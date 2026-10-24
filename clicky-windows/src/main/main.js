'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  nativeImage,
  ipcMain,
  screen,
  session,
} = require('electron');
const settings = require('./settings');
const { Overlay } = require('./overlay');
const { Companion } = require('./companion');
const { registerHotkeys } = require('./radialHotkey');
const { RadialMenu } = require('./radialMenu');
const { ScreenshotSelector } = require('./screenshotSelector');
const { captureAllScreens, captureRegion } = require('./capture');
const { Snap } = require('./snap');
const { Reminders } = require('./reminders');
const { RemindersWindow } = require('./remindersWindow');

// Windows needs an app id to show toast notifications. When running unpackaged
// (npm start) the id has to be the Electron executable path.
app.setAppUserModelId(app.isPackaged ? 'com.clickit.app' : process.execPath);

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const PANEL_SIZE = { width: 360, height: 680 };

let tray = null;
let panelWindow = null;
let audioWindow = null;
let overlay = null;
let companion = null;
let hotkeys = null;
let radialMenu = null;
let screenshotSelector = null;
let snap = null;
let reminders = null;
let remindersWindow = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => showPanel());
app.on('window-all-closed', () => {
  // Tray app: keep running with no windows open.
});

function sendToAudio(channel, payload) {
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.webContents.send(channel, payload);
  }
}

function sendToPanel(channel, payload) {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send(channel, payload);
  }
}

function createAudioWindow() {
  audioWindow = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'audio.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  audioWindow.loadFile(path.join(__dirname, '..', 'renderer', 'audio.html'));
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: PANEL_SIZE.width,
    height: PANEL_SIZE.height,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'panel.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));
  panelWindow.on('blur', () => {
    if (!panelWindow.webContents.isDevToolsOpened()) panelWindow.hide();
  });
}

function positionPanelNearTray() {
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const { workArea } = display;
  const height = Math.min(PANEL_SIZE.height, workArea.height - 16);
  panelWindow.setSize(PANEL_SIZE.width, height);

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - PANEL_SIZE.width / 2);
  let y = Math.round(trayBounds.y - height - 8);
  if (y < workArea.y) y = Math.round(trayBounds.y + trayBounds.height + 8); // taskbar on top

  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - PANEL_SIZE.width - 8));
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - height - 8));
  panelWindow.setPosition(x, y);
}

function showPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  positionPanelNearTray();
  panelWindow.show();
  panelWindow.focus();
}

function openRadialMenu() {
  console.log('[main] openRadialMenu');
  if (!radialMenu || radialMenu.isVisible()) return;
  radialMenu.show(handleRadialAction);
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('ClickIt');
  tray.on('click', () => {
    if (panelWindow.isVisible()) panelWindow.hide();
    else showPanel();
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open ClickIt panel', click: () => showPanel() },
      { label: 'Open radial menu', click: () => openRadialMenu() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function applyCursorSettings(current) {
  overlay.setEnabled(current.showCursor);
  overlay.setCursorSettings({
    color: current.cursorColor,
    size: current.cursorSize,
    glow: current.cursorGlow,
  });
}

/** Shows a Windows toast and also says it aloud, in case notifications are muted (Focus Assist). */
function notifyUser(title, body) {
  console.log(`[notify] ${title}: ${body.replace(/\n/g, ' | ')}`);
  if (process.env.CLICKIT_DEBUG) {
    // Lets a test script know exactly when a notification fired.
    require('fs').appendFileSync(
      require('path').join(require('os').homedir(), 'clickit-notify.log'),
      `${new Date().toISOString()} ${title}: ${body.replace(/\n/g, ' | ')}\n`
    );
  }
  if (Notification.isSupported()) {
    const toast = new Notification({ title, body });
    toast.on('show', () => console.log('[notify] toast shown'));
    toast.on('failed', (_event, error) => console.log(`[notify] toast failed: ${error}`));
    toast.show();
  } else {
    console.log('[notify] notifications are not supported on this system');
  }
  sendToAudio('audio:speak', { text: title === 'ClickIt reminder' ? `Reminder: ${body}` : title });
}

/** Drag a rectangle, then capture that region and hand it to `done`. */
function selectRegion(done) {
  screenshotSelector.show(async (display, rect) => {
    try {
      const capture = await captureRegion(display, rect);
      console.log(`[main] captured region ${capture.screenshotWidth}x${capture.screenshotHeight}`);
      done(capture);
    } catch (error) {
      companion.fail(error);
    }
  });
}

function handleRadialAction(action) {
  console.log(`[main] action: ${action}`);
  switch (action) {
    case 'screenshot':
      // Let the menu window disappear before capturing the screen.
      setTimeout(async () => {
        try {
          const [cursorScreen] = await captureAllScreens();
          snap.open('ask', cursorScreen);
        } catch (error) {
          companion.fail(error);
        }
      }, 150);
      break;
    case 'select-area':
      selectRegion((capture) => snap.open('ask', capture));
      break;
    case 'translate':
      selectRegion((capture) => snap.open('translate', capture));
      break;
    case 'reminders':
      remindersWindow.open();
      break;
    case 'voice':
      companion.startListening();
      break;
    case 'settings':
      showPanel();
      break;
    default:
      break;
  }
}

function registerIpc() {
  // Audio window -> main
  ipcMain.on('audio:recorded', (_event, payload) => companion.handleRecording(payload));
  ipcMain.on('audio:error', (_event, payload) => companion.handleAudioError(payload));
  ipcMain.on('audio:level', (_event, level) => overlay.setAudioLevel(Number(level) || 0));
  ipcMain.on('audio:playback-started', () => companion.handlePlaybackStarted());
  ipcMain.on('audio:playback-ended', () => companion.handlePlaybackEnded());

  // Panel <-> main
  ipcMain.handle('panel:get-state', () => ({
    settings: settings.load(),
    status: companion.getStatus(),
    hotkeyMode: hotkeys?.mode ?? 'none',
  }));
  ipcMain.handle('panel:save-settings', (_event, patch) => {
    const next = settings.update(settings.sanitize(patch || {}));
    applyCursorSettings(next);
    return next;
  });
  ipcMain.on('panel:ask', (_event, text) => companion.ask(String(text || '')));
  ipcMain.on('panel:quit', () => app.quit());
  ipcMain.on('panel:action', (_event, action) => {
    // Close the panel first so the radial menu / selector can take focus.
    panelWindow.hide();
    if (action === 'menu') openRadialMenu();
    else if (action === 'voice') companion.toggleListening();
    else if (['screenshot', 'select-area', 'translate', 'reminders'].includes(action)) {
      handleRadialAction(action);
    }
  });

  // Radial menu -> main
  ipcMain.on('radial:select', (_event, action) => {
    console.log(`[radial] select ${action}`);
    radialMenu.handleSelect(action);
  });
  ipcMain.on('radial:close', () => {
    console.log('[radial] close (clicked outside a gem)');
    radialMenu.close();
  });

  // Area selector -> main
  ipcMain.on('selector:capture', (_event, rect) => screenshotSelector.handleCapture(rect));
  ipcMain.on('selector:cancel', () => screenshotSelector.close());
}

app.whenReady().then(() => {
  // Only our own audio page may use the microphone.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && webContents === audioWindow?.webContents);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media' && webContents === audioWindow?.webContents;
  });

  createAudioWindow();
  createPanelWindow();
  createTray();

  overlay = new Overlay();
  overlay.start();
  applyCursorSettings(settings.load());

  companion = new Companion({ overlay, sendToAudio });
  companion.on('status', (status) => sendToPanel('panel:status', status));

  radialMenu = new RadialMenu();
  screenshotSelector = new ScreenshotSelector();
  snap = new Snap();
  reminders = new Reminders({ notify: notifyUser });
  remindersWindow = new RemindersWindow({ reminders });
  reminders.start();
  reminders.setNudgeMinutes(settings.load().nudgeMinutes);

  if (process.env.CLICKIT_DEBUG) {
    // Test hooks: CLICKIT_AUTOREMIND="text|seconds", CLICKIT_AUTONUDGE=1, CLICKIT_AUTOOPEN=reminders
    const [text, seconds] = (process.env.CLICKIT_AUTOREMIND || '').split('|');
    if (text) {
      reminders.items.push({ id: `debug-${Date.now()}`, text, at: Date.now() + Number(seconds || 5) * 1000 });
      reminders.save();
    }
    if (process.env.CLICKIT_AUTONUDGE) {
      setTimeout(async () => {
        const windows = await reminders.nudge();
        console.log(`[nudge] found ${windows.length} open window(s): ${windows.map((w) => w.app).join(', ')}`);
      }, 4000);
    }
    if (process.env.CLICKIT_AUTOOPEN === 'reminders') setTimeout(() => remindersWindow.open(), 3000);
  }

  registerIpc();

  hotkeys = registerHotkeys({
    onOpenMenu: openRadialMenu,
    onToggleVoice: () => companion.toggleListening(),
    isDoubleClickEnabled: () => settings.load().doubleClickMenu,
  });

  // First run with no Gemini access configured: open the panel for setup.
  if (!settings.load().workerUrl && !require('./gemini').hasApiKey()) {
    panelWindow.webContents.once('did-finish-load', () => showPanel());
  }
});

app.on('will-quit', () => {
  hotkeys?.stop();
  overlay?.stop();
  reminders?.stop();
  snap?.close();
  remindersWindow?.close();
  radialMenu?.close();
  screenshotSelector?.close();
});
