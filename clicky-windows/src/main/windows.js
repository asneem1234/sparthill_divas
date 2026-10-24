'use strict';

const { execFile } = require('child_process');

// Shell and helper processes that have a "window" but are not apps the user opened.
const IGNORED_PROCESSES = new Set([
  'electron',
  'textinputhost',
  'searchhost',
  'searchapp',
  'shellexperiencehost',
  'startmenuexperiencehost',
  'lockapp',
  'systemsettings',
  'widgets',
]);
const IGNORED_TITLES = new Set(['program manager', 'windows input experience']);

// Fixed command (no user input is ever interpolated into it).
const SCRIPT =
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
  "Get-Process | Where-Object { $_.MainWindowTitle } | " +
  "ForEach-Object { $_.ProcessName + '|' + $_.MainWindowTitle }";

/**
 * Lists apps that have a visible top-level window, e.g. [{app: 'chrome', title: 'Inbox - Gmail'}].
 * For browsers Windows only exposes the title of the *active* tab, not every tab.
 */
function listOpenWindows() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          console.warn('[windows] could not list windows:', error.message);
          resolve([]);
          return;
        }
        const seen = new Set();
        const windows = [];
        for (const line of stdout.split(/\r?\n/)) {
          const index = line.indexOf('|');
          if (index < 1) continue;
          const app = line.slice(0, index).trim();
          const title = line.slice(index + 1).trim();
          if (!title || IGNORED_PROCESSES.has(app.toLowerCase())) continue;
          if (IGNORED_TITLES.has(title.toLowerCase())) continue;
          // Background helpers (tray/hardware utilities) title their hidden window after the process.
          if (title.toLowerCase() === app.toLowerCase()) continue;
          const key = `${app}|${title}`;
          if (seen.has(key)) continue;
          seen.add(key);
          windows.push({ app, title: title.slice(0, 90) });
        }
        resolve(windows);
      }
    );
  });
}

module.exports = { listOpenWindows };
