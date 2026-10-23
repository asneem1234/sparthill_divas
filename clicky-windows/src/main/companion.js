'use strict';

const { EventEmitter } = require('events');
const settings = require('./settings');
const { COMPANION_SYSTEM_PROMPT } = require('./prompt');
const { parsePointingCoordinates } = require('./pointTag');
const { captureAllScreens, screenshotPointToGlobal } = require('./capture');
const worker = require('./worker');

const MAX_HISTORY_EXCHANGES = 10;

/**
 * Central state machine: idle -> listening -> processing -> responding -> idle.
 * Mirrors CompanionManager in the macOS app.
 */
class Companion extends EventEmitter {
  /**
   * @param {{overlay: import('./overlay').Overlay, sendToAudio: (channel: string, payload?: any) => void}} deps
   */
  constructor({ overlay, sendToAudio }) {
    super();
    this.overlay = overlay;
    this.sendToAudio = sendToAudio;
    this.state = 'idle';
    this.sessionId = 0;
    this.history = [];
    this.abortController = null;
    this.lastTranscript = '';
    this.lastResponse = '';
    this.lastError = '';
  }

  getStatus() {
    return {
      state: this.state,
      transcript: this.lastTranscript,
      response: this.lastResponse,
      error: this.lastError,
    };
  }

  setState(state) {
    this.state = state;
    this.overlay.setMode(state);
    this.emit('status', this.getStatus());
  }

  /** Cancels any in-flight request, recording, or playback. */
  interrupt() {
    this.sessionId += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.sendToAudio('audio:cancel');
    this.sendToAudio('audio:stop-playback');
  }

  // --- Push to talk -------------------------------------------------------

  async startListening() {
    if (this.state === 'listening') return;
    this.interrupt();
    const session = this.sessionId;
    this.lastError = '';
    this.setState('listening');

    // Start the mic right away; the websocket connects once the token arrives.
    this.sendToAudio('audio:start', { session });
    try {
      const token = await worker.fetchTranscriptionToken();
      if (session !== this.sessionId) return;
      this.sendToAudio('audio:connect', { session, token });
    } catch (error) {
      if (session !== this.sessionId) return;
      this.fail(error);
    }
  }

  stopListening() {
    if (this.state !== 'listening') return;
    this.setState('processing');
    this.sendToAudio('audio:stop', { session: this.sessionId });
  }

  /** Called when the audio window reports a final transcript. */
  handleTranscript({ session, text }) {
    if (session !== this.sessionId || this.state !== 'processing') return;
    const transcript = (text || '').trim();
    if (!transcript) {
      this.setState('idle');
      return;
    }
    this.respondTo(transcript);
  }

  handleAudioError({ session, message }) {
    if (session !== this.sessionId) return;
    this.fail(new Error(message));
  }

  handlePlaybackStarted() {
    if (this.state === 'processing') this.setState('responding');
  }

  handlePlaybackEnded() {
    if (this.state === 'responding') this.setState('idle');
  }

  /** Typed question from the panel (no mic involved). */
  ask(text) {
    const transcript = (text || '').trim();
    if (!transcript || this.state === 'listening') return;
    this.interrupt();
    this.lastError = '';
    this.setState('processing');
    this.respondTo(transcript);
  }

  // --- Response pipeline --------------------------------------------------

  async respondTo(transcript) {
    const session = this.sessionId;
    const abortController = new AbortController();
    this.abortController = abortController;
    const isStale = () => session !== this.sessionId || abortController.signal.aborted;

    this.lastTranscript = transcript;
    this.lastResponse = '';
    this.emit('status', this.getStatus());

    try {
      const captures = await captureAllScreens();
      if (isStale()) return;

      const fullResponse = await worker.streamChat({
        model: settings.load().model,
        systemPrompt: COMPANION_SYSTEM_PROMPT,
        history: this.history,
        images: captures.map((capture) => ({ data: capture.jpeg, label: capture.label })),
        userPrompt: transcript,
        signal: abortController.signal,
      });
      if (isStale()) return;

      const parsed = parsePointingCoordinates(fullResponse);
      this.lastResponse = parsed.spokenText;

      if (parsed.coordinate) {
        const target =
          (parsed.screenNumber && captures[parsed.screenNumber - 1]) ||
          captures.find((capture) => capture.isCursorScreen) ||
          captures[0];
        this.overlay.pointTo(screenshotPointToGlobal(target, parsed.coordinate), parsed.label);
      }

      this.history.push({ userTranscript: transcript, assistantResponse: parsed.spokenText });
      if (this.history.length > MAX_HISTORY_EXCHANGES) {
        this.history.splice(0, this.history.length - MAX_HISTORY_EXCHANGES);
      }
      this.emit('status', this.getStatus());

      if (!parsed.spokenText) {
        this.setState('idle');
        return;
      }

      const mp3 = await worker.synthesizeSpeech(parsed.spokenText, abortController.signal);
      if (isStale()) return;
      this.sendToAudio('audio:play', { session, mp3 });
      // State flips to "responding" when the audio window reports playback started.
    } catch (error) {
      if (isStale() || error.name === 'AbortError') return;
      this.fail(error);
    }
  }

  fail(error) {
    console.error('[companion]', error);
    this.lastError = error.message || String(error);
    this.sendToAudio('audio:cancel');
    this.sendToAudio('audio:speak-fallback', {
      text: 'sorry, something went wrong. check the clicky panel for details.',
    });
    this.setState('idle');
  }
}

module.exports = { Companion };
