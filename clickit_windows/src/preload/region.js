const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickItRegion', {
  onInit: (handler) => ipcRenderer.on('region:init', (event, initialPayload) => handler(initialPayload)),
  confirm: (selectedRectangle) => ipcRenderer.send('region:confirm', selectedRectangle),
  cancel: () => ipcRenderer.send('region:cancel'),
});
