'use strict';

const els = {
  state: document.getElementById('state'),
  hint: document.getElementById('hotkey-hint'),
  workerUrl: document.getElementById('worker-url'),
  model: document.getElementById('model'),
  translateTo: document.getElementById('translate-to'),
  doubleClickMenu: document.getElementById('double-click-menu'),
  showCursor: document.getElementById('show-cursor'),
  cursorColor: document.getElementById('cursor-color'),
  cursorSize: document.getElementById('cursor-size'),
  cursorSizeValue: document.getElementById('cursor-size-value'),
  cursorGlow: document.getElementById('cursor-glow'),
  cursorGlowValue: document.getElementById('cursor-glow-value'),
  save: document.getElementById('save'),
  saved: document.getElementById('saved'),
  askForm: document.getElementById('ask-form'),
  askInput: document.getElementById('ask-input'),
  transcript: document.getElementById('transcript'),
  response: document.getElementById('response'),
  error: document.getElementById('error'),
  quit: document.getElementById('quit'),
};

function renderStatus(status) {
  els.state.textContent = status.state;
  els.state.dataset.state = status.state;
  els.transcript.textContent = status.transcript ? `You: ${status.transcript}` : '';
  els.response.textContent = status.response ? `ClickIt: ${status.response}` : '';
  els.error.textContent = status.error || '';
}

function renderHint(mode) {
  els.hint.textContent =
    mode === 'fallback'
      ? 'Press Ctrl + Alt + M for the radial menu. Press Ctrl + Alt + Space to start or stop talking.'
      : 'Radial menu: tap Left Ctrl + Left Alt, or press Ctrl + Alt + M. Voice: Left Ctrl + Left Alt + Space.';
}

function renderSliderValues() {
  els.cursorSizeValue.textContent = els.cursorSize.value;
  els.cursorGlowValue.textContent = els.cursorGlow.value;
}

async function init() {
  const { settings, status, hotkeyMode } = await window.clickyPanel.getState();
  els.workerUrl.value = settings.workerUrl;
  els.model.value = settings.model;
  els.translateTo.value = settings.translateTo;
  els.doubleClickMenu.checked = settings.doubleClickMenu;
  els.showCursor.checked = settings.showCursor;
  els.cursorColor.value = settings.cursorColor;
  els.cursorSize.value = settings.cursorSize;
  els.cursorGlow.value = settings.cursorGlow;
  renderSliderValues();
  renderHint(hotkeyMode);
  renderStatus(status);
}

els.cursorSize.addEventListener('input', renderSliderValues);
els.cursorGlow.addEventListener('input', renderSliderValues);

els.save.addEventListener('click', async () => {
  await window.clickyPanel.saveSettings({
    workerUrl: els.workerUrl.value,
    model: els.model.value,
    translateTo: els.translateTo.value,
    doubleClickMenu: els.doubleClickMenu.checked,
    showCursor: els.showCursor.checked,
    cursorColor: els.cursorColor.value,
    cursorSize: Number(els.cursorSize.value),
    cursorGlow: Number(els.cursorGlow.value),
  });
  els.saved.textContent = 'Saved.';
  setTimeout(() => (els.saved.textContent = ''), 2000);
});

els.askForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.askInput.value.trim();
  if (!text) return;
  window.clickyPanel.ask(text);
  els.askInput.value = '';
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => window.clickyPanel.action(button.dataset.action));
});

els.quit.addEventListener('click', () => window.clickyPanel.quit());
window.clickyPanel.onStatus(renderStatus);

init();
