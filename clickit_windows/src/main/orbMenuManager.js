// Owns the small interactive window that hosts the Click It gemstone menu.
// Port of ClickItOrbMenuPanelManager. It is separate from the click-through
// cursor overlay so push-to-talk behavior stays untouched.
//
// The window appears centered on the mouse and closes when the user picks an
// action, presses Escape, clicks the center orb, or clicks anywhere else.

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { CLICK_IT_ACTIONS } = require('./clickItActions');

// The window holds a typed greeting on top and the ring of gems below it. The gems are
// centered at ORB_MENU_GEM_CENTER inside the window.
const ORB_MENU_WINDOW_WIDTH = 280;
const ORB_MENU_WINDOW_HEIGHT = 264;
const ORB_MENU_GEM_CENTER = { x: 140, y: 152 };
// Windows can send a blur right as the window opens; ignore it briefly.
const BLUR_GRACE_PERIOD_MILLISECONDS = 250;

class OrbMenuManager {
  constructor() {
    this.orbMenuWindow = null;
    this.onSelectAction = null;
    this.onDismiss = null;

    this.windowControlService = null; // set by main.js

    ipcMain.handle('orb:get-actions', () => CLICK_IT_ACTIONS);
    ipcMain.on('orb:select', (event, selectedActionIdentifier) => {
      if (this.onSelectAction) this.onSelectAction(selectedActionIdentifier);
    });
    ipcMain.on('orb:dismiss', () => {
      if (this.onDismiss) this.onDismiss();
    });
  }

  get isShowingOrbMenu() {
    return this.orbMenuWindow !== null;
  }

  /**
   * @param {object} options
   * @param {{x: number, y: number}} [options.anchorPoint] where to center the gems (default: the mouse)
   */
  showOrbMenu({ anchorPoint = null, onSelectAction, onDismiss }) {
    this.hideOrbMenu();
    this.onSelectAction = onSelectAction;
    this.onDismiss = onDismiss;

    const centerPoint = anchorPoint || screen.getCursorScreenPoint();
    const workArea = screen.getDisplayNearestPoint(centerPoint).workArea;

    // Center the gems (not the greeting or caption) on the anchor, then keep the menu on screen.
    const windowX = Math.min(
      Math.max(Math.round(centerPoint.x - ORB_MENU_GEM_CENTER.x), workArea.x),
      workArea.x + workArea.width - ORB_MENU_WINDOW_WIDTH
    );
    const windowY = Math.min(
      Math.max(Math.round(centerPoint.y - ORB_MENU_GEM_CENTER.y), workArea.y),
      workArea.y + workArea.height - ORB_MENU_WINDOW_HEIGHT
    );

    const orbMenuWindow = new BrowserWindow({
      x: windowX,
      y: windowY,
      width: ORB_MENU_WINDOW_WIDTH,
      height: ORB_MENU_WINDOW_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'orb.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    orbMenuWindow.setAlwaysOnTop(true, 'pop-up-menu');
    orbMenuWindow.setBounds({ x: windowX, y: windowY, width: ORB_MENU_WINDOW_WIDTH, height: ORB_MENU_WINDOW_HEIGHT });
    orbMenuWindow.setContentProtection(true);
    orbMenuWindow.loadFile(path.join(__dirname, '..', 'renderer', 'orb.html'));

    const windowShownAt = Date.now();
    orbMenuWindow.once('ready-to-show', () => {
      if (orbMenuWindow.isDestroyed()) return;
      orbMenuWindow.show();
      orbMenuWindow.focus();
      // The window the user just chose is usually in front, and Windows won't hand focus to
      // us on a plain focus(). Without real focus, Esc and the arrow keys wouldn't work and
      // clicking elsewhere wouldn't close the menu.
      if (this.windowControlService) this.windowControlService.focusOwnWindow(orbMenuWindow);
    });

    // Clicking outside takes focus away, which we treat as a dismiss so the menu never lingers.
    orbMenuWindow.on('blur', () => {
      if (Date.now() - windowShownAt < BLUR_GRACE_PERIOD_MILLISECONDS) {
        if (!orbMenuWindow.isDestroyed()) orbMenuWindow.focus();
        return;
      }
      if (this.onDismiss) this.onDismiss();
    });

    this.orbMenuWindow = orbMenuWindow;
  }

  hideOrbMenu() {
    const orbMenuWindow = this.orbMenuWindow;
    this.orbMenuWindow = null;
    this.onSelectAction = null;
    this.onDismiss = null;
    if (orbMenuWindow && !orbMenuWindow.isDestroyed()) {
      orbMenuWindow.removeAllListeners('blur');
      orbMenuWindow.destroy();
    }
  }
}

module.exports = { OrbMenuManager };
