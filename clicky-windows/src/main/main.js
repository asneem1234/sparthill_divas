'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, session } = require('electron');
const settings = require('./settings');
const { Overlay } = require('./overlay');
const { Companion } = require('./companion');
const { registerPushToTalk } = require('./hotkey');

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const PANEL_SIZE = { width: 360, height: 620 };

let tray = null;
let panelWindow = null;
let audioWindow = null;
let overlay = null;
let companion = null;
let hotkey = null;

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

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - PANEL_SIZE.width / 2);
  let y = Math.round(trayBounds.y - PANEL_SIZE.height - 8);
  if (y < workArea.y) y = Math.round(trayBounds.y + trayBounds.height + 8); // taskbar on top

  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - PANEL_SIZE.width - 8));
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - PANEL_SIZE.height - 8));
  panelWindow.setPosition(x, y);
}

function showPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  positionPanelNearTray();
  panelWindow.show();
  panelWindow.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Clicky');
  tray.on('click', () => {
    if (panelWindow.isVisible()) panelWindow.hide();
    else showPanel();
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Clicky', click: () => showPanel() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function registerIpc() {
  // Audio window -> main
  ipcMain.on('audio:transcript', (_event, payload) => companion.handleTranscript(payload));
  ipcMain.on('audio:error', (_event, payload) => companion.handleAudioError(payload));
  ipcMain.on('audio:level', (_event, level) => overlay.setAudioLevel(level));
  ipcMain.on('audio:playback-started', () => companion.handlePlaybackStarted());
  ipcMain.on('audio:playback-ended', () => companion.handlePlaybackEnded());

  // Panel <-> main
  ipcMain.handle('panel:get-state', () => ({
    settings: settings.load(),
    status: companion.getStatus(),
    hotkeyMode: hotkey?.mode ?? 'none',
  }));
  ipcMain.handle('panel:save-settings', (_event, patch) => {
    const allowed = {};
    if (typeof patch.workerUrl === 'string') allowed.workerUrl = patch.workerUrl;
    if (patch.model === 'claude-sonnet-4-6' || patch.model === 'claude-opus-4-6') allowed.model = patch.model;
    if (typeof patch.showCursor === 'boolean') allowed.showCursor = patch.showCursor;
    const next = settings.update(allowed);
    overlay.setEnabled(next.showCursor);
    return next;
  });
  ipcMain.on('panel:ask', (_event, text) => companion.ask(text));
  ipcMain.on('panel:quit', () => app.quit());
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
  overlay.setEnabled(settings.load().showCursor);
  overlay.start();

  companion = new Companion({ overlay, sendToAudio });
  companion.on('status', (status) => sendToPanel('panel:status', status));

  registerIpc();

  hotkey = registerPushToTalk({
    onStart: () => companion.startListening(),
    onStop: () => companion.stopListening(),
  });

  // First run: open the panel so the user can paste their Worker URL.
  if (!settings.load().workerUrl) {
    panelWindow.webContents.once('did-finish-load', () => showPanel());
  }
});

app.on('will-quit', () => {
  hotkey?.stop();
  overlay?.stop();
});
