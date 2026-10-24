// The "Choose what ClickIt can see" window. It appears before the Click It gemstones:
// the user picks one window (or a whole screen), and only that is ever captured.
// Windows that look like password managers are shown but can't be picked.

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { listCaptureTargets } = require('./capture');

const PICKER_CONTENT_WIDTH = 640;
const PICKER_CONTENT_HEIGHT = 500;
const PICKER_SHADOW_MARGIN = 16;
// Windows can send a blur right as the window opens; ignore it briefly.
const BLUR_GRACE_PERIOD_MILLISECONDS = 400;

class WindowPickerManager {
  constructor() {
    this.pickerWindow = null;
    this.targetsBySourceId = new Map();
    this.onSelectTarget = null;
    this.onCancel = null;
    this.windowControlService = null; // set by main.js

    ipcMain.on('picker:select', (event, sourceId) => {
      if (!this.isFromPickerWindow(event)) return;
      const chosenTarget = this.targetsBySourceId.get(sourceId);
      // The renderer only sends an id: the details come from the list this process built,
      // and blocked windows can never be chosen.
      if (!chosenTarget || chosenTarget.isBlocked) return;
      const onSelectTarget = this.onSelectTarget;
      this.hidePicker();
      if (onSelectTarget) {
        onSelectTarget({
          sourceId: chosenTarget.sourceId,
          kind: chosenTarget.kind,
          name: chosenTarget.name,
          processName: chosenTarget.processName,
        });
      }
    });

    ipcMain.on('picker:cancel', (event) => {
      if (!this.isFromPickerWindow(event)) return;
      const onCancel = this.onCancel;
      this.hidePicker();
      if (onCancel) onCancel();
    });
  }

  isFromPickerWindow(event) {
    return Boolean(this.pickerWindow && !this.pickerWindow.isDestroyed() && event.sender === this.pickerWindow.webContents);
  }

  get isShowingPicker() {
    return this.pickerWindow !== null;
  }

  /**
   * @param {{onSelectTarget: (target: object) => void, onCancel: () => void}} callbacks
   */
  showPicker({ onSelectTarget, onCancel }) {
    this.hidePicker();
    this.onSelectTarget = onSelectTarget;
    this.onCancel = onCancel;

    const mouseLocation = screen.getCursorScreenPoint();
    const workArea = screen.getDisplayNearestPoint(mouseLocation).workArea;
    const windowWidth = PICKER_CONTENT_WIDTH + PICKER_SHADOW_MARGIN * 2;
    const windowHeight = Math.min(PICKER_CONTENT_HEIGHT + PICKER_SHADOW_MARGIN * 2, workArea.height);
    const windowX = Math.round(workArea.x + (workArea.width - windowWidth) / 2);
    const windowY = Math.round(workArea.y + (workArea.height - windowHeight) / 2);

    const pickerWindow = new BrowserWindow({
      x: windowX,
      y: windowY,
      width: windowWidth,
      height: windowHeight,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'picker.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    pickerWindow.setAlwaysOnTop(true, 'pop-up-menu');
    pickerWindow.setBounds({ x: windowX, y: windowY, width: windowWidth, height: windowHeight });
    // Previews of other windows may be sensitive, so keep this window out of any capture.
    pickerWindow.setContentProtection(true);
    pickerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'picker.html'));

    const windowShownAt = Date.now();
    pickerWindow.webContents.once('did-finish-load', async () => {
      if (pickerWindow.isDestroyed()) return;
      pickerWindow.show();
      pickerWindow.focus();
      // Opened from a hotkey while another program is in front: Windows won't give us focus on a
      // plain focus(), which would leave the keyboard (arrows, Enter, Esc) and click-away dismissal dead.
      if (this.windowControlService) this.windowControlService.focusOwnWindow(pickerWindow);

      try {
        // Our own picker window is excluded from the list because it is already open and protected.
        const targets = await listCaptureTargets();
        if (pickerWindow.isDestroyed() || this.pickerWindow !== pickerWindow) return;
        this.targetsBySourceId = new Map(targets.map((target) => [target.sourceId, target]));
        pickerWindow.webContents.send('picker:items', targets);
      } catch (error) {
        console.error('[ClickIt] Could not list windows:', error.message);
        if (!pickerWindow.isDestroyed()) pickerWindow.webContents.send('picker:error', error.message);
      }
    });

    // Clicking outside takes focus away; treat it as cancel so the picker never lingers.
    pickerWindow.on('blur', () => {
      if (Date.now() - windowShownAt < BLUR_GRACE_PERIOD_MILLISECONDS) {
        if (!pickerWindow.isDestroyed()) pickerWindow.focus();
        return;
      }
      const onCancelCallback = this.onCancel;
      this.hidePicker();
      if (onCancelCallback) onCancelCallback();
    });

    this.pickerWindow = pickerWindow;
  }

  hidePicker() {
    const pickerWindow = this.pickerWindow;
    this.pickerWindow = null;
    this.targetsBySourceId = new Map();
    this.onSelectTarget = null;
    this.onCancel = null;
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.removeAllListeners('blur');
      pickerWindow.destroy();
    }
  }
}

module.exports = { WindowPickerManager };
