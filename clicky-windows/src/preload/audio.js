'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INCOMING = new Set([
  'audio:start',
  'audio:connect',
  'audio:stop',
  'audio:cancel',
  'audio:play',
  'audio:stop-playback',
  'audio:speak-fallback',
]);
const OUTGOING = new Set([
  'audio:transcript',
  'audio:error',
  'audio:level',
  'audio:playback-started',
  'audio:playback-ended',
]);

contextBridge.exposeInMainWorld('clickyAudio', {
  on(channel, handler) {
    if (!INCOMING.has(channel)) throw new Error(`Unknown channel: ${channel}`);
    ipcRenderer.on(channel, (_event, payload) => handler(payload));
  },
  send(channel, payload) {
    if (!OUTGOING.has(channel)) throw new Error(`Unknown channel: ${channel}`);
    ipcRenderer.send(channel, payload);
  },
});
