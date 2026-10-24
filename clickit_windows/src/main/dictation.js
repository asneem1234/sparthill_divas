// Push-to-talk voice pipeline. Port of BuddyDictationManager (keyboard shortcut path).
//
// Press   -> open the mic and buffer 16 kHz mono PCM16 audio
// Release -> stop the mic, upload the recording as a WAV to the worker, and hand
//            the finalized transcript to the submit callback.
//
// Like the macOS OpenAI upload provider, audio is transcribed after release rather
// than streamed live, because the repo's worker transcribes complete recordings.

const { EventEmitter } = require('events');
const { systemPreferences } = require('electron');
const { describeWorkerError } = require('./worker');

const TARGET_SAMPLE_RATE = 16000;
// Recordings shorter than this are accidental taps. Sending them to a speech model
// invites made-up transcripts, so they are treated as silence.
const MINIMUM_RECORDING_SECONDS = 0.25;

// The loudest 50 ms window of a real utterance sits well above this (speech is
// typically 0.04 - 0.2 RMS). Room noise stays below it: a quiet laptop mic
// measured about 0.011 of background noise.
const SILENCE_RMS_THRESHOLD = 0.02;
const SILENCE_ANALYSIS_WINDOW_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.05);

/**
 * True when no part of the recording is louder than background noise. Speech models
 * invent text for silent audio, so silent recordings must never be uploaded.
 */
function isRecordingEffectivelySilent(pcm16AudioBuffer) {
  const totalSampleCount = Math.floor(pcm16AudioBuffer.length / 2);
  for (let windowStart = 0; windowStart < totalSampleCount; windowStart += SILENCE_ANALYSIS_WINDOW_SAMPLES) {
    const windowEnd = Math.min(windowStart + SILENCE_ANALYSIS_WINDOW_SAMPLES, totalSampleCount);
    let sumOfSquares = 0;
    for (let sampleIndex = windowStart; sampleIndex < windowEnd; sampleIndex += 1) {
      const normalizedSample = pcm16AudioBuffer.readInt16LE(sampleIndex * 2) / 32768;
      sumOfSquares += normalizedSample * normalizedSample;
    }
    const windowRms = Math.sqrt(sumOfSquares / Math.max(windowEnd - windowStart, 1));
    if (windowRms >= SILENCE_RMS_THRESHOLD) return false;
  }
  return true;
}

/** Wraps raw PCM16 mono audio in a 44-byte WAV header. */
function buildWavFileFromPcm16Mono(pcm16AudioBuffer, sampleRate) {
  const bytesPerSample = 2;
  const channelCount = 1;
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + pcm16AudioBuffer.length, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16); // PCM chunk size
  wavHeader.writeUInt16LE(1, 20); // PCM format
  wavHeader.writeUInt16LE(channelCount, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  wavHeader.writeUInt16LE(channelCount * bytesPerSample, 32);
  wavHeader.writeUInt16LE(bytesPerSample * 8, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(pcm16AudioBuffer.length, 40);
  return Buffer.concat([wavHeader, pcm16AudioBuffer]);
}

class DictationManager extends EventEmitter {
  /**
   * @param {import('./audioBridge').AudioBridge} audioBridge
   * @param {import('./worker').WorkerClient} workerClient
   */
  constructor(audioBridge, workerClient) {
    super();
    this.audioBridge = audioBridge;
    this.workerClient = workerClient;

    this.isPreparingToRecord = false;
    this.isRecordingFromKeyboardShortcut = false;
    this.isFinalizingTranscript = false;
    this.lastErrorMessage = null;

    // Bumped on every press/release so a slow mic start can tell it was superseded.
    this.currentStartRequestIdentifier = 0;
    this.transcriptionAbortController = null;
  }

  get isDictationInProgress() {
    return this.isPreparingToRecord || this.isRecordingFromKeyboardShortcut || this.isFinalizingTranscript;
  }

  emitChange() {
    this.emit('change');
  }

  /** @param {(finalTranscript: string) => void} submitDraftText */
  async startPushToTalkFromKeyboardShortcut(submitDraftText) {
    if (this.isDictationInProgress) return;

    this.currentStartRequestIdentifier += 1;
    const startRequestIdentifier = this.currentStartRequestIdentifier;
    this.submitDraftText = submitDraftText;
    this.lastErrorMessage = null;
    this.isPreparingToRecord = true;
    this.emitChange();

    if (systemPreferences.getMediaAccessStatus('microphone') === 'denied') {
      this.lastErrorMessage = 'Microphone access is turned off. Enable it in Windows Settings > Privacy > Microphone.';
      this.isPreparingToRecord = false;
      this.emitChange();
      return;
    }

    try {
      await this.audioBridge.startRecording();
    } catch (error) {
      console.error('[ClickIt] Failed to start recording:', error.message);
      this.lastErrorMessage = "couldn't start voice input. try again.";
      this.isPreparingToRecord = false;
      this.emitChange();
      return;
    }

    // The key was released (or a newer press arrived) while the mic was starting.
    if (this.currentStartRequestIdentifier !== startRequestIdentifier) {
      await this.audioBridge.cancelRecording();
      this.isPreparingToRecord = false;
      this.emitChange();
      return;
    }

    this.isPreparingToRecord = false;
    this.isRecordingFromKeyboardShortcut = true;
    this.emitChange();
  }

  stopPushToTalkFromKeyboardShortcut() {
    // Invalidates any start that is still waiting on the mic.
    this.currentStartRequestIdentifier += 1;

    if (!this.isRecordingFromKeyboardShortcut) {
      return;
    }
    if (this.isFinalizingTranscript) return;

    this.isRecordingFromKeyboardShortcut = false;
    this.isFinalizingTranscript = true;
    this.emitChange();

    this.finalizeRecording().catch((error) => {
      console.error('[ClickIt] Finalizing the recording failed:', error);
    });
  }

  async finalizeRecording() {
    let finalTranscriptText = '';

    try {
      const pcm16AudioBuffer = await this.audioBridge.stopRecording();
      const recordedSeconds = pcm16AudioBuffer.length / 2 / TARGET_SAMPLE_RATE;

      if (recordedSeconds >= MINIMUM_RECORDING_SECONDS && isRecordingEffectivelySilent(pcm16AudioBuffer)) {
        console.log('[ClickIt] Recording was silent, not sending it for transcription.');
      } else if (recordedSeconds >= MINIMUM_RECORDING_SECONDS) {
        this.transcriptionAbortController = new AbortController();
        const wavAudioBuffer = buildWavFileFromPcm16Mono(pcm16AudioBuffer, TARGET_SAMPLE_RATE);
        finalTranscriptText = await this.workerClient.transcribeWavAudio(
          wavAudioBuffer,
          this.transcriptionAbortController.signal
        );
      }
    } catch (error) {
      if (!this.isFinalizingTranscript) return; // cancelled
      console.error('[ClickIt] Transcription error:', error.message);
      this.lastErrorMessage = describeWorkerError(error, this.workerClient.getWorkerBaseUrl());
      finalTranscriptText = '';
    }

    // Cancelled while the upload was in flight.
    if (!this.isFinalizingTranscript) return;
    this.transcriptionAbortController = null;

    // Submit BEFORE clearing the finalizing flag so the companion marks its response
    // as in flight first and doesn't treat the gap as an idle moment.
    const submitDraftText = this.submitDraftText;
    this.submitDraftText = null;
    if (finalTranscriptText && submitDraftText) {
      submitDraftText(finalTranscriptText);
    }

    this.isFinalizingTranscript = false;
    this.emitChange();
  }

  cancelCurrentDictation() {
    this.currentStartRequestIdentifier += 1;

    if (this.transcriptionAbortController) {
      this.transcriptionAbortController.abort();
      this.transcriptionAbortController = null;
    }

    const wasRecording = this.isRecordingFromKeyboardShortcut;
    this.isPreparingToRecord = false;
    this.isRecordingFromKeyboardShortcut = false;
    this.isFinalizingTranscript = false;
    this.submitDraftText = null;
    if (wasRecording) this.audioBridge.cancelRecording();
    this.emitChange();
  }
}

module.exports = { DictationManager, buildWavFileFromPcm16Mono, isRecordingEffectivelySilent };
