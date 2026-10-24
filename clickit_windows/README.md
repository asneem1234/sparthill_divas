# Click It: an AI that lives in your cursor

> Pitch deck. Setup and usage docs start [further down](#click-it-for-windows-setup-and-guide).

---

## 1. The one-liner

**Click It is a small pink cursor that sees the window you choose, hears you, answers out loud, and points at what it is talking about.** Before anything is sent to the AI, it checks for private content on your PC.

---

## 2. The problem

Learning and getting unstuck on a computer is still a copy-paste chore.

- **Context switching.** You hit an error, a confusing form, a foreign-language page. To ask an AI, you leave your app, open a chat tab, and describe what you are looking at.
- **Describing a screen is hard.** "The third button on the left, under the red banner" is slower than just showing it.
- **Text answers don't point.** Even a good answer makes you hunt for the thing it mentions.
- **Typing breaks flow.** Hands are busy, eyes are on the work, and a chat box wants your full attention.
- **Trust is the blocker.** "Screen-aware" AI means sending screenshots to a third party. Passwords, API keys, card numbers and private messages are one stray window away. Most tools either ignore this or ask you to trust them.

---

## 3. The solution

An AI companion that lives where you already are: **the cursor**.

| You do | Click It does |
|---|---|
| Hold **Left Ctrl + Left Alt** and ask a question | Hears you, looks at your screen, answers out loud, and **flies a pink cursor to the thing it means** |
| Tap **Ctrl + Shift** | Asks **which window** it may look at (live previews), jumps to it, and shows the gems: **Snap, Ask / Explain, Translate, Privacy Guard, Voice chat** |
| Start **Voice chat** | A tiny hovering icon. Talk hands-free, voice to voice. Ask "what's on my screen?" and it looks once, then answers |

No window to manage, no tab to switch to. You talk, it helps, it points.

---

## 4. Why Click It

**1. It points.** Answers end with a pointer tag (`[POINT:x,y:label]`). The cursor flies to the exact spot and returns. "Where is the export button?" gets a finger, not a paragraph.

**2. Privacy is the product, not a footnote.** Before anything is sent to the AI:
- You choose the window; only that window is captured.
- The capture is read **on your PC** with Windows' built-in text recognition (nothing downloaded, nothing uploaded).
- Private keys, API keys, passwords, card numbers, SSN / Aadhaar / PAN numbers, recovery phrases, password-manager windows are **hard-blocked**: the AI is never called and nothing can override it.
- Sign-in forms and one-time codes **ask first**.
- Voice chat is stricter still: anything suspicious is withheld, and the AI is told so.

**3. No keys in the app.** The app talks to a small Cloudflare Worker that holds the Gemini key. The app ships with none.

**4. Voice-first and hands-free.** Push-to-talk for quick questions, a streaming voice-to-voice chat for conversations, with barge-in (talk over it to interrupt).

**5. Free to try.** Runs on a free Gemini API key.

**6. Built for Windows.** The idea comes from a macOS app; this is a ground-up Windows build (tray, global hotkeys, per-monitor overlay, window switching).

---

## 5. How it works

```
 You: hold hotkey, speak
        |
        v
 [ Mic 16 kHz PCM ] --> Worker /transcribe --> text
        |
        v
 [ Window picker ] --> [ Capture ] --> [ On-device OCR + secret scan ] --+--> blocked: AI never called
                                                                         |
                                                                         +--> clean: screenshot + text --> Worker /chat (Gemini 2.5 Flash, streamed)
                                                                                                              |
                                      [ Cursor flies to the spot ] <-- parse [POINT:x,y:label] <-- spoken answer
```

**Voice chat (hands-free):**

```
 Mic --> WebSocket --> Worker /live (adds the key, allows only live models) --> Gemini Live --> spoken audio --> Speaker
                                                                                  |
                                       "look at my screen" --> tool call --> capture + on-device check --> one screenshot (or "held back")
```

---

## 6. Product tour

| Feature | What it does |
|---|---|
| **Pink cursor overlay** | Click-through overlay on every monitor; the buddy follows your mouse, shows its state, and flies to targets on a curved path |
| **Push-to-talk** | Hold Left Ctrl + Left Alt; release to send. Silent or accidental presses are never uploaded |
| **Window picker** | Live previews of open windows. Blocked windows (password managers, ".env", etc.) can't be chosen |
| **Snap** | Like the Windows screenshot tool: freeze the screen, drag a rectangle, get an explanation and follow-ups |
| **Ask / Explain** | Type a question about the window or your copied text |
| **Translate** | Translate copied text, or everything in the window, into any language |
| **Privacy Guard** | Scans a window for sensitive data before you share it. Reports findings from your PC without sending them anywhere |
| **Voice chat** | Floating icon, voice to voice, interruptible, screen-aware on request, mute / drag / voice menu |

---

## 7. Technical stack

| Layer | Technology | Why |
|---|---|---|
| **App shell** | **Electron 33** (Node.js), tray-only app | Fast path to a polished native-feeling Windows app: tray, transparent overlays, global shortcuts |
| **Global hotkeys** | **uiohook-napi 1.5.5** (native keyboard hook) with a fallback shortcut | Push-to-talk needs key *down* and key *up*, which Electron's own shortcuts can't give |
| **Vision + chat model** | **Gemini 2.5 Flash** (streamed over SSE) | Fast, multimodal, free-tier friendly |
| **Voice to voice** | **Gemini Live API** over WebSocket (`gemini-3.1-flash-live-preview`, with automatic fallback to three other live models) | One streaming connection per conversation instead of three requests per turn, which fits the free tier |
| **Tool use** | Gemini **function calling** (`look_at_screen`) | The model decides when the screen is needed; nothing is captured otherwise |
| **Backend** | **Cloudflare Worker** (TypeScript, Wrangler) with `/chat`, `/transcribe` and a `/live` WebSocket proxy | Keeps the API key off the device; `/live` only lets Gemini live models through |
| **Speech in** | Web Audio **AudioWorklet**, 16 kHz mono PCM16, echo cancellation | Low-latency capture in Chromium |
| **Speech out** | Streamed 24 kHz PCM scheduled through an `AudioContext`, with instant barge-in; Windows system voice for push-to-talk replies | Natural voice, interruptible |
| **Screen capture** | Electron `desktopCapturer`, per-window and per-region, JPEG capped at 1280 px | Capture only what was chosen |
| **On-device privacy check** | **Windows built-in OCR** (via a persistent PowerShell host) + a rule engine for secrets (`sensitiveContent.js`) + masking (`redact.js`) | Nothing sensitive leaves the PC to find out whether it is sensitive |
| **Window control** | Win32 calls via PowerShell: switch to a window, read its bounds | "Take me to that window" |
| **Own-window exclusion** | `setContentProtection` so Click It's overlays never appear in screenshots | The AI never sees its own UI |
| **Security hardening** | `contextIsolation`, sandboxed renderers, strict CSP per page, navigation and pop-up blocking, mic permission only for bundled pages, secrets in a git-ignored `.dev.vars` | Defense in depth |
| **Testing** | Unit checks (`npm run check`) plus Electron end-to-end harnesses with synthetic speech (Windows SAPI) and canned screenshots, so tests never read a real screen | Repeatable without touching private content |

**Notable engineering details**
- The privacy gate is enforced **in the main process**: the AI request code refuses to run until the check has passed, so the UI can't skip it.
- Gemini Live answers about a screenshot correctly only if the image arrives *before* the tool reply *and* a follow-up message tells the model to answer. Found by testing four models; encoded in `renderer/voice.js`.
- Speech models invent text for silence, so silent recordings are never uploaded.
- Long voice chats use sliding-window context compression and session resumption to survive connection limits.

---

## 8. Honest limits today

- **Demo-grade build.** Not packaged, signed, or installable yet; run it with `npm start`.
- **Local worker has no user authentication.** Fine on `localhost` for a demo. A public deployment needs sign-in and rate limiting first.
- **Free-tier limits** (about 5 requests a minute on 2.5 Flash) and **preview Live models** that Google can change or retire.
- **Free-tier terms:** Google may use what you send. Click It's privacy check reduces what leaves the PC; it does not change those terms.
- **The privacy check is a safety net, not a guarantee.** Secrets inside images, or passwords shown as dots, can slip past OCR.
- **Browser tabs:** Windows can't jump to a background tab, so you pick the window showing the tab you want.
- **Transcription** uploads the finished recording rather than streaming it live (push-to-talk only; voice chat streams).

---

## 9. Future enhancements

**Near term**
- **Installer and auto-update** (code-signed), so people can install it instead of running from source.
- **Real accounts and a hosted worker** with authentication, per-user rate limits and usage caps.
- **Live-streaming transcription** for push-to-talk, to cut latency.
- **Settings screen** for voice, hotkeys, language and which models to use.
- **Better local detection:** more document types and regional ID formats, plus image-based secret detection.

**Next**
- **Privacy-first local mode:** on-device speech and a small local vision model, so nothing leaves the PC.
- **More tools for the voice agent:** read the clipboard, open an app, fill a form field *with your approval*, set a reminder.
- **Teach-me mode:** step-by-step walkthroughs where the cursor guides you click by click and checks you did it.
- **Proactive help:** notice an error dialog and offer help, never uploading until you agree.
- **Memory:** remember your preferences and what you were working on, stored locally and clearable.
- **Accessibility:** screen-reader-friendly status, larger / high-contrast cursor, captions for the voice chat on demand.

**Later**
- **Team and education versions:** admin-set privacy policies (blocked apps, blocked patterns).
- **macOS and Linux parity** from one shared core.
- **Plug-in actions** so developers can add their own gems.

---

## 10. Why now

- Multimodal models can finally read screens well enough to be useful.
- Live voice APIs make natural, interruptible conversation cheap, and available on a free key.
- People are rightly more wary about what "screen-aware AI" sends away. A product that **proves** it checks first has an edge.

---

## 11. The ask / what's next

This is a working demo built to show that a screen-aware voice companion can be **useful and private at the same time**.

**Next steps:** package an installer, host the worker with sign-in, run a small user test with 10 people, and measure how often the pointing saves them a search.

---

## 12. Demo script (2 minutes)

1. Click the tray icon, press **Start**. The cursor says hi.
2. Hold **Left Ctrl + Left Alt**, ask "how do I save this as a PDF?" in any app. The cursor flies to the right menu item.
3. Tap **Ctrl + Shift**, pick a window. Click **Snap**, drag a box around an error, get an explanation.
4. Open a window with a fake password on it and click **Privacy Guard** or **Ask**. It is blocked on your PC, and the AI is never called.
5. Start **Voice chat**. Say "explain what's on my screen". The icon sweeps, then it answers out loud. Interrupt it mid-sentence.

---

## Submission answers

### 1. What problem are you solving?

Getting help from an AI while you work on a computer is slow and awkward. You leave your app, open a chat, and try to describe what is on your screen ("the third button, under the red banner"). The answer comes back as a paragraph you then have to match to the screen. Typing also breaks your flow.

There is a second problem behind it: **trust**. A screen-aware AI means sending screenshots to a third party, and one stray window can hold a password, an API key, a card number or a private message. Most tools either ignore this or ask you to trust them.

### 2. Who experiences this problem?

- **People learning software or a new tool**, who often don't know the words to search for.
- **Anyone hitting an error or a confusing form** who just wants "what does this mean and where do I click?".
- **People reading or working in a language they don't fully know**, who need a quick translation of what is on screen.
- **People who are busy with their hands or eyes**, or who find typing hard, and benefit from hands-free voice.
- **Anyone who shares or screenshots their screen** and worries about leaking something sensitive.

### 3. What does your solution do?

Click It is an AI that lives in your cursor (a Windows tray app with a small pink cursor).

- **Ask by voice.** Hold Left Ctrl + Left Alt, ask a question, release. It hears you, looks at the window you chose, answers out loud, and **flies the cursor to the exact thing it is talking about**.
- **Choose what it can see.** Tap Ctrl + Shift to pick one window. Only that window is captured. Then use the gems: **Snap** (drag a box around something and get it explained), **Ask / Explain**, **Translate**, **Privacy Guard**.
- **Voice chat.** A tiny hovering icon for hands-free, voice-to-voice conversation. You can interrupt it, and when you ask about your screen it looks once and answers out loud.
- **Privacy first.** Before anything is sent to the AI, the capture is read **on your PC** (Windows' built-in text recognition) and checked for passwords, keys, card numbers, ID numbers and similar. Those are blocked and the AI is never called. Sign-in forms ask first. In voice chat, anything suspicious is simply not sent.

### 4. How does AI contribute to your solution?

AI is the core of what Click It does:

- **Speech to text:** Gemini transcribes what you say in push-to-talk.
- **Seeing and explaining:** Gemini 2.5 Flash is multimodal. It reads the screenshot and your question together, explains, translates, and checks content. It also outputs a pointer tag (`[POINT:x,y:label]`) so the cursor can fly to the right spot.
- **Voice to voice:** The Gemini Live API streams your voice in and its voice out, with natural turn-taking and interruption.
- **Deciding when to look:** In voice chat, the model uses function calling (`look_at_screen`) to decide when it needs the screen. If you don't ask about the screen, nothing is captured.

The privacy gate is deliberately **not** left to the AI. It runs locally with OCR and rules, so a model can't talk its way past it.

### 5. What technologies, tools, frameworks, or datasets did you use?

- **App:** Electron 33 (Node.js, JavaScript), tray-only app with transparent click-through overlays on every monitor.
- **Global hotkeys:** uiohook-napi 1.5.5 (native keyboard hook) for push-to-talk key down and up.
- **AI models:** Gemini 2.5 Flash (chat and vision, streamed over SSE) and the Gemini Live API over WebSocket (`gemini-3.1-flash-live-preview` with automatic fallback to three other live models), using a free Gemini API key.
- **Backend:** a Cloudflare Worker (TypeScript, Wrangler) with `/chat`, `/transcribe` and a `/live` WebSocket proxy. It keeps the API key off the device and only lets Gemini live models through.
- **Audio:** Web Audio API and AudioWorklet (16 kHz mic capture, 24 kHz streamed playback), echo cancellation, the Windows system voice for push-to-talk replies.
- **Screen and windows:** Electron `desktopCapturer`, Win32 calls through PowerShell for switching windows, and `setContentProtection` so Click It's own UI never appears in screenshots.
- **On-device privacy:** Windows built-in OCR plus a custom rule engine for secrets and masking.
- **Security:** `contextIsolation`, sandboxed renderers, strict Content Security Policy, navigation blocking, mic permission only for bundled pages, secrets kept in a git-ignored file.
- **Testing:** unit checks and Electron end-to-end tests using synthetic speech (Windows SAPI) and canned screenshots, so tests never read a real screen.
- **Datasets:** none. Click It uses pre-trained models and does not train or fine-tune anything.

### 6. What impact could your solution create?

- **Less friction and faster answers.** Asking without leaving your app, and being shown where to click, can save the search-and-translate loop that people go through many times a day.
- **Easier learning.** Showing the exact spot instead of describing it helps beginners, and the pointing works across any app, not just one product.
- **Safer screen-aware AI.** It demonstrates that an assistant can be useful *and* check for private content before anything leaves the PC, instead of asking people to trust it blindly.
- **More accessible.** Hands-free voice and translation help people who find typing hard or who work in a second language.
- **Low barrier.** It runs on a free API key, so students and individuals can try it.

These are expected benefits. I haven't measured them yet: the first step would be a small user test (for example 10 people) to see how often pointing saves a search.

### 7. What are its limitations and potential next steps?

**Limitations**
- It's a **demo-grade build**: run from source, not packaged, signed or installable yet.
- The local worker has **no user sign-in or rate limiting**. That's fine on `localhost` but must be added before any public deployment.
- **Free-tier limits** (about 5 requests a minute on 2.5 Flash), and the live voice models are **previews** that Google can change or retire.
- On the free tier, Google may use what is sent. The privacy check reduces what leaves the PC, but it doesn't change those terms.
- The privacy check is a **safety net, not a guarantee**: a secret inside an image, or a password shown as dots, can slip past OCR, and harmless content is sometimes flagged.
- Windows can't jump to a background browser tab, so you pick the window that shows the tab you want.
- Push-to-talk uploads the finished recording instead of streaming it, so there is a short delay.
- Tested with synthetic speech and canned screenshots; it needs more real-world testing with real microphones, speakers and accents.

**Next steps**
- A signed installer with auto-update, and a hosted worker with accounts, rate limits and usage caps.
- Streaming transcription for push-to-talk, and a settings screen (voice, hotkeys, language, model).
- Stronger local detection (more ID formats, secrets inside images).
- A privacy-first local mode with on-device speech and vision.
- More voice-agent tools with the user's approval (clipboard, open an app, fill a field), a step-by-step teach-me mode, and local, clearable memory.
- Team and education versions with admin-set privacy rules, then macOS and Linux parity.

---

# Click It for Windows: setup and guide


Click It is an AI that lives in your cursor. This is the Windows version of the macOS `clicky` app. It sits in the system tray, listens when you hold a hotkey, looks at your screen, answers out loud, and flies a small pink cursor to whatever it is talking about.

It follows the Mac app's design (panel, cursor overlay, Click It gemstone menu, onboarding) and talks to a small Cloudflare Worker in `worker/` (a copy of the Mac app's Gemini worker plus a voice route), so no API keys live in the app.

## Run it

You need Node.js 18 or newer.

1. Start the worker (it holds the Gemini key). From the repo root:

   ```powershell
   cd clickit_windows\worker
   npm install
   # put GEMINI_API_KEY=... in clickit_windows\worker\.dev.vars (see .dev.vars.example; it is git-ignored)
   npx wrangler dev --port 8787 --ip 127.0.0.1
   ```

   This serves `http://localhost:8787`, which is the app's default. To use a deployed worker instead, paste its URL into the **Worker** field in the panel.

2. Start the app:

   ```powershell
   cd clickit_windows
   npm install
   npm start
   ```

3. Click the pink triangle in the system tray (it may be under the `^` overflow arrow). Allow the microphone and press **Start**. The cursor says hi, flies to something on your screen, then invites you to hold the hotkey and talk.

## Using it

| Action | How |
|---|---|
| Talk | Hold **Left Ctrl + Left Alt**, speak, release |
| Click It menu | Tap **Ctrl + Shift**, or use the panel button or tray menu |
| Dismiss the menu | Esc, the center orb, or click anywhere else |

### Click It: choose a window first

Tap **Ctrl + Shift** and Click It asks **which window it may look at**, with live previews. Only the one you pick is captured.

When you pick one, Click It **switches straight to that window** and shows the gems **on top of it**, with a typed "hi, i'm click it. ai living in your cursor." greeting. Browser windows show whichever tab is open, so switch to the tab you want before you pick it (Windows can't jump to a background tab). Minimized windows aren't listed.

Then pick a gemstone and a result window opens with the answer. Copy text first (Ctrl+C) and Ask, Translate and Privacy Guard will use it; click the ✕ on the "Using copied text" chip to ignore it.

| Gem | What it does |
|---|---|
| Snap | Works like the Windows screenshot tool: the screen freezes, you **drag a rectangle** around what you want and press **Snap** (or Enter). It explains that area and takes follow-up questions. Esc, Cancel or right-click backs out, and nothing is captured or sent |
| Ask / Explain | Type a question about the window or the copied text |
| Translate | Translates the copied text, or all the text in the window, into the language you pick (remembered for next time) |
| Privacy Guard | Checks the window (and copied text) for passwords, keys, cards and personal details before you share it. When it finds something it reports it from your PC and sends nothing to the AI |
| Voice chat | A small pink icon you just talk to, hands-free (below). It looks at your screen only when you ask about it |

### Voice chat (voice to voice)

Pick the **Voice chat** gem, press **Voice chat** in the panel, or use **Start voice chat** in the tray menu. There is no window: a small pink icon appears at the bottom right and Click It starts listening. Just talk. It answers out loud, and you can talk over it to interrupt.

- **Ask about your screen.** Say something like "what's on my screen?" or "explain this error". Click It then looks at your screen once, and answers out loud. The icon shows a sweeping light while it looks. If you don't ask about the screen, nothing is captured.
- **Private screens are not sent.** Before a screenshot goes anywhere, it is read on your PC for passwords, keys, card numbers and similar. If anything looks private, or the check can't run, that screen is held back and Click It tells you so. Close the private window and ask again.
- **The icon.** Click it to mute or unmute (grey with a slash when muted). Drag it to move it. Right-click for the menu: mute, start a fresh conversation, pick a voice (one of eight), or end the chat. A grey icon with a red `!` means it isn't connected: click it to reconnect. Details of any problem arrive as a notification.
- It uses the Gemini Live API, so the whole conversation is one streaming connection. That suits the free tier far better than transcribe, then chat, then text-to-speech for every sentence.
- The icon connects to the worker's `/live` route, which adds the API key and only lets Gemini live models through. The key is never in the app.
- The icon never appears in the screenshots, and hold-to-talk is switched off while a voice chat is open.
- **Use headphones.** With speakers, the mic can pick up the reply and Click It may interrupt itself.
- On the free tier Google may use what you say, and any screenshot you ask it to look at, to improve its products. Don't ask about anything you wouldn't put in a free chatbot.
- Models are tried in order if one is unavailable: `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-latest`, `gemini-3.8-live`, then `gemini-2.5-flash-native-audio-preview-12-2025`. They are preview models and can change; the list is in `src/main/voiceChatManager.js`.
- If the free-tier limit is reached, you get a notification; wait a minute and click the icon.

### What stays private

Before anything goes to the AI, Click It reads the window (or, for Snap, the area you dragged) **on your PC** using the text recognition built into Windows (nothing is downloaded or uploaded for this) and looks for secrets:

- **Blocked, no way around it:** private keys, API keys and tokens, `password=...` values, payment card numbers, SSN/Aadhaar/PAN numbers, card security codes, recovery phrases, and windows from password managers (1Password, Bitwarden, KeePass and others) or with titles like "Passwords" or ".env". The AI is never called, and the message shows only a masked hint such as `hu...or`.
- **Asks first:** a sign-in form or a one-time code on screen. You see what was noticed and can choose **Send anyway** or pick another window.
- **Copied text** is checked the same way.
- **Voice questions** are checked too. A screen that looks private is not attached; the assistant is told it can't see it, and the panel tells you.
- If Windows' text recognition can't run, voice questions send no screen, and Click It asks before sending anything.

This is a safety net, not a guarantee. It can miss a secret that is not readable as text (for example one inside an image, or a password typed as dots), and it can occasionally flag harmless content. When in doubt, close the window.

Right Alt is ignored on purpose, because AltGr on many keyboard layouts sends Ctrl + Right Alt.

If the native keyboard hook can't load, the app falls back to **Ctrl + Alt + Space** (press to start, press again to send) and **Ctrl + Alt + M** (menu). The panel shows which shortcuts are active.

Windows blocks global hooks while an app running as administrator has focus. Run Click It elevated if you need the hotkey there.

## How it works

1. Hold the hotkey: the mic records 16 kHz audio.
2. Release: the recording is sent to the worker's `/transcribe` route.
3. Every monitor is screenshotted (longest side 1280px, cursor screen first) and checked on your PC for secrets; screens that look private are left out. The rest are sent with the transcript to `/chat`, which streams the reply back.
4. The reply is spoken. If the worker has a `/tts` route it plays that audio, otherwise it uses the Windows system voice.
5. If the reply ends with `[POINT:x,y:label]`, the cursor flies to that spot and shows a short bubble, then returns to your mouse.

## Differences from the Mac app

- **Transcription** uploads the finished recording instead of streaming live. The repo's worker only has `/transcribe`, not the AssemblyAI token route the Mac app expects.
- **Speech** falls back to the Windows system voice because the worker has no `/tts` route.
- **Permissions**: Windows only gates the microphone. There are no Accessibility or Screen Recording prompts.
- **Not ported**: PostHog analytics and Sparkle auto-updates.
- **Click It actions** (Snap, Ask / Explain, Translate, Privacy Guard) work on Windows. The Mac app only shows a placeholder for them.
- Screenshot exclusion of the app's own windows needs Windows 10 2004 or newer. On older builds the overlay is briefly hidden during capture instead.

## Project layout

```
src/main/        Electron main process
  main.js          app entry, tray-only lifecycle, wiring
  companion.js     state machine: idle -> listening -> processing -> responding
  worker.js        /chat (SSE), /transcribe, optional /tts
  voiceChatManager.js  the voice chat icon + look_at_screen privacy check (renderer/voice.js holds the mic, socket and speaker)
  dictation.js     push-to-talk recording and transcription
  hotkey.js        global shortcuts (uiohook-napi, with fallback)
  capture.js       screenshots: all screens, or one chosen window
  windowPickerManager.js  the "choose what Click It can see" window
  regionSelectorManager.js  Snap's drag-to-select screenshot overlay
  actionsManager.js  Click It gems + the on-device check before any AI call
  sensitiveContent.js  detects secrets in text and in window titles
  privacyFilter.js   keeps private screens out of voice questions
  ocr/             local text recognition (Windows built-in OCR)
  windowControl/   switches to the window you picked and finds where it is
  redact.js        masks secrets in answers
  pointTag.js      [POINT:...] parser and coordinate mapping
  overlayManager.js  per-display click-through cursor overlay windows
  panelManager.js  tray icon and floating panel
  orbMenuManager.js  Click It gemstone menu window
  audioBridge.js   drives the hidden audio window
src/renderer/    panel, overlay, orb, and the hidden audio page
src/preload/     one small contextBridge API per window
scripts/check-*.js        npm run check (parser, redaction, secret detection)
```

Gemini keys on the free tier allow only a few requests per minute (about 5 for 2.5 Flash). One spoken question uses two requests (transcribe and answer). If you hit the limit, the app says so and how long to wait.

Settings are stored in `%APPDATA%\ClickIt\settings.json`. Set `CLICKIT_DEBUG_LOGS=1` to print renderer console output in the terminal.
