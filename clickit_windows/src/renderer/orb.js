// Click It radial menu: a center close orb surrounded by five gemstones. Each
// gemstone floats gently, grows and glows on hover, and shows a ring when selected
// with the keyboard. Arrow keys or Tab move the selection, Enter or Space activates
// it, and Escape closes the menu. Port of ClickItOrbMenuView.

(async function startOrbMenu() {
  const MENU_RADIUS = 70;
  // Middle of the gem ring inside the window (the intro sits above it, the caption below).
  const MENU_CENTER_X = 140;
  const MENU_CENTER_Y = 152;
  const INTRO_TEXT = "hi, i'm click it. ai living in your cursor.";
  const INTRO_CHARACTER_DELAY_MILLISECONDS = 28;

  // Hand-drawn stand-ins for the SF Symbols the macOS menu uses.
  const ICON_MARKUP_BY_NAME = {
    'camera-viewfinder':
      '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="8" y="9" width="8" height="6" rx="1.2"/><path d="M10.5 9l.6-1h1.8l.6 1"/>',
    'question-bubble':
      '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M10 9.5a2 2 0 1 1 2.8 1.8c-.6.3-.8.7-.8 1.2"/><path d="M12 14.2v.1"/>',
    'character-bubble':
      '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 9h8M12 8v1M9.5 12c1.5-.5 2.7-1.6 3.3-3M10 10.5c.6 1 1.6 1.7 3 2"/>',
    waveform: '<path d="M5 10v4M8.5 7v10M12 4v16M15.5 8v8M19 10.5v3"/>',
    'lock-shield':
      '<path d="M12 3l7 2.5v5.7c0 4.2-2.9 7.6-7 9.3-4.1-1.7-7-5.1-7-9.3V5.5z"/><rect x="9" y="11" width="6" height="4.5" rx="1"/><path d="M10.2 11V9.8a1.8 1.8 0 0 1 3.6 0V11"/>',
  };

  const clickItActions = await window.clickItOrb.getActions();
  const orbMenuElement = document.getElementById('orb-menu');

  let hoveredActionIdentifier = null;
  let keyboardSelectedActionIndex = 0;
  const gemButtonElements = [];
  const gemLabelElements = [];

  function rgbString(color, opacity = 1) {
    return `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${opacity})`;
  }

  // Center close orb.
  const centerOrbElement = document.createElement('button');
  centerOrbElement.id = 'center-orb';
  centerOrbElement.title = 'Close Click It (Esc)';
  centerOrbElement.setAttribute('aria-label', 'Close Click It menu');
  centerOrbElement.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  centerOrbElement.addEventListener('click', () => window.clickItOrb.dismiss());
  orbMenuElement.appendChild(centerOrbElement);

  // Gemstones are spread evenly around the center, starting at the top.
  clickItActions.forEach((action, actionIndex) => {
    const angleInRadians = (actionIndex / clickItActions.length) * 2 * Math.PI - Math.PI / 2;

    const slotElement = document.createElement('div');
    slotElement.className = 'gem-slot';
    slotElement.style.left = `${MENU_CENTER_X + Math.cos(angleInRadians) * MENU_RADIUS}px`;
    slotElement.style.top = `${MENU_CENTER_Y + Math.sin(angleInRadians) * MENU_RADIUS}px`;

    const floatElement = document.createElement('div');
    floatElement.className = `gem-float ${actionIndex % 2 === 0 ? 'float-even' : 'float-odd'}`;
    if (!action.isAvailable) floatElement.classList.add('is-unavailable');

    const gemButtonElement = document.createElement('button');
    gemButtonElement.className = 'gem-button';
    gemButtonElement.disabled = !action.isAvailable;
    gemButtonElement.title = action.tooltip;
    gemButtonElement.setAttribute('aria-label', action.isAvailable ? action.label : `${action.label}, coming soon`);
    gemButtonElement.style.setProperty('--gem-color', rgbString(action.gemstoneColor));
    gemButtonElement.style.setProperty('--gem-color-dim', rgbString(action.gemstoneColor, 0.7));
    gemButtonElement.style.setProperty('--gem-glow-low', rgbString(action.gemstoneColor, 0.45));
    gemButtonElement.style.setProperty('--gem-glow-high', rgbString(action.gemstoneColor, 0.95));
    gemButtonElement.innerHTML = `<svg viewBox="0 0 24 24">${ICON_MARKUP_BY_NAME[action.iconName] || ''}</svg>`;
    gemButtonElement.addEventListener('click', () => window.clickItOrb.selectAction(action.id));
    gemButtonElement.addEventListener('mouseenter', () => {
      hoveredActionIdentifier = action.id;
      refreshHighlights();
    });
    gemButtonElement.addEventListener('mouseleave', () => {
      if (hoveredActionIdentifier === action.id) hoveredActionIdentifier = null;
      refreshHighlights();
    });

    const gemLabelElement = document.createElement('div');
    gemLabelElement.className = 'gem-label';
    gemLabelElement.textContent = action.isAvailable ? action.label : `${action.label} - Coming soon`;

    floatElement.append(gemButtonElement, gemLabelElement);
    slotElement.appendChild(floatElement);
    orbMenuElement.appendChild(slotElement);
    gemButtonElements.push(gemButtonElement);
    gemLabelElements.push(gemLabelElement);
  });

  function refreshHighlights() {
    clickItActions.forEach((action, actionIndex) => {
      const isHovered = hoveredActionIdentifier === action.id;
      const isKeyboardSelected = keyboardSelectedActionIndex === actionIndex;
      const isHighlighted = (isHovered || isKeyboardSelected) && action.isAvailable;
      gemButtonElements[actionIndex].classList.toggle('is-hovered', isHovered && action.isAvailable);
      gemButtonElements[actionIndex].classList.toggle('is-keyboard-selected', isKeyboardSelected);
      gemButtonElements[actionIndex].classList.toggle('is-highlighted', isHighlighted);
      gemLabelElements[actionIndex].classList.toggle('is-highlighted', isHighlighted);
    });
  }

  document.addEventListener('keydown', (keyboardEvent) => {
    const actionCount = clickItActions.length;
    switch (keyboardEvent.key) {
      case 'Escape':
        window.clickItOrb.dismiss();
        break;
      case 'Enter':
      case ' ': {
        const selectedAction = clickItActions[keyboardSelectedActionIndex];
        if (selectedAction.isAvailable) window.clickItOrb.selectAction(selectedAction.id);
        break;
      }
      case 'ArrowRight':
      case 'ArrowDown':
      case 'Tab':
        keyboardSelectedActionIndex = (keyboardSelectedActionIndex + 1) % actionCount;
        refreshHighlights();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        keyboardSelectedActionIndex = (keyboardSelectedActionIndex - 1 + actionCount) % actionCount;
        refreshHighlights();
        break;
      default:
        return;
    }
    keyboardEvent.preventDefault();
  });

  // Typed greeting above the gems.
  const introBubbleElement = document.createElement('div');
  introBubbleElement.id = 'intro-bubble';
  introBubbleElement.classList.add('is-typing');
  orbMenuElement.appendChild(introBubbleElement);
  let typedCharacterCount = 0;
  const typingIntervalId = setInterval(() => {
    typedCharacterCount += 1;
    introBubbleElement.textContent = INTRO_TEXT.slice(0, typedCharacterCount);
    if (typedCharacterCount >= INTRO_TEXT.length) {
      clearInterval(typingIntervalId);
      introBubbleElement.classList.remove('is-typing');
    }
  }, INTRO_CHARACTER_DELAY_MILLISECONDS);

  refreshHighlights();
  requestAnimationFrame(() => orbMenuElement.classList.add('is-open'));
})();
