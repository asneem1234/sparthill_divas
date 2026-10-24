'use strict';

const fs = require('fs');
const path = require('path');
const { app, clipboard, ipcMain, nativeImage } = require('electron');
const { createPopup } = require('./popup');
const worker = require('./worker');
const settings = require('./settings');

const ASK_SYSTEM_PROMPT =
  'You are looking at a screenshot the user captured. Answer their question about it clearly and ' +
  'concisely in plain text. Do not use markdown formatting.';
const TRANSLATE_SYSTEM_PROMPT =
  'You are a precise translator. You read text from screenshots and translate it. ' +
  'Reply with the translation only, in plain text.';
const AUTO_QUESTION = 'Describe what is in this image and point out anything notable. Keep it short.';

/**
 * The "snap" window: shows a captured image, streams Gemini's answer, lets the
 * user ask follow-ups (or re-translate), and copy/save the result.
 */
class Snap {
  constructor() {
    this.window = null;
    this.kind = 'ask'; // 'ask' | 'translate'
    this.capture = null;
    this.history = [];
    this.abort = null;
    this.run = 0;
    this.registerIpc();
  }

  /** @param {'ask'|'translate'} kind @param {{jpeg: Buffer, label: string}} capture */
  open(kind, capture) {
    this.close();
    this.kind = kind;
    this.capture = capture;
    this.history = [];

    const win = createPopup({
      htmlFile: 'snap.html',
      preloadFile: 'snap.js',
      width: 520,
      height: 640,
      title: kind === 'translate' ? 'ClickIt Translate' : 'ClickIt Snap',
    });
    this.window = win;
    console.log(`[snap] window created (${kind}), bounds=${JSON.stringify(win.getBounds())}`);
    win.on('show', () => console.log('[snap] window shown'));
    win.webContents.on('did-fail-load', (_e, code, description) => {
      console.log(`[snap] failed to load: ${code} ${description}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[snap] renderer gone: ${details.reason}`);
    });
    win.webContents.on('console-message', (_e, _level, message) => {
      console.log(`[snap-renderer] ${message}`);
    });
    win.on('closed', () => {
      console.log('[snap] window closed');
      if (this.window === win) {
        this.abort?.abort();
        this.window = null;
      }
    });

    win.webContents.once('did-finish-load', () => {
      console.log('[snap] loaded');
      const language = settings.load().translateTo;
      this.send('snap:init', {
        kind,
        language,
        preview: `data:image/jpeg;base64,${capture.jpeg.toString('base64')}`,
      });
      if (kind === 'translate') this.translate(language);
      else this.ask(AUTO_QUESTION, true);
    });
  }

  close() {
    this.abort?.abort();
    this.run += 1;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  send(channel, payload) {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, payload);
  }

  ask(question, isAuto = false) {
    return this.query({
      systemPrompt: ASK_SYSTEM_PROMPT,
      userPrompt: question,
      shown: isAuto ? '' : question,
    });
  }

  translate(language) {
    const target = settings.cleanLanguage(language);
    settings.update({ translateTo: target });
    this.history = []; // each translation is independent
    return this.query({
      systemPrompt: TRANSLATE_SYSTEM_PROMPT,
      userPrompt:
        `Translate all the visible text in this image into ${target}. Output only the translation, ` +
        'keeping the original order and line breaks. If the text is already in that language, say so ' +
        'and repeat it. If there is no readable text, reply "No text found."',
      shown: '',
    });
  }

  async query({ systemPrompt, userPrompt, shown }) {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const run = ++this.run;
    this.send('snap:state', { phase: 'loading', question: shown });

    try {
      const text = await worker.streamChat({
        model: settings.load().model,
        systemPrompt,
        history: this.history,
        images: [{ data: this.capture.jpeg, label: this.capture.label }],
        userPrompt,
        signal: controller.signal,
        onText: (partial) => {
          if (run === this.run) this.send('snap:state', { phase: 'streaming', question: shown, text: partial });
        },
      });
      if (run !== this.run) return;
      this.history.push({ userTranscript: userPrompt, assistantResponse: text });
      this.send('snap:state', { phase: 'done', question: shown, text: text.trim() || '(no answer)' });
    } catch (error) {
      if (error.name === 'AbortError' || run !== this.run) return;
      console.error('[snap]', error);
      this.send('snap:state', { phase: 'error', message: error.message || String(error) });
    }
  }

  saveImage() {
    const dir = path.join(app.getPath('pictures'), 'ClickIt');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `snap-${stamp}.jpg`);
    fs.writeFileSync(file, this.capture.jpeg);
    return file;
  }

  registerIpc() {
    const fromSnapWindow = (event) =>
      this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;

    ipcMain.on('snap:ask', (event, question) => {
      if (!fromSnapWindow(event) || this.kind !== 'ask') return;
      const text = String(question || '').trim().slice(0, 2000);
      if (text) this.ask(text);
    });
    ipcMain.on('snap:translate', (event, language) => {
      if (!fromSnapWindow(event) || this.kind !== 'translate') return;
      this.translate(String(language || ''));
    });
    ipcMain.on('snap:copy-text', (event, text) => {
      if (fromSnapWindow(event)) clipboard.writeText(String(text || '').slice(0, 100000));
    });
    ipcMain.on('snap:copy-image', (event) => {
      if (fromSnapWindow(event) && this.capture) {
        clipboard.writeImage(nativeImage.createFromBuffer(this.capture.jpeg));
        this.send('snap:notice', 'Image copied.');
      }
    });
    ipcMain.on('snap:save-image', (event) => {
      if (!fromSnapWindow(event) || !this.capture) return;
      try {
        this.send('snap:notice', `Saved to ${this.saveImage()}`);
      } catch (error) {
        this.send('snap:notice', `Could not save: ${error.message}`);
      }
    });
    ipcMain.on('snap:close', (event) => {
      if (fromSnapWindow(event)) this.close();
    });
  }
}

module.exports = { Snap };
