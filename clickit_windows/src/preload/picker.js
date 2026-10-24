const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickItPicker', {
  onItems: (handler) => ipcRenderer.on('picker:items', (event, items) => handler(items)),
  onError: (handler) => ipcRenderer.on('picker:error', (event, message) => handler(message)),
  select: (sourceId) => ipcRenderer.send('picker:select', sourceId),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
