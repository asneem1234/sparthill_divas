// Owns the system tray icon and the floating control panel that opens from it.
// Windows equivalent of MenuBarPanelManager (NSStatusItem + borderless NSPanel).

const path = require('path');
const { BrowserWindow, Menu, Tray, ipcMain, screen } = require('electron');
const { buildTrayIcon } = require('./trayIcon');

const PANEL_CONTENT_WIDTH = 320;
// Transparent margin around the panel so its CSS drop shadow isn't clipped.
const PANEL_SHADOW_MARGIN = 16;
const PANEL_GAP_FROM_TASKBAR = 4;
const INITIAL_PANEL_CONTENT_HEIGHT = 380;

class PanelManager {
  /**
   * @param {import('./companion').CompanionManager} companionManager
   * @param {{ onQuitRequested: () => void }} callbacks
   */
  constructor(companionManager, { onQuitRequested }) {
    this.companionManager = companionManager;
    this.onQuitRequested = onQuitRequested;
    this.tray = null;
    this.panelWindow = null;
    this.panelContentHeight = INITIAL_PANEL_CONTENT_HEIGHT;
    this.lastHiddenByBlurTimestamp = 0;

    companionManager.on('dismissPanel', () => this.hidePanel());
    companionManager.on('stateChanged', (panelState) => {
      if (this.panelWindow && !this.panelWindow.isDestroyed()) {
        this.panelWindow.webContents.send('panel:state', panelState);
      }
    });

    ipcMain.handle('panel:get-state', () => companionManager.getPanelState());
    ipcMain.on('panel:content-height', (event, contentHeight) => {
      this.panelContentHeight = Math.ceil(contentHeight);
      this.resizePanelToContent();
    });
    ipcMain.on('panel:action', (event, panelAction) => {
      this.handlePanelAction(panelAction);
    });
  }

  // MARK: Tray

  createTray() {
    this.tray = new Tray(buildTrayIcon());
    this.tray.setToolTip('Click It');

    this.tray.on('click', () => this.togglePanel());
    this.tray.on('right-click', () => {
      const trayMenu = Menu.buildFromTemplate([
        { label: 'Open panel', click: () => this.showPanel() },
        { label: 'Open Click It menu', click: () => this.companionManager.toggleClickItOrbMenu() },
        {
          label: this.companionManager.voiceChatManager && this.companionManager.voiceChatManager.isActive ? 'End voice chat' : 'Start voice chat',
          click: () => this.companionManager.toggleVoiceChat(),
        },
        { type: 'separator' },
        { label: 'Quit Click It', click: () => this.onQuitRequested() },
      ]);
      this.tray.popUpContextMenu(trayMenu);
    });
  }

  destroyTray() {
    if (this.tray) this.tray.destroy();
    this.tray = null;
  }

  // MARK: Panel lifecycle

  get isPanelVisible() {
    return Boolean(this.panelWindow && !this.panelWindow.isDestroyed() && this.panelWindow.isVisible());
  }

  togglePanel() {
    // Clicking the tray icon blurs (and hides) the panel just before this click
    // arrives. Without this check the panel would instantly pop back open.
    if (Date.now() - this.lastHiddenByBlurTimestamp < 300) return;
    if (this.isPanelVisible) this.hidePanel();
    else this.showPanel();
  }

  showPanel() {
    if (!this.panelWindow || this.panelWindow.isDestroyed()) this.createPanelWindow();
    this.positionPanelNearTray();
    this.panelWindow.show();
    this.panelWindow.focus();
  }

  hidePanel() {
    if (this.panelWindow && !this.panelWindow.isDestroyed()) this.panelWindow.hide();
  }

  /** Opens the panel automatically on launch so new users see setup right away. */
  showPanelOnLaunch() {
    // Small delay so the tray icon has time to appear.
    setTimeout(() => this.showPanel(), 400);
  }

  createPanelWindow() {
    const panelWindow = new BrowserWindow({
      width: PANEL_CONTENT_WIDTH + PANEL_SHADOW_MARGIN * 2,
      height: this.panelContentHeight + PANEL_SHADOW_MARGIN * 2,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'panel.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    panelWindow.setAlwaysOnTop(true, 'pop-up-menu');
    panelWindow.setContentProtection(true);
    panelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));

    // Dismiss when the user clicks elsewhere, like an NSPopover. While permissions are
    // still missing the panel stays put, because a Windows Settings window will have
    // focus and the user needs to come back to the panel.
    panelWindow.on('blur', () => {
      setTimeout(() => {
        if (!this.isPanelVisible) return;
        if (BrowserWindow.getFocusedWindow() === this.panelWindow) return;
        if (!this.companionManager.allPermissionsGranted) return;
        this.lastHiddenByBlurTimestamp = Date.now();
        this.hidePanel();
      }, 120);
    });

    this.panelWindow = panelWindow;
  }

  resizePanelToContent() {
    if (!this.panelWindow || this.panelWindow.isDestroyed()) return;
    // Windows ignores setSize on a non-resizable window, so unlock it for the resize.
    this.panelWindow.setResizable(true);
    this.panelWindow.setSize(PANEL_CONTENT_WIDTH + PANEL_SHADOW_MARGIN * 2, this.panelContentHeight + PANEL_SHADOW_MARGIN * 2);
    this.panelWindow.setResizable(false);
    if (this.isPanelVisible) this.positionPanelNearTray();
  }

  positionPanelNearTray() {
    if (!this.panelWindow || this.panelWindow.isDestroyed()) return;

    const [windowWidth, windowHeight] = this.panelWindow.getSize();
    const trayBounds = this.tray ? this.tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
    const hasUsableTrayBounds = trayBounds.width > 0 && trayBounds.height > 0;

    const anchorPoint = hasUsableTrayBounds
      ? { x: trayBounds.x + trayBounds.width / 2, y: trayBounds.y + trayBounds.height / 2 }
      : screen.getCursorScreenPoint();
    const workArea = screen.getDisplayNearestPoint(anchorPoint).workArea;

    // Center under/over the tray icon, then keep the visible panel inside the work area.
    const minimumX = workArea.x - PANEL_SHADOW_MARGIN + 8;
    const maximumX = workArea.x + workArea.width - windowWidth + PANEL_SHADOW_MARGIN - 8;
    const windowX = Math.round(Math.min(Math.max(anchorPoint.x - windowWidth / 2, minimumX), maximumX));

    let windowY;
    const isTaskbarAtTop = hasUsableTrayBounds && anchorPoint.y < workArea.y + workArea.height / 2;
    if (isTaskbarAtTop) {
      windowY = workArea.y - PANEL_SHADOW_MARGIN + PANEL_GAP_FROM_TASKBAR;
    } else {
      // Taskbar at the bottom (the default) or unknown: sit just above it.
      windowY = workArea.y + workArea.height - windowHeight + PANEL_SHADOW_MARGIN - PANEL_GAP_FROM_TASKBAR;
    }

    this.panelWindow.setPosition(windowX, Math.round(windowY));
  }

  // MARK: Actions from the panel UI

  handlePanelAction({ type, value }) {
    switch (type) {
      case 'dismiss':
        this.hidePanel();
        break;
      case 'quit':
        this.onQuitRequested();
        break;
      case 'set-model':
        this.companionManager.setSelectedModel(value);
        break;
      case 'set-worker-url':
        this.companionManager.setWorkerBaseUrl(value);
        break;
      case 'set-cursor-enabled':
        this.companionManager.setClickyCursorEnabled(Boolean(value));
        break;
      case 'grant-microphone':
        this.companionManager.requestMicrophonePermission();
        break;
      case 'start-onboarding':
        this.companionManager.triggerOnboarding();
        break;
      case 'replay-onboarding':
        this.companionManager.replayOnboarding();
        break;
      case 'open-click-it-menu':
        this.hidePanel();
        // Give the panel a moment to close so it doesn't cover the gemstones.
        setTimeout(() => this.companionManager.toggleClickItOrbMenu(), 150);
        break;
      case 'start-voice-chat':
        this.hidePanel();
        this.companionManager.toggleVoiceChat();
        break;
      default:
        break;
    }
  }
}

module.exports = { PanelManager };
