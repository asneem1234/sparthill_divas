'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { listOpenWindows } = require('./windows');

const CHECK_INTERVAL_MS = 10 * 1000;
const MAX_TEXT = 200;
const MAX_MINUTES = 7 * 24 * 60;
const MAX_LISTED_WINDOWS = 5;

/**
 * Timed reminders plus periodic "still open in the background" nudges.
 * Reminders persist in userData/reminders.json, so one that comes due while the
 * app is closed fires the next time it starts.
 */
class Reminders {
  /** @param {{notify: (title: string, body: string) => void}} deps */
  constructor({ notify }) {
    this.notify = notify;
    this.items = this.load();
    this.checkTimer = null;
    this.nudgeTimer = null;
  }

  filePath() {
    return path.join(app.getPath('userData'), 'reminders.json');
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.id && item.text && item.at) : [];
    } catch {
      return [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath()), { recursive: true });
    fs.writeFileSync(this.filePath(), JSON.stringify(this.items, null, 2));
  }

  list() {
    return [...this.items].sort((a, b) => a.at - b.at);
  }

  add(text, minutes) {
    const cleanText = String(text || '').trim().slice(0, MAX_TEXT);
    const delay = Math.round(Number(minutes));
    if (!cleanText) throw new Error('Reminder text is required.');
    if (!Number.isFinite(delay) || delay < 1 || delay > MAX_MINUTES) {
      throw new Error(`Minutes must be between 1 and ${MAX_MINUTES}.`);
    }
    this.items.push({ id: crypto.randomUUID(), text: cleanText, at: Date.now() + delay * 60 * 1000 });
    this.save();
    return this.list();
  }

  remove(id) {
    this.items = this.items.filter((item) => item.id !== id);
    this.save();
    return this.list();
  }

  start() {
    this.checkDue();
    this.checkTimer = setInterval(() => this.checkDue(), CHECK_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.checkTimer);
    clearInterval(this.nudgeTimer);
  }

  checkDue() {
    const now = Date.now();
    const due = this.items.filter((item) => item.at <= now);
    if (due.length === 0) return;
    this.items = this.items.filter((item) => item.at > now);
    this.save();
    for (const item of due) this.notify('ClickIt reminder', item.text);
  }

  /** Sets how often (in minutes) to nudge about open background apps. 0 turns it off. */
  setNudgeMinutes(minutes) {
    clearInterval(this.nudgeTimer);
    this.nudgeTimer = null;
    if (minutes > 0) {
      this.nudgeTimer = setInterval(() => this.nudge(), minutes * 60 * 1000);
    }
  }

  /** Notifies about apps with open windows. Returns the list it found. */
  async nudge() {
    const windows = await listOpenWindows();
    if (windows.length === 0) return windows;
    const lines = windows.slice(0, MAX_LISTED_WINDOWS).map((entry) => `${entry.app}: ${entry.title}`);
    const extra = windows.length - lines.length;
    if (extra > 0) lines.push(`…and ${extra} more`);
    this.notify('Still open in the background', lines.join('\n'));
    return windows;
  }
}

module.exports = { Reminders };
