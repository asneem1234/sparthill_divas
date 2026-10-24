'use strict';

const path = require('path');
const { BrowserWindow, globalShortcut, screen } = require('electron');

/**
 * Full-screen overlay on the cursor's display where the user drags a rectangle.
 * The window is excluded from screen capture so it never appears in the image.
 */
class ScreenshotSelector {
  constructor() {
    this.window = null;
    this.display = null;
    this.onCapture = null;
  }

  /**
   * @param {(display: Electron.Display, rect: {x:number,y:number,width:number,height:number}) => void} onCapture
   *   rect is in DIPs relative to the display's top-left corner.
   */
  show(onCapture) {
    this.close();
    this.onCapture = onCapture;
    this.display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { bounds } = this.display;

    this.window = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      focusable: false, // see RadialMenu: avoids the first click being spent on activation
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'screenshot-selector.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window.setContentProtection(true);
    this.window.loadFile(path.join(__dirname, '..', 'renderer', 'screenshot-selector.html'));
    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.webContents.on('console-message', (_event, _level, message) => {
      if (process.env.CLICKIT_DEBUG) console.log(`[selector-renderer] ${message}`);
    });
    this.window.webContents.on('did-fail-load', (_e, code, description) => {
      console.log(`[selector] failed to load: ${code} ${description}`);
    });
    this.window.once('ready-to-show', () => {
      console.log('[selector] shown');
      this.window.showInactive();
      globalShortcut.register('Escape', () => this.close());

      // Test hook: CLICKIT_AUTODRAG="x1,y1,x2,y2" (DIPs) drags a rectangle with synthetic input.
      const drag = process.env.CLICKIT_AUTODRAG;
      if (drag) {
        const [x1, y1, x2, y2] = drag.split(',').map(Number);
        const wc = this.window.webContents;
        setTimeout(() => {
          if (!this.window || this.window.isDestroyed()) return;
          wc.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 });
          for (let i = 1; i <= 8; i++) {
            wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x1 + ((x2 - x1) * i) / 8), y: Math.round(y1 + ((y2 - y1) * i) / 8) });
          }
          wc.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 });
        }, 1500);
      }
    });
    this.window.on('closed', () => {
      this.window = null;
    });
  }

  close() {
    globalShortcut.unregister('Escape');
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }

  handleCapture(rect) {
    console.log(`[selector] region ${JSON.stringify(rect)}`);
    const display = this.display;
    const callback = this.onCapture;
    const valid =
      rect &&
      ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) &&
      rect.width > 0 &&
      rect.height > 0;
    this.close();
    if (!valid || !display || !callback) return;
    // Let the selector window disappear before the screen is captured.
    setTimeout(() => callback(display, rect), 120);
  }
}

module.exports = { ScreenshotSelector };
