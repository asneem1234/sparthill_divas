'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

/**
 * Creates a small, frameless, focusable window near the cursor.
 * It is excluded from screen capture so it never shows up in a later snap.
 */
function createPopup({ htmlFile, preloadFile, width, height, title }) {
  const point = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(point);
  const w = Math.min(width, workArea.width - 16);
  const h = Math.min(height, workArea.height - 16);

  const win = new BrowserWindow({
    x: Math.round(clamp(point.x - w / 2, workArea.x + 8, workArea.x + workArea.width - w - 8)),
    y: Math.round(clamp(point.y - h / 2, workArea.y + 8, workArea.y + workArea.height - h - 8)),
    width: w,
    height: h,
    title,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', preloadFile),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setContentProtection(!process.env.CLICKIT_DEBUG);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', htmlFile));
  win.once('ready-to-show', () => {
    // Applied after show: Windows can drop the topmost flag from a window
    // that was created while another app had focus.
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    win.focus();
  });
  return win;
}

module.exports = { createPopup };
