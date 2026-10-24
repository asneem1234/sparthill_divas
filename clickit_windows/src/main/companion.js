// Central state manager for the companion voice mode. Port of CompanionManager.
//
// Owns the push-to-talk pipeline (dictation + global shortcut + overlay) and
// exposes observable state for the panel UI. Coordinates the full
// push-to-talk -> screenshot -> model -> speech -> pointing flow.
//
// Not ported on purpose: PostHog analytics and the FormSpark email gate, because
// both send user data to third-party services.

const { EventEmitter } = require('events');
const { screen, shell, systemPreferences } = require('electron');

const { captureAllScreensAsJpeg } = require('./capture');
const { describeWorkerError } = require('./worker');
const { filterScreenCapturesForPrivacy } = require('./privacyFilter');
const { COMPANION_VOICE_RESPONSE_SYSTEM_PROMPT, ONBOARDING_DEMO_SYSTEM_PROMPT } = require('./prompt');
const { parsePointingCoordinates, convertScreenshotPointToGlobalLocation } = require('./pointTag');
const { CLICK_IT_ACTIONS } = require('./clickItActions');

// gemini-2.5-flash answers "no longer available to new users" on newer API keys, so the app uses 3.5 Flash.
const AVAILABLE_MODELS = [{ label: 'Flash 3.5', id: 'gemini-3.5-flash' }];

const MAXIMUM_CONVERSATION_HISTORY_EXCHANGES = 10;
const PERMISSION_POLLING_INTERVAL_MILLISECONDS = 1500;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CompanionManager extends EventEmitter {
  /**
   * @param {object} dependencies
   * @param {import('./settings').SettingsStore} dependencies.settings
   * @param {import('./worker').WorkerClient} dependencies.workerClient
   * @param {import('./audioBridge').AudioBridge} dependencies.audioBridge
   * @param {import('./dictation').DictationManager} dependencies.dictationManager
   * @param {import('./hotkey').GlobalPushToTalkShortcutMonitor} dependencies.hotkeyMonitor
   * @param {import('./overlayManager').OverlayManager} dependencies.overlayManager
   * @param {import('./orbMenuManager').OrbMenuManager} dependencies.orbMenuManager
   * @param {import('./actionsManager').ClickItActionsManager} dependencies.actionsManager
   * @param {import('./windowPickerManager').WindowPickerManager} dependencies.windowPickerManager
   */
  constructor({ settings, workerClient, audioBridge, dictationManager, hotkeyMonitor, overlayManager, orbMenuManager, actionsManager, windowPickerManager, ocrService, windowControlService, regionSelectorManager }) {
    super();
    this.settings = settings;
    this.workerClient = workerClient;
    this.audioBridge = audioBridge;
    this.dictationManager = dictationManager;
    this.hotkeyMonitor = hotkeyMonitor;
    this.overlayManager = overlayManager;
    this.orbMenuManager = orbMenuManager;
    this.actionsManager = actionsManager;
    this.windowPickerManager = windowPickerManager;
    this.ocrService = ocrService;
    this.windowControlService = windowControlService;
    this.regionSelectorManager = regionSelectorManager;
    this.selectedClickItTarget = null;
    // Set by main.js. While a voice chat is open, push-to-talk is off (the chat owns the microphone).
    this.voiceChatManager = null;

    // "Choose another window" in a result window reopens the picker.
    if (this.actionsManager) {
      this.actionsManager.onChooseAnotherWindow = () => this.toggleClickItOrbMenu();
    }

    // 'idle' | 'listening' | 'processing' | 'responding'
    this.voiceState = 'idle';
    this.lastTranscript = null;
    this.lastErrorMessage = null;
    this.isOverlayVisible = false;
    this.hasMicrophonePermission = false;
    this.didMicrophoneProbeSucceed = false;

    // Where the model asked the cursor to point, in global desktop coordinates.
    this.detectedElement = null;
    this.nextDetectedElementRequestIdentifier = 1;

    // Conversation history so the model remembers prior exchanges within a session.
    this.conversationHistory = [];

    // The AI response currently running. Cancelled when the user speaks again.
    this.currentResponse = null; // { identifier, abortController }
    this.nextResponseIdentifier = 1;
    this.isResponseInFlight = false;

    this.transientHideToken = null;
    this.permissionPollingIntervalId = null;

    // Onboarding
    this.isRunningOnboardingDemo = false;
    this.onboardingPromptTimeoutIds = [];
  }

  // MARK: Settings-backed state

  /** The saved model, unless it's one this version no longer offers (older settings files). */
  get selectedModel() {
    const savedModelIdentifier = this.settings.get('selectedModel');
    const isStillAvailable = AVAILABLE_MODELS.some((model) => model.id === savedModelIdentifier);
    return isStillAvailable ? savedModelIdentifier : AVAILABLE_MODELS[0].id;
  }

  get isClickyCursorEnabled() {
    return this.settings.get('isClickyCursorEnabled');
  }

  get hasCompletedOnboarding() {
    return this.settings.get('hasCompletedOnboarding');
  }

  /** Windows only gates the microphone: there is no screen-recording or accessibility prompt. */
  get allPermissionsGranted() {
    return this.hasMicrophonePermission;
  }

  getPanelState() {
    return {
      voiceState: this.voiceState,
      isOverlayVisible: this.isOverlayVisible,
      hasCompletedOnboarding: this.hasCompletedOnboarding,
      allPermissionsGranted: this.allPermissionsGranted,
      hasMicrophonePermission: this.hasMicrophonePermission,
      availableModels: AVAILABLE_MODELS,
      selectedModel: this.selectedModel,
      workerBaseUrl: this.settings.get('workerBaseUrl'),
      isClickyCursorEnabled: this.isClickyCursorEnabled,
      pushToTalkInstructionText: this.hotkeyMonitor.pushToTalkInstructionText,
      clickItMenuInstructionText: this.hotkeyMonitor.clickItMenuInstructionText,
      lastErrorMessage: this.lastErrorMessage || this.dictationManager.lastErrorMessage,
    };
  }

  emitStateChanged() {
    this.emit('stateChanged', this.getPanelState());
  }

  setVoiceState(newVoiceState) {
    if (this.voiceState === newVoiceState) return;
    this.voiceState = newVoiceState;
    this.overlayManager.updateOverlayState({ voiceState: newVoiceState });
    this.emitStateChanged();
  }

  setSelectedModel(modelIdentifier) {
    this.settings.set('selectedModel', modelIdentifier);
    this.emitStateChanged();
  }

  setWorkerBaseUrl(newWorkerBaseUrl) {
    const trimmedUrl = String(newWorkerBaseUrl || '').trim().replace(/\/+$/, '');
    try {
      const parsedUrl = new URL(trimmedUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch (error) {
      this.lastErrorMessage = 'That worker URL is not valid. Use something like http://localhost:8787.';
      this.emitStateChanged();
      return;
    }

    this.settings.set('workerBaseUrl', trimmedUrl);
    this.workerClient.resetRouteAvailability();
    this.workerClient.warmUpConnectionIfNeeded();
    this.lastErrorMessage = null;
    this.emitStateChanged();
  }

  /**
   * Whether the cursor should be shown. When off, the overlay is hidden and only
   * appears transiently while the user holds the push-to-talk shortcut.
   */
  setClickyCursorEnabled(enabled) {
    this.settings.set('isClickyCursorEnabled', enabled);
    this.cancelTransientHide();

    if (enabled) {
      this.showOverlayWithoutWelcome();
    } else {
      this.overlayManager.hideOverlay();
      this.isOverlayVisible = false;
    }
    this.emitStateChanged();
  }

  showOverlayWithoutWelcome() {
    this.overlayManager.hasShownOverlayBefore = true;
    this.overlayManager.showOverlay();
    this.isOverlayVisible = true;
  }

  // MARK: Lifecycle

  start() {
    this.refreshAllPermissions();
    console.log(
      `[ClickIt] Start. mic: ${this.hasMicrophonePermission}, onboarded: ${this.hasCompletedOnboarding}, worker: ${this.settings.get('workerBaseUrl')}`
    );

    this.permissionPollingIntervalId = setInterval(() => this.refreshAllPermissions(), PERMISSION_POLLING_INTERVAL_MILLISECONDS);

    this.dictationManager.on('change', () => this.handleDictationStateChange());
    this.audioBridge.on('audioPowerLevel', (audioPowerLevel) => this.overlayManager.sendAudioPowerLevel(audioPowerLevel));
    this.hotkeyMonitor.on('transition', (shortcutTransition) => this.handleShortcutTransition(shortcutTransition));
    this.hotkeyMonitor.on('clickItMenuShortcut', () => this.toggleClickItOrbMenu());
    this.overlayManager.on('overlayEvent', (overlayEvent) => this.handleOverlayEvent(overlayEvent));

    this.hotkeyMonitor.start();

    // Open the connection to the worker now so the first request doesn't pay for the handshake.
    this.workerClient.warmUpConnectionIfNeeded();

    // If onboarding is done and permissions are still granted, show the cursor immediately.
    // If permissions were revoked the panel shows the permissions UI instead.
    if (this.hasCompletedOnboarding && this.allPermissionsGranted && this.isClickyCursorEnabled) {
      this.showOverlayWithoutWelcome();
    }
  }

  stop() {
    this.hotkeyMonitor.stop();
    this.dictationManager.cancelCurrentDictation();
    this.orbMenuManager.hideOrbMenu();
    this.windowPickerManager.hidePicker();
    if (this.regionSelectorManager) this.regionSelectorManager.cancel();
    this.actionsManager.closeResultWindow();
    if (this.voiceChatManager) this.voiceChatManager.stop();
    this.overlayManager.hideOverlay();
    this.cancelTransientHide();
    this.abortCurrentResponse();
    this.clearOnboardingPromptTimers();
    if (this.permissionPollingIntervalId) clearInterval(this.permissionPollingIntervalId);
    this.permissionPollingIntervalId = null;
  }

  // MARK: Permissions

  refreshAllPermissions() {
    const previouslyHadMicrophone = this.hasMicrophonePermission;

    const microphoneAccessStatus = systemPreferences.getMediaAccessStatus('microphone');
    this.hasMicrophonePermission =
      microphoneAccessStatus === 'granted' || (microphoneAccessStatus !== 'denied' && this.didMicrophoneProbeSucceed);

    if (previouslyHadMicrophone === this.hasMicrophonePermission) return;
    console.log(`[ClickIt] Permissions: microphone ${this.hasMicrophonePermission}`);

    // Permission arrived after onboarding was already done: bring the cursor back.
    if (
      this.hasMicrophonePermission &&
      this.hasCompletedOnboarding &&
      this.isClickyCursorEnabled &&
      !this.isOverlayVisible
    ) {
      this.showOverlayWithoutWelcome();
    }
    this.emitStateChanged();
  }

  /** Tries the mic; if Windows blocks it, sends the user to the Privacy settings page. */
  async requestMicrophonePermission() {
    this.didMicrophoneProbeSucceed = await this.audioBridge.probeMicrophoneAccess();
    this.refreshAllPermissions();
    if (!this.hasMicrophonePermission) {
      shell.openExternal('ms-settings:privacy-microphone');
    }
    this.emitStateChanged();
  }

  // MARK: Click It menu

  /**
   * Starts Click It, or closes it if it's already open. First the user chooses which
   * window ClickIt may look at; only then do the gemstones appear, and they work on
   * that one window only.
   */
  toggleClickItOrbMenu() {
    if (this.orbMenuManager.isShowingOrbMenu) {
      this.orbMenuManager.hideOrbMenu();
      return;
    }
    if (this.windowPickerManager.isShowingPicker) {
      this.windowPickerManager.hidePicker();
      return;
    }
    if (this.regionSelectorManager && this.regionSelectorManager.isActive) {
      this.regionSelectorManager.cancel();
      return;
    }
    this.windowPickerManager.showPicker({
      onSelectTarget: (chosenTarget) => this.showClickItGemsForTarget(chosenTarget),
      onCancel: () => {},
    });
  }

  /**
   * Takes the user to the window they chose and shows the gems on top of it. Windows can't
   * switch to a browser tab directly, so for a browser this brings up the window that is
   * showing the tab they picked.
   */
  async showClickItGemsForTarget(chosenTarget) {
    this.selectedClickItTarget = chosenTarget;

    let anchorPoint = null; // null: at the mouse (used for whole screens)
    if (chosenTarget.kind === 'window' && this.windowControlService) {
      const switchResult = await this.windowControlService.bringWindowToFront(chosenTarget.sourceId);
      if (switchResult.ok && switchResult.boundsInDips) {
        // Remember where the window is: Snap opens its area picker on that screen.
        this.selectedClickItTarget = { ...chosenTarget, boundsInDips: switchResult.boundsInDips };
        anchorPoint = this.findCenterOfVisibleWindowArea(switchResult.boundsInDips);
      } else {
        console.warn('[ClickIt] Could not switch to the chosen window:', switchResult.error || 'unknown');
      }
      // Give the window a moment to finish coming to the front before the gems appear over it.
      await sleep(120);
    }

    // The user may have closed things while the window was coming forward.
    if (this.orbMenuManager.isShowingOrbMenu || this.windowPickerManager.isShowingPicker) return;

    this.orbMenuManager.showOrbMenu({
      anchorPoint,
      onSelectAction: (selectedActionIdentifier) => this.handleClickItActionSelected(selectedActionIdentifier),
      onDismiss: () => this.orbMenuManager.hideOrbMenu(),
    });
  }

  /**
   * Runs the chosen gemstone action. The macOS app only shows a placeholder here;
   * on Windows the action captures the screen and answers in a result window.
   */
  /** Middle of the part of the window that is actually on a screen (windows can hang off an edge). */
  findCenterOfVisibleWindowArea(windowBounds) {
    const visibleScreenArea = screen.getDisplayMatching(windowBounds).workArea;
    const left = Math.max(windowBounds.x, visibleScreenArea.x);
    const top = Math.max(windowBounds.y, visibleScreenArea.y);
    const right = Math.min(windowBounds.x + windowBounds.width, visibleScreenArea.x + visibleScreenArea.width);
    const bottom = Math.min(windowBounds.y + windowBounds.height, visibleScreenArea.y + visibleScreenArea.height);
    if (right <= left || bottom <= top) {
      return { x: windowBounds.x + windowBounds.width / 2, y: windowBounds.y + windowBounds.height / 2 };
    }
    return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
  }

  handleClickItActionSelected(selectedActionIdentifier) {
    this.orbMenuManager.hideOrbMenu();
    const selectedAction = CLICK_IT_ACTIONS.find((action) => action.id === selectedActionIdentifier);
    if (!selectedAction || !selectedAction.isAvailable) return;

    // Voice chat doesn't work on the window picked in the picker: it asks for the screen itself,
    // only when the user asks about it, and checks it on this PC first.
    if (selectedAction.id === 'speech') {
      this.toggleVoiceChat();
      return;
    }

    // Let the menu window finish closing so it can't end up in the screenshot.
    const chosenTarget = this.selectedClickItTarget;
    setTimeout(() => {
      this.actionsManager.run(selectedAction.id, chosenTarget).catch((error) => {
        console.error('[ClickIt] Click It action failed to start:', error);
        this.lastErrorMessage = String(error && error.message ? error.message : error).slice(0, 240);
        this.emitStateChanged();
      });
    }, 120);
  }

  // MARK: Overlay events

  handleOverlayEvent(overlayEvent) {
    switch (overlayEvent.type) {
      case 'navigation-finished':
        // The cursor landed back at the mouse after pointing.
        this.clearDetectedElementLocation();
        this.finishOnboardingDemoAndShowPromptIfRunning();
        break;
      case 'onboarding-welcome-finished':
        this.runOnboardingDemoThenShowPrompt();
        break;
      default:
        break;
    }
  }

  /**
   * After the welcome message, the buddy flies to something interesting on screen and
   * comments on it, then the "try talking to me" prompt appears. If the demo can't run
   * (for example the worker is unreachable), the prompt appears right away.
   */
  async runOnboardingDemoThenShowPrompt() {
    this.isRunningOnboardingDemo = true;
    const didStartPointing = await this.performOnboardingDemoInteraction();
    if (!didStartPointing) {
      this.finishOnboardingDemoAndShowPromptIfRunning();
      return;
    }
    // Safety net in case the flight-finished event never arrives.
    this.onboardingPromptTimeoutIds.push(setTimeout(() => this.finishOnboardingDemoAndShowPromptIfRunning(), 20000));
  }

  finishOnboardingDemoAndShowPromptIfRunning() {
    if (!this.isRunningOnboardingDemo) return;
    this.isRunningOnboardingDemo = false;
    this.onboardingPromptTimeoutIds.push(setTimeout(() => this.startOnboardingPromptStream(), 300));
  }

  setDetectedElementLocation(globalLocation, displayFrame, bubbleText) {
    this.detectedElement = {
      requestIdentifier: this.nextDetectedElementRequestIdentifier,
      location: globalLocation,
      displayFrame,
      bubbleText: bubbleText || null,
    };
    this.nextDetectedElementRequestIdentifier += 1;
    this.overlayManager.updateOverlayState({ detectedElement: this.detectedElement });
  }

  clearDetectedElementLocation() {
    if (!this.detectedElement) return;
    this.detectedElement = null;
    this.overlayManager.updateOverlayState({ detectedElement: null });
  }

  // MARK: Push-to-talk

  handleDictationStateChange() {
    // While a response is running, the response pipeline owns the voice state.
    if (!this.isResponseInFlight && this.voiceState !== 'responding') {
      const dictation = this.dictationManager;
      if (dictation.isFinalizingTranscript) {
        this.setVoiceState('processing');
      } else if (dictation.isRecordingFromKeyboardShortcut) {
        this.setVoiceState('listening');
      } else if (dictation.isPreparingToRecord) {
        this.setVoiceState('processing');
      } else {
        this.setVoiceState('idle');
        // The user pressed and released without saying anything, so no response
        // will run. Schedule the transient hide here so the overlay doesn't get stuck.
        this.scheduleTransientHideIfNeeded();
      }
    }
    this.emitStateChanged();
  }

  /** Shows the small voice chat icon and starts listening, or ends the chat if it is already running. */
  toggleVoiceChat() {
    if (!this.voiceChatManager) return;
    if (this.voiceChatManager.isActive) {
      this.voiceChatManager.stop();
      this.emit('dismissPanel');
      return;
    }
    // Anything the push-to-talk pipeline is doing stops: the chat window takes the microphone.
    this.orbMenuManager.hideOrbMenu();
    this.dictationManager.cancelCurrentDictation();
    this.abortCurrentResponse();
    this.audioBridge.stopSpeech();
    this.clearDetectedElementLocation();
    this.setVoiceState('idle');
    this.lastErrorMessage = null;
    this.emit('dismissPanel');
    this.voiceChatManager.start();
  }

  handleShortcutTransition(shortcutTransition) {
    // The voice chat has the microphone; a second recording would fight it.
    if (this.voiceChatManager && this.voiceChatManager.isActive) return;

    if (shortcutTransition === 'pressed') {
      if (this.dictationManager.isDictationInProgress) return;

      // Keep the overlay visible: cancel any pending transient hide.
      this.cancelTransientHide();

      // If the cursor is hidden, bring it back transiently for this interaction.
      if (!this.isClickyCursorEnabled && !this.isOverlayVisible) {
        this.showOverlayWithoutWelcome();
      }

      // Dismiss the panel so it doesn't cover the screen.
      this.emit('dismissPanel');

      // Cancel any in-progress response and speech from a previous utterance.
      this.abortCurrentResponse();
      this.audioBridge.stopSpeech();
      this.clearDetectedElementLocation();
      this.lastErrorMessage = null;
      if (this.voiceState === 'responding') this.setVoiceState('idle');

      this.dismissOnboardingPromptIfShowing();

      this.dictationManager.startPushToTalkFromKeyboardShortcut((finalTranscript) => {
        this.lastTranscript = finalTranscript;
        console.log(`[ClickIt] Companion received transcript: ${finalTranscript}`);
        this.sendTranscriptToModelWithScreenshot(finalTranscript);
      });
    } else if (shortcutTransition === 'released') {
      // The dictation manager also handles a release that arrives before recording
      // has begun, so a quick press-and-release can't leave the waveform stuck.
      this.dictationManager.stopPushToTalkFromKeyboardShortcut();
    }
  }

  // MARK: AI response pipeline

  abortCurrentResponse() {
    if (this.currentResponse) {
      this.currentResponse.abortController.abort();
      this.currentResponse = null;
    }
    this.isResponseInFlight = false;
  }

  /**
   * Captures a screenshot, sends it with the transcript to the model, and speaks the
   * reply. The cursor stays in the spinner state until speech begins. If the reply
   * has a [POINT:x,y:label] tag, the buddy flies to that element on screen.
   */
  sendTranscriptToModelWithScreenshot(transcript) {
    this.abortCurrentResponse();
    this.audioBridge.stopSpeech();
    this.cancelTransientHide();

    const responseIdentifier = this.nextResponseIdentifier;
    this.nextResponseIdentifier += 1;
    const abortController = new AbortController();
    this.currentResponse = { identifier: responseIdentifier, abortController };
    this.isResponseInFlight = true;

    // Spinner state, no streamed text.
    this.setVoiceState('processing');

    this.runResponsePipeline(transcript, responseIdentifier, abortController.signal).catch((error) => {
      console.error('[ClickIt] Unhandled response pipeline error:', error);
    });
  }

  async runResponsePipeline(transcript, responseIdentifier, abortSignal) {
    try {
      // Capture all connected screens so the AI has full context.
      const screenCaptures = await this.overlayManager.runWithOverlaysExcludedFromCapture(() => captureAllScreensAsJpeg());
      if (abortSignal.aborted) return;

      // Read each screen on this PC first. Screens that show passwords, keys, card numbers
      // and the like are never sent to the AI.
      const { sendableCaptures, withheldCaptures } = await filterScreenCapturesForPrivacy({
        ocrService: this.ocrService,
        screenCaptures,
      });
      if (abortSignal.aborted) return;
      if (withheldCaptures.length > 0) {
        const withheldDescription = withheldCaptures
          .map(({ capture, reasons }) => `${capture.label.split(' —')[0]}: ${reasons.join(', ')}`)
          .join('; ');
        console.log(`[ClickIt] Withheld from the AI: ${withheldDescription}`);
        this.lastErrorMessage = `Click It didn't send ${withheldCaptures.length === 1 ? 'a screen' : 'some screens'} to the AI because of privacy: ${withheldCaptures.flatMap(({ reasons }) => reasons).slice(0, 3).join(', ')}.`;
        this.emitStateChanged();
      }

      // Label each image with its pixel dimensions so the model's coordinate space
      // matches the image it sees. We scale to display points ourselves.
      const labeledImages = sendableCaptures.map((screenCapture) => ({
        imageBuffer: screenCapture.imageBuffer,
        label: `${screenCapture.label} (image dimensions: ${screenCapture.screenshotWidthInPixels}x${screenCapture.screenshotHeightInPixels} pixels)`,
      }));

      // Tell the model plainly when it can't see something, so it doesn't guess.
      const privacyNote = withheldCaptures.length === 0
        ? ''
        : `\n\n(note for you: ${sendableCaptures.length === 0 ? 'no screenshot is attached' : 'some screens are not attached'} because ${withheldCaptures.length === 1 ? 'it' : 'they'} showed private information such as a password or key. you cannot see ${withheldCaptures.length === 1 ? 'it' : 'them'}. if the question needs ${withheldCaptures.length === 1 ? 'it' : 'them'}, say so briefly instead of guessing, and do not point at anything on ${withheldCaptures.length === 1 ? 'that screen' : 'those screens'}.)`;

      const { text: fullResponseText } = await this.workerClient.analyzeImageStreaming({
        images: labeledImages,
        systemPrompt: COMPANION_VOICE_RESPONSE_SYSTEM_PROMPT,
        model: this.selectedModel,
        conversationHistory: this.conversationHistory,
        userPrompt: `${transcript}${privacyNote}`,
        abortSignal,
      });
      if (abortSignal.aborted) return;

      // Parse the [POINT:...] tag from the response.
      const parseResult = parsePointingCoordinates(fullResponseText);
      const spokenText = parseResult.spokenText;

      // Switch to idle BEFORE setting the location so the triangle is visible and the
      // flight animation can be seen. The spinner would otherwise hide the triangle.
      if (parseResult.coordinate) this.setVoiceState('idle');

      // Pick the screen the model named, falling back to the cursor's screen. Never point
      // into a screen that was withheld: the model couldn't have seen it.
      let targetScreenCapture = null;
      if (parseResult.screenNumber !== null && parseResult.screenNumber >= 1 && parseResult.screenNumber <= screenCaptures.length) {
        targetScreenCapture = screenCaptures[parseResult.screenNumber - 1];
      } else {
        targetScreenCapture = screenCaptures.find((screenCapture) => screenCapture.isCursorScreen) || null;
      }
      if (targetScreenCapture && !sendableCaptures.includes(targetScreenCapture)) targetScreenCapture = null;

      if (parseResult.coordinate && targetScreenCapture) {
        const globalLocation = convertScreenshotPointToGlobalLocation(parseResult.coordinate, targetScreenCapture);
        this.setDetectedElementLocation(globalLocation, targetScreenCapture.displayFrame, null);
        console.log(
          `[ClickIt] Element pointing: (${Math.round(parseResult.coordinate.x)}, ${Math.round(parseResult.coordinate.y)}) -> "${parseResult.elementLabel || 'element'}"`
        );
      } else {
        console.log(`[ClickIt] Element pointing: ${parseResult.elementLabel || 'no element'}`);
      }

      // Save the exchange (point tag stripped so it doesn't confuse future context).
      this.conversationHistory.push({ userTranscript: transcript, assistantResponse: spokenText });
      if (this.conversationHistory.length > MAXIMUM_CONVERSATION_HISTORY_EXCHANGES) {
        this.conversationHistory.splice(0, this.conversationHistory.length - MAXIMUM_CONVERSATION_HISTORY_EXCHANGES);
      }
      console.log(`[ClickIt] Conversation history: ${this.conversationHistory.length} exchanges`);

      // Speak the reply. The spinner stays until audio actually starts.
      if (spokenText.trim() !== '') {
        try {
          await this.speakText(spokenText, abortSignal);
          if (abortSignal.aborted) return;
          this.setVoiceState('responding');
        } catch (error) {
          if (abortSignal.aborted) return;
          console.error('[ClickIt] Speech error:', error.message);
          this.speakErrorFallback();
        }
      }
    } catch (error) {
      if (abortSignal.aborted) return; // the user spoke again, so this response was interrupted
      console.error('[ClickIt] Companion response error:', error);
      this.lastErrorMessage = describeWorkerError(error, this.settings.get('workerBaseUrl'));
      this.speakErrorFallback();
    } finally {
      // Only the response that is still current may reset the state.
      if (this.currentResponse && this.currentResponse.identifier === responseIdentifier) {
        this.currentResponse = null;
        this.isResponseInFlight = false;
        this.setVoiceState('idle');
        this.scheduleTransientHideIfNeeded();
        this.emitStateChanged();
      }
    }
  }

  /** Plays the worker's TTS audio if it has one, otherwise uses the Windows system voice. */
  async speakText(textToSpeak, abortSignal) {
    const speechAudio = await this.workerClient.synthesizeSpeech(textToSpeak, abortSignal);
    if (abortSignal.aborted) return;

    if (speechAudio) {
      try {
        await this.audioBridge.playSpeechAudio(speechAudio);
        return;
      } catch (error) {
        console.warn('[ClickIt] Could not play worker speech, using the system voice:', error.message);
      }
    }
    await this.audioBridge.speakWithSystemVoice(textToSpeak);
  }

  /** Speaks a short error with the system voice so failures aren't silent. */
  speakErrorFallback() {
    this.audioBridge
      .speakWithSystemVoice("sorry, something went wrong reaching my brain. check that the worker is running and try again.")
      .catch(() => {});
    this.setVoiceState('responding');
  }

  // MARK: Transient cursor mode

  cancelTransientHide() {
    if (this.transientHideToken) this.transientHideToken.cancelled = true;
    this.transientHideToken = null;
  }

  /**
   * In transient mode ("Show Clicky" off), waits for speech and any pointing animation
   * to finish, then fades the overlay out after one second. Cancelled automatically
   * if the user starts another interaction.
   */
  scheduleTransientHideIfNeeded() {
    if (this.isClickyCursorEnabled || !this.isOverlayVisible) return;

    this.cancelTransientHide();
    const transientHideToken = { cancelled: false };
    this.transientHideToken = transientHideToken;

    (async () => {
      while (this.audioBridge.isTextToSpeechPlaying) {
        await sleep(200);
        if (transientHideToken.cancelled) return;
      }
      // The location is cleared when the buddy flies back to the cursor.
      while (this.detectedElement) {
        await sleep(200);
        if (transientHideToken.cancelled) return;
      }
      await sleep(1000);
      if (transientHideToken.cancelled) return;

      this.overlayManager.fadeOutAndHideOverlay();
      this.isOverlayVisible = false;
      this.emitStateChanged();
    })();
  }

  // MARK: Onboarding

  /** Dismisses the panel and starts the welcome animation and pointing demo. */
  triggerOnboarding() {
    this.emit('dismissPanel');
    this.settings.set('hasCompletedOnboarding', true);

    // First appearance of the overlay triggers the welcome animation.
    this.overlayManager.showOverlay();
    this.isOverlayVisible = true;
    this.emitStateChanged();
  }

  /** Replays onboarding from the "Watch Onboarding Again" link. */
  replayOnboarding() {
    this.emit('dismissPanel');
    this.overlayManager.hasShownOverlayBefore = false;
    this.overlayManager.showOverlay();
    this.isOverlayVisible = true;
    this.emitStateChanged();
  }

  clearOnboardingPromptTimers() {
    this.onboardingPromptTimeoutIds.forEach((timeoutId) => clearTimeout(timeoutId));
    this.onboardingPromptTimeoutIds = [];
  }

  setOnboardingPrompt(promptChanges) {
    const currentPrompt = this.overlayManager.overlayState.onboardingPrompt;
    this.overlayManager.updateOverlayState({ onboardingPrompt: { ...currentPrompt, ...promptChanges } });
  }

  /** Types the "try talking to me" prompt next to the cursor after the video ends. */
  startOnboardingPromptStream() {
    this.clearOnboardingPromptTimers();
    const messageToType = this.hotkeyMonitor.isUsingFallbackShortcuts
      ? 'press control + alt + space and introduce yourself'
      : 'hold control + alt and introduce yourself';

    this.setOnboardingPrompt({ text: '', show: true, opacity: 1 });

    let typedCharacterCount = 0;
    const typingIntervalId = setInterval(() => {
      if (typedCharacterCount >= messageToType.length) {
        clearInterval(typingIntervalId);
        // Auto-dismiss after 10 seconds.
        this.onboardingPromptTimeoutIds.push(
          setTimeout(() => this.dismissOnboardingPromptIfShowing(), 10000)
        );
        return;
      }
      typedCharacterCount += 1;
      this.setOnboardingPrompt({ text: messageToType.slice(0, typedCharacterCount) });
    }, 30);
    this.onboardingPromptTimeoutIds.push(typingIntervalId);
  }

  dismissOnboardingPromptIfShowing() {
    if (!this.overlayManager.overlayState.onboardingPrompt.show) return;
    this.clearOnboardingPromptTimers();
    this.setOnboardingPrompt({ opacity: 0 });
    this.onboardingPromptTimeoutIds.push(
      setTimeout(() => this.setOnboardingPrompt({ show: false, text: '' }), 350)
    );
  }

  /**
   * Asks the model to find something interesting to point at, then flies the
   * buddy there. Used during onboarding to demo pointing.
   * @returns {Promise<boolean>} true if the buddy was sent to point at something
   */
  async performOnboardingDemoInteraction() {
    // Don't interrupt an active voice response.
    if (this.voiceState !== 'idle' && this.voiceState !== 'responding') return false;

    try {
      const screenCaptures = await this.overlayManager.runWithOverlaysExcludedFromCapture(() => captureAllScreensAsJpeg());

      // Only send the cursor screen so the model can't pick something on another monitor.
      const cursorScreenCapture = screenCaptures.find((screenCapture) => screenCapture.isCursorScreen);
      if (!cursorScreenCapture) {
        console.log('[ClickIt] Onboarding demo: no cursor screen found');
        return false;
      }

      // The demo screenshot gets the same on-device check as everything else.
      const { sendableCaptures } = await filterScreenCapturesForPrivacy({
        ocrService: this.ocrService,
        screenCaptures: [cursorScreenCapture],
      });
      if (sendableCaptures.length === 0) {
        console.log('[ClickIt] Onboarding demo skipped: the screen looked private.');
        return false;
      }

      const { text: fullResponseText } = await this.workerClient.analyzeImageStreaming({
        images: [
          {
            imageBuffer: cursorScreenCapture.imageBuffer,
            label: `${cursorScreenCapture.label} (image dimensions: ${cursorScreenCapture.screenshotWidthInPixels}x${cursorScreenCapture.screenshotHeightInPixels} pixels)`,
          },
        ],
        systemPrompt: ONBOARDING_DEMO_SYSTEM_PROMPT,
        model: this.selectedModel,
        userPrompt: 'look around my screen and find something interesting to point at',
      });

      const parseResult = parsePointingCoordinates(fullResponseText);
      if (!parseResult.coordinate) {
        console.log('[ClickIt] Onboarding demo: no element to point at');
        return false;
      }

      const globalLocation = convertScreenshotPointToGlobalLocation(parseResult.coordinate, cursorScreenCapture);
      // The model's comment becomes the bubble text instead of a random phrase.
      this.setDetectedElementLocation(globalLocation, cursorScreenCapture.displayFrame, parseResult.spokenText);
      console.log(`[ClickIt] Onboarding demo: pointing at "${parseResult.elementLabel || 'element'}" - "${parseResult.spokenText}"`);
      return true;
    } catch (error) {
      console.error('[ClickIt] Onboarding demo error:', error.message);
      return false;
    }
  }
}

module.exports = { CompanionManager, AVAILABLE_MODELS };
