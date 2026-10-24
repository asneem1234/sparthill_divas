const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickItResult', {
  onInit: (handler) => ipcRenderer.on('result:init', (event, initialPayload) => handler(initialPayload)),
  onChunk: (handler) => ipcRenderer.on('result:chunk', (event, accumulatedText) => handler(accumulatedText)),
  onState: (handler) => ipcRenderer.on('result:state', (event, stateUpdate) => handler(stateUpdate)),
  onGate: (handler) => ipcRenderer.on('result:gate', (event, gateUpdate) => handler(gateUpdate)),
  overrideAndSend: () => ipcRenderer.send('result:override'),
  chooseAnotherWindow: () => ipcRenderer.send('result:choose-another'),
  submit: (submission) => ipcRenderer.send('result:submit', submission),
  copy: (textToCopy) => ipcRenderer.send('result:copy', textToCopy),
  close: () => ipcRenderer.send('result:close'),
});
