const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickItPanel', {
  getState: () => ipcRenderer.invoke('panel:get-state'),
  onState: (handler) => ipcRenderer.on('panel:state', (event, panelState) => handler(panelState)),
  sendAction: (type, value) => ipcRenderer.send('panel:action', { type, value }),
  reportContentHeight: (contentHeight) => ipcRenderer.send('panel:content-height', contentHeight),
});
