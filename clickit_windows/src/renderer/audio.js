// Hidden audio window: microphone capture and speech playback.
// Everything here is driven by requests from the main process (see audioBridge.js).

const TARGET_SAMPLE_RATE = 16000;

// ---------------------------------------------------------------------------
// Microphone capture
// ---------------------------------------------------------------------------

const CAPTURE_WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pendingSamples = new Float32Array(1024);
    this.pendingSampleCount = 0;
  }
  process(inputs) {
    const firstChannel = inputs[0] && inputs[0][0];
    if (!firstChannel) return true;
    for (let sampleIndex = 0; sampleIndex < firstChannel.length; sampleIndex += 1) {
      this.pendingSamples[this.pendingSampleCount] = firstChannel[sampleIndex];
      this.pendingSampleCount += 1;
      if (this.pendingSampleCount === this.pendingSamples.length) {
        this.port.postMessage(this.pendingSamples.slice());
        this.pendingSampleCount = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

let activeRecordingSession = null;

/** Linear-interpolation resample, only used if the browser ignored our requested 16 kHz context rate. */
function resampleTo16kHz(inputSamples, inputSampleRate) {
  if (inputSampleRate === TARGET_SAMPLE_RATE) return inputSamples;
  const sampleRatio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(inputSamples.length / sampleRatio);
  const outputSamples = new Float32Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const exactInputPosition = outputIndex * sampleRatio;
    const lowerIndex = Math.floor(exactInputPosition);
    const upperIndex = Math.min(lowerIndex + 1, inputSamples.length - 1);
    const interpolationWeight = exactInputPosition - lowerIndex;
    outputSamples[outputIndex] = inputSamples[lowerIndex] * (1 - interpolationWeight) + inputSamples[upperIndex] * interpolationWeight;
  }
  return outputSamples;
}

function convertFloatSamplesToPcm16(floatSamples) {
  const pcm16Samples = new Int16Array(floatSamples.length);
  for (let sampleIndex = 0; sampleIndex < floatSamples.length; sampleIndex += 1) {
    const clampedSample = Math.max(-1, Math.min(1, floatSamples[sampleIndex]));
    pcm16Samples[sampleIndex] = clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7fff;
  }
  return pcm16Samples;
}

async function startRecording() {
  if (activeRecordingSession) await teardownRecordingSession();

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await audioContext.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const microphoneSourceNode = audioContext.createMediaStreamSource(mediaStream);
  const captureNode = new AudioWorkletNode(audioContext, 'capture-processor');
  const recordingSession = { mediaStream, audioContext, microphoneSourceNode, captureNode, pcm16Chunks: [], smoothedPowerLevel: 0 };

  captureNode.port.onmessage = (messageEvent) => {
    const resampledSamples = resampleTo16kHz(messageEvent.data, audioContext.sampleRate);
    recordingSession.pcm16Chunks.push(convertFloatSamplesToPcm16(resampledSamples));

    // RMS power for the waveform. Fast attack, slower release so bars don't flicker.
    let sumOfSquares = 0;
    for (let sampleIndex = 0; sampleIndex < resampledSamples.length; sampleIndex += 1) {
      sumOfSquares += resampledSamples[sampleIndex] * resampledSamples[sampleIndex];
    }
    const rootMeanSquare = Math.sqrt(sumOfSquares / Math.max(resampledSamples.length, 1));
    recordingSession.smoothedPowerLevel = Math.max(rootMeanSquare, recordingSession.smoothedPowerLevel * 0.7);
    window.clickItAudio.sendAudioPowerLevel(recordingSession.smoothedPowerLevel);
  };

  microphoneSourceNode.connect(captureNode);
  // The worklet has no outputs, but Chromium only pulls the graph if it reaches the destination.
  const silentGainNode = audioContext.createGain();
  silentGainNode.gain.value = 0;
  captureNode.connect(silentGainNode).connect(audioContext.destination);

  activeRecordingSession = recordingSession;
}

async function teardownRecordingSession() {
  const recordingSession = activeRecordingSession;
  activeRecordingSession = null;
  if (!recordingSession) return null;

  recordingSession.captureNode.port.onmessage = null;
  recordingSession.microphoneSourceNode.disconnect();
  recordingSession.captureNode.disconnect();
  recordingSession.mediaStream.getTracks().forEach((track) => track.stop());
  await recordingSession.audioContext.close().catch(() => {});
  return recordingSession;
}

async function stopRecording() {
  const recordingSession = await teardownRecordingSession();
  if (!recordingSession) return new Uint8Array(0);

  const totalSampleCount = recordingSession.pcm16Chunks.reduce((total, chunk) => total + chunk.length, 0);
  const combinedPcm16Samples = new Int16Array(totalSampleCount);
  let writeOffset = 0;
  for (const chunk of recordingSession.pcm16Chunks) {
    combinedPcm16Samples.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  return new Uint8Array(combinedPcm16Samples.buffer);
}

async function probeMicrophone() {
  const probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  probeStream.getTracks().forEach((track) => track.stop());
  return true;
}

// ---------------------------------------------------------------------------
// Speech playback
// ---------------------------------------------------------------------------

let speechAudioElement = null;
let speechAudioUrl = null;

function stopSpeech() {
  if (speechAudioElement) {
    speechAudioElement.onended = null;
    speechAudioElement.onerror = null;
    speechAudioElement.pause();
    speechAudioElement = null;
  }
  if (speechAudioUrl) {
    URL.revokeObjectURL(speechAudioUrl);
    speechAudioUrl = null;
  }
  window.speechSynthesis.cancel();
  window.clickItAudio.sendTextToSpeechState(false);
}

function playSpeechAudio(mp3Bytes) {
  stopSpeech();
  speechAudioUrl = URL.createObjectURL(new Blob([mp3Bytes], { type: 'audio/mpeg' }));
  const audioElement = new Audio(speechAudioUrl);
  speechAudioElement = audioElement;

  return new Promise((resolve, reject) => {
    audioElement.onplaying = () => {
      window.clickItAudio.sendTextToSpeechState(true);
      resolve(true);
    };
    audioElement.onended = () => stopSpeech();
    audioElement.onerror = () => {
      stopSpeech();
      reject(new Error('Could not play speech audio'));
    };
    audioElement.play().catch((error) => {
      stopSpeech();
      reject(error);
    });
  });
}

function speakWithSystemVoice(textToSpeak) {
  stopSpeech();
  const utterance = new SpeechSynthesisUtterance(textToSpeak);

  return new Promise((resolve) => {
    // If no voice is installed the 'start' event never fires, so don't wait forever.
    const startTimeoutId = setTimeout(() => resolve(false), 3000);
    utterance.onstart = () => {
      clearTimeout(startTimeoutId);
      window.clickItAudio.sendTextToSpeechState(true);
      resolve(true);
    };
    utterance.onend = () => window.clickItAudio.sendTextToSpeechState(false);
    utterance.onerror = () => window.clickItAudio.sendTextToSpeechState(false);
    window.speechSynthesis.speak(utterance);
  });
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

const requestHandlers = {
  'start-recording': startRecording,
  'stop-recording': stopRecording,
  'cancel-recording': async () => {
    await teardownRecordingSession();
    return true;
  },
  'probe-microphone': probeMicrophone,
  'play-audio': playSpeechAudio,
  'speak-system-voice': speakWithSystemVoice,
  'stop-speech': async () => {
    stopSpeech();
    return true;
  },
};

window.clickItAudio.onRequest(async ({ requestIdentifier, commandName, payload }) => {
  const requestHandler = requestHandlers[commandName];
  if (!requestHandler) {
    window.clickItAudio.respond(requestIdentifier, null, `Unknown audio command: ${commandName}`);
    return;
  }
  try {
    const result = await requestHandler(payload);
    window.clickItAudio.respond(requestIdentifier, result, null);
  } catch (error) {
    window.clickItAudio.respond(requestIdentifier, null, error && error.message ? error.message : String(error));
  }
});
