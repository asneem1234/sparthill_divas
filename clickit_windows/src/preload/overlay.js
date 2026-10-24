const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickItOverlay', {
  getInitialState: () => ipcRenderer.invoke('overlay:get-initial-state'),
  onOverlayState: (handler) => ipcRenderer.on('overlay:state', (event, overlayState) => handler(overlayState)),
  onCursorLocation: (handler) => ipcRenderer.on('overlay:cursor', (event, cursorLocation) => handler(cursorLocation)),
  onAudioPowerLevel: (handler) => ipcRenderer.on('overlay:audio-level', (event, level) => handler(level)),
  onFadeOut: (handler) => ipcRenderer.on('overlay:fade-out', (event, durationSeconds) => handler(durationSeconds)),
  sendEvent: (overlayEvent) => ipcRenderer.send('overlay:event', overlayEvent),
});
