const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clickItAudio', {
  onRequest(requestHandler) {
    ipcRenderer.on('audio:request', (event, request) => requestHandler(request));
  },
  respond(requestIdentifier, result, errorMessage) {
    ipcRenderer.send('audio:response', { requestIdentifier, result, errorMessage });
  },
  sendAudioPowerLevel(audioPowerLevel) {
    ipcRenderer.send('audio:level', audioPowerLevel);
  },
  sendTextToSpeechState(isPlaying) {
    ipcRenderer.send('audio:tts-state', isPlaying);
  },
});
