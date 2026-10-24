'use strict';

const TARGET_SAMPLE_RATE = 16000;
const EXPLICIT_FINAL_GRACE_MS = 1400;
const FINAL_FALLBACK_MS = 2800;
const WS_BASE_URL = 'wss://streaming.assemblyai.com/v3/ws';

/** @type {null | ReturnType<typeof createSession>} */
let current = null;

// ---------------------------------------------------------------------------
// Recording + streaming transcription
// ---------------------------------------------------------------------------

function floatToPcm16(samples, inputRate) {
  // Linear resample when the browser couldn't give us a 16 kHz context.
  let source = samples;
  if (inputRate !== TARGET_SAMPLE_RATE) {
    const ratio = inputRate / TARGET_SAMPLE_RATE;
    const length = Math.floor(samples.length / ratio);
    source = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const position = i * ratio;
      const index = Math.floor(position);
      const fraction = position - index;
      const next = samples[Math.min(index + 1, samples.length - 1)];
      source[i] = samples[index] * (1 - fraction) + next * fraction;
    }
  }

  const pcm = new Int16Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const clamped = Math.max(-1, Math.min(1, source[i]));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm.buffer;
}

function createSession(id) {
  const session = {
    id,
    stream: null,
    context: null,
    processor: null,
    source: null,
    ws: null,
    ready: false, // true once AssemblyAI sends "Begin"
    pending: [], // audio captured before the websocket was ready
    finishing: false,
    delivered: false,
    cancelled: false,
    storedTurns: new Map(), // turn_order -> { text, formatted }
    activeTurn: { order: null, text: '' },
    graceTimer: null,
    fallbackTimer: null,
    lastLevelAt: 0,
  };
  return session;
}

function composeTranscript(session) {
  const committed = [...session.storedTurns.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, turn]) => turn.text)
    .filter(Boolean);
  const active = session.activeTurn.text.trim();
  if (active) committed.push(active);
  return committed.join(' ').trim();
}

function deliverFinal(session) {
  if (session.delivered || session.cancelled) return;
  session.delivered = true;
  clearTimeout(session.graceTimer);
  clearTimeout(session.fallbackTimer);
  window.clickyAudio.send('audio:transcript', { session: session.id, text: composeTranscript(session) });
  closeSocket(session);
}

function closeSocket(session) {
  const ws = session.ws;
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Terminate' }));
    ws.close();
  } catch {
    // Already closed.
  }
  session.ws = null;
}

function releaseMic(session) {
  try {
    session.processor?.disconnect();
    session.source?.disconnect();
  } catch {
    // Nodes already disconnected.
  }
  session.processor = null;
  session.source = null;
  session.stream?.getTracks().forEach((track) => track.stop());
  session.stream = null;
  session.context?.close().catch(() => {});
  session.context = null;
}

function sendAudio(session, buffer) {
  if (session.ready && session.ws?.readyState === WebSocket.OPEN) {
    session.ws.send(buffer);
  } else {
    session.pending.push(buffer);
  }
}

function requestFinalTranscript(session) {
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;
  session.ws.send(JSON.stringify({ type: 'ForceEndpoint' }));
  clearTimeout(session.graceTimer);
  session.graceTimer = setTimeout(() => deliverFinal(session), EXPLICIT_FINAL_GRACE_MS);
}

function handleSocketMessage(session, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  switch ((message.type || '').toLowerCase()) {
    case 'begin':
      session.ready = true;
      for (const buffer of session.pending) session.ws.send(buffer);
      session.pending = [];
      if (session.finishing) requestFinalTranscript(session);
      break;

    case 'turn': {
      const text = (message.transcript || '').trim();
      const order =
        message.turn_order ?? session.activeTurn.order ?? (Math.max(-1, ...session.storedTurns.keys()) + 1);
      const turnIsOver = message.end_of_turn === true || message.turn_is_formatted === true;

      if (turnIsOver) {
        session.activeTurn = { order: null, text: '' };
        const existing = session.storedTurns.get(order);
        const keepExisting = existing?.formatted && message.turn_is_formatted !== true;
        if (text && !keepExisting) {
          session.storedTurns.set(order, { text, formatted: message.turn_is_formatted === true });
        }
        if (session.finishing) deliverFinal(session);
      } else {
        session.activeTurn = { order, text };
      }
      break;
    }

    case 'termination':
      if (session.finishing) deliverFinal(session);
      break;

    case 'error':
      failSession(session, new Error(message.error || message.message || 'AssemblyAI returned an error.'));
      break;

    default:
      break;
  }
}

function failSession(session, error) {
  if (session.delivered || session.cancelled) return;
  // If we already heard something, hand back what we have instead of failing.
  if (session.finishing && composeTranscript(session)) {
    deliverFinal(session);
    return;
  }
  session.cancelled = true;
  clearTimeout(session.graceTimer);
  clearTimeout(session.fallbackTimer);
  releaseMic(session);
  closeSocket(session);
  window.clickyAudio.send('audio:error', { session: session.id, message: error.message });
}

async function startSession({ session: id }) {
  cancelSession();
  const session = createSession(id);
  current = session;

  try {
    session.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    // The user may have released the hotkey (or interrupted) while the mic was opening.
    if (session.cancelled || session.finishing || current !== session) {
      releaseMic(session);
      return;
    }

    session.context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    session.source = session.context.createMediaStreamSource(session.stream);
    // ScriptProcessor is deprecated but reliable in Electron and keeps this
    // renderer to a single file. 2048 samples is about 128 ms at 16 kHz.
    session.processor = session.context.createScriptProcessor(2048, 1, 1);
    session.processor.onaudioprocess = (event) => {
      if (session.cancelled || session.finishing) return;
      const samples = event.inputBuffer.getChannelData(0);

      const now = performance.now();
      if (now - session.lastLevelAt > 50) {
        session.lastLevelAt = now;
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        window.clickyAudio.send('audio:level', Math.min(1, rms * 6));
      }

      sendAudio(session, floatToPcm16(samples, session.context.sampleRate));
    };
    session.source.connect(session.processor);
    session.processor.connect(session.context.destination);
  } catch (error) {
    failSession(session, new Error(`Microphone unavailable: ${error.message}`));
  }
}

function connectSession({ session: id, token }) {
  const session = current;
  if (!session || session.id !== id || session.cancelled) return;

  const params = new URLSearchParams({
    sample_rate: String(TARGET_SAMPLE_RATE),
    encoding: 'pcm_s16le',
    format_turns: 'true',
    speech_model: 'u3-rt-pro',
    token,
  });

  const ws = new WebSocket(`${WS_BASE_URL}?${params}`);
  ws.binaryType = 'arraybuffer';
  session.ws = ws;

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') handleSocketMessage(session, event.data);
  };
  ws.onerror = () => failSession(session, new Error('Transcription connection failed.'));
  ws.onclose = () => {
    if (session.delivered || session.cancelled) return;
    if (session.finishing) deliverFinal(session);
    else failSession(session, new Error('Transcription connection closed unexpectedly.'));
  };
}

function stopSession({ session: id }) {
  const session = current;
  if (!session || session.id !== id || session.cancelled) return;

  session.finishing = true;
  releaseMic(session);
  window.clickyAudio.send('audio:level', 0);

  if (session.ready) requestFinalTranscript(session);
  // Covers a websocket that never became ready (slow token, network trouble).
  session.fallbackTimer = setTimeout(() => deliverFinal(session), FINAL_FALLBACK_MS);
}

function cancelSession() {
  const session = current;
  if (!session) return;
  session.cancelled = true;
  clearTimeout(session.graceTimer);
  clearTimeout(session.fallbackTimer);
  releaseMic(session);
  closeSocket(session);
  current = null;
  window.clickyAudio.send('audio:level', 0);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

let player = null;
let playerUrl = null;

function stopPlayback() {
  if (player) {
    player.onended = null;
    player.onerror = null;
    player.pause();
    player = null;
  }
  if (playerUrl) {
    URL.revokeObjectURL(playerUrl);
    playerUrl = null;
  }
  window.speechSynthesis.cancel();
}

function playMp3({ mp3 }) {
  stopPlayback();
  playerUrl = URL.createObjectURL(new Blob([mp3], { type: 'audio/mpeg' }));
  player = new Audio(playerUrl);
  player.onplaying = () => window.clickyAudio.send('audio:playback-started');
  player.onended = () => {
    stopPlayback();
    window.clickyAudio.send('audio:playback-ended');
  };
  player.onerror = () => {
    stopPlayback();
    window.clickyAudio.send('audio:playback-ended');
  };
  player.play().catch(() => window.clickyAudio.send('audio:playback-ended'));
}

/** Windows system voice, used when the cloud TTS call fails. */
function speakFallback({ text }) {
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

window.clickyAudio.on('audio:start', startSession);
window.clickyAudio.on('audio:connect', connectSession);
window.clickyAudio.on('audio:stop', stopSession);
window.clickyAudio.on('audio:cancel', cancelSession);
window.clickyAudio.on('audio:play', playMp3);
window.clickyAudio.on('audio:stop-playback', stopPlayback);
window.clickyAudio.on('audio:speak-fallback', speakFallback);
