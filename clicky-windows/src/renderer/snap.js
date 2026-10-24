'use strict';

const els = {
  title: document.getElementById('title'),
  preview: document.getElementById('preview'),
  question: document.getElementById('question'),
  answer: document.getElementById('answer'),
  error: document.getElementById('error'),
  askForm: document.getElementById('ask-form'),
  askInput: document.getElementById('ask-input'),
  translateForm: document.getElementById('translate-form'),
  language: document.getElementById('language'),
  notice: document.getElementById('notice'),
};

let currentText = '';

window.clickitSnap.onInit(({ kind, language, preview }) => {
  els.preview.src = preview;
  els.title.textContent = kind === 'translate' ? 'Translate' : 'Snap';
  els.askForm.classList.toggle('hidden', kind === 'translate');
  els.translateForm.classList.toggle('hidden', kind !== 'translate');
  els.language.value = language;
  (kind === 'translate' ? els.language : els.askInput).focus();
});

window.clickitSnap.onState((state) => {
  els.error.textContent = '';
  if (state.phase === 'error') {
    els.answer.textContent = '';
    els.error.textContent = state.message;
    return;
  }
  els.question.textContent = state.question ? `You: ${state.question}` : '';
  if (state.phase === 'loading') {
    els.answer.textContent = 'Working…';
    currentText = '';
    return;
  }
  currentText = state.text || '';
  els.answer.textContent = currentText;
  els.answer.scrollTop = els.answer.scrollHeight;
});

window.clickitSnap.onNotice((message) => {
  els.notice.textContent = message;
});

els.askForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.askInput.value.trim();
  if (!text) return;
  window.clickitSnap.ask(text);
  els.askInput.value = '';
});

els.translateForm.addEventListener('submit', (event) => {
  event.preventDefault();
  window.clickitSnap.translate(els.language.value);
});

document.getElementById('copy-text').addEventListener('click', () => {
  if (!currentText) return;
  window.clickitSnap.copyText(currentText);
  els.notice.textContent = 'Text copied.';
});
document.getElementById('copy-image').addEventListener('click', () => window.clickitSnap.copyImage());
document.getElementById('save-image').addEventListener('click', () => window.clickitSnap.saveImage());
document.getElementById('close').addEventListener('click', () => window.clickitSnap.close());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.clickitSnap.close();
});
