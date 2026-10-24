// Lets the user drag out an area of the screen to snap, like the Windows screenshot tool.
//
// The screen is "frozen": it is captured once, shown dimmed in a full-screen overlay, and the
// user drags a rectangle and presses Snap. The area is cut out of that frozen picture, so
// what the user sees is exactly what is analyzed, and the overlay never ends up in it.

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { captureDisplayImage, buildCaptureFromImage } = require('./capture');

const MINIMUM_SELECTION_SIZE = 12;

class RegionSelectorManager {
  constructor() {
    this.overlayWindow = null;
    this.windowControlService = null; // set by main.js
    this.pendingSelection = null; // { resolve, display, frozenImage }

    ipcMain.on('region:confirm', (event, selectedRectangle) => {
      if (!this.isFromOverlay(event)) return;
      this.finishSelection(selectedRectangle);
    });
    ipcMain.on('region:cancel', (event) => {
      if (!this.isFromOverlay(event)) return;
      this.finishSelection(null);
    });
  }

  isFromOverlay(event) {
    return Boolean(this.overlayWindow && !this.overlayWindow.isDestroyed() && event.sender === this.overlayWindow.webContents);
  }

  get isActive() {
    return this.pendingSelection !== null;
  }

  /** Closes the selector without a result (for example when the hotkey is tapped again). */
  cancel() {
    this.finishSelection(null);
  }

  /**
   * Freezes the screen under `preferredPoint`, lets the user drag out an area, and resolves with
   * a capture of just that area (the same shape captureTarget returns), or null if they cancelled.
   * @param {{preferredPoint?: {x: number, y: number}, frozenImageForTests?: Electron.NativeImage}} options
   */
  async selectRegion({ preferredPoint, frozenImageForTests } = {}) {
    this.cancel();

    const display = screen.getDisplayNearestPoint(preferredPoint || screen.getCursorScreenPoint());
    const frozenImage = frozenImageForTests || (await captureDisplayImage(display));

    return new Promise((resolve) => {
      this.pendingSelection = { resolve, display, frozenImage };
      this.openOverlay(display, frozenImage);
    });
  }

  openOverlay(display, frozenImage) {
    const { bounds } = display;
    const overlayWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      show: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'region.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setBounds(bounds);
    overlayWindow.setContentProtection(true);
    overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'region.html'));

    overlayWindow.webContents.once('did-finish-load', () => {
      if (overlayWindow.isDestroyed() || this.overlayWindow !== overlayWindow) return;
      // The overlay only needs a picture at the size of the screen in DIPs.
      const displayPicture = frozenImage.resize({ width: bounds.width, height: bounds.height, quality: 'good' });
      overlayWindow.webContents.send('region:init', {
        pictureDataUrl: `data:image/jpeg;base64,${displayPicture.toJPEG(85).toString('base64')}`,
        width: bounds.width,
        height: bounds.height,
      });
      overlayWindow.show();
      overlayWindow.focus();
      if (this.windowControlService) this.windowControlService.focusOwnWindow(overlayWindow);
    });

    // Switching to another program cancels, like the Windows screenshot tool.
    const windowShownAt = Date.now();
    overlayWindow.on('blur', () => {
      if (Date.now() - windowShownAt < 600) {
        if (!overlayWindow.isDestroyed()) overlayWindow.focus();
        return;
      }
      this.finishSelection(null);
    });

    this.overlayWindow = overlayWindow;
  }

  /**
   * @param {{x: number, y: number, width: number, height: number}|null} selectedRectangle in DIPs, relative to the screen
   */
  finishSelection(selectedRectangle) {
    const pendingSelection = this.pendingSelection;
    const overlayWindow = this.overlayWindow;
    this.pendingSelection = null;
    this.overlayWindow = null;

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.removeAllListeners('blur');
      overlayWindow.destroy();
    }
    if (!pendingSelection) return;

    if (!this.isUsableRectangle(selectedRectangle, pendingSelection.display)) {
      pendingSelection.resolve(null);
      return;
    }

    // Cut the area out of the frozen picture (which is at native resolution).
    const { frozenImage, display } = pendingSelection;
    const imageSize = frozenImage.getSize();
    const horizontalScale = imageSize.width / display.bounds.width;
    const verticalScale = imageSize.height / display.bounds.height;
    const cropRectangle = {
      x: Math.max(0, Math.round(selectedRectangle.x * horizontalScale)),
      y: Math.max(0, Math.round(selectedRectangle.y * verticalScale)),
      width: Math.round(selectedRectangle.width * horizontalScale),
      height: Math.round(selectedRectangle.height * verticalScale),
    };
    cropRectangle.width = Math.max(1, Math.min(cropRectangle.width, imageSize.width - cropRectangle.x));
    cropRectangle.height = Math.max(1, Math.min(cropRectangle.height, imageSize.height - cropRectangle.y));

    const croppedImage = frozenImage.crop(cropRectangle);
    pendingSelection.resolve(buildCaptureFromImage(croppedImage, 'the area of the screen the user selected'));
  }

  isUsableRectangle(rectangle, display) {
    if (!rectangle) return false;
    const values = [rectangle.x, rectangle.y, rectangle.width, rectangle.height];
    if (!values.every((value) => Number.isFinite(value))) return false;
    if (rectangle.width < MINIMUM_SELECTION_SIZE || rectangle.height < MINIMUM_SELECTION_SIZE) return false;
    return rectangle.x >= 0 && rectangle.y >= 0 &&
      rectangle.x + rectangle.width <= display.bounds.width + 1 &&
      rectangle.y + rectangle.height <= display.bounds.height + 1;
  }
}

module.exports = { RegionSelectorManager };
