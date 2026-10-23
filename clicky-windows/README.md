# Clicky for Windows

A Windows port of [Clicky](https://github.com/farzaa/clicky) (MIT). A small blue
cursor buddy lives next to your mouse. Hold a hotkey, ask a question, and it
looks at your screen, answers out loud, and can fly to the thing it's talking about.

This is a new Electron app that follows the macOS app's design. It reuses the
original Cloudflare Worker in `../clicky/worker` unchanged, so your API keys
never ship inside the app.

## How it works

1. Hold **Left Ctrl + Left Alt**. Your voice streams to AssemblyAI.
2. On release, Clicky screenshots every monitor and sends the transcript plus
   screenshots to Claude through your Worker.
3. The reply is spoken with ElevenLabs.
4. If Claude includes a `[POINT:x,y:label]` tag, the triangle flies to that spot.

Right Alt is ignored on purpose, because AltGr on many keyboard layouts sends
Ctrl + Right Alt. If the native keyboard hook can't load, Clicky falls back to a
toggle shortcut: **Ctrl + Alt + Space** to start, again to send.

## Setup

You need Node.js 18+ and a deployed Worker with your own keys.

1. Deploy the Worker (one time). See the main Clicky README for the secrets
   it needs (Anthropic, AssemblyAI, ElevenLabs):

   ```powershell
   cd ..\clicky\worker
   npm install
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put ASSEMBLYAI_API_KEY
   npx wrangler secret put ELEVENLABS_API_KEY
   npx wrangler deploy
   ```

   Set `ELEVENLABS_VOICE_ID` in `wrangler.toml` first.

2. Run the app:

   ```powershell
   cd clicky-windows
   npm install
   npm start
   ```

3. Click the Clicky icon in the system tray (it may be under the `^` overflow
   arrow), paste your Worker URL, and press Save. You can also type a question
   in the panel instead of using the mic.

Allow microphone access if Windows asks.

## Project layout

```
src/main/        Electron main process
  main.js          tray, windows, IPC wiring
  companion.js     state machine: idle -> listening -> processing -> responding
  worker.js        Claude (SSE), TTS, and transcription-token calls via the Worker
  capture.js       multi-monitor screenshots and screenshot -> screen coordinates
  overlay.js       click-through overlay windows and the cursor animation
  hotkey.js        push-to-talk (uiohook-napi, with a toggle fallback)
  pointTag.js      parser for [POINT:...] tags
  prompt.js        system prompt
src/renderer/    audio.* (mic, AssemblyAI, playback), overlay.*, panel.*
src/preload/     contextBridge APIs, one per window
```

## Notes

- The overlay windows are excluded from screen capture, so Claude only sees your content.
- Settings are stored in `%APPDATA%\clicky-windows\settings.json`.
- `npm run check` runs a quick test of the POINT tag parser.
- Differences from the macOS app: no onboarding flow, no analytics, no
  response-text bubble near the cursor, and no packaged installer yet.
