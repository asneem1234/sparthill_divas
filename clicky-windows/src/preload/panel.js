'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickyPanel', {
  getState: () => ipcRenderer.invoke('panel:get-state'),
  saveSettings: (patch) => ipcRenderer.invoke('panel:save-settings', patch),
  ask: (text) => ipcRenderer.send('panel:ask', text),
  quit: () => ipcRenderer.send('panel:quit'),
  onStatus: (handler) => ipcRenderer.on('panel:status', (_event, status) => handler(status)),
});
