'use strict';

const { ipcMain } = require('electron');
const { createPopup } = require('./popup');
const { listOpenWindows } = require('./windows');
const settings = require('./settings');

/** Window for adding/removing reminders and configuring background-app nudges. */
class RemindersWindow {
  /** @param {{reminders: import('./reminders').Reminders}} deps */
  constructor({ reminders }) {
    this.reminders = reminders;
    this.window = null;
    this.registerIpc();
  }

  open() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }
    const win = createPopup({
      htmlFile: 'reminders.html',
      preloadFile: 'reminders.js',
      width: 440,
      height: 680,
      title: 'ClickIt Reminders',
    });
    this.window = win;
    win.on('closed', () => {
      if (this.window === win) this.window = null;
    });
  }

  close() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  registerIpc() {
    // Reject calls from any window other than the reminders window.
    const handle = (channel, fn) =>
      ipcMain.handle(channel, (event, ...args) => {
        if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents) {
          throw new Error('Not allowed.');
        }
        return fn(...args);
      });

    handle('reminders:list', () => this.reminders.list());
    handle('reminders:add', ({ text, minutes } = {}) => this.reminders.add(text, minutes));
    handle('reminders:remove', (id) => this.reminders.remove(String(id)));
    handle('reminders:windows', () => listOpenWindows());
    handle('reminders:get-nudge', () => settings.load().nudgeMinutes);
    handle('reminders:set-nudge', (minutes) => {
      const { nudgeMinutes } = settings.sanitize({ nudgeMinutes: Number(minutes) });
      const value = nudgeMinutes ?? 0;
      settings.update({ nudgeMinutes: value });
      this.reminders.setNudgeMinutes(value);
      return value;
    });
    handle('reminders:check-now', () => this.reminders.nudge());
    ipcMain.on('reminders:close', (event) => {
      if (this.window && event.sender === this.window.webContents) this.close();
    });
  }
}

module.exports = { RemindersWindow };
