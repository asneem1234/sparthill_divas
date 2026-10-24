// System-wide keyboard shortcuts. Port of GlobalPushToTalkShortcutMonitor.
//
//   Hold Left Ctrl + Left Alt  -> push-to-talk (emits 'transition' pressed / released)
//   Tap  Ctrl + Shift          -> opens the Click It menu (emits 'clickItMenuShortcut')
//
// Uses a low-level keyboard hook (uiohook-napi) so modifier-only shortcuts work
// in the background. Right Alt is ignored on purpose: on many keyboard layouts
// AltGr is reported as Ctrl + Right Alt and would trigger push-to-talk by accident.
//
// If the native hook can't load, falls back to two Electron global shortcuts:
//   Ctrl+Alt+Space  toggles push-to-talk (press to start, press again to send)
//   Ctrl+Alt+M      opens the Click It menu

const { EventEmitter } = require('events');
const { globalShortcut } = require('electron');

let uiohookModule = null;
try {
  uiohookModule = require('uiohook-napi');
} catch (error) {
  console.warn('[ClickIt] Native keyboard hook unavailable, using fallback shortcuts:', error.message);
}

const FALLBACK_PUSH_TO_TALK_ACCELERATOR = 'Control+Alt+Space';
const FALLBACK_CLICK_IT_MENU_ACCELERATOR = 'Control+Alt+M';

class GlobalPushToTalkShortcutMonitor extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.isUsingFallbackShortcuts = false;
    this.isShortcutCurrentlyPressed = false;
    this.isClickItModifierTapInProgress = false;
    this.currentlyHeldKeyCodes = new Set();
  }

  /** Text shown in the panel so the user knows how to talk to the app. */
  get pushToTalkInstructionText() {
    return this.isUsingFallbackShortcuts
      ? 'Press Ctrl+Alt+Space to talk, press it again to send.'
      : 'Hold Ctrl+Alt to talk.';
  }

  get clickItMenuInstructionText() {
    return this.isUsingFallbackShortcuts ? 'Or press Ctrl+Alt+M anywhere' : 'Or tap Ctrl+Shift anywhere';
  }

  get pushToTalkDisplayText() {
    return this.isUsingFallbackShortcuts ? 'ctrl + alt + space' : 'ctrl + alt';
  }

  start() {
    // Starting twice would reset isShortcutCurrentlyPressed mid-press.
    if (this.isRunning) return;

    if (uiohookModule) {
      try {
        this.startNativeHook();
        this.isRunning = true;
        this.isUsingFallbackShortcuts = false;
        return;
      } catch (error) {
        console.warn('[ClickIt] Native keyboard hook failed to start, using fallback shortcuts:', error.message);
      }
    }

    this.startFallbackShortcuts();
    this.isRunning = true;
    this.isUsingFallbackShortcuts = true;
  }

  stop() {
    if (!this.isRunning) return;

    if (this.isUsingFallbackShortcuts) {
      globalShortcut.unregister(FALLBACK_PUSH_TO_TALK_ACCELERATOR);
      globalShortcut.unregister(FALLBACK_CLICK_IT_MENU_ACCELERATOR);
    } else if (uiohookModule) {
      try {
        uiohookModule.uIOhook.stop();
      } catch (error) {
        // Already stopped.
      }
    }

    this.isRunning = false;
    this.isShortcutCurrentlyPressed = false;
    this.isClickItModifierTapInProgress = false;
    this.currentlyHeldKeyCodes.clear();
  }

  // MARK: Native hook

  startNativeHook() {
    const { uIOhook, UiohookKey } = uiohookModule;

    this.leftControlKeyCode = UiohookKey.Ctrl;
    this.rightControlKeyCode = UiohookKey.CtrlRight;
    this.leftAltKeyCode = UiohookKey.Alt;
    this.rightAltKeyCode = UiohookKey.AltRight;
    this.leftShiftKeyCode = UiohookKey.Shift;
    this.rightShiftKeyCode = UiohookKey.ShiftRight;
    this.leftMetaKeyCode = UiohookKey.Meta;
    this.rightMetaKeyCode = UiohookKey.MetaRight;

    this.modifierKeyCodes = new Set([
      this.leftControlKeyCode, this.rightControlKeyCode,
      this.leftAltKeyCode, this.rightAltKeyCode,
      this.leftShiftKeyCode, this.rightShiftKeyCode,
      this.leftMetaKeyCode, this.rightMetaKeyCode,
    ]);

    uIOhook.on('keydown', (keyboardEvent) => this.handleKeyDown(keyboardEvent.keycode));
    uIOhook.on('keyup', (keyboardEvent) => this.handleKeyUp(keyboardEvent.keycode));
    // Clicking while Ctrl+Shift are held is a normal shortcut (multi-select), not a menu tap.
    uIOhook.on('mousedown', () => {
      this.isClickItModifierTapInProgress = false;
    });
    uIOhook.start();
  }

  isControlHeld() {
    return this.currentlyHeldKeyCodes.has(this.leftControlKeyCode) || this.currentlyHeldKeyCodes.has(this.rightControlKeyCode);
  }

  isShiftHeld() {
    return this.currentlyHeldKeyCodes.has(this.leftShiftKeyCode) || this.currentlyHeldKeyCodes.has(this.rightShiftKeyCode);
  }

  isAnyAltHeld() {
    return this.currentlyHeldKeyCodes.has(this.leftAltKeyCode) || this.currentlyHeldKeyCodes.has(this.rightAltKeyCode);
  }

  isAnyMetaHeld() {
    return this.currentlyHeldKeyCodes.has(this.leftMetaKeyCode) || this.currentlyHeldKeyCodes.has(this.rightMetaKeyCode);
  }

  handleKeyDown(keyCode) {
    this.currentlyHeldKeyCodes.add(keyCode);

    // Any non-modifier key while the modifiers are held cancels the Click It tap,
    // so shortcuts like Ctrl+Shift+Tab never open the menu.
    if (!this.modifierKeyCodes.has(keyCode)) {
      this.isClickItModifierTapInProgress = false;
    }

    this.updateModifierShortcuts();
  }

  handleKeyUp(keyCode) {
    this.currentlyHeldKeyCodes.delete(keyCode);
    this.updateModifierShortcuts();
  }

  updateModifierShortcuts() {
    this.trackClickItModifierTap();
    this.trackPushToTalkShortcut();
  }

  /** Push-to-talk is Ctrl + LEFT Alt held together. */
  trackPushToTalkShortcut() {
    const isShortcutHeldNow = this.isControlHeld() && this.currentlyHeldKeyCodes.has(this.leftAltKeyCode);

    if (isShortcutHeldNow && !this.isShortcutCurrentlyPressed) {
      this.isShortcutCurrentlyPressed = true;
      this.emit('transition', 'pressed');
    } else if (!isShortcutHeldNow && this.isShortcutCurrentlyPressed) {
      this.isShortcutCurrentlyPressed = false;
      this.emit('transition', 'released');
    }
  }

  /** A clean Ctrl+Shift tap: both pressed, both released, nothing else in between. */
  trackClickItModifierTap() {
    const isControlHeld = this.isControlHeld();
    const isShiftHeld = this.isShiftHeld();
    const isOtherModifierHeld = this.isAnyAltHeld() || this.isAnyMetaHeld();

    if (isControlHeld && isShiftHeld && !isOtherModifierHeld) {
      this.isClickItModifierTapInProgress = true;
    } else if (isOtherModifierHeld) {
      this.isClickItModifierTapInProgress = false;
    } else if (!isControlHeld && !isShiftHeld) {
      if (this.isClickItModifierTapInProgress) {
        this.isClickItModifierTapInProgress = false;
        this.emit('clickItMenuShortcut');
      }
    }
  }

  // MARK: Fallback shortcuts

  startFallbackShortcuts() {
    const didRegisterPushToTalk = globalShortcut.register(FALLBACK_PUSH_TO_TALK_ACCELERATOR, () => {
      this.isShortcutCurrentlyPressed = !this.isShortcutCurrentlyPressed;
      this.emit('transition', this.isShortcutCurrentlyPressed ? 'pressed' : 'released');
    });
    const didRegisterMenu = globalShortcut.register(FALLBACK_CLICK_IT_MENU_ACCELERATOR, () => {
      this.emit('clickItMenuShortcut');
    });

    if (!didRegisterPushToTalk || !didRegisterMenu) {
      console.warn('[ClickIt] Could not register one or more fallback shortcuts (already in use?).');
    }
  }
}

module.exports = { GlobalPushToTalkShortcutMonitor };
