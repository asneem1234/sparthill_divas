'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // Base URL of your deployed Cloudflare Worker (see ../clicky/worker).
  // Example: https://clicky-proxy.your-subdomain.workers.dev
  workerUrl: process.env.CLICKY_WORKER_URL || '',
  model: 'claude-sonnet-4-6',
  showCursor: true,
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

module.exports = { load, update };
