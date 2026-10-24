'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickyOverlay', {
  onFrame(handler) {
    ipcRenderer.on('overlay:frame', (_event, frame) => handler(frame));
  },
  onCursorSettings(handler) {
    ipcRenderer.on('overlay:cursor-settings', (_event, settings) => handler(settings));
  },
});
