// Bridge to the hidden "audio" window. Microphone capture and text-to-speech
// playback need Chromium media APIs, so they run in a hidden renderer and are
// driven from the main process with small request/response messages.

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('events');

class AudioBridge extends EventEmitter {
  constructor() {
    super();
    this.audioWindow = null;
    this.nextRequestIdentifier = 1;
    this.pendingRequests = new Map();
    this.isTextToSpeechPlaying = false;

    ipcMain.on('audio:response', (event, response) => {
      const pendingRequest = this.pendingRequests.get(response.requestIdentifier);
      if (!pendingRequest) return;
      this.pendingRequests.delete(response.requestIdentifier);
      if (response.errorMessage) {
        pendingRequest.reject(new Error(response.errorMessage));
      } else {
        pendingRequest.resolve(response.result);
      }
    });

    ipcMain.on('audio:level', (event, audioPowerLevel) => {
      this.emit('audioPowerLevel', audioPowerLevel);
    });

    ipcMain.on('audio:tts-state', (event, isPlaying) => {
      this.isTextToSpeechPlaying = Boolean(isPlaying);
      this.emit('textToSpeechPlaybackChanged', this.isTextToSpeechPlaying);
    });
  }

  /** Creates the hidden window and waits for it to finish loading. */
  async create() {
    this.audioWindow = new BrowserWindow({
      show: false,
      width: 100,
      height: 100,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'audio.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The mic stream and speech must keep running while the window is hidden.
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    await this.audioWindow.loadFile(path.join(__dirname, '..', 'renderer', 'audio.html'));
  }

  destroy() {
    if (this.audioWindow && !this.audioWindow.isDestroyed()) this.audioWindow.destroy();
    this.audioWindow = null;
  }

  /** Sends a command to the audio window and resolves with its reply. */
  sendRequest(commandName, payload) {
    if (!this.audioWindow || this.audioWindow.isDestroyed()) {
      return Promise.reject(new Error('Audio window is not available'));
    }
    const requestIdentifier = this.nextRequestIdentifier;
    this.nextRequestIdentifier += 1;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestIdentifier, { resolve, reject });
      this.audioWindow.webContents.send('audio:request', { requestIdentifier, commandName, payload });
    });
  }

  // MARK: Microphone

  /** Opens the mic and starts buffering 16 kHz mono PCM16 audio. */
  startRecording() {
    return this.sendRequest('start-recording');
  }

  /** Stops recording and returns the buffered PCM16 audio as a Buffer. */
  async stopRecording() {
    const pcm16Bytes = await this.sendRequest('stop-recording');
    return Buffer.from(pcm16Bytes);
  }

  cancelRecording() {
    return this.sendRequest('cancel-recording').catch(() => {});
  }

  /** Opens and immediately closes the mic. Resolves true if the OS allowed it. */
  async probeMicrophoneAccess() {
    try {
      return Boolean(await this.sendRequest('probe-microphone'));
    } catch (error) {
      return false;
    }
  }

  // MARK: Speech

  /** Plays MP3 audio. Resolves once playback has started. */
  playSpeechAudio(mp3Buffer) {
    return this.sendRequest('play-audio', mp3Buffer);
  }

  /** Speaks text with the Windows system voice. Resolves once speech has started. */
  speakWithSystemVoice(textToSpeak) {
    return this.sendRequest('speak-system-voice', textToSpeak);
  }

  stopSpeech() {
    return this.sendRequest('stop-speech').catch(() => {});
  }
}

module.exports = { AudioBridge };
