// Voice chat icon: talks to Gemini Live through the worker's /live WebSocket.
//
//   microphone (16 kHz PCM16) --> WebSocket --> Gemini Live --> 24 kHz PCM16 --> speaker
//
// Gemini detects when the user starts and stops talking, so there is no button to hold.
// When the user talks over a reply the server sends `interrupted` and playback is cut.
// The only thing on screen is the small pink orb. The API key never reaches this page:
// the worker adds it.
//
// When the user asks about their screen, Gemini calls the look_at_screen tool. The main
// process then captures and privacy-checks the screens; only clean screenshots come back.

const MIC_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;
const SETUP_TIMEOUT_MILLISECONDS = 12000;
const MAXIMUM_RESUME_ATTEMPTS = 3;
// Mic level (0..1 RMS) above which the user counts as talking, for the "thinking" state only.
const SPEAKING_LEVEL_THRESHOLD = 0.02;
const THINKING_AFTER_SILENCE_MILLISECONDS = 700;
const DRAG_START_DISTANCE_PIXELS = 4;

const orbElement = document.getElementById('orb');

let config = null;

// Connection
let socket = null;
let connectionGeneration = 0; // bumped on every (re)connect so stale socket events can be ignored
let activeModelIndex = 0;
let isReady = false;
let isEnding = false;
let resumeHandle = null;
let resumeAttempts = 0;

// Microphone
let micStream = null;
let micContext = null;
let micSourceNode = null;
let micWorkletNode = null;
let isMuted = false;
let micLevel = 0;

// Playback
let playbackContext = null;
let playbackGain = null;
let playbackAnalyser = null;
let nextPlaybackTime = 0;
const activePlaybackSources = new Set();
let outputLevel = 0;

// Conversation
let isAwaitingReply = false;
let lastUserVoiceTimestamp = 0;
let isLookingAtScreen = false;
let toolRunCounter = 0;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// ---------------------------------------------------------------------------
// The icon
// ---------------------------------------------------------------------------

const STATE_TITLES = {
  connecting: 'Click It is connecting...',
  listening: 'Click It is listening. Click to mute, right-click for more.',
  thinking: 'Click It is thinking...',
  speaking: 'Click It is speaking. Talk over it to interrupt.',
  looking: 'Click It is looking at your screen...',
  muted: 'Microphone muted. Click to unmute, right-click for more.',
  error: 'Voice chat is not connected. Click to reconnect.',
};

let uiState = 'connecting';

function setUiState(newState) {
  uiState = newState;
  orbElement.dataset.state = newState;
  orbElement.title = STATE_TITLES[newState] || '';
}

/** Problems go to a notification (see main process); the icon turns grey with a small "!". */
function showError(message) {
  isReady = false;
  isLookingAtScreen = false;
  setUiState('error');
  window.clickItVoice.reportError(message);
}

/** Picks what the orb shows while a conversation is running. */
function refreshConversationState() {
  if (!isReady) return;
  if (isLookingAtScreen) setUiState('looking');
  else if (activePlaybackSources.size > 0) setUiState('speaking');
  else if (isMuted) setUiState('muted');
  else if (isAwaitingReply && performance.now() - lastUserVoiceTimestamp > THINKING_AFTER_SILENCE_MILLISECONDS) setUiState('thinking');
  else setUiState('listening');
}

/** Drives the orb's glow from whoever is talking, plus the thinking state. */
function animationLoop() {
  if (playbackAnalyser && activePlaybackSources.size > 0) {
    const samples = new Uint8Array(playbackAnalyser.fftSize);
    playbackAnalyser.getByteTimeDomainData(samples);
    let sumOfSquares = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const centered = (samples[index] - 128) / 128;
      sumOfSquares += centered * centered;
    }
    outputLevel = Math.max(Math.sqrt(sumOfSquares / samples.length) * 3, outputLevel * 0.8);
  } else {
    outputLevel *= 0.8;
  }

  const glowLevel = activePlaybackSources.size > 0 ? outputLevel : isMuted ? 0 : micLevel * 3;
  document.documentElement.style.setProperty('--level', Math.min(1, glowLevel).toFixed(3));

  if (isReady && (uiState === 'listening' || uiState === 'thinking')) refreshConversationState();
  requestAnimationFrame(animationLoop);
}

// ---------------------------------------------------------------------------
// Microphone
// ---------------------------------------------------------------------------

const CAPTURE_WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pendingSamples = new Float32Array(1600); // 100 ms at 16 kHz
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

/** Linear-interpolation resample, only used if the browser ignored our requested 16 kHz rate. */
function resampleTo16kHz(inputSamples, inputSampleRate) {
  if (inputSampleRate === MIC_SAMPLE_RATE) return inputSamples;
  const sampleRatio = inputSampleRate / MIC_SAMPLE_RATE;
  const outputSamples = new Float32Array(Math.floor(inputSamples.length / sampleRatio));
  for (let outputIndex = 0; outputIndex < outputSamples.length; outputIndex += 1) {
    const exactPosition = outputIndex * sampleRatio;
    const lowerIndex = Math.floor(exactPosition);
    const upperIndex = Math.min(lowerIndex + 1, inputSamples.length - 1);
    const weight = exactPosition - lowerIndex;
    outputSamples[outputIndex] = inputSamples[lowerIndex] * (1 - weight) + inputSamples[upperIndex] * weight;
  }
  return outputSamples;
}

function floatToPcm16Bytes(floatSamples) {
  const pcm16 = new Int16Array(floatSamples.length);
  for (let index = 0; index < floatSamples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, floatSamples[index]));
    pcm16[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return new Uint8Array(pcm16.buffer);
}

function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

function base64ToBytes(base64Text) {
  const binary = atob(base64Text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function startMicrophone() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  micStream.getAudioTracks().forEach((track) => { track.enabled = !isMuted; });
  micContext = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
  const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await micContext.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  micSourceNode = micContext.createMediaStreamSource(micStream);
  micWorkletNode = new AudioWorkletNode(micContext, 'capture-processor');
  micWorkletNode.port.onmessage = (messageEvent) => handleMicChunk(resampleTo16kHz(messageEvent.data, micContext.sampleRate));

  micSourceNode.connect(micWorkletNode);
  // Chromium only pulls the graph if it reaches the destination, so end it in a silent gain.
  const silentGain = micContext.createGain();
  silentGain.gain.value = 0;
  micWorkletNode.connect(silentGain).connect(micContext.destination);
}

function stopMicrophone() {
  if (micWorkletNode) micWorkletNode.port.onmessage = null;
  if (micSourceNode) micSourceNode.disconnect();
  if (micWorkletNode) micWorkletNode.disconnect();
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  if (micContext) micContext.close().catch(() => {});
  micStream = micContext = micSourceNode = micWorkletNode = null;
}

function handleMicChunk(samples) {
  let sumOfSquares = 0;
  for (let index = 0; index < samples.length; index += 1) sumOfSquares += samples[index] * samples[index];
  const rootMeanSquare = Math.sqrt(sumOfSquares / Math.max(samples.length, 1));
  micLevel = isMuted ? 0 : Math.max(rootMeanSquare, micLevel * 0.7);
  if (!isMuted && rootMeanSquare > SPEAKING_LEVEL_THRESHOLD) {
    lastUserVoiceTimestamp = performance.now();
    isAwaitingReply = true;
  }

  if (!isReady || isMuted || !socket || socket.readyState !== WebSocket.OPEN) return;
  sendJson({
    realtimeInput: { audio: { data: bytesToBase64(floatToPcm16Bytes(samples)), mimeType: `audio/pcm;rate=${MIC_SAMPLE_RATE}` } },
  });
}

function setMuted(shouldMute) {
  isMuted = shouldMute;
  if (micStream) micStream.getAudioTracks().forEach((track) => { track.enabled = !shouldMute; });
  // Tell the server the mic stream has paused so it can answer what it already heard.
  if (shouldMute && isReady) sendJson({ realtimeInput: { audioStreamEnd: true } });
  if (shouldMute) isAwaitingReply = false;
  refreshConversationState();
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function ensurePlaybackContext() {
  if (playbackContext) return;
  playbackContext = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
  playbackGain = playbackContext.createGain();
  playbackAnalyser = playbackContext.createAnalyser();
  playbackAnalyser.fftSize = 512;
  playbackGain.connect(playbackAnalyser);
  playbackAnalyser.connect(playbackContext.destination);
}

function playPcmChunk(base64Audio) {
  ensurePlaybackContext();
  if (playbackContext.state === 'suspended') playbackContext.resume().catch(() => {});

  const bytes = base64ToBytes(base64Audio);
  const sampleCount = bytes.length >> 1;
  if (sampleCount === 0) return;
  const pcm16 = new Int16Array(bytes.buffer, 0, sampleCount);
  const floats = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) floats[index] = pcm16[index] / 0x8000;

  const audioBuffer = playbackContext.createBuffer(1, sampleCount, PLAYBACK_SAMPLE_RATE);
  audioBuffer.copyToChannel(floats, 0);
  const sourceNode = playbackContext.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(playbackGain);

  // Chunks are queued back to back. A small lead on the first chunk absorbs network jitter.
  const startTime = Math.max(playbackContext.currentTime + 0.05, nextPlaybackTime);
  sourceNode.start(startTime);
  nextPlaybackTime = startTime + audioBuffer.duration;

  activePlaybackSources.add(sourceNode);
  sourceNode.onended = () => {
    activePlaybackSources.delete(sourceNode);
    if (activePlaybackSources.size === 0) refreshConversationState();
  };
  refreshConversationState();
}

/** Drops everything that is queued or playing (the user talked over the reply). */
function stopPlayback() {
  for (const sourceNode of activePlaybackSources) {
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch (error) { /* already finished */ }
  }
  activePlaybackSources.clear();
  nextPlaybackTime = 0;
  refreshConversationState();
}

// ---------------------------------------------------------------------------
// Connection to Gemini Live (through the worker)
// ---------------------------------------------------------------------------

function sendJson(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function buildSetupMessage(model) {
  return {
    setup: {
      model,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voiceName } } },
      },
      systemInstruction: { parts: [{ text: config.systemPrompt }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'look_at_screen',
              description:
                "Takes a look at the user's screen right now. Call this whenever the user asks about what is on their screen, a window, a page, an error, or anything they are looking at.",
            },
          ],
        },
      ],
      // Lets a chat run longer than the default audio session limit.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      // Developer testing only (CLICKIT_VOICE_DEBUG=1): transcripts, kept in window.__voiceDebug. Off by default.
      ...(config.debug ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {}),
    },
  };
}

/**
 * Opens a socket and sends the setup. Resolves once Gemini accepts it ({ ok: true }) or
 * with the reason it failed. After that, `socket` events are handled by the functions below.
 */
function tryConnect(model, generation) {
  return new Promise((resolve) => {
    let hasSettled = false;
    let hasOpened = false;
    let timeoutId = null;
    const settle = (result) => {
      if (hasSettled) return;
      hasSettled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    let newSocket;
    try {
      newSocket = new WebSocket(config.liveUrl);
    } catch (error) {
      resolve({ ok: false, unreachable: true, reason: String(error.message || error) });
      return;
    }
    newSocket.binaryType = 'arraybuffer';
    socket = newSocket;

    timeoutId = setTimeout(() => {
      settle({ ok: false, reason: 'Timed out waiting for Gemini to accept the session.' });
      try { newSocket.close(); } catch (error) { /* ignore */ }
    }, SETUP_TIMEOUT_MILLISECONDS);

    newSocket.onopen = () => {
      hasOpened = true;
      newSocket.send(JSON.stringify(buildSetupMessage(model)));
    };
    newSocket.onmessage = (messageEvent) => {
      if (generation !== connectionGeneration) return;
      const message = parseServerMessage(messageEvent.data);
      if (!message) return;
      if (message.setupComplete && !hasSettled) {
        settle({ ok: true });
        return;
      }
      if (hasSettled) handleServerMessage(message);
    };
    newSocket.onerror = () => { /* the close event that follows carries the details */ };
    newSocket.onclose = (closeEvent) => {
      if (generation !== connectionGeneration) return;
      if (!hasSettled) {
        settle({ ok: false, unreachable: !hasOpened, code: closeEvent.code, reason: closeEvent.reason });
      } else {
        handleUnexpectedClose(closeEvent);
      }
    };
  });
}

function parseServerMessage(rawData) {
  try {
    const text = typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData);
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

/** Connects with the first model that works, trying the others if one is unavailable. */
async function connect() {
  connectionGeneration += 1;
  const generation = connectionGeneration;
  isReady = false;
  toolRunCounter += 1; // a tool call from the old connection must not answer on the new one
  isLookingAtScreen = false;
  setUiState('connecting');
  closeSocketQuietly();

  if (!config.liveUrl) {
    showError('The worker URL in the Click It panel is not valid. Use something like http://localhost:8787.');
    return;
  }

  let lastFailure = null;
  while (activeModelIndex < config.models.length) {
    const result = await tryConnect(config.models[activeModelIndex], generation);
    if (generation !== connectionGeneration || isEnding) return;

    if (result.ok) {
      isReady = true;
      resumeAttempts = 0;
      if (isMuted) sendJson({ realtimeInput: { audioStreamEnd: true } });
      refreshConversationState();
      return;
    }

    closeSocketQuietly();
    lastFailure = result;
    console.warn(`[voice] ${config.models[activeModelIndex]} failed:`, result.code, result.reason);

    // A dead worker fails the same way for every model, so don't walk the whole list.
    if (result.unreachable) break;
    // A resume that was rejected (expired handle): start a fresh conversation on the same model.
    if (resumeHandle) {
      resumeHandle = null;
      continue;
    }
    activeModelIndex += 1;
  }

  showError(describeFailure(lastFailure));
}

function describeFailure(failure) {
  if (!failure) return 'Could not start the voice chat.';
  const reason = String(failure.reason || '');
  if (failure.unreachable) {
    return `Can't reach the voice server at ${config.workerBaseUrl}. Start it from the worker folder with: npx wrangler dev --port 8787 --ip 127.0.0.1`;
  }
  if (/quota|resource_exhausted|rate|429/i.test(reason)) {
    return "Gemini's request limit was reached. Wait a minute, then click the icon to reconnect.";
  }
  if (/api key|permission|unauthenticated|403|401/i.test(reason)) {
    return "Gemini rejected the request (credentials). Check the worker setup, then restart the worker.";
  }
  // Never show anything that looks like a key, whatever the server's reason text says.
  const safeReason = reason.replace(/\bAQ\.[A-Za-z0-9_-]{16,}/g, '[hidden]').replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[hidden]');
  return `Gemini ended the connection${failure.code ? ` (code ${failure.code})` : ''}${safeReason ? `: ${safeReason.slice(0, 160)}` : '.'}`;
}

function closeSocketQuietly() {
  const oldSocket = socket;
  socket = null;
  if (!oldSocket) return;
  oldSocket.onopen = oldSocket.onmessage = oldSocket.onerror = oldSocket.onclose = null;
  try { oldSocket.close(1000, 'client closed'); } catch (error) { /* ignore */ }
}

/** The connection dropped mid-chat (Gemini limits how long one connection lasts). */
function handleUnexpectedClose(closeEvent) {
  isReady = false;
  isLookingAtScreen = false;
  toolRunCounter += 1;
  stopPlayback();
  if (isEnding) return;

  if (resumeHandle && resumeAttempts < MAXIMUM_RESUME_ATTEMPTS) {
    resumeAttempts += 1;
    setUiState('connecting');
    setTimeout(() => { if (!isEnding) connect(); }, 400);
    return;
  }
  showError(describeFailure({ code: closeEvent.code, reason: closeEvent.reason }));
}

function handleServerMessage(message) {
  if (message.sessionResumptionUpdate) {
    const update = message.sessionResumptionUpdate;
    if (update.resumable !== false && update.newHandle) resumeHandle = update.newHandle;
    return;
  }

  if (message.toolCall) {
    handleToolCall(message.toolCall).catch((error) => console.warn('[voice] tool call failed:', error));
    return;
  }
  if (message.toolCallCancellation) {
    toolRunCounter += 1;
    isLookingAtScreen = false;
    refreshConversationState();
    return;
  }

  const content = message.serverContent;
  if (!content) return;

  if (content.interrupted) stopPlayback();

  if (config.debug) {
    window.__voiceDebug = window.__voiceDebug || { heard: '', said: '' };
    if (content.inputTranscription && content.inputTranscription.text) window.__voiceDebug.heard += content.inputTranscription.text;
    if (content.outputTranscription && content.outputTranscription.text) window.__voiceDebug.said += content.outputTranscription.text;
  }

  const parts = (content.modelTurn && content.modelTurn.parts) || [];
  for (const part of parts) {
    if (part.inlineData && part.inlineData.data) {
      isAwaitingReply = false;
      playPcmChunk(part.inlineData.data);
    }
  }

  if (content.turnComplete) {
    isAwaitingReply = false;
    refreshConversationState();
  }
}

// ---------------------------------------------------------------------------
// Looking at the screen (the look_at_screen tool)
// ---------------------------------------------------------------------------

function sendToolResponse(call, resultText) {
  sendJson({ toolResponse: { functionResponses: [{ id: call.id, name: call.name, response: { result: resultText } }] } });
}

function describePrivacyReasons(reasons) {
  return reasons && reasons.length > 0 ? ` (${reasons.join('; ')})` : '';
}

/**
 * The order matters, it is the one that was tested against every model: the screenshot goes
 * first, then the tool reply tells the model to wait, then a message tells it the picture is
 * there. A reply sent straight after the tool call, without that last message, makes the
 * model answer before it has looked and make something up.
 */
async function handleToolCall(toolCall) {
  for (const call of toolCall.functionCalls || []) {
    if (call.name !== 'look_at_screen') {
      sendToolResponse(call, 'That tool does not exist.');
      continue;
    }

    toolRunCounter += 1;
    const runIdentifier = toolRunCounter;
    const generation = connectionGeneration;
    const isStillCurrent = () =>
      runIdentifier === toolRunCounter && generation === connectionGeneration && socket && socket.readyState === WebSocket.OPEN;

    isLookingAtScreen = true;
    refreshConversationState();
    try {
      let lookResult;
      try {
        lookResult = await window.clickItVoice.lookAtScreen();
      } catch (error) {
        lookResult = { images: [], reasons: [], failed: true };
      }
      if (!isStillCurrent()) return;

      if (lookResult.images.length === 0) {
        sendToolResponse(
          call,
          lookResult.failed
            ? 'Taking the screenshot failed. You did not look. Tell the user in one sentence that you could not look at the screen just now.'
            : `The screen was NOT shared because it may show something private${describePrivacyReasons(lookResult.reasons)}. You did not look. Tell the user kindly, in one sentence, that you held back to protect their privacy, and that they can close the private window and ask again.`
        );
        continue;
      }

      for (const imageBase64 of lookResult.images) {
        sendJson({ realtimeInput: { video: { data: imageBase64, mimeType: 'image/jpeg' } } });
      }
      await sleep(400);
      if (!isStillCurrent()) return;

      const screenshotCountNote =
        lookResult.images.length > 1
          ? ` There are ${lookResult.images.length} screenshots, one per monitor; the first is the monitor with the user's cursor.`
          : '';
      sendToolResponse(
        call,
        `Screenshot taken and delivered as the image just before this. In your next message the user will tell you to answer. Until then say only the words "Let me look." Do NOT describe or guess anything on the screen yet.${screenshotCountNote}`
      );
      await sleep(700);
      if (!isStillCurrent()) return;

      sendJson({
        realtimeInput: { text: 'The screenshot is now in front of you. Answer my question about it using only what you can see in the picture.' },
      });
    } finally {
      if (runIdentifier === toolRunCounter) {
        isLookingAtScreen = false;
        refreshConversationState();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Start, restart, end
// ---------------------------------------------------------------------------

function describeMicrophoneError(error) {
  if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
    return 'Microphone access is blocked. Allow it in Windows Settings > Privacy & security > Microphone, then click the icon to reconnect.';
  }
  if (error && error.name === 'NotFoundError') return 'No microphone was found. Plug one in, then click the icon to reconnect.';
  return `Could not open the microphone: ${error && error.message ? error.message : error}`;
}

async function startChat() {
  try {
    await startMicrophone();
  } catch (error) {
    stopMicrophone();
    showError(describeMicrophoneError(error));
    return;
  }
  await connect();
}

/** Fresh conversation: new session, first model again. */
async function restartChat() {
  resumeHandle = null;
  resumeAttempts = 0;
  activeModelIndex = 0;
  isAwaitingReply = false;
  stopPlayback();
  await startChat();
}

function endChat() {
  if (isEnding) return;
  isEnding = true;
  connectionGeneration += 1;
  closeSocketQuietly();
  stopPlayback();
  stopMicrophone();
  if (playbackContext) playbackContext.close().catch(() => {});
  window.clickItVoice.close();
}

// ---------------------------------------------------------------------------
// Mouse: click = mute, drag = move, right-click = menu
// ---------------------------------------------------------------------------

function setUpPointerHandling() {
  let pressStart = null; // { x, y } in screen pixels while the primary button is down
  let lastPoint = null;
  let isDragging = false;

  orbElement.addEventListener('pointerdown', (pointerEvent) => {
    if (pointerEvent.button !== 0) return;
    pressStart = { x: pointerEvent.screenX, y: pointerEvent.screenY };
    lastPoint = { ...pressStart };
    isDragging = false;
    try {
      orbElement.setPointerCapture(pointerEvent.pointerId); // keep getting moves while the window follows the mouse
    } catch (error) { /* not an active pointer */ }
  });

  orbElement.addEventListener('pointermove', (pointerEvent) => {
    if (!pressStart) return;
    if (!isDragging && Math.hypot(pointerEvent.screenX - pressStart.x, pointerEvent.screenY - pressStart.y) < DRAG_START_DISTANCE_PIXELS) return;
    isDragging = true;
    window.clickItVoice.moveBy(pointerEvent.screenX - lastPoint.x, pointerEvent.screenY - lastPoint.y);
    lastPoint = { x: pointerEvent.screenX, y: pointerEvent.screenY };
  });

  orbElement.addEventListener('pointerup', (pointerEvent) => {
    if (pointerEvent.button !== 0 || !pressStart) return;
    const wasDragged = isDragging;
    pressStart = null;
    isDragging = false;
    if (wasDragged) return;
    if (uiState === 'error') restartChat();
    else if (uiState !== 'connecting') setMuted(!isMuted);
  });

  orbElement.addEventListener('contextmenu', (contextEvent) => {
    contextEvent.preventDefault();
    window.clickItVoice.showMenu({ isMuted, hasError: uiState === 'error' });
  });
}

async function initialize() {
  config = await window.clickItVoice.getConfig();
  if (!config) return;

  window.clickItVoice.onCommand((commandName) => {
    if (commandName === 'toggle-mute') setMuted(!isMuted);
    else if (commandName === 'restart') restartChat();
  });
  window.addEventListener('beforeunload', () => {
    closeSocketQuietly();
    stopMicrophone();
  });
  setUpPointerHandling();

  requestAnimationFrame(animationLoop);
  startChat();
}

initialize();
