'use strict';

const { globalShortcut } = require('electron');

const TAP_MAX_MS = 2000;

/**
 * Global hotkeys.
 *  - Tap Left Ctrl + Left Alt (press both, release without touching another key): open the radial menu.
 *  - Left Ctrl + Left Alt + Space: start/stop voice recording.
 *  - Optional double-click anywhere: open the radial menu (see `isDoubleClickEnabled`).
 *
 * Right Alt is ignored on purpose, because AltGr on many keyboard layouts
 * sends Ctrl + Right Alt and would trigger these while typing.
 *
 * If the native hook can't load, falls back to Ctrl+Alt+M (menu) and
 * Ctrl+Alt+Space (voice) via Electron's globalShortcut.
 *
 * @returns {{mode: 'native'|'fallback', stop: () => void}}
 */
function registerHotkeys({ onOpenMenu, onToggleVoice, isDoubleClickEnabled }) {
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');

    let ctrlDown = false;
    let altDown = false;
    let armedAt = 0;
    let otherKeyUsed = false;

    uIOhook.on('keydown', (event) => {
      if (event.keycode === UiohookKey.Ctrl) ctrlDown = true;
      else if (event.keycode === UiohookKey.Alt) altDown = true;
      else {
        otherKeyUsed = true;
        if (event.keycode === UiohookKey.Space && ctrlDown && altDown) onToggleVoice();
        return;
      }
      if (ctrlDown && altDown && armedAt === 0) {
        armedAt = Date.now();
        otherKeyUsed = false;
      }
    });

    uIOhook.on('keyup', (event) => {
      const isModifier = event.keycode === UiohookKey.Ctrl || event.keycode === UiohookKey.Alt;
      if (!isModifier) return;
      const wasTap = armedAt !== 0 && !otherKeyUsed && Date.now() - armedAt < TAP_MAX_MS;
      if (event.keycode === UiohookKey.Ctrl) ctrlDown = false;
      if (event.keycode === UiohookKey.Alt) altDown = false;
      if (armedAt !== 0) {
        armedAt = 0;
        console.log(`[hotkeys] Ctrl+Alt released, tap=${wasTap}`);
        if (wasTap) onOpenMenu();
      }
    });

    uIOhook.on('click', (event) => {
      if (event.clicks === 2 && event.button === 1 && isDoubleClickEnabled()) onOpenMenu();
    });

    uIOhook.start();

    // Always-on backup that doesn't depend on the native hook's timing.
    const backupOk = globalShortcut.register('Control+Alt+M', onOpenMenu);
    console.log(`[hotkeys] native hook started; Ctrl+Alt+M backup registered: ${backupOk}`);

    return {
      mode: 'native',
      stop: () => {
        globalShortcut.unregister('Control+Alt+M');
        uIOhook.stop();
      },
    };
  } catch (error) {
    console.warn('[hotkeys] Native hook unavailable, using global shortcuts:', error.message);

    const menuOk = globalShortcut.register('Control+Alt+M', onOpenMenu);
    const voiceOk = globalShortcut.register('Control+Alt+Space', onToggleVoice);
    if (!menuOk) console.warn('[hotkeys] Could not register Control+Alt+M.');
    if (!voiceOk) console.warn('[hotkeys] Could not register Control+Alt+Space.');

    return {
      mode: 'fallback',
      stop: () => {
        globalShortcut.unregister('Control+Alt+M');
        globalShortcut.unregister('Control+Alt+Space');
      },
    };
  }
}

module.exports = { registerHotkeys };
