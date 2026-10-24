'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const FRAME_INTERVAL_MS = 16;
const FOLLOW_OFFSET = { x: 16, y: 20 };
const FOLLOW_SMOOTHING = 0.35;
const HOLD_MS = 3200;
const REST_ANGLE = -35;

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Owns one transparent, click-through window per display and animates the
 * blue triangle across them. Animation state lives here (not in the windows)
 * so the triangle can fly between monitors.
 */
class Overlay {
  constructor() {
    this.windows = new Map(); // display.id -> BrowserWindow
    this.position = { x: 0, y: 0 };
    this.angle = REST_ANGLE;
    this.mode = 'idle'; // idle | listening | processing | responding
    this.audioLevel = 0;
    this.enabled = true;
    this.flight = null;
    this.timer = null;
    this.hasPosition = false;
  }

  start() {
    this.syncWindows();
    screen.on('display-added', () => this.syncWindows());
    screen.on('display-removed', () => this.syncWindows());
    screen.on('display-metrics-changed', () => this.syncWindows());
    this.timer = setInterval(() => this.tick(), FRAME_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
    for (const window of this.windows.values()) window.destroy();
    this.windows.clear();
  }

  setMode(mode) {
    this.mode = mode;
  }

  setAudioLevel(level) {
    this.audioLevel = level;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /** Whether a pointing flight (fly, hold, or return) is in progress. */
  get isPointing() {
    return this.flight !== null;
  }

  /** Flies the triangle to a global DIP coordinate and holds there briefly. */
  pointTo(target, label) {
    this.flight = {
      phase: 'flying',
      from: { ...this.position },
      to: target,
      label: label || '',
      startedAt: Date.now(),
      duration: 0,
    };
    this.flight.duration = this.flightDuration(this.flight.from, target);
  }

  flightDuration(from, to) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    return Math.min(1400, Math.max(500, distance * 0.9));
  }

  syncWindows() {
    const displays = screen.getAllDisplays();
    const liveIds = new Set(displays.map((display) => display.id));

    for (const [id, window] of this.windows) {
      if (!liveIds.has(id)) {
        window.destroy();
        this.windows.delete(id);
      }
    }

    for (const display of displays) {
      let window = this.windows.get(display.id);
      if (!window || window.isDestroyed()) {
        window = this.createWindow(display);
        this.windows.set(display.id, window);
      } else {
        window.setBounds(display.bounds);
      }
    }
  }

  createWindow(display) {
    const window = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    window.setAlwaysOnTop(true, 'screen-saver');
    window.setIgnoreMouseEvents(true);
    // Keeps the overlay out of screenshots (WDA_EXCLUDEFROMCAPTURE on Windows).
    window.setContentProtection(true);
    window.setVisibleOnAllWorkspaces(true);
    window.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
    window.once('ready-to-show', () => {
      window.showInactive();
      // Re-apply bounds after show: mixed-DPI setups can offset the first placement.
      window.setBounds(display.bounds);
    });
    return window;
  }

  tick() {
    const cursor = screen.getCursorScreenPoint();
    const followTarget = { x: cursor.x + FOLLOW_OFFSET.x, y: cursor.y + FOLLOW_OFFSET.y };

    if (!this.hasPosition) {
      this.position = { ...followTarget };
      this.hasPosition = true;
    }

    let label = '';
    let scale = 1;

    if (this.flight) {
      const result = this.advanceFlight(followTarget);
      label = result.label;
      scale = result.scale;
    } else {
      this.position.x += (followTarget.x - this.position.x) * FOLLOW_SMOOTHING;
      this.position.y += (followTarget.y - this.position.y) * FOLLOW_SMOOTHING;
      this.angle += (REST_ANGLE - this.angle) * 0.2;
    }

    for (const [displayId, window] of this.windows) {
      if (window.isDestroyed() || window.webContents.isLoading()) continue;
      const bounds = window.getBounds();
      const inside =
        this.enabled &&
        this.position.x >= bounds.x - 40 &&
        this.position.x <= bounds.x + bounds.width + 40 &&
        this.position.y >= bounds.y - 40 &&
        this.position.y <= bounds.y + bounds.height + 40;

      window.webContents.send('overlay:frame', {
        displayId,
        visible: inside,
        x: this.position.x - bounds.x,
        y: this.position.y - bounds.y,
        angle: this.angle,
        scale,
        pointing: this.flight !== null,
        mode: this.mode,
        level: this.audioLevel,
        label,
      });
    }
  }

  advanceFlight(followTarget) {
    const flight = this.flight;
    const elapsed = Date.now() - flight.startedAt;
    let label = '';
    let scale = 1;

    if (flight.phase === 'flying' || flight.phase === 'returning') {
      const destination = flight.phase === 'flying' ? flight.to : followTarget;
      const progress = Math.min(1, elapsed / flight.duration);
      const eased = easeInOutCubic(progress);

      // Quadratic bezier with the control point lifted above the midpoint for an arc.
      const mid = { x: (flight.from.x + destination.x) / 2, y: (flight.from.y + destination.y) / 2 };
      const distance = Math.hypot(destination.x - flight.from.x, destination.y - flight.from.y);
      const control = { x: mid.x, y: mid.y - distance * 0.25 };

      const point = (t) => ({
        x: (1 - t) * (1 - t) * flight.from.x + 2 * (1 - t) * t * control.x + t * t * destination.x,
        y: (1 - t) * (1 - t) * flight.from.y + 2 * (1 - t) * t * control.y + t * t * destination.y,
      });

      const next = point(eased);
      const ahead = point(Math.min(1, eased + 0.02));
      if (Math.hypot(ahead.x - next.x, ahead.y - next.y) > 0.01) {
        // Triangle's tip points up at angle 0, so rotate relative to the travel direction.
        this.angle = (Math.atan2(ahead.y - next.y, ahead.x - next.x) * 180) / Math.PI + 90;
      }
      this.position = next;
      scale = 1 + 0.35 * Math.sin(progress * Math.PI);

      if (progress >= 1) {
        if (flight.phase === 'flying') {
          flight.phase = 'holding';
          flight.startedAt = Date.now();
        } else {
          this.flight = null;
        }
      }
    } else if (flight.phase === 'holding') {
      this.position = { ...flight.to };
      this.angle += (REST_ANGLE - this.angle) * 0.2;
      label = flight.label;
      scale = 1.1 + 0.06 * Math.sin(elapsed / 160);

      if (elapsed >= HOLD_MS) {
        flight.phase = 'returning';
        flight.from = { ...this.position };
        flight.startedAt = Date.now();
        flight.duration = this.flightDuration(flight.from, followTarget);
      }
    }

    return { label, scale };
  }
}

module.exports = { Overlay };
