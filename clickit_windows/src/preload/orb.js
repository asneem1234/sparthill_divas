const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickItOrb', {
  getActions: () => ipcRenderer.invoke('orb:get-actions'),
  selectAction: (actionIdentifier) => ipcRenderer.send('orb:select', actionIdentifier),
  dismiss: () => ipcRenderer.send('orb:dismiss'),
});
