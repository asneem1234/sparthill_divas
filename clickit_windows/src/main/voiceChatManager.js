// Hands-free voice chat (speech-to-speech) with Gemini Live.
//
// The chat is just a small floating pink icon: no window to read, nothing to click through.
// The icon's page (renderer/voice.js) owns the microphone, the WebSocket and the speaker.
// The WebSocket goes to the worker's /live route, which adds the API key, so no key is ever
// in this app. This class opens and closes the icon, hands it its settings, and answers
// its request to look at the screen.
//
// The AI answers out loud. When the user asks about their screen, Gemini calls a
// `look_at_screen` tool. Only then is the screen captured, read on this PC for passwords and
// other secrets, and sent as a one-time screenshot, and only if nothing private was found.
// Nothing is streamed and nothing is captured when the user doesn't ask about the screen.

const path = require('path');
const { BrowserWindow, Menu, Notification, ipcMain, screen } = require('electron');

const { captureAllScreensAsJpeg } = require('./capture');
const { filterScreenCapturesForPrivacy } = require('./privacyFilter');

// The icon is 52 px; the rest is room for its glow and the drop shadow.
const ICON_WINDOW_SIZE = 84;
const SCREEN_EDGE_MARGIN = 20;
const MAXIMUM_SCREENSHOTS_PER_LOOK = 3;

/**
 * Live models tried in order. All four connected on the free tier when tested; a preview
 * model can be retired at any time, so the icon falls back to the next one on failure.
 */
const LIVE_MODELS = [
  'models/gemini-3.1-flash-live-preview',
  'models/gemini-2.5-flash-native-audio-latest',
  'models/gemini-3.8-live',
  'models/gemini-2.5-flash-native-audio-preview-12-2025',
];

const VOICES = ['Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];
const DEFAULT_VOICE = 'Aoede';

const VOICE_CHAT_SYSTEM_PROMPT = [
  'You are Click It, a friendly AI living in the user\'s cursor, having a spoken conversation.',
  'Talk like a person: one to three short sentences, plain words, no lists, no markdown, no emoji.',
  'Be warm and a little playful. If the user wants more detail they will ask.',
  'You cannot see the screen on your own. Whenever the user asks about their screen, a window, or anything they are looking at,',
  'call look_at_screen first. Never guess what is on the screen.',
  'After you call it, you get a short reply, then the screenshot arrives as a picture. Until the user tells you the picture is in front of you,',
  'say only "Let me look." and nothing else. Then answer using only what is visible in the picture.',
  'If the tool says the screen was not shared because it may be private, tell the user kindly that you did not look and that they can close the private window and ask again.',
  'A screenshot is a single moment, not live video: for a changed screen, call look_at_screen again.',
  'Reply in the language the user speaks.',
].join(' ');

/** http(s) worker URL -> ws(s) URL of its /live route. Returns null if the URL is unusable. */
function buildLiveUrl(workerBaseUrl) {
  try {
    const url = new URL(String(workerBaseUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/live`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (error) {
    return null;
  }
}

class VoiceChatManager {
  /**
   * @param {object} dependencies
   * @param {import('./settings').SettingsStore} dependencies.settings
   * @param {import('./ocr/ocrService').OcrService} dependencies.ocrService
   * @param {() => Promise<object[]>} [dependencies.captureScreens] replaceable for tests
   */
  constructor({ settings, ocrService, captureScreens }) {
    this.settings = settings;
    this.ocrService = ocrService;
    this.captureScreens = captureScreens || captureAllScreensAsJpeg;
    this.iconWindow = null;
    this.isLookingAtScreen = false;
    /** Called with true when a chat starts and false when it ends. */
    this.onActiveChanged = () => {};

    ipcMain.handle('voice:get-config', (event) => (this.isFromIcon(event) ? this.buildConfig() : null));
    ipcMain.handle('voice:look-at-screen', (event) => (this.isFromIcon(event) ? this.lookAtScreen() : { images: [], reasons: [] }));
    ipcMain.on('voice:close', (event) => {
      if (this.isFromIcon(event)) this.stop();
    });
    ipcMain.on('voice:error', (event, message) => {
      if (this.isFromIcon(event)) this.showErrorNotification(String(message || '').slice(0, 300));
    });
    ipcMain.on('voice:move', (event, delta) => {
      if (!this.isFromIcon(event) || !delta) return;
      const deltaX = Number(delta.dx);
      const deltaY = Number(delta.dy);
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
      const [x, y] = this.iconWindow.getPosition();
      this.iconWindow.setPosition(Math.round(x + deltaX), Math.round(y + deltaY));
    });
    ipcMain.on('voice:context-menu', (event, iconState) => {
      if (this.isFromIcon(event)) this.popUpMenu(iconState || {});
    });
  }

  get isActive() {
    return Boolean(this.iconWindow && !this.iconWindow.isDestroyed());
  }

  isFromIcon(event) {
    return this.isActive && event.sender === this.iconWindow.webContents;
  }

  buildConfig() {
    const savedVoice = this.settings.get('liveVoiceName');
    return {
      liveUrl: buildLiveUrl(this.settings.get('workerBaseUrl')),
      workerBaseUrl: this.settings.get('workerBaseUrl'),
      models: LIVE_MODELS,
      voiceName: VOICES.includes(savedVoice) ? savedVoice : DEFAULT_VOICE,
      systemPrompt: VOICE_CHAT_SYSTEM_PROMPT,
      debug: process.env.CLICKIT_VOICE_DEBUG === '1',
    };
  }

  // MARK: Looking at the screen

  /**
   * Captures the screens and checks them on this PC. Anything that looks private (or a check
   * that couldn't run) means that screen is not sent. There is nobody to ask "send anyway?"
   * mid-conversation, so this is the strict version of the check.
   * @returns {Promise<{images: string[], reasons: string[], failed?: boolean}>} base64 JPEGs of the screens that are safe to send
   */
  async lookAtScreen() {
    if (this.isLookingAtScreen) return { images: [], reasons: [], failed: true };
    this.isLookingAtScreen = true;
    try {
      const screenCaptures = (await this.captureScreens()).slice(0, MAXIMUM_SCREENSHOTS_PER_LOOK);
      const { sendableCaptures, withheldCaptures } = await filterScreenCapturesForPrivacy({
        ocrService: this.ocrService,
        screenCaptures,
      });
      const reasons = [...new Set(withheldCaptures.flatMap((withheld) => withheld.reasons))].slice(0, 4);
      if (withheldCaptures.length > 0) console.log(`[ClickIt] Voice chat withheld ${withheldCaptures.length} screen(s): ${reasons.join('; ')}`);
      return { images: sendableCaptures.map((capture) => capture.imageBuffer.toString('base64')), reasons };
    } catch (error) {
      console.error('[ClickIt] Voice chat could not capture the screen:', error.message);
      return { images: [], reasons: [], failed: true };
    } finally {
      this.isLookingAtScreen = false;
    }
  }

  // MARK: The icon

  /** Shows the icon and starts listening. Does nothing if a chat is already running. */
  start() {
    if (this.isActive) return;

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const workArea = display.workArea;
    const iconWindow = new BrowserWindow({
      x: workArea.x + workArea.width - ICON_WINDOW_SIZE - SCREEN_EDGE_MARGIN,
      y: workArea.y + workArea.height - ICON_WINDOW_SIZE - SCREEN_EDGE_MARGIN,
      width: ICON_WINDOW_SIZE,
      height: ICON_WINDOW_SIZE,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true, // no taskbar tab, it is only an icon
      focusable: false, // never steals focus from the app the user is working in
      hasShadow: false,
      fullscreenable: false,
      show: false,
      title: 'Click It voice chat',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'voice.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The conversation must keep flowing while the user works in another app.
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });

    iconWindow.setAlwaysOnTop(true, 'screen-saver');
    // The icon must never show up in the screenshots Gemini is given.
    iconWindow.setContentProtection(true);
    iconWindow.loadFile(path.join(__dirname, '..', 'renderer', 'voice.html'));
    iconWindow.once('ready-to-show', () => {
      if (!iconWindow.isDestroyed()) iconWindow.showInactive();
    });
    iconWindow.on('closed', () => {
      if (this.iconWindow === iconWindow) {
        this.iconWindow = null;
        this.onActiveChanged(false);
      }
    });

    this.iconWindow = iconWindow;
    this.onActiveChanged(true);
  }

  /** Ends the chat: closing the icon drops the connection and releases the microphone. */
  stop() {
    const iconWindow = this.iconWindow;
    if (!iconWindow) return;
    this.iconWindow = null;
    if (!iconWindow.isDestroyed()) iconWindow.destroy();
    this.onActiveChanged(false);
  }

  toggle() {
    if (this.isActive) this.stop();
    else this.start();
  }

  sendCommand(commandName) {
    if (this.isActive) this.iconWindow.webContents.send('voice:command', commandName);
  }

  /** Right-click menu on the icon. Changing the voice starts a new conversation. */
  popUpMenu(iconState) {
    if (!this.isActive) return;
    const savedVoice = this.settings.get('liveVoiceName');
    const menuTemplate = [
      { label: iconState.isMuted ? 'Unmute microphone' : 'Mute microphone', click: () => this.sendCommand('toggle-mute') },
      { label: iconState.hasError ? 'Reconnect' : 'Start a fresh conversation', click: () => this.sendCommand('restart') },
      {
        label: 'Voice',
        submenu: VOICES.map((voiceName) => ({
          label: voiceName,
          type: 'radio',
          checked: voiceName === savedVoice,
          click: () => {
            this.settings.set('liveVoiceName', voiceName);
            this.sendCommand('restart');
          },
        })),
      },
      { type: 'separator' },
      { label: 'End voice chat', click: () => this.stop() },
    ];
    Menu.buildFromTemplate(menuTemplate).popup({ window: this.iconWindow });
  }

  /** Problems are shown as a notification; the icon itself just turns grey. */
  showErrorNotification(message) {
    if (!message) return;
    console.warn(`[ClickIt] Voice chat: ${message}`);
    try {
      if (Notification.isSupported()) new Notification({ title: 'Click It voice chat', body: message }).show();
    } catch (error) {
      /* the icon still shows the error state */
    }
  }
}

module.exports = { VoiceChatManager, buildLiveUrl, LIVE_MODELS, VOICES, DEFAULT_VOICE };
