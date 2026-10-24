// Panel UI. Port of CompanionPanelView. Elements are static in panel.html and this
// script shows, hides and fills them from the state pushed by the main process, so
// typing in the Worker field is never interrupted by a re-render.

(async function startPanel() {
  const element = (elementIdentifier) => document.getElementById(elementIdentifier);

  const statusDotElement = element('status-dot');
  const statusTextElement = element('status-text');
  const workerUrlInputElement = element('worker-url-input');

  function setHidden(targetElement, shouldHide) {
    targetElement.classList.toggle('hidden', shouldHide);
  }

  function computeStatusText(panelState) {
    if (!panelState.hasCompletedOnboarding || !panelState.allPermissionsGranted) return 'Setup';
    if (!panelState.isOverlayVisible) return 'Ready';
    switch (panelState.voiceState) {
      case 'listening':
        return 'Listening';
      case 'processing':
        return 'Processing';
      case 'responding':
        return 'Responding';
      default:
        return 'Active';
    }
  }

  function computeStatusDotColor(panelState) {
    if (!panelState.isOverlayVisible) return '#6b736f';
    return panelState.voiceState === 'idle' ? '#34d399' : '#f472b6';
  }

  function renderModelPicker(panelState) {
    const modelPickerElement = element('model-picker');
    modelPickerElement.textContent = '';
    for (const modelOption of panelState.availableModels) {
      const optionButtonElement = document.createElement('button');
      optionButtonElement.className = 'segmented-option';
      optionButtonElement.textContent = modelOption.label;
      optionButtonElement.classList.toggle('is-selected', panelState.selectedModel === modelOption.id);
      optionButtonElement.addEventListener('click', () => window.clickItPanel.sendAction('set-model', modelOption.id));
      modelPickerElement.appendChild(optionButtonElement);
    }
  }

  function render(panelState) {
    const isOnboardedAndReady = panelState.hasCompletedOnboarding && panelState.allPermissionsGranted;

    statusDotElement.style.background = computeStatusDotColor(panelState);
    statusDotElement.style.boxShadow = `0 0 4px ${computeStatusDotColor(panelState)}99`;
    statusTextElement.textContent = computeStatusText(panelState);

    // Which explanation to show, in the same priority order as the macOS panel.
    setHidden(element('copy-ready'), !isOnboardedAndReady);
    setHidden(element('copy-all-set'), isOnboardedAndReady || !panelState.allPermissionsGranted);
    setHidden(element('copy-revoked'), panelState.allPermissionsGranted || !panelState.hasCompletedOnboarding);
    setHidden(element('copy-intro'), panelState.allPermissionsGranted || panelState.hasCompletedOnboarding);
    element('push-to-talk-instruction').textContent = panelState.pushToTalkInstructionText;

    setHidden(element('model-section'), !isOnboardedAndReady);
    if (isOnboardedAndReady) renderModelPicker(panelState);

    setHidden(element('permissions-section'), panelState.allPermissionsGranted);
    setHidden(element('microphone-granted'), !panelState.hasMicrophonePermission);
    setHidden(element('grant-microphone-button'), panelState.hasMicrophonePermission);
    element('microphone-icon').classList.toggle('warning', !panelState.hasMicrophonePermission);

    setHidden(element('start-section'), panelState.hasCompletedOnboarding || !panelState.allPermissionsGranted);

    // Don't overwrite what the user is typing.
    if (document.activeElement !== workerUrlInputElement) {
      workerUrlInputElement.value = panelState.workerBaseUrl;
    }

    setHidden(element('error-section'), !panelState.lastErrorMessage);
    element('error-text').textContent = panelState.lastErrorMessage || '';

    element('click-it-instruction').textContent = panelState.clickItMenuInstructionText;

    setHidden(element('voice-chat-section'), !isOnboardedAndReady);
    setHidden(element('cursor-toggle-section'), !isOnboardedAndReady);
    element('cursor-toggle').checked = panelState.isClickyCursorEnabled;

    setHidden(element('replay-onboarding-button'), !panelState.hasCompletedOnboarding);
  }

  // ---- Events ----

  element('close-button').addEventListener('click', () => window.clickItPanel.sendAction('dismiss'));
  element('quit-button').addEventListener('click', () => window.clickItPanel.sendAction('quit'));
  element('grant-microphone-button').addEventListener('click', () => window.clickItPanel.sendAction('grant-microphone'));
  element('start-button').addEventListener('click', () => window.clickItPanel.sendAction('start-onboarding'));
  element('replay-onboarding-button').addEventListener('click', () => window.clickItPanel.sendAction('replay-onboarding'));
  element('open-click-it-button').addEventListener('click', () => window.clickItPanel.sendAction('open-click-it-menu'));
  element('voice-chat-button').addEventListener('click', () => window.clickItPanel.sendAction('start-voice-chat'));
  element('cursor-toggle').addEventListener('change', (changeEvent) => {
    window.clickItPanel.sendAction('set-cursor-enabled', changeEvent.target.checked);
  });

  function commitWorkerUrl() {
    window.clickItPanel.sendAction('set-worker-url', workerUrlInputElement.value);
  }
  workerUrlInputElement.addEventListener('change', commitWorkerUrl);
  workerUrlInputElement.addEventListener('keydown', (keyboardEvent) => {
    if (keyboardEvent.key === 'Enter') {
      commitWorkerUrl();
      workerUrlInputElement.blur();
    }
  });

  document.addEventListener('keydown', (keyboardEvent) => {
    if (keyboardEvent.key === 'Escape') window.clickItPanel.sendAction('dismiss');
  });

  // The window height follows the content, so the panel always wraps it snugly.
  new ResizeObserver(() => {
    window.clickItPanel.reportContentHeight(element('panel').offsetHeight);
  }).observe(element('panel'));

  window.clickItPanel.onState(render);
  render(await window.clickItPanel.getState());
})();
