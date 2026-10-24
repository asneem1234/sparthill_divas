'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickitSelector', {
  captureArea: (rect) => ipcRenderer.send('selector:capture', rect),
  cancel: () => ipcRenderer.send('selector:cancel'),
});
