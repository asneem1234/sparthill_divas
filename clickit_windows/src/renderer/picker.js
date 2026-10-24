// Window picker UI. Shows live previews of open windows; blocked ones (password managers
// and similar) are blurred and can't be chosen.

(function startPicker() {
  const statusElement = document.getElementById('status');
  const gridElement = document.getElementById('grid');
  let cardElements = [];

  function buildCard(item) {
    const cardElement = document.createElement('button');
    cardElement.className = `card${item.isBlocked ? ' is-blocked' : ''}`;
    cardElement.setAttribute('role', 'option');
    cardElement.setAttribute('aria-disabled', item.isBlocked ? 'true' : 'false');
    cardElement.title = item.isBlocked ? `${item.name}: ${item.blockedReason}` : item.name;

    const thumbnailFrame = document.createElement('div');
    thumbnailFrame.className = `thumbnail-frame${item.isBlocked ? ' is-blocked-frame' : ''}`;
    if (item.isBlocked) {
      // No preview at all for blocked windows: just a label.
      const lockBadge = document.createElement('div');
      lockBadge.className = 'lock-badge';
      lockBadge.textContent = 'Blocked';
      thumbnailFrame.appendChild(lockBadge);
    } else {
      const thumbnailElement = document.createElement('img');
      thumbnailElement.className = 'thumbnail';
      thumbnailElement.alt = '';
      thumbnailElement.src = item.thumbnailDataUrl;
      thumbnailFrame.appendChild(thumbnailElement);
    }

    const titleRow = document.createElement('div');
    titleRow.className = 'card-title-row';
    if (item.iconDataUrl) {
      const iconElement = document.createElement('img');
      iconElement.className = 'app-icon';
      iconElement.alt = '';
      iconElement.src = item.iconDataUrl;
      titleRow.appendChild(iconElement);
    }
    const titleElement = document.createElement('span');
    titleElement.className = 'card-title';
    titleElement.textContent = item.name; // textContent: window titles are untrusted text
    titleRow.appendChild(titleElement);

    const subtitleElement = document.createElement('div');
    subtitleElement.className = 'card-subtitle';
    subtitleElement.textContent = item.isBlocked
      ? item.blockedReason
      : item.kind === 'screen'
        ? 'Everything on this display'
        : item.processName;

    cardElement.append(thumbnailFrame, titleRow, subtitleElement);

    cardElement.addEventListener('click', () => {
      if (!item.isBlocked) window.clickItPicker.select(item.sourceId);
    });
    return cardElement;
  }

  function moveFocus(step) {
    const enabledCards = cardElements.filter((cardElement) => !cardElement.classList.contains('is-blocked'));
    if (enabledCards.length === 0) return;
    const currentIndex = enabledCards.indexOf(document.activeElement);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + step + enabledCards.length) % enabledCards.length;
    enabledCards[nextIndex].focus();
  }

  window.clickItPicker.onItems((items) => {
    gridElement.textContent = '';
    cardElements = items.map(buildCard);
    cardElements.forEach((cardElement) => gridElement.appendChild(cardElement));

    if (items.length === 0) {
      statusElement.textContent = 'No windows found. Open the window you want Click It to look at, then try again.';
      return;
    }
    statusElement.classList.add('hidden');
    moveFocus(0);
  });

  window.clickItPicker.onError((message) => {
    statusElement.classList.remove('hidden');
    statusElement.textContent = `Couldn't list your windows: ${message}`;
  });

  document.getElementById('close-button').addEventListener('click', () => window.clickItPicker.cancel());

  document.addEventListener('keydown', (keyboardEvent) => {
    switch (keyboardEvent.key) {
      case 'Escape':
        window.clickItPicker.cancel();
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        moveFocus(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        moveFocus(-1);
        break;
      default:
        return;
    }
    keyboardEvent.preventDefault();
  });
})();
