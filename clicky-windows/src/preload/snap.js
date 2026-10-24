'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickitSnap', {
  onInit: (handler) => ipcRenderer.on('snap:init', (_event, payload) => handler(payload)),
  onState: (handler) => ipcRenderer.on('snap:state', (_event, payload) => handler(payload)),
  onNotice: (handler) => ipcRenderer.on('snap:notice', (_event, message) => handler(message)),
  ask: (question) => ipcRenderer.send('snap:ask', question),
  translate: (language) => ipcRenderer.send('snap:translate', language),
  copyText: (text) => ipcRenderer.send('snap:copy-text', text),
  copyImage: () => ipcRenderer.send('snap:copy-image'),
  saveImage: () => ipcRenderer.send('snap:save-image'),
  close: () => ipcRenderer.send('snap:close'),
});
