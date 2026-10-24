'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickitRadial', {
  selectAction: (action) => ipcRenderer.send('radial:select', action),
  close: () => ipcRenderer.send('radial:close'),
});
