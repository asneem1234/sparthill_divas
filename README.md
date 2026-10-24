# ClickIt

A Windows tray app (Electron) that sees your screen, answers questions with Google Gemini, speaks the reply, and points at things with a cursor buddy. It talks to Gemini through a small Cloudflare Worker so the API key never ships in the app.

```
clicky/worker/     Cloudflare Worker: /chat (streaming) and /transcribe (voice -> text)
clicky-windows/    Electron app
```

## Quick start (no Cloudflare needed)

```powershell
cd "C:\Users\ASUS\Desktop\Spartan divas\clicky-windows"
npm.cmd install
npm.cmd start
```

The app reads `GEMINI_API_KEY` from `clicky-windows\.env` (git-ignored) and calls Gemini directly. Leave **Worker URL** empty in the panel. `npm.cmd run test:gemini` checks the key and model from the command line.

## Optional: use the Cloudflare Worker instead

If you paste a Worker URL in the panel, the app uses the Worker and the key stays on Cloudflare. To deploy it:

1. Put your Gemini key in `clicky/worker/.env` (`GEMINI_API_KEY=...`). For local `wrangler dev`, also put it in `clicky/worker/.dev.vars`. Both files are git-ignored.
2. Deploy the worker:
   ```powershell
   cd clicky\worker
   npm install
   npx wrangler login
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler deploy
   ```
   Copy the printed `https://....workers.dev` URL.
3. Run the app:
   ```powershell
   cd clicky-windows
   npm install
   npm start
   ```
4. Open the panel from the tray icon, paste the Worker URL, pick a model, Save.

To check a running worker: `powershell -File clicky\worker\scripts\smoke-test.ps1 -BaseUrl <url>`.

## Using it

| Action | How |
|---|---|
| Radial menu | Tap Left Ctrl + Left Alt, or press Ctrl + Alt + M, or use the panel's Actions buttons or the tray menu. Optional: double-click anywhere, enabled in the panel. |
| Voice | Left Ctrl + Left Alt + Space starts recording, press again to send. Also the Voice gem. |
| Snap the screen | Camera gem. Opens a Snap window with the image, an automatic description, follow-up questions, Copy text / Copy image / Save image (saved to Pictures\ClickIt). |
| Snap a region | Scissors gem, then drag a rectangle. Same Snap window. |
| Translate | Globe gem, then drag over the text. Translates it into the language in the panel's "Translate to" field; change the language in the window and press Translate to redo it. |
| Reminders | Clock gem. Timed reminders (including "go back to this open window"), plus optional notifications every N minutes listing apps left open in the background. Delivered as a Windows notification and spoken aloud. |
| Typed question with pointing | Type in the panel. The reply is spoken and the cursor buddy can point at things. |
| Close menu | Esc or click outside. |

If the native keyboard hook (`uiohook-napi`) fails to load, the fallbacks are Ctrl+Alt+M (menu) and Ctrl+Alt+Space (voice).

Background-app reminders list windows that Windows reports. For browsers that is only the active tab's title, not every tab.

## Models

Models are chosen in the panel. `gemini-3.5-flash` and `gemini-3.8-flash` work with the project's key. `gemini-2.5-flash` is listed but the API rejects it for new accounts (404), so it is not offered. Model availability varies per key, so check `GET https://generativelanguage.googleapis.com/v1beta/models` if a request returns 404.

## Notes

- Voice recordings are sent to the Worker, which sends them to Gemini for transcription. Replies are spoken with the Windows system voice.
- Screenshots are sent to Gemini with every question. The app's own overlay windows are excluded from capture.
- Rotate your Gemini key if it was ever pasted somewhere public.
