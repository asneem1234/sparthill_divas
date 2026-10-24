// Runs the Click It gemstone actions: Snap, Ask / Explain, Translate, Privacy Guard.
//
// Each action works on ONE window (or screen) that the user chose in the window picker.
// Before anything is sent to the AI, that window is read on this PC (local OCR) and
// checked for passwords, keys, card numbers and similar. If something is found the AI
// is never called. The AI request methods refuse to run until the check has passed or
// the user has explicitly approved a soft warning, so the UI can't skip the check.

const path = require('path');
const { BrowserWindow, clipboard, ipcMain, screen } = require('electron');

const { captureTarget } = require('./capture');
const { describeWorkerError } = require('./worker');
const { redactSensitiveValues } = require('./redact');
const { scanText, assessWindowIdentity } = require('./sensitiveContent');
const {
  SNAP_SYSTEM_PROMPT,
  ASK_EXPLAIN_SYSTEM_PROMPT,
  PRIVACY_GUARD_SYSTEM_PROMPT,
  buildTranslateSystemPrompt,
} = require('./prompt');

const RESULT_WINDOW_CONTENT_WIDTH = 440;
const RESULT_WINDOW_CONTENT_HEIGHT = 580;
// Transparent margin around the window so its CSS drop shadow isn't clipped.
const RESULT_WINDOW_SHADOW_MARGIN = 16;
const MAXIMUM_CLIPBOARD_CHARACTERS = 8000;
const MAXIMUM_FOLLOW_UP_EXCHANGES = 10;

const TRANSLATE_LANGUAGE_SUGGESTIONS = [
  'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Russian',
  'Hindi', 'Bengali', 'Tamil', 'Telugu', 'Marathi', 'Urdu', 'Arabic', 'Turkish',
  'Chinese (Simplified)', 'Japanese', 'Korean', 'Indonesian', 'Vietnamese', 'Thai',
];

/**
 * What each action does.
 *  - automaticallyRuns: starts once the window has been cleared (Ask waits for a question)
 *  - usesCopiedText: offers the clipboard text as extra input
 *  - allowsFollowUps: shows the follow-up question box
 */
const ACTION_DEFINITIONS = {
  snap: {
    title: 'Snap',
    automaticallyRuns: true,
    usesCopiedText: false,
    allowsFollowUps: true,
    showsLanguagePicker: false,
    workingText: 'Looking at your snap...',
    inputPlaceholder: 'Ask a follow-up about this snap...',
  },
  askExplain: {
    title: 'Ask / Explain',
    automaticallyRuns: false,
    usesCopiedText: true,
    allowsFollowUps: true,
    showsLanguagePicker: false,
    workingText: 'Thinking...',
    inputPlaceholder: 'Ask about the window or the copied text...',
    idleHint: 'Ask anything about the window you chose. Copy some text first and it will be used as the thing you are asking about.',
  },
  translate: {
    title: 'Translate',
    automaticallyRuns: true,
    usesCopiedText: true,
    allowsFollowUps: false,
    showsLanguagePicker: true,
    workingText: 'Translating...',
    inputPlaceholder: '',
  },
  privacyGuard: {
    title: 'Privacy Guard',
    automaticallyRuns: true,
    usesCopiedText: true,
    allowsFollowUps: true,
    showsLanguagePicker: false,
    workingText: 'Checking for sensitive information...',
    inputPlaceholder: 'Ask about something it found...',
  },
};

class ClickItActionsManager {
  /**
   * @param {object} dependencies
   * @param {import('./worker').WorkerClient} dependencies.workerClient
   * @param {import('./settings').SettingsStore} dependencies.settings
   * @param {import('./ocr/ocrService').OcrService} dependencies.ocrService
   * @param {import('./regionSelectorManager').RegionSelectorManager} dependencies.regionSelectorManager
   * @param {() => string} dependencies.getSelectedModel
   */
  constructor({ workerClient, settings, ocrService, regionSelectorManager, getSelectedModel }) {
    this.workerClient = workerClient;
    this.settings = settings;
    this.ocrService = ocrService;
    this.regionSelectorManager = regionSelectorManager;
    this.getSelectedModel = getSelectedModel;

    // Set by the companion: reopens the window picker.
    this.onChooseAnotherWindow = () => {};

    this.resultWindow = null;
    this.session = null;

    ipcMain.on('result:submit', (event, submission) => {
      if (this.isFromResultWindow(event)) this.submit(submission);
    });
    ipcMain.on('result:copy', (event, textToCopy) => {
      if (this.isFromResultWindow(event) && typeof textToCopy === 'string') clipboard.writeText(textToCopy);
    });
    ipcMain.on('result:close', (event) => {
      if (this.isFromResultWindow(event)) this.closeResultWindow();
    });
    ipcMain.on('result:override', (event) => {
      if (this.isFromResultWindow(event)) this.approveSendingAnyway();
    });
    ipcMain.on('result:choose-another', (event) => {
      if (!this.isFromResultWindow(event)) return;
      this.closeResultWindow();
      this.onChooseAnotherWindow();
    });
  }

  isFromResultWindow(event) {
    return Boolean(this.resultWindow && !this.resultWindow.isDestroyed() && event.sender === this.resultWindow.webContents);
  }

  // MARK: Running an action

  /**
   * Captures the chosen window, opens the result window, checks the capture on this PC,
   * and only then (if it is clean) starts the action.
   * @param {string} actionIdentifier
   * @param {{sourceId: string, kind: 'screen'|'window', name: string, processName: string}} target
   */
  async run(actionIdentifier, target) {
    const actionDefinition = ACTION_DEFINITIONS[actionIdentifier];
    if (!actionDefinition) return;

    this.closeResultWindow();

    // Capture BEFORE opening our window. For a window target our own windows can't appear
    // in the picture anyway, but for a whole screen they could.
    let screenCapture = null;
    let captureErrorMessage = null;
    if (!target) {
      captureErrorMessage = 'No window was chosen.';
    } else if (actionIdentifier === 'snap') {
      // Snap works like the Windows screenshot tool: the user drags out the area to analyze.
      try {
        screenCapture = await this.regionSelectorManager.selectRegion({
          preferredPoint: target.boundsInDips
            ? { x: target.boundsInDips.x + target.boundsInDips.width / 2, y: target.boundsInDips.y + target.boundsInDips.height / 2 }
            : undefined,
        });
      } catch (error) {
        console.error('[ClickIt] Snap area capture failed:', error.message);
        captureErrorMessage = error.message;
      }
      // Cancelled (Esc, Cancel, right-click, or switching away): nothing to show, nothing was captured.
      if (!screenCapture && !captureErrorMessage) return;
    } else {
      try {
        screenCapture = await captureTarget(target);
      } catch (error) {
        console.error('[ClickIt] Click It capture failed:', error.message);
        captureErrorMessage = error.message;
      }
    }

    const copiedText = actionDefinition.usesCopiedText
      ? clipboard.readText().trim().slice(0, MAXIMUM_CLIPBOARD_CHARACTERS)
      : '';

    this.session = {
      actionIdentifier,
      actionDefinition,
      target,
      screenCapture,
      captureErrorMessage,
      copiedText,
      isUsingCopiedText: copiedText !== '',
      targetLanguage: this.settings.get('translateTargetLanguage'),
      conversationHistory: [],
      abortController: null,
      // Nothing may go to the AI until this is true (clean scan, or the user approved a warning).
      isClearedToSend: false,
      pendingFindings: [],
    };

    this.openResultWindow();
  }

  openResultWindow() {
    const session = this.session;
    const mouseLocation = screen.getCursorScreenPoint();
    const workArea = screen.getDisplayNearestPoint(mouseLocation).workArea;

    const windowWidth = RESULT_WINDOW_CONTENT_WIDTH + RESULT_WINDOW_SHADOW_MARGIN * 2;
    const windowHeight = RESULT_WINDOW_CONTENT_HEIGHT + RESULT_WINDOW_SHADOW_MARGIN * 2;
    // Dock it toward the right side of the screen the user is on, out of the way of what they are reading.
    const windowX = Math.max(workArea.x, workArea.x + workArea.width - windowWidth - 8);
    const windowY = Math.max(workArea.y, workArea.y + Math.round((workArea.height - windowHeight) / 2));

    const resultWindow = new BrowserWindow({
      x: windowX,
      y: windowY,
      width: windowWidth,
      height: Math.min(windowHeight, workArea.height),
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: false,
      hasShadow: false,
      fullscreenable: false,
      show: false,
      title: `Click It - ${session.actionDefinition.title}`,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'result.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    resultWindow.setAlwaysOnTop(true, 'floating');
    resultWindow.loadFile(path.join(__dirname, '..', 'renderer', 'result.html'));
    resultWindow.webContents.once('did-finish-load', () => {
      if (resultWindow.isDestroyed() || this.session !== session) return;
      resultWindow.webContents.send('result:init', this.buildInitialPayload(session));
      resultWindow.show();
      resultWindow.focus();
      this.checkThenStart(session).catch((error) => {
        console.error('[ClickIt] Click It check failed:', error);
        this.sendToResultWindow('result:state', { state: 'error', message: String(error.message || error).slice(0, 300) });
      });
    });
    resultWindow.on('closed', () => {
      if (this.resultWindow === resultWindow) {
        this.abortCurrentRequest();
        this.resultWindow = null;
        this.session = null;
      }
    });

    this.resultWindow = resultWindow;
  }

  /** What the window needs to draw itself. The screenshot itself is sent only after the check passes. */
  buildInitialPayload(session) {
    const copiedTextPreview = session.copiedText
      ? { characterCount: session.copiedText.length, preview: session.copiedText.slice(0, 120) }
      : null;

    return {
      title: session.actionDefinition.title,
      windowName: session.target ? session.target.name : '',
      copiedTextPreview,
      showsLanguagePicker: session.actionDefinition.showsLanguagePicker,
      targetLanguage: session.targetLanguage,
      languageSuggestions: TRANSLATE_LANGUAGE_SUGGESTIONS,
      allowsFollowUps: session.actionDefinition.allowsFollowUps,
      inputPlaceholder: session.actionDefinition.inputPlaceholder,
      automaticallyRuns: session.actionDefinition.automaticallyRuns,
      workingText: session.actionDefinition.workingText,
      idleHint: session.actionDefinition.idleHint || '',
      isPrivacyGuard: session.actionIdentifier === 'privacyGuard',
    };
  }

  // MARK: The on-device check

  /**
   * Reads the window on this PC and decides whether it may be sent to the AI.
   * @returns {Promise<{verdict: 'ok'|'confirm'|'blocked', findings: object[]}>}
   */
  async runLocalPrivacyCheck(session) {
    const findings = [];
    const addFindings = (newFindings) => newFindings.forEach((finding) => findings.push(finding));

    // 1. The window's own title and app (re-checked now: titles change).
    if (session.target && session.target.kind === 'window') {
      const identityAssessment = assessWindowIdentity({ title: session.target.name, processName: session.target.processName });
      if (identityAssessment.isBlocked) {
        addFindings([{ kind: 'window-identity', label: identityAssessment.reason, severity: 'block', example: '' }]);
      }
    }

    // 2. Copied text, if the action uses it.
    if (session.copiedText) {
      addFindings(scanText(session.copiedText).findings.map((finding) => ({ ...finding, label: `Copied text: ${finding.label}` })));
    }

    // 3. What is actually visible in the window. Skipped when something is already blocked.
    const isAlreadyBlocked = findings.some((finding) => finding.severity === 'block');
    if (session.screenCapture && !isAlreadyBlocked) {
      const ocrResult = await this.ocrService.recognizeText(session.screenCapture.scanImageBuffer);
      if (!ocrResult.isAvailable) {
        console.warn('[ClickIt] Local text check unavailable:', ocrResult.error);
        addFindings([{ kind: 'unchecked', label: "Click It couldn't read this window on your PC to check it", severity: 'confirm', example: '' }]);
      } else {
        addFindings(scanText(ocrResult.text).findings);
      }
    }

    const verdict = findings.some((finding) => finding.severity === 'block')
      ? 'blocked'
      : findings.length > 0
        ? 'confirm'
        : 'ok';
    return { verdict, findings: findings.slice(0, 8) };
  }

  async checkThenStart(session) {
    if (session.captureErrorMessage) {
      this.sendToResultWindow('result:state', { state: 'error', message: session.captureErrorMessage });
      return;
    }

    this.sendToResultWindow('result:gate', { phase: 'checking' });
    const { verdict, findings } = await this.runLocalPrivacyCheck(session);
    if (this.session !== session) return; // the window was closed meanwhile

    const safeFindings = findings.map(({ label, severity, example }) => ({ label, severity, example }));

    // Privacy Guard answers locally whenever it already found something, so the content
    // it is warning about never has to be sent to the AI to be reported.
    if (session.actionIdentifier === 'privacyGuard' && verdict !== 'ok') {
      this.sendToResultWindow('result:gate', {
        phase: 'report',
        riskLevel: verdict === 'blocked' ? 'high' : 'medium',
        findings: safeFindings,
      });
      return;
    }

    if (verdict === 'blocked') {
      console.log(`[ClickIt] Blocked "${session.actionIdentifier}": ${findings.map((finding) => finding.kind).join(', ')}`);
      this.sendToResultWindow('result:gate', { phase: 'blocked', findings: safeFindings });
      return;
    }
    if (verdict === 'confirm') {
      session.pendingFindings = safeFindings;
      this.sendToResultWindow('result:gate', { phase: 'confirm', findings: safeFindings });
      return;
    }

    this.clearToSend(session);
  }

  /** The user chose "Send anyway" on a soft warning. Hard blocks can't be overridden. */
  approveSendingAnyway() {
    const session = this.session;
    if (!session || session.isClearedToSend || session.pendingFindings.length === 0) return;
    this.clearToSend(session);
  }

  clearToSend(session) {
    session.isClearedToSend = true;
    const thumbnailDataUrl = session.screenCapture
      ? `data:image/jpeg;base64,${session.screenCapture.imageBuffer.toString('base64')}`
      : null;
    this.sendToResultWindow('result:gate', { phase: 'cleared', thumbnailDataUrl });

    if (session.actionDefinition.automaticallyRuns) {
      this.submit({ question: '', targetLanguage: session.targetLanguage, isUsingCopiedText: session.isUsingCopiedText });
    }
  }

  // MARK: Sending a request

  /**
   * @param {{question: string, targetLanguage?: string, isUsingCopiedText?: boolean}} submission
   */
  async submit(submission) {
    const session = this.session;
    if (!session) return;

    // The one rule that matters most: nothing is sent before the on-device check allows it.
    if (!session.isClearedToSend) {
      console.warn('[ClickIt] Ignored a request that arrived before the privacy check finished.');
      return;
    }

    const question = String(submission.question || '').trim();
    if (session.actionIdentifier === 'askExplain' && question === '' && session.conversationHistory.length === 0) {
      return; // Ask needs a question to answer.
    }

    if (typeof submission.targetLanguage === 'string' && submission.targetLanguage.trim() !== '') {
      session.targetLanguage = submission.targetLanguage.trim().slice(0, 60);
      this.settings.set('translateTargetLanguage', session.targetLanguage);
    }
    session.isUsingCopiedText = Boolean(submission.isUsingCopiedText) && session.copiedText !== '';

    if (!session.screenCapture && !(session.actionIdentifier === 'translate' && session.isUsingCopiedText)) {
      this.sendToResultWindow('result:state', {
        state: 'error',
        message: session.captureErrorMessage || "There's no screenshot to work with.",
      });
      return;
    }

    this.abortCurrentRequest();
    const abortController = new AbortController();
    session.abortController = abortController;

    const request = this.buildRequest(session, question);
    this.sendToResultWindow('result:state', { state: 'working', question });

    // Privacy Guard answers are masked in code before they are shown, so they are not
    // streamed: a half-streamed secret would appear unmasked for a moment.
    const shouldRedactAnswer = session.actionIdentifier === 'privacyGuard';

    try {
      const { text: rawResponseText } = await this.workerClient.analyzeImageStreaming({
        images: request.images,
        systemPrompt: request.systemPrompt,
        model: this.getSelectedModel(),
        conversationHistory: request.conversationHistory,
        userPrompt: request.userPrompt,
        onTextChunk: (accumulatedText) => {
          if (!abortController.signal.aborted && !shouldRedactAnswer) {
            this.sendToResultWindow('result:chunk', accumulatedText);
          }
        },
        abortSignal: abortController.signal,
      });
      if (abortController.signal.aborted) return;

      const responseText = shouldRedactAnswer ? redactSensitiveValues(rawResponseText) : rawResponseText;
      if (shouldRedactAnswer && responseText.trim() !== '') {
        this.sendToResultWindow('result:chunk', responseText);
      }

      if (responseText.trim() === '') {
        this.sendToResultWindow('result:state', {
          state: 'error',
          message: 'The model sent back an empty answer. Try again.',
        });
        return;
      }

      // Translate runs are independent; the others build up a conversation for follow-ups.
      if (session.actionIdentifier !== 'translate') {
        session.conversationHistory.push({ userTranscript: request.historyLabel, assistantResponse: responseText });
        if (session.conversationHistory.length > MAXIMUM_FOLLOW_UP_EXCHANGES) {
          session.conversationHistory.splice(0, session.conversationHistory.length - MAXIMUM_FOLLOW_UP_EXCHANGES);
        }
      }
      this.sendToResultWindow('result:state', { state: 'done' });
    } catch (error) {
      if (abortController.signal.aborted) return;
      console.error('[ClickIt] Click It action error:', error.message);
      this.sendToResultWindow('result:state', {
        state: 'error',
        message: describeWorkerError(error, this.settings.get('workerBaseUrl')),
      });
    }
  }

  /** Builds the model request for the current action and turn. */
  buildRequest(session, question) {
    const isFirstTurn = session.conversationHistory.length === 0;
    const screenshotImages = session.screenCapture
      ? [
          {
            imageBuffer: session.screenCapture.imageBuffer,
            label: `${session.screenCapture.label} (image dimensions: ${session.screenCapture.screenshotWidthInPixels}x${session.screenCapture.screenshotHeightInPixels} pixels)`,
          },
        ]
      : [];
    const copiedTextBlock = session.isUsingCopiedText ? `\n\nthe user copied this text:\n"""\n${session.copiedText}\n"""` : '';

    switch (session.actionIdentifier) {
      case 'snap': {
        const userPrompt = isFirstTurn ? 'what is in this screenshot? summarize it and explain what matters.' : question;
        return {
          images: screenshotImages,
          systemPrompt: SNAP_SYSTEM_PROMPT,
          conversationHistory: session.conversationHistory,
          userPrompt,
          historyLabel: userPrompt,
        };
      }
      case 'askExplain': {
        return {
          images: screenshotImages,
          systemPrompt: ASK_EXPLAIN_SYSTEM_PROMPT,
          conversationHistory: session.conversationHistory,
          userPrompt: `${question}${copiedTextBlock}`,
          historyLabel: question,
        };
      }
      case 'translate': {
        // Copied text wins when there is some (it is what the user selected); otherwise translate the window.
        const translatesCopiedText = session.isUsingCopiedText;
        return {
          images: translatesCopiedText ? [] : screenshotImages,
          systemPrompt: buildTranslateSystemPrompt(session.targetLanguage),
          conversationHistory: [],
          userPrompt: translatesCopiedText
            ? `translate this text into ${session.targetLanguage}:\n"""\n${session.copiedText}\n"""`
            : `translate the text visible in this screenshot into ${session.targetLanguage}.`,
          historyLabel: '',
        };
      }
      case 'privacyGuard': {
        const userPrompt = isFirstTurn
          ? `check this window for sensitive information before i share it.${copiedTextBlock ? ` also check the copied text.${copiedTextBlock}` : ''}`
          : question;
        return {
          images: screenshotImages,
          systemPrompt: PRIVACY_GUARD_SYSTEM_PROMPT,
          conversationHistory: session.conversationHistory,
          userPrompt,
          historyLabel: isFirstTurn ? 'check this window for sensitive information before i share it.' : question,
        };
      }
      default:
        throw new Error(`Unknown Click It action: ${session.actionIdentifier}`);
    }
  }

  // MARK: Helpers

  sendToResultWindow(channelName, payload) {
    if (this.resultWindow && !this.resultWindow.isDestroyed()) {
      this.resultWindow.webContents.send(channelName, payload);
    }
  }

  abortCurrentRequest() {
    if (this.session && this.session.abortController) {
      this.session.abortController.abort();
      this.session.abortController = null;
    }
  }

  closeResultWindow() {
    this.abortCurrentRequest();
    const resultWindow = this.resultWindow;
    this.resultWindow = null;
    this.session = null;
    if (resultWindow && !resultWindow.isDestroyed()) resultWindow.destroy();
  }
}

module.exports = { ClickItActionsManager };
