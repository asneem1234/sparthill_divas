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
 * Voice: the audio window records a clip, the Worker transcribes it with
 * Gemini, and the reply is spoken with the Windows system voice.
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

  // --- Voice ----------------------------------------------------------------

  startListening() {
    if (this.state === 'listening') return;
    this.interrupt();
    this.lastError = '';
    this.setState('listening');
    this.sendToAudio('audio:start', { session: this.sessionId });
  }

  stopListening() {
    if (this.state !== 'listening') return;
    this.setState('processing');
    this.sendToAudio('audio:stop', { session: this.sessionId });
  }

  toggleListening() {
    console.log(`[companion] toggle voice (state=${this.state})`);
    if (this.state === 'listening') this.stopListening();
    else this.startListening();
  }

  /** Called when the audio window delivers a recorded clip. */
  async handleRecording({ session, data, mime }) {
    if (session !== this.sessionId) return;
    if (this.state === 'listening') this.setState('processing'); // auto-stopped by the recorder
    if (this.state !== 'processing') return;

    if (!data) {
      this.setState('idle');
      return;
    }

    const abortController = new AbortController();
    this.abortController = abortController;
    try {
      console.log(`[companion] transcribing ${mime} clip (${Math.round(data.length * 0.75 / 1024)} KB)`);
      const text = (await worker.transcribe({ data, mime, signal: abortController.signal })).trim();
      console.log(`[companion] transcript: "${text}"`);
      if (session !== this.sessionId || abortController.signal.aborted) return;
      if (!text) {
        this.setState('idle');
        return;
      }
      await this.respondTo(text);
    } catch (error) {
      if (session !== this.sessionId || error.name === 'AbortError') return;
      this.fail(error);
    }
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

  // --- Typed / menu questions -------------------------------------------------

  /**
   * Ask a question. Pass `captures` to answer about specific images
   * (for example a selected region) instead of capturing every screen.
   */
  ask(text, captures) {
    const transcript = (text || '').trim();
    if (!transcript || this.state === 'listening') return;
    this.interrupt();
    this.lastError = '';
    this.setState('processing');
    this.respondTo(transcript, captures);
  }

  // --- Response pipeline --------------------------------------------------

  async respondTo(transcript, providedCaptures) {
    const session = this.sessionId;
    const abortController = new AbortController();
    this.abortController = abortController;
    const isStale = () => session !== this.sessionId || abortController.signal.aborted;

    this.lastTranscript = transcript;
    this.lastResponse = '';
    this.emit('status', this.getStatus());

    try {
      const captures = providedCaptures || (await captureAllScreens());
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
      console.log(`[companion] reply (${captures.length} image(s)): ${parsed.spokenText.slice(0, 200)}`);

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

      this.setState('responding');
      this.sendToAudio('audio:speak', { session, text: parsed.spokenText });
    } catch (error) {
      if (isStale() || error.name === 'AbortError') return;
      this.fail(error);
    }
  }

  fail(error) {
    console.error('[companion]', error);
    this.lastError = error.message || String(error);
    this.sendToAudio('audio:cancel');
    this.sendToAudio('audio:speak', {
      text: 'sorry, something went wrong. check the ClickIt panel for details.',
    });
    this.setState('idle');
  }
}

module.exports = { Companion };
