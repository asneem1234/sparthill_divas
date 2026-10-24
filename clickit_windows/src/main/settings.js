// Small JSON-backed settings store. Lives in %APPDATA%\ClickIt\settings.json.
// This is the Windows equivalent of the UserDefaults keys the macOS app uses.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
  // Base URL of the Cloudflare Worker proxy (clicky/worker). `wrangler dev`
  // serves on http://localhost:8787 which matches the macOS app's default.
  workerBaseUrl: 'http://localhost:8787',
  selectedModel: 'gemini-2.5-flash',
  isClickyCursorEnabled: true,
  hasCompletedOnboarding: false,
  // Language the Click It "Translate" action translates into.
  translateTargetLanguage: 'English',
  // Voice Gemini Live speaks with in voice chat.
  liveVoiceName: 'Aoede',
};

class SettingsStore {
  constructor() {
    this.settingsFilePath = path.join(app.getPath('userData'), 'settings.json');
    this.currentSettings = { ...DEFAULT_SETTINGS };
    this.loadFromDisk();
  }

  loadFromDisk() {
    try {
      const rawFileContents = fs.readFileSync(this.settingsFilePath, 'utf8');
      const parsedSettings = JSON.parse(rawFileContents);
      this.currentSettings = { ...DEFAULT_SETTINGS, ...parsedSettings };
    } catch (error) {
      // First launch or unreadable file: keep defaults.
      this.currentSettings = { ...DEFAULT_SETTINGS };
    }
  }

  get(settingName) {
    return this.currentSettings[settingName];
  }

  set(settingName, newValue) {
    this.currentSettings[settingName] = newValue;
    this.saveToDisk();
  }

  saveToDisk() {
    try {
      fs.mkdirSync(path.dirname(this.settingsFilePath), { recursive: true });
      fs.writeFileSync(this.settingsFilePath, JSON.stringify(this.currentSettings, null, 2));
    } catch (error) {
      console.warn('[ClickIt] Could not save settings:', error.message);
    }
  }
}

module.exports = { SettingsStore, DEFAULT_SETTINGS };
