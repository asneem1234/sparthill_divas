'use strict';

const MAX_RECORDING_MS = 20000;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

/** @type {null | {id: number, recorder: MediaRecorder, stream: MediaStream, chunks: Blob[], cancelled: boolean, finished: boolean, timer: any, levelTimer: any, context: AudioContext|null}} */
let current = null;

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function releaseSession(session) {
  clearTimeout(session.timer);
  clearInterval(session.levelTimer);
  session.stream.getTracks().forEach((track) => track.stop());
  session.context?.close().catch(() => {});
  session.context = null;
  window.clickyAudio.send('audio:level', 0);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function startSession({ session: id }) {
  cancelSession();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (error) {
    window.clickyAudio.send('audio:error', { session: id, message: `Microphone unavailable: ${error.message}` });
    return;
  }

  const mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const session = {
    id,
    recorder,
    stream,
    chunks: [],
    cancelled: false,
    finished: false,
    timer: null,
    levelTimer: null,
    context: null,
  };
  current = session;

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) session.chunks.push(event.data);
  };
  recorder.onstop = async () => {
    releaseSession(session);
    if (session.cancelled || session.finished) return;
    session.finished = true;
    const blob = new Blob(session.chunks, { type: recorder.mimeType || 'audio/webm' });
    const data = blob.size > 0 ? arrayBufferToBase64(await blob.arrayBuffer()) : '';
    window.clickyAudio.send('audio:recorded', {
      session: id,
      data,
      mime: (recorder.mimeType || 'audio/webm').split(';')[0],
    });
  };

  // Level meter for the cursor's waveform.
  try {
    session.context = new AudioContext();
    const analyser = session.context.createAnalyser();
    analyser.fftSize = 512;
    session.context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    session.levelTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      window.clickyAudio.send('audio:level', Math.min(1, Math.sqrt(sum / samples.length) * 6));
    }, 50);
  } catch {
    // Meter is cosmetic; recording still works.
  }

  recorder.start();
  // Safety net so a forgotten recording can't run forever.
  session.timer = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, MAX_RECORDING_MS);
}

function stopSession({ session: id }) {
  const session = current;
  if (!session || session.id !== id || session.recorder.state !== 'recording') return;
  session.recorder.stop();
}

function cancelSession() {
  const session = current;
  if (!session) return;
  session.cancelled = true;
  if (session.recorder.state === 'recording') {
    session.recorder.stop();
  } else {
    releaseSession(session);
  }
  current = null;
}

// ---------------------------------------------------------------------------
// Speech playback (Windows system voice)
// ---------------------------------------------------------------------------

function stopPlayback() {
  window.speechSynthesis.cancel();
}

function speak({ text }) {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onstart = () => window.clickyAudio.send('audio:playback-started');
  utterance.onend = () => window.clickyAudio.send('audio:playback-ended');
  utterance.onerror = () => window.clickyAudio.send('audio:playback-ended');
  window.speechSynthesis.speak(utterance);
}

window.clickyAudio.on('audio:start', startSession);
window.clickyAudio.on('audio:stop', stopSession);
window.clickyAudio.on('audio:cancel', cancelSession);
window.clickyAudio.on('audio:stop-playback', stopPlayback);
window.clickyAudio.on('audio:speak', speak);
