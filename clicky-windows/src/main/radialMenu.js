'use strict';

const path = require('path');
const { BrowserWindow, globalShortcut, screen } = require('electron');

const ACTIONS = new Set(['screenshot', 'voice', 'select-area', 'translate', 'reminders', 'settings']);

/** Full-screen transparent window on the cursor's display that shows the radial gem menu. */
class RadialMenu {
  constructor() {
    this.window = null;
    this.onSelect = null;
  }

  show(onSelect) {
    this.close();
    this.onSelect = onSelect;

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    this.window = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      // Not focusable: a window summoned by a background hotkey usually can't
      // take focus on Windows, and the first click would be spent activating it.
      focusable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'radial.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window.setContentProtection(!process.env.CLICKIT_DEBUG);
    this.window.loadFile(path.join(__dirname, '..', 'renderer', 'radial.html'));
    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.once('ready-to-show', () => {
      this.window.showInactive();
      // Esc can't reach an unfocused window, so listen for it globally while the menu is open.
      globalShortcut.register('Escape', () => this.close());
    });
    if (process.env.CLICKIT_DEBUG) {
      this.window.webContents.on('console-message', (_event, _level, message) => {
        console.log(`[radial-renderer] ${message}`);
      });
      // Test helper: print each gem's center in physical screen pixels.
      this.window.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          if (!this.window || this.window.isDestroyed()) return;
          const bounds = this.window.getBounds();
          const rects = await this.window.webContents.executeJavaScript(
            'Array.from(document.querySelectorAll(".gem")).map(g => { const r = g.getBoundingClientRect(); return [g.dataset.action, r.x + r.width / 2, r.y + r.height / 2]; })'
          );
          const scale = display.scaleFactor;
          const centers = rects.map(([action, x, y]) => ({
            action,
            x: Math.round((bounds.x + x) * scale),
            y: Math.round((bounds.y + y) * scale),
          }));
          console.log(`[radial-debug] bounds=${JSON.stringify(bounds)} scale=${scale} gems=${JSON.stringify(centers)}`);

          // Test hook: CLICKIT_AUTOCLICK=<action> clicks that gem with synthetic input.
          const wanted = process.env.CLICKIT_AUTOCLICK;
          const target = rects.find(([action]) => action === wanted);
          if (target) {
            const x = Math.round(target[1]);
            const y = Math.round(target[2]);
            this.window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
            this.window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            this.window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          }
        }, 1500);
      });
    }
    this.window.on('closed', () => {
      this.window = null;
    });
  }

  close() {
    globalShortcut.unregister('Escape');
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }

  handleSelect(action) {
    const callback = this.onSelect;
    this.close();
    if (callback && ACTIONS.has(action)) callback(action);
  }

  isVisible() {
    return Boolean(this.window && !this.window.isDestroyed());
  }
}

module.exports = { RadialMenu };
