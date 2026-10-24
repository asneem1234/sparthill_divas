'use strict';

const { globalShortcut } = require('electron');

const FALLBACK_ACCELERATOR = 'Control+Alt+Space';

/**
 * Push-to-talk: hold Left Ctrl + Left Alt to talk, release to send.
 * Right Alt is ignored on purpose, because AltGr on many keyboard layouts
 * sends Ctrl + Right Alt and would trigger it while typing.
 *
 * If the native keyboard hook can't load, falls back to a toggle shortcut
 * (Ctrl+Alt+Space: press once to start, press again to send).
 *
 * @returns {{mode: 'hold'|'toggle', stop: () => void}}
 */
function registerPushToTalk({ onStart, onStop }) {
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');

    let ctrlDown = false;
    let altDown = false;
    let active = false;

    const update = () => {
      const shouldBeActive = ctrlDown && altDown;
      if (shouldBeActive && !active) {
        active = true;
        onStart();
      } else if (!shouldBeActive && active) {
        active = false;
        onStop();
      }
    };

    uIOhook.on('keydown', (event) => {
      if (event.keycode === UiohookKey.Ctrl) ctrlDown = true;
      if (event.keycode === UiohookKey.Alt) altDown = true;
      update();
    });
    uIOhook.on('keyup', (event) => {
      if (event.keycode === UiohookKey.Ctrl) ctrlDown = false;
      if (event.keycode === UiohookKey.Alt) altDown = false;
      update();
    });
    uIOhook.start();

    return { mode: 'hold', stop: () => uIOhook.stop() };
  } catch (error) {
    console.warn('[hotkey] Native keyboard hook unavailable, using toggle shortcut:', error.message);

    let listening = false;
    const registered = globalShortcut.register(FALLBACK_ACCELERATOR, () => {
      listening = !listening;
      if (listening) onStart();
      else onStop();
    });
    if (!registered) console.warn(`[hotkey] Could not register ${FALLBACK_ACCELERATOR}.`);

    return { mode: 'toggle', stop: () => globalShortcut.unregister(FALLBACK_ACCELERATOR) };
  }
}

module.exports = { registerPushToTalk };
