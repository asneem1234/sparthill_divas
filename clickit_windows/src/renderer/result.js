// Result window for the Click It actions (Snap, Ask / Explain, Translate, Privacy Guard).
// Shows the privacy check first, then the window preview, the streamed answer, and
// follow-up questions. Nothing in this window can send anything to the AI before the
// main process has cleared it: the check and the refusal live there.

(function startResultWindow() {
  const element = (elementIdentifier) => document.getElementById(elementIdentifier);

  const statusDotElement = element('status-dot');
  const responseElement = element('response');
  const riskBadgeElement = element('risk-badge');
  const questionInputElement = element('question-input');
  const sendButtonElement = element('send-button');
  const languageInputElement = element('language-input');
  const translateButtonElement = element('translate-button');
  const copyButtonElements = [element('copy-button'), element('copy-button-secondary')];
  const copiedTextChipElement = element('copied-text-chip');
  const gateCardElement = element('gate-card');

  // A small line above the answer that echoes the question being answered.
  const questionEchoElement = document.createElement('div');
  questionEchoElement.className = 'question-echo hidden';
  responseElement.parentNode.insertBefore(questionEchoElement, responseElement);

  let initialPayload = null;
  let isWorking = false;
  let isUsingCopiedText = false;
  let currentAnswerText = '';

  function setStatus(statusName) {
    statusDotElement.className = `status-dot${statusName ? ` is-${statusName}` : ''}`;
  }

  function show(targetElement, shouldShow) {
    targetElement.classList.toggle('hidden', !shouldShow);
  }

  /** Privacy Guard answers start with "RISK: high" etc. Show that as a colored badge. */
  function renderAnswer(answerText) {
    let visibleText = answerText;
    if (initialPayload && initialPayload.isPrivacyGuard) {
      const riskMatch = /^\s*RISK:\s*(none|low|medium|high)\b[^\n]*\n?/i.exec(answerText);
      if (riskMatch) {
        const riskLevel = riskMatch[1].toLowerCase();
        riskBadgeElement.textContent = `RISK: ${riskLevel.toUpperCase()}`;
        riskBadgeElement.className = `risk-badge risk-${riskLevel}`;
        visibleText = answerText.slice(riskMatch[0].length).replace(/^\s+/, '');
      }
    }
    responseElement.className = 'response';
    responseElement.textContent = visibleText;
    currentAnswerText = answerText;
  }

  function setBusy(busy) {
    isWorking = busy;
    sendButtonElement.disabled = busy;
    translateButtonElement.disabled = busy;
    copyButtonElements.forEach((buttonElement) => {
      buttonElement.disabled = busy || currentAnswerText.trim() === '';
    });
  }

  function submitCurrentInput() {
    if (isWorking) return;
    const questionText = questionInputElement.value.trim();
    if (initialPayload.allowsFollowUps && !initialPayload.showsLanguagePicker && questionText === '') return;

    window.clickItResult.submit({
      question: questionText,
      targetLanguage: languageInputElement.value,
      isUsingCopiedText,
    });
    questionInputElement.value = '';
    resizeQuestionInput();
  }

  function resizeQuestionInput() {
    questionInputElement.style.height = 'auto';
    questionInputElement.style.height = `${Math.min(questionInputElement.scrollHeight, 90)}px`;
  }

  // ---- The privacy gate ----

  function makeButton(label, className, onClick) {
    const buttonElement = document.createElement('button');
    buttonElement.className = className;
    buttonElement.textContent = label;
    buttonElement.addEventListener('click', onClick);
    return buttonElement;
  }

  /** Hides everything that belongs to a cleared window, until the check has passed. */
  function lockWindowContent() {
    show(element('thumbnail'), false);
    show(copiedTextChipElement, false);
    show(element('language-row'), false);
    show(element('footer'), false);
    show(element('copy-only-bar'), false);
    show(riskBadgeElement, false);
    show(questionEchoElement, false);
  }

  function renderFindings(findings) {
    const listElement = element('gate-findings');
    listElement.textContent = '';
    for (const finding of findings) {
      const itemElement = document.createElement('li');
      // textContent: findings come from OCR'd screen text.
      itemElement.textContent = finding.example ? `${finding.label} (${finding.example})` : finding.label;
      listElement.appendChild(itemElement);
    }
  }

  function showGateCard({ cardClass, title, message, findings, riskLevel, buttons }) {
    gateCardElement.className = `gate-card ${cardClass}`;
    element('gate-title').textContent = title;
    element('gate-message').textContent = message;
    renderFindings(findings || []);

    const gateRiskElement = element('gate-risk');
    if (riskLevel) {
      gateRiskElement.textContent = `RISK: ${riskLevel.toUpperCase()}`;
      gateRiskElement.className = `risk-badge risk-${riskLevel}`;
    } else {
      gateRiskElement.className = 'risk-badge hidden';
    }

    const actionsElement = element('gate-actions');
    actionsElement.textContent = '';
    buttons.forEach((buttonElement) => actionsElement.appendChild(buttonElement));
    show(responseElement, false);
  }

  const chooseAnotherWindowButton = () =>
    makeButton('Choose another window', 'secondary-button', () => window.clickItResult.chooseAnotherWindow());

  function revealClearedWindow(thumbnailDataUrl) {
    show(gateCardElement, false);
    show(responseElement, true);

    if (thumbnailDataUrl) {
      element('thumbnail').src = thumbnailDataUrl;
      show(element('thumbnail'), true);
    }
    if (initialPayload.copiedTextPreview) {
      const { characterCount, preview } = initialPayload.copiedTextPreview;
      element('copied-text-label').textContent = `Using copied text (${characterCount} characters): ${preview.replace(/\s+/g, ' ')}`;
      show(copiedTextChipElement, true);
    }
    if (initialPayload.showsLanguagePicker) show(element('language-row'), true);

    if (initialPayload.allowsFollowUps) {
      show(element('footer'), true);
      if (!initialPayload.automaticallyRuns) questionInputElement.focus();
    } else {
      show(element('copy-only-bar'), true);
    }

    if (initialPayload.automaticallyRuns) {
      responseElement.className = 'response is-working-placeholder';
      responseElement.textContent = initialPayload.workingText;
    } else {
      responseElement.className = 'response is-hint';
      responseElement.textContent = initialPayload.idleHint;
    }
  }

  window.clickItResult.onGate((gate) => {
    switch (gate.phase) {
      case 'checking':
        lockWindowContent();
        show(gateCardElement, false);
        show(responseElement, true);
        responseElement.className = 'response is-working-placeholder';
        responseElement.textContent = 'Checking this window on your PC first. Nothing is sent to the AI until it passes.';
        setStatus('working');
        break;

      case 'blocked':
        lockWindowContent();
        showGateCard({
          cardClass: 'is-blocked',
          title: "Click It won't send this window",
          message: 'It looks like this window shows something private. Nothing was sent to the AI. Hide or close it, or choose another window.',
          findings: gate.findings,
          buttons: [chooseAnotherWindowButton()],
        });
        show(gateCardElement, true);
        setStatus('error');
        break;

      case 'confirm':
        lockWindowContent();
        showGateCard({
          cardClass: 'is-confirm',
          title: 'Check before sending',
          message: 'Click It noticed something that might be sensitive. Nothing has been sent yet.',
          findings: gate.findings,
          buttons: [
            makeButton('Send anyway', 'secondary-button is-risky', () => window.clickItResult.overrideAndSend()),
            chooseAnotherWindowButton(),
          ],
        });
        show(gateCardElement, true);
        setStatus('error');
        break;

      case 'report':
        lockWindowContent();
        showGateCard({
          cardClass: gate.riskLevel === 'high' ? 'is-blocked' : 'is-confirm',
          title: 'Privacy check (done on your PC)',
          message: 'This window has content you probably should not share. Nothing was sent to the AI.',
          findings: gate.findings,
          riskLevel: gate.riskLevel,
          buttons: [chooseAnotherWindowButton()],
        });
        show(gateCardElement, true);
        setStatus('done');
        break;

      case 'cleared':
        revealClearedWindow(gate.thumbnailDataUrl);
        break;

      default:
        break;
    }
  });

  // ---- Messages from the main process ----

  window.clickItResult.onInit((payload) => {
    initialPayload = payload;
    isUsingCopiedText = Boolean(payload.copiedTextPreview);
    element('title').textContent = payload.title;
    element('title').title = payload.windowName || '';
    document.title = `Click It - ${payload.title}`;

    if (payload.showsLanguagePicker) {
      languageInputElement.value = payload.targetLanguage;
      const suggestionsElement = element('language-suggestions');
      payload.languageSuggestions.forEach((languageName) => {
        const optionElement = document.createElement('option');
        optionElement.value = languageName;
        suggestionsElement.appendChild(optionElement);
      });
    }
    questionInputElement.placeholder = payload.inputPlaceholder || '';

    element('copied-text-remove').addEventListener('click', () => {
      isUsingCopiedText = !isUsingCopiedText;
      copiedTextChipElement.classList.toggle('is-disabled', !isUsingCopiedText);
      element('copied-text-remove').title = isUsingCopiedText ? "Don't use the copied text" : 'Use the copied text';
    });

    lockWindowContent();
  });

  window.clickItResult.onChunk((accumulatedText) => {
    renderAnswer(accumulatedText);
    const contentElement = element('content');
    contentElement.scrollTop = contentElement.scrollHeight;
  });

  window.clickItResult.onState((stateUpdate) => {
    if (stateUpdate.state === 'working') {
      currentAnswerText = '';
      riskBadgeElement.className = 'risk-badge hidden';
      responseElement.className = 'response is-working-placeholder';
      responseElement.textContent = initialPayload ? initialPayload.workingText : 'Working...';
      if (stateUpdate.question) {
        questionEchoElement.textContent = stateUpdate.question;
        questionEchoElement.classList.remove('hidden');
      } else {
        questionEchoElement.classList.add('hidden');
      }
      setStatus('working');
      setBusy(true);
    } else if (stateUpdate.state === 'done') {
      setStatus('done');
      setBusy(false);
      if (!element('footer').classList.contains('hidden')) questionInputElement.focus();
    } else if (stateUpdate.state === 'error') {
      show(gateCardElement, false);
      show(responseElement, true);
      responseElement.className = 'response is-error';
      responseElement.textContent = stateUpdate.message || 'Something went wrong.';
      currentAnswerText = '';
      setStatus('error');
      setBusy(false);
    }
  });

  // ---- Events ----

  element('close-button').addEventListener('click', () => window.clickItResult.close());
  sendButtonElement.addEventListener('click', submitCurrentInput);
  translateButtonElement.addEventListener('click', submitCurrentInput);

  questionInputElement.addEventListener('input', resizeQuestionInput);
  questionInputElement.addEventListener('keydown', (keyboardEvent) => {
    if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      submitCurrentInput();
    }
  });
  languageInputElement.addEventListener('keydown', (keyboardEvent) => {
    if (keyboardEvent.key === 'Enter') {
      keyboardEvent.preventDefault();
      submitCurrentInput();
    }
  });

  copyButtonElements.forEach((buttonElement) => {
    const originalLabel = buttonElement.textContent;
    buttonElement.addEventListener('click', () => {
      if (currentAnswerText.trim() === '') return;
      // Copy the answer without the RISK line, exactly as it is shown.
      window.clickItResult.copy(responseElement.textContent);
      buttonElement.textContent = 'Copied';
      setTimeout(() => {
        buttonElement.textContent = originalLabel;
      }, 1200);
    });
  });

  document.addEventListener('keydown', (keyboardEvent) => {
    if (keyboardEvent.key === 'Escape') window.clickItResult.close();
  });
})();
