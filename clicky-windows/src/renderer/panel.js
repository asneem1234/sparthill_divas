'use strict';

const els = {
  state: document.getElementById('state'),
  hint: document.getElementById('hotkey-hint'),
  workerUrl: document.getElementById('worker-url'),
  model: document.getElementById('model'),
  showCursor: document.getElementById('show-cursor'),
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
  els.response.textContent = status.response ? `Clicky: ${status.response}` : '';
  els.error.textContent = status.error || '';
}

function renderHint(mode) {
  els.hint.textContent =
    mode === 'hold'
      ? 'Hold Left Ctrl + Left Alt to talk, release to send.'
      : 'Press Ctrl + Alt + Space to start talking, press again to send.';
}

async function init() {
  const { settings, status, hotkeyMode } = await window.clickyPanel.getState();
  els.workerUrl.value = settings.workerUrl;
  els.model.value = settings.model;
  els.showCursor.checked = settings.showCursor;
  renderHint(hotkeyMode);
  renderStatus(status);
}

els.save.addEventListener('click', async () => {
  await window.clickyPanel.saveSettings({
    workerUrl: els.workerUrl.value,
    model: els.model.value,
    showCursor: els.showCursor.checked,
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

els.quit.addEventListener('click', () => window.clickyPanel.quit());
window.clickyPanel.onStatus(renderStatus);

init();
