// ClickIt for Windows: entry point.
//
// A tray-only companion app. There is no main window and no taskbar button.
// Clicking the tray icon opens a floating panel with the companion controls.
// Windows port of the macOS app's leanring_buddyApp.swift (CompanionAppDelegate).

const path = require('path');
const { app, session } = require('electron');

const { SettingsStore } = require('./settings');
const { WorkerClient } = require('./worker');
const { AudioBridge } = require('./audioBridge');
const { DictationManager } = require('./dictation');
const { GlobalPushToTalkShortcutMonitor } = require('./hotkey');
const { OverlayManager } = require('./overlayManager');
const { OrbMenuManager } = require('./orbMenuManager');
const { CompanionManager, AVAILABLE_MODELS } = require('./companion');
const { ClickItActionsManager } = require('./actionsManager');
const { WindowPickerManager } = require('./windowPickerManager');
const { RegionSelectorManager } = require('./regionSelectorManager');
const { OcrService } = require('./ocr/ocrService');
const { WindowControlService } = require('./windowControl/windowControlService');
const { PanelManager } = require('./panelManager');
const { VoiceChatManager } = require('./voiceChatManager');

app.setAppUserModelId('com.clickit.windows');

// Only one copy should own the hotkeys and the tray icon.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

// Keep running when every window is closed: the app lives in the tray.
app.on('window-all-closed', () => {});

// Renderers only ever show our own bundled pages. Block navigation and popups.
app.on('web-contents-created', (event, webContents) => {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (navigationEvent) => navigationEvent.preventDefault());

  if (process.env.CLICKIT_DEBUG_LOGS) {
    webContents.on('console-message', (consoleEvent, level, message, lineNumber, sourceId) => {
      console.log(`[renderer ${path.basename(String(sourceId))}:${lineNumber}] ${message}`);
    });
  }
});

process.on('uncaughtException', (error) => {
  console.error('[ClickIt] Uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ClickIt] Unhandled rejection:', reason);
});

async function startClickIt() {
  await app.whenReady();

  // The hidden audio window needs the microphone. Grant it only to our own bundled pages.
  const isOwnBundledPage = (requestingUrl) => String(requestingUrl).startsWith('file://');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permission === 'media' && isOwnBundledPage(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return permission === 'media' && isOwnBundledPage(requestingOrigin || webContents?.getURL());
  });

  const settings = new SettingsStore();
  const workerClient = new WorkerClient(() => settings.get('workerBaseUrl'));
  const audioBridge = new AudioBridge();
  const dictationManager = new DictationManager(audioBridge, workerClient);
  const hotkeyMonitor = new GlobalPushToTalkShortcutMonitor();
  const overlayManager = new OverlayManager();
  const orbMenuManager = new OrbMenuManager();

  await audioBridge.create();

  // The Click It actions use whichever model the panel has selected (falls back to the default).
  // Reads window contents on this PC (nothing is uploaded) so secrets can be caught before the AI sees anything.
  const ocrService = new OcrService();
  ocrService.ensureStarted(); // warm it up now so the first check is quick

  // Switches to the window the user picks (warm it up now so the first switch is quick).
  const windowControlService = new WindowControlService();
  windowControlService.ensureStarted();

  // Snap's drag-to-select screenshot overlay.
  const regionSelectorManager = new RegionSelectorManager();
  regionSelectorManager.windowControlService = windowControlService;

  const windowPickerManager = new WindowPickerManager();
  windowPickerManager.windowControlService = windowControlService;
  orbMenuManager.windowControlService = windowControlService;
  const actionsManager = new ClickItActionsManager({
    workerClient,
    settings,
    ocrService,
    regionSelectorManager,
    getSelectedModel: () => {
      const savedModelIdentifier = settings.get('selectedModel');
      return AVAILABLE_MODELS.some((model) => model.id === savedModelIdentifier)
        ? savedModelIdentifier
        : AVAILABLE_MODELS[0].id;
    },
  });

  const companionManager = new CompanionManager({
    settings,
    workerClient,
    audioBridge,
    dictationManager,
    hotkeyMonitor,
    overlayManager,
    orbMenuManager,
    actionsManager,
    windowPickerManager,
    ocrService,
    windowControlService,
    regionSelectorManager,
  });

  // Hands-free voice-to-voice chat (Gemini Live through the worker's /live route).
  const voiceChatManager = new VoiceChatManager({ settings, ocrService });
  companionManager.voiceChatManager = voiceChatManager;

  const panelManager = new PanelManager(companionManager, { onQuitRequested: () => app.quit() });
  panelManager.createTray();

  companionManager.start();

  // Auto-open the panel if the user still needs to do something:
  // either they haven't onboarded yet, or permissions were revoked.
  if (!companionManager.hasCompletedOnboarding || !companionManager.allPermissionsGranted) {
    panelManager.showPanelOnLaunch();
  }

  // Launch at login, like the macOS login item. Skipped in development, where the
  // executable would be the bare Electron binary rather than the packaged app.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  app.on('second-instance', () => panelManager.showPanel());

  app.on('before-quit', () => {
    companionManager.stop();
    ocrService.destroy();
    windowControlService.destroy();
    audioBridge.destroy();
    panelManager.destroyTray();
  });

  console.log(`[ClickIt] Started (version ${app.getVersion()})`);
}

if (isPrimaryInstance) {
  startClickIt().catch((error) => {
    console.error('[ClickIt] Failed to start:', error);
    app.quit();
  });
}
