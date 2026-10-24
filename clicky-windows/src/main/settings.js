'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // Base URL of your deployed Cloudflare Worker (see ../clicky/worker).
  // Example: https://clickit-worker.your-subdomain.workers.dev
  workerUrl: process.env.CLICKIT_WORKER_URL || '',
  model: 'gemini-3.5-flash',
  showCursor: true,
  // Opening the radial menu with a double-click fires on every double-click
  // in every app, so it is opt-in.
  doubleClickMenu: false,
  cursorColor: '#00ff88',
  cursorSize: 24, // px, 24 is the base size
  cursorGlow: 50, // 0-100
  translateTo: 'English',
  // Minutes between "still open in the background" notifications, 0 = off.
  nudgeMinutes: 0,
};

let cached = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cached) return cached;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    // First run or unreadable file: fall back to defaults.
  }
  cached = { ...DEFAULTS, ...stored };
  // Gemini 2.5 Flash is refused for new accounts (HTTP 404), so move old settings off it.
  if (cached.model === 'gemini-2.5-flash') cached.model = DEFAULTS.model;
  return cached;
}

function update(patch) {
  const next = { ...load(), ...patch };
  if (typeof next.workerUrl === 'string') {
    next.workerUrl = next.workerUrl.trim().replace(/\/+$/, '');
  }
  cached = next;
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return cached;
}

/** A language name safe to put in a prompt: letters, digits, spaces, hyphens, parentheses. */
function cleanLanguage(value) {
  return String(value).replace(/[^\p{L}\p{N} \-()]/gu, '').trim().slice(0, 40) || 'English';
}

/** Keeps only known keys with valid values from untrusted renderer input. */
function sanitize(patch) {
  const out = {};
  if (typeof patch.workerUrl === 'string') out.workerUrl = patch.workerUrl.slice(0, 300);
  if (typeof patch.model === 'string' && /^gemini-[a-z0-9.\-]+$/i.test(patch.model)) out.model = patch.model;
  if (typeof patch.showCursor === 'boolean') out.showCursor = patch.showCursor;
  if (typeof patch.doubleClickMenu === 'boolean') out.doubleClickMenu = patch.doubleClickMenu;
  if (typeof patch.cursorColor === 'string' && /^#[0-9a-f]{6}$/i.test(patch.cursorColor)) {
    out.cursorColor = patch.cursorColor;
  }
  if (Number.isFinite(patch.cursorSize)) out.cursorSize = Math.max(16, Math.min(48, patch.cursorSize));
  if (Number.isFinite(patch.cursorGlow)) out.cursorGlow = Math.max(0, Math.min(100, patch.cursorGlow));
  if (typeof patch.translateTo === 'string') out.translateTo = cleanLanguage(patch.translateTo);
  if (Number.isFinite(patch.nudgeMinutes)) {
    out.nudgeMinutes = Math.max(0, Math.min(240, Math.round(patch.nudgeMinutes)));
  }
  return out;
}

module.exports = { load, update, sanitize, cleanLanguage };
