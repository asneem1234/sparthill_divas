'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickitReminders', {
  list: () => ipcRenderer.invoke('reminders:list'),
  add: (text, minutes) => ipcRenderer.invoke('reminders:add', { text, minutes }),
  remove: (id) => ipcRenderer.invoke('reminders:remove', id),
  windows: () => ipcRenderer.invoke('reminders:windows'),
  getNudge: () => ipcRenderer.invoke('reminders:get-nudge'),
  setNudge: (minutes) => ipcRenderer.invoke('reminders:set-nudge', minutes),
  checkNow: () => ipcRenderer.invoke('reminders:check-now'),
  close: () => ipcRenderer.send('reminders:close'),
});
