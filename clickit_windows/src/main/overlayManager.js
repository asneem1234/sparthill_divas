// Owns the transparent, click-through overlay windows (one per display) that host
// the pink cursor buddy. Port of OverlayWindowManager + OverlayWindow.
//
// The main process polls the real mouse position and pushes it to every overlay,
// because a click-through window can't observe the global cursor by itself.

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { EventEmitter } = require('events');

// WDA_EXCLUDEFROMCAPTURE (hides our windows from screenshots) needs Windows 10 2004.
const MINIMUM_WINDOWS_BUILD_FOR_CAPTURE_EXCLUSION = 19041;

function windowsSupportsCaptureExclusion() {
  const systemVersionParts = String(process.getSystemVersion()).split('.');
  const buildNumber = Number(systemVersionParts[2] || 0);
  return buildNumber >= MINIMUM_WINDOWS_BUILD_FOR_CAPTURE_EXCLUSION;
}

class OverlayManager extends EventEmitter {
  constructor() {
    super();
    this.overlayEntries = []; // { browserWindow, displayFrame }
    this.hasShownOverlayBefore = false;
    this.cursorPollIntervalId = null;
    this.lastBroadcastCursorLocation = null;
    this.displayChangeTimeoutId = null;
    this.canExcludeOverlaysFromCapture = windowsSupportsCaptureExclusion();

    // What every overlay needs to render, pushed whenever it changes.
    this.overlayState = {
      voiceState: 'idle',
      detectedElement: null, // { requestIdentifier, location, displayFrame, bubbleText }
      onboardingPrompt: { show: false, text: '', opacity: 0 },
    };

    ipcMain.handle('overlay:get-initial-state', (event) => {
      const matchingEntry = this.overlayEntries.find((entry) => entry.browserWindow.webContents.id === event.sender.id);
      if (!matchingEntry) return null;
      return {
        screenFrame: matchingEntry.displayFrame,
        isFirstAppearance: matchingEntry.isFirstAppearance,
        cursorLocation: screen.getCursorScreenPoint(),
        overlayState: this.overlayState,
      };
    });

    ipcMain.on('overlay:event', (event, overlayEvent) => {
      this.emit('overlayEvent', overlayEvent);
    });

    const handleDisplayConfigurationChange = () => this.rebuildOverlaysAfterDisplayChange();
    screen.on('display-added', handleDisplayConfigurationChange);
    screen.on('display-removed', handleDisplayConfigurationChange);
    screen.on('display-metrics-changed', handleDisplayConfigurationChange);
  }

  isShowingOverlay() {
    return this.overlayEntries.length > 0;
  }

  /** Creates one overlay window per display. */
  showOverlay() {
    this.hideOverlay();

    // The first appearance plays the welcome animation and onboarding video.
    const isFirstAppearance = !this.hasShownOverlayBefore;
    this.hasShownOverlayBefore = true;
    this.createOverlayWindows(isFirstAppearance);
    this.startCursorPolling();
  }

  createOverlayWindows(isFirstAppearance) {
    for (const display of screen.getAllDisplays()) {
      const displayFrame = { ...display.bounds };

      const overlayWindow = new BrowserWindow({
        x: displayFrame.x,
        y: displayFrame.y,
        width: displayFrame.width,
        height: displayFrame.height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false, // never steals focus
        skipTaskbar: true,
        hasShadow: false,
        fullscreenable: false,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });

      overlayWindow.setAlwaysOnTop(true, 'screen-saver'); // above menus and popups
      overlayWindow.setIgnoreMouseEvents(true); // click-through
      overlayWindow.setBounds(displayFrame);
      if (this.canExcludeOverlaysFromCapture) {
        // Keeps the overlay out of screenshots so the model only sees the user's content.
        overlayWindow.setContentProtection(true);
      }

      overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
      overlayWindow.webContents.once('did-finish-load', () => {
        if (!overlayWindow.isDestroyed()) overlayWindow.showInactive();
      });

      this.overlayEntries.push({ browserWindow: overlayWindow, displayFrame, isFirstAppearance });
    }
  }

  hideOverlay() {
    this.stopCursorPolling();
    for (const entry of this.overlayEntries) {
      if (!entry.browserWindow.isDestroyed()) entry.browserWindow.destroy();
    }
    this.overlayEntries = [];
  }

  /** Fades the overlays out, then removes them. */
  fadeOutAndHideOverlay(durationSeconds = 0.4) {
    const entriesToFade = this.overlayEntries;
    this.overlayEntries = [];
    this.stopCursorPolling();

    for (const entry of entriesToFade) {
      if (!entry.browserWindow.isDestroyed()) {
        entry.browserWindow.webContents.send('overlay:fade-out', durationSeconds);
      }
    }
    setTimeout(() => {
      for (const entry of entriesToFade) {
        if (!entry.browserWindow.isDestroyed()) entry.browserWindow.destroy();
      }
    }, durationSeconds * 1000 + 50);
  }

  broadcast(channelName, payload) {
    for (const entry of this.overlayEntries) {
      if (!entry.browserWindow.isDestroyed()) entry.browserWindow.webContents.send(channelName, payload);
    }
  }

  /** Merges changes into the shared overlay state and pushes it to every overlay. */
  updateOverlayState(partialState) {
    this.overlayState = { ...this.overlayState, ...partialState };
    this.broadcast('overlay:state', this.overlayState);
  }

  sendAudioPowerLevel(audioPowerLevel) {
    this.broadcast('overlay:audio-level', audioPowerLevel);
  }

  /**
   * Runs a screenshot callback while guaranteeing our overlays aren't in the picture.
   * On Windows 10 builds without capture exclusion the overlays are made invisible
   * for the capture instead.
   */
  async runWithOverlaysExcludedFromCapture(captureCallback) {
    if (this.canExcludeOverlaysFromCapture || this.overlayEntries.length === 0) {
      return captureCallback();
    }

    const aliveWindows = this.overlayEntries.map((entry) => entry.browserWindow).filter((window) => !window.isDestroyed());
    aliveWindows.forEach((window) => window.setOpacity(0));
    await new Promise((resolve) => setTimeout(resolve, 80));
    try {
      return await captureCallback();
    } finally {
      aliveWindows.forEach((window) => {
        if (!window.isDestroyed()) window.setOpacity(1);
      });
    }
  }

  // MARK: Cursor polling

  startCursorPolling() {
    this.stopCursorPolling();
    this.lastBroadcastCursorLocation = null;
    this.cursorPollIntervalId = setInterval(() => {
      const cursorLocation = screen.getCursorScreenPoint();
      const lastLocation = this.lastBroadcastCursorLocation;
      if (lastLocation && lastLocation.x === cursorLocation.x && lastLocation.y === cursorLocation.y) return;
      this.lastBroadcastCursorLocation = cursorLocation;
      this.broadcast('overlay:cursor', cursorLocation);
    }, 8);
  }

  stopCursorPolling() {
    if (this.cursorPollIntervalId) clearInterval(this.cursorPollIntervalId);
    this.cursorPollIntervalId = null;
  }

  /** Monitors can be plugged in or rearranged while the overlay is up. */
  rebuildOverlaysAfterDisplayChange() {
    if (!this.isShowingOverlay()) return;
    clearTimeout(this.displayChangeTimeoutId);
    this.displayChangeTimeoutId = setTimeout(() => {
      if (!this.isShowingOverlay()) return;
      for (const entry of this.overlayEntries) {
        if (!entry.browserWindow.isDestroyed()) entry.browserWindow.destroy();
      }
      this.overlayEntries = [];
      this.createOverlayWindows(false);
    }, 300);
  }
}

module.exports = { OverlayManager };
