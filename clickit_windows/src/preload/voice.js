const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickItVoice', {
  getConfig: () => ipcRenderer.invoke('voice:get-config'),
  lookAtScreen: () => ipcRenderer.invoke('voice:look-at-screen'),
  reportError: (message) => ipcRenderer.send('voice:error', message),
  moveBy: (dx, dy) => ipcRenderer.send('voice:move', { dx, dy }),
  showMenu: (iconState) => ipcRenderer.send('voice:context-menu', iconState),
  onCommand: (handler) => ipcRenderer.on('voice:command', (event, commandName) => handler(commandName)),
  close: () => ipcRenderer.send('voice:close'),
});
