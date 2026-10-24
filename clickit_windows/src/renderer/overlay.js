// Cursor overlay renderer. Port of BlueCursorView (OverlayWindow.swift).
// One instance runs per display. It follows the real mouse with a spring, swaps
// between triangle / waveform / spinner by voice state, and flies along a bezier
// arc to elements the model points at.

(async function startOverlay() {
  const initialState = await window.clickItOverlay.getInitialState();
  if (!initialState) return;

  const screenFrame = initialState.screenFrame;
  const isFirstAppearance = initialState.isFirstAppearance;
  let overlayState = initialState.overlayState;

  // ---- Layout constants (same values as the macOS view) ----
  const CURSOR_FOLLOW_OFFSET = { x: 35, y: 25 };
  const DEFAULT_TRIANGLE_ROTATION_DEGREES = -35;
  const FULL_WELCOME_MESSAGE = "hi, i'm click it. ai living in your cursor.";
  const NAVIGATION_POINTER_PHRASES = ['right here!', 'this one!', 'over here!', 'click this!', 'here it is!', 'found it!'];
  const SPRING_RESPONSE_SECONDS = 0.2;
  const SPRING_DAMPING_FRACTION = 0.6;

  // ---- Elements ----
  const buddyAnchorElement = document.getElementById('buddy-anchor');
  const cursorVisualsElement = document.getElementById('cursor-visuals');
  const triangleScaleWrapperElement = document.getElementById('triangle-scale-wrapper');
  const triangleElement = document.getElementById('triangle');
  const waveformElement = document.getElementById('waveform');
  const waveformBarElements = Array.from(document.querySelectorAll('.waveform-bar'));
  const spinnerElement = document.getElementById('spinner');
  const welcomeBubbleElement = document.getElementById('welcome-bubble');
  const promptBubbleElement = document.getElementById('prompt-bubble');
  const navigationBubbleElement = document.getElementById('navigation-bubble');

  // ---- State ----
  let latestMouseLocation = {
    x: initialState.cursorLocation.x - screenFrame.x,
    y: initialState.cursorLocation.y - screenFrame.y,
  };
  let isCursorOnThisScreen = isGlobalPointOnThisScreen(initialState.cursorLocation);

  // The buddy sits offset from the mouse. Seeded so it doesn't flash at (0,0).
  let cursorPosition = { x: latestMouseLocation.x + CURSOR_FOLLOW_OFFSET.x, y: latestMouseLocation.y + CURSOR_FOLLOW_OFFSET.y };
  let cursorVelocity = { x: 0, y: 0 };

  let buddyNavigationMode = 'followingCursor'; // followingCursor | navigatingToTarget | pointingAtTarget
  let isReturningToCursor = false;
  let triangleRotationDegrees = DEFAULT_TRIANGLE_ROTATION_DEGREES;
  let buddyFlightScale = 1;
  let cursorPositionWhenNavigationStarted = { x: 0, y: 0 };
  let activeFlight = null;

  let audioPowerLevel = 0;
  let showWelcome = true;
  let welcomeText = '';
  let navigationBubbleText = '';
  let navigationBubbleScale = 1;
  let lastHandledDetectedElementRequestIdentifier = 0;

  function isGlobalPointOnThisScreen(globalPoint) {
    return (
      globalPoint.x >= screenFrame.x &&
      globalPoint.x < screenFrame.x + screenFrame.width &&
      globalPoint.y >= screenFrame.y &&
      globalPoint.y < screenFrame.y + screenFrame.height
    );
  }

  function convertGlobalPointToLocal(globalPoint) {
    return { x: globalPoint.x - screenFrame.x, y: globalPoint.y - screenFrame.y };
  }

  // ---- Visibility ----

  /**
   * Whether the buddy should be drawn on this screen. While another screen's overlay
   * is flying to an element, this one hides so only one buddy is ever visible.
   */
  function buddyIsVisibleOnThisScreen() {
    if (buddyNavigationMode === 'followingCursor') {
      if (overlayState.detectedElement) return false;
      return isCursorOnThisScreen;
    }
    return true;
  }

  function applyVisibility() {
    const isVisible = buddyIsVisibleOnThisScreen();
    const voiceState = overlayState.voiceState;
    triangleScaleWrapperElement.style.opacity = isVisible && (voiceState === 'idle' || voiceState === 'responding') ? '1' : '0';
    waveformElement.style.opacity = isVisible && voiceState === 'listening' ? '1' : '0';
    spinnerElement.style.opacity = isVisible && voiceState === 'processing' ? '1' : '0';

    const prompt = overlayState.onboardingPrompt;
    const shouldShowPrompt = isCursorOnThisScreen && prompt.show && prompt.text !== '';
    promptBubbleElement.textContent = prompt.text;
    promptBubbleElement.style.opacity = shouldShowPrompt ? String(prompt.opacity) : '0';

    welcomeBubbleElement.textContent = welcomeText;
    welcomeBubbleElement.style.opacity = isCursorOnThisScreen && showWelcome && welcomeText !== '' ? String(welcomeBubbleOpacity) : '0';

    navigationBubbleElement.textContent = navigationBubbleText;
    const isPointing = buddyNavigationMode === 'pointingAtTarget' && navigationBubbleText !== '';
    navigationBubbleElement.style.opacity = isPointing ? String(navigationBubbleOpacity) : '0';
    // Pop-in: scale springs from 0.5 to 1 and the glow starts bright, then settles.
    const glowStrength = 1 - navigationBubbleScale;
    navigationBubbleElement.style.transform = `translateY(-50%) scale(${navigationBubbleScale})`;
    navigationBubbleElement.style.boxShadow = `0 0 ${6 + glowStrength * 16}px rgba(255, 79, 163, ${0.5 + glowStrength})`;
  }

  let welcomeBubbleOpacity = 1;
  let navigationBubbleOpacity = 0;

  // ---- Per-frame update ----

  let lastFrameTimestamp = performance.now();
  let lastWaveformUpdateTimestamp = 0;

  function stepSpringTowardCursor(deltaSeconds) {
    const angularFrequency = (2 * Math.PI) / SPRING_RESPONSE_SECONDS;
    const targetX = latestMouseLocation.x + CURSOR_FOLLOW_OFFSET.x;
    const targetY = latestMouseLocation.y + CURSOR_FOLLOW_OFFSET.y;

    // Buddy is on another screen: no need to animate, just stay parked at the target.
    if (!isCursorOnThisScreen) {
      cursorPosition = { x: targetX, y: targetY };
      cursorVelocity = { x: 0, y: 0 };
      return;
    }

    // Small fixed sub-steps keep the spring stable on slow frames.
    const subStepSeconds = 1 / 240;
    let remainingSeconds = Math.min(deltaSeconds, 0.05);
    while (remainingSeconds > 0) {
      const stepSeconds = Math.min(subStepSeconds, remainingSeconds);
      const accelerationX = -angularFrequency * angularFrequency * (cursorPosition.x - targetX) - 2 * SPRING_DAMPING_FRACTION * angularFrequency * cursorVelocity.x;
      const accelerationY = -angularFrequency * angularFrequency * (cursorPosition.y - targetY) - 2 * SPRING_DAMPING_FRACTION * angularFrequency * cursorVelocity.y;
      cursorVelocity.x += accelerationX * stepSeconds;
      cursorVelocity.y += accelerationY * stepSeconds;
      cursorPosition.x += cursorVelocity.x * stepSeconds;
      cursorPosition.y += cursorVelocity.y * stepSeconds;
      remainingSeconds -= stepSeconds;
    }
  }

  /** Advances the bezier flight, if one is running. */
  function stepFlight(frameTimestamp) {
    if (!activeFlight) return;
    const flight = activeFlight;
    const linearProgress = (frameTimestamp - flight.startTimestamp) / flight.durationMilliseconds;

    if (linearProgress >= 1) {
      activeFlight = null;
      cursorPosition = { ...flight.endPosition };
      buddyFlightScale = 1;
      flight.onComplete();
      return;
    }

    // Smoothstep ease-in-out: 3t^2 - 2t^3.
    const t = linearProgress * linearProgress * (3 - 2 * linearProgress);
    const oneMinusT = 1 - t;
    const { startPosition, controlPoint, endPosition } = flight;

    // Quadratic bezier: B(t) = (1-t)^2 P0 + 2(1-t)t P1 + t^2 P2.
    cursorPosition = {
      x: oneMinusT * oneMinusT * startPosition.x + 2 * oneMinusT * t * controlPoint.x + t * t * endPosition.x,
      y: oneMinusT * oneMinusT * startPosition.y + 2 * oneMinusT * t * controlPoint.y + t * t * endPosition.y,
    };

    // Face the direction of travel: tangent B'(t) = 2(1-t)(P1-P0) + 2t(P2-P1).
    const tangentX = 2 * oneMinusT * (controlPoint.x - startPosition.x) + 2 * t * (endPosition.x - controlPoint.x);
    const tangentY = 2 * oneMinusT * (controlPoint.y - startPosition.y) + 2 * t * (endPosition.y - controlPoint.y);
    // +90 because the triangle's tip points up at 0 degrees while atan2 treats rightward as 0.
    triangleRotationDegrees = (Math.atan2(tangentY, tangentX) * 180) / Math.PI + 90;

    // Grows to ~1.3x at the apex of the flight, back to 1.0x on landing.
    buddyFlightScale = 1 + Math.sin(linearProgress * Math.PI) * 0.3;
  }

  function updateWaveformBars(frameTimestamp) {
    // ~36 fps is plenty for the bars.
    if (frameTimestamp - lastWaveformUpdateTimestamp < 28) return;
    lastWaveformUpdateTimestamp = frameTimestamp;

    const listeningBarProfile = [0.4, 0.7, 1.0, 0.7, 0.4];
    const normalizedPowerLevel = Math.max(audioPowerLevel - 0.008, 0);
    const easedPowerLevel = Math.pow(Math.min(normalizedPowerLevel * 2.85, 1), 0.76);

    waveformBarElements.forEach((barElement, barIndex) => {
      const animationPhase = (frameTimestamp / 1000) * 3.6 + barIndex * 0.35;
      const reactiveHeight = easedPowerLevel * 10 * listeningBarProfile[barIndex];
      const idlePulse = ((Math.sin(animationPhase) + 1) / 2) * 1.5;
      barElement.style.height = `${3 + reactiveHeight + idlePulse}px`;
    });
  }

  function renderFrame(frameTimestamp) {
    const deltaSeconds = (frameTimestamp - lastFrameTimestamp) / 1000;
    lastFrameTimestamp = frameTimestamp;

    if (buddyNavigationMode === 'followingCursor') {
      stepSpringTowardCursor(deltaSeconds);
    } else {
      stepFlight(frameTimestamp);
    }

    buddyAnchorElement.style.transform = `translate3d(${cursorPosition.x}px, ${cursorPosition.y}px, 0)`;
    triangleElement.style.transform = `rotate(${triangleRotationDegrees}deg)`;
    triangleElement.classList.toggle('is-navigating', buddyNavigationMode === 'navigatingToTarget');
    triangleScaleWrapperElement.style.transform = `scale(${buddyFlightScale})`;
    triangleScaleWrapperElement.style.filter = `drop-shadow(0 0 ${8 + (buddyFlightScale - 1) * 20}px #FF4FA3)`;

    if (overlayState.voiceState === 'listening') updateWaveformBars(frameTimestamp);
    requestAnimationFrame(renderFrame);
  }

  // ---- Element navigation ----

  function startNavigatingToElement(detectedElement) {
    // Don't interrupt the welcome animation.
    if (showWelcome && welcomeText !== '') return;

    const targetInLocalCoordinates = convertGlobalPointToLocal(detectedElement.location);
    // Sit beside the element rather than on top of it: 8px right, 12px below.
    const offsetTarget = { x: targetInLocalCoordinates.x + 8, y: targetInLocalCoordinates.y + 12 };
    const clampedTarget = {
      x: Math.max(20, Math.min(offsetTarget.x, screenFrame.width - 20)),
      y: Math.max(20, Math.min(offsetTarget.y, screenFrame.height - 20)),
    };

    // Remember where the mouse was so moving it can cancel the return flight.
    cursorPositionWhenNavigationStarted = { ...latestMouseLocation };

    buddyNavigationMode = 'navigatingToTarget';
    isReturningToCursor = false;

    animateBezierFlightArc(clampedTarget, () => {
      if (buddyNavigationMode !== 'navigatingToTarget') return;
      startPointingAtElement(detectedElement);
    });
  }

  /** Flies along a quadratic bezier arc. Duration scales with distance, clamped to 0.6s-1.4s. */
  function animateBezierFlightArc(destination, onComplete) {
    const startPosition = { ...cursorPosition };
    const distance = Math.hypot(destination.x - startPosition.x, destination.y - startPosition.y);
    const flightDurationSeconds = Math.min(Math.max(distance / 800, 0.6), 1.4);

    // Lift the control point so the buddy travels in a parabolic arc.
    const midPoint = { x: (startPosition.x + destination.x) / 2, y: (startPosition.y + destination.y) / 2 };
    const arcHeight = Math.min(distance * 0.2, 80);

    activeFlight = {
      startPosition,
      endPosition: { ...destination },
      controlPoint: { x: midPoint.x, y: midPoint.y - arcHeight },
      startTimestamp: performance.now(),
      durationMilliseconds: flightDurationSeconds * 1000,
      onComplete,
    };
  }

  function startPointingAtElement(detectedElement) {
    buddyNavigationMode = 'pointingAtTarget';
    triangleRotationDegrees = DEFAULT_TRIANGLE_ROTATION_DEGREES;

    // Start small for the scale-bounce entrance.
    navigationBubbleText = '';
    navigationBubbleOpacity = 1;
    navigationBubbleScale = 0.5;
    applyVisibility();

    const pointerPhrase =
      detectedElement.bubbleText || NAVIGATION_POINTER_PHRASES[Math.floor(Math.random() * NAVIGATION_POINTER_PHRASES.length)];

    streamNavigationBubbleCharacter(pointerPhrase, 0, () => {
      // Hold for 3 seconds, then fade the bubble and fly back.
      setTimeout(() => {
        if (buddyNavigationMode !== 'pointingAtTarget') return;
        navigationBubbleOpacity = 0;
        applyVisibility();
        setTimeout(() => {
          if (buddyNavigationMode !== 'pointingAtTarget') return;
          startFlyingBackToCursor();
        }, 500);
      }, 3000);
    });
  }

  /** Streams the bubble text one character at a time with 30-60ms delays. */
  function streamNavigationBubbleCharacter(phrase, characterIndex, onComplete) {
    if (buddyNavigationMode !== 'pointingAtTarget') return;
    if (characterIndex >= phrase.length) {
      onComplete();
      return;
    }

    navigationBubbleText += phrase[characterIndex];
    if (characterIndex === 0) navigationBubbleScale = 1; // triggers the bounce-in
    applyVisibility();

    const characterDelayMilliseconds = 30 + Math.random() * 30;
    setTimeout(() => streamNavigationBubbleCharacter(phrase, characterIndex + 1, onComplete), characterDelayMilliseconds);
  }

  function startFlyingBackToCursor() {
    const cursorWithTrackingOffset = {
      x: latestMouseLocation.x + CURSOR_FOLLOW_OFFSET.x,
      y: latestMouseLocation.y + CURSOR_FOLLOW_OFFSET.y,
    };
    cursorPositionWhenNavigationStarted = { ...latestMouseLocation };

    buddyNavigationMode = 'navigatingToTarget';
    isReturningToCursor = true;
    animateBezierFlightArc(cursorWithTrackingOffset, finishNavigationAndResumeFollowing);
  }

  /** The user moved the mouse during the return flight: snap back to following. */
  function cancelNavigationAndResumeFollowing() {
    activeFlight = null;
    finishNavigationAndResumeFollowing();
  }

  function finishNavigationAndResumeFollowing() {
    activeFlight = null;
    buddyNavigationMode = 'followingCursor';
    isReturningToCursor = false;
    triangleRotationDegrees = DEFAULT_TRIANGLE_ROTATION_DEGREES;
    buddyFlightScale = 1;
    navigationBubbleText = '';
    navigationBubbleOpacity = 0;
    navigationBubbleScale = 1;
    cursorVelocity = { x: 0, y: 0 };
    applyVisibility();
    window.clickItOverlay.sendEvent({ type: 'navigation-finished' });
  }

  // ---- Welcome animation ----

  function startWelcomeAnimation() {
    welcomeBubbleOpacity = 1;
    applyVisibility();

    let currentIndex = 0;
    const typingIntervalId = setInterval(() => {
      if (currentIndex >= FULL_WELCOME_MESSAGE.length) {
        clearInterval(typingIntervalId);
        // Hold the text for 2 seconds, then fade it out.
        setTimeout(() => {
          welcomeBubbleOpacity = 0;
          applyVisibility();
        }, 2000);
        setTimeout(() => {
          showWelcome = false;
          applyVisibility();
          // Once the welcome text is gone, the app runs the live pointing demo.
          window.clickItOverlay.sendEvent({ type: 'onboarding-welcome-finished' });
        }, 2500);
        return;
      }
      welcomeText += FULL_WELCOME_MESSAGE[currentIndex];
      currentIndex += 1;
      applyVisibility();
    }, 30);
  }

  // ---- Messages from the main process ----

  window.clickItOverlay.onCursorLocation((globalCursorLocation) => {
    isCursorOnThisScreen = isGlobalPointOnThisScreen(globalCursorLocation);
    latestMouseLocation = convertGlobalPointToLocal(globalCursorLocation);

    // Only the RETURN flight can be cancelled by moving the mouse. The outbound
    // flight and the pointing pause always finish.
    if (buddyNavigationMode === 'navigatingToTarget' && isReturningToCursor) {
      const distanceFromNavigationStart = Math.hypot(
        latestMouseLocation.x - cursorPositionWhenNavigationStarted.x,
        latestMouseLocation.y - cursorPositionWhenNavigationStarted.y
      );
      if (distanceFromNavigationStart > 100) cancelNavigationAndResumeFollowing();
    }
    applyVisibility();
  });

  window.clickItOverlay.onOverlayState((newOverlayState) => {
    overlayState = newOverlayState;

    const detectedElement = overlayState.detectedElement;
    if (detectedElement && detectedElement.requestIdentifier !== lastHandledDetectedElementRequestIdentifier) {
      lastHandledDetectedElementRequestIdentifier = detectedElement.requestIdentifier;
      // Only the overlay whose display holds the target animates.
      const targetFrame = detectedElement.displayFrame;
      const isTargetOnThisScreen =
        targetFrame.x === screenFrame.x &&
        targetFrame.y === screenFrame.y &&
        targetFrame.width === screenFrame.width &&
        targetFrame.height === screenFrame.height;
      if (isTargetOnThisScreen) startNavigatingToElement(detectedElement);
    }
    applyVisibility();
  });

  window.clickItOverlay.onAudioPowerLevel((newAudioPowerLevel) => {
    audioPowerLevel = newAudioPowerLevel;
  });

  window.clickItOverlay.onFadeOut((durationSeconds) => {
    document.body.style.transition = `opacity ${durationSeconds}s ease-in`;
    document.body.style.opacity = '0';
  });

  // ---- Startup ----

  applyVisibility();
  requestAnimationFrame(renderFrame);

  if (isFirstAppearance && isCursorOnThisScreen) {
    // Fade the cursor in over 2 seconds, then type the welcome message.
    cursorVisualsElement.style.transition = 'opacity 2s ease-in';
    requestAnimationFrame(() => {
      cursorVisualsElement.style.opacity = '1';
    });
    setTimeout(() => {
      welcomeBubbleOpacity = 0;
      applyVisibility();
      startWelcomeAnimation();
    }, 2000);
  } else {
    cursorVisualsElement.style.opacity = '1';
  }
})();
