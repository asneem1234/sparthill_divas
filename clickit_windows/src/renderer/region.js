// Snap area picker: drag a rectangle over the frozen screen, then press Snap (or Enter).
// Dragging again starts over. Esc or Cancel closes it without snapping.

(function startRegionSelector() {
  const element = (elementIdentifier) => document.getElementById(elementIdentifier);
  const frozenPictureElement = element('frozen-picture');
  const dimElement = element('dim');
  const hintElement = element('hint');
  const selectionElement = element('selection');
  const sizeLabelElement = element('size-label');
  const toolbarElement = element('toolbar');

  const MINIMUM_SELECTION_SIZE = 12;
  const TOOLBAR_GAP = 10;

  let screenWidth = window.innerWidth;
  let screenHeight = window.innerHeight;
  let dragStartPoint = null;
  let currentRectangle = null; // { x, y, width, height } in CSS pixels
  let hasConfirmableSelection = false;

  function rectangleFromPoints(startPoint, endPoint) {
    const left = Math.max(0, Math.min(startPoint.x, endPoint.x));
    const top = Math.max(0, Math.min(startPoint.y, endPoint.y));
    const right = Math.min(screenWidth, Math.max(startPoint.x, endPoint.x));
    const bottom = Math.min(screenHeight, Math.max(startPoint.y, endPoint.y));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function drawSelection(rectangle) {
    selectionElement.classList.remove('hidden');
    selectionElement.style.left = `${rectangle.x}px`;
    selectionElement.style.top = `${rectangle.y}px`;
    selectionElement.style.width = `${rectangle.width}px`;
    selectionElement.style.height = `${rectangle.height}px`;
    selectionElement.classList.toggle('is-near-top', rectangle.y < 34);
    sizeLabelElement.textContent = `${Math.round(rectangle.width)} × ${Math.round(rectangle.height)}`;
    dimElement.classList.add('is-hidden'); // the selection's own shadow dims the rest
    hintElement.classList.add('hidden');
  }

  function placeToolbar(rectangle) {
    toolbarElement.classList.remove('hidden');
    const toolbarWidth = toolbarElement.offsetWidth;
    const toolbarHeight = toolbarElement.offsetHeight;

    // Below the area, right-aligned; above it if there is no room; inside it as a last resort.
    let toolbarTop = rectangle.y + rectangle.height + TOOLBAR_GAP;
    if (toolbarTop + toolbarHeight > screenHeight - 6) {
      toolbarTop = rectangle.y - toolbarHeight - TOOLBAR_GAP;
      if (toolbarTop < 6) toolbarTop = rectangle.y + rectangle.height - toolbarHeight - TOOLBAR_GAP;
    }
    let toolbarLeft = rectangle.x + rectangle.width - toolbarWidth;
    toolbarLeft = Math.max(6, Math.min(toolbarLeft, screenWidth - toolbarWidth - 6));
    toolbarElement.style.left = `${toolbarLeft}px`;
    toolbarElement.style.top = `${toolbarTop}px`;
  }

  function resetSelection() {
    dragStartPoint = null;
    currentRectangle = null;
    hasConfirmableSelection = false;
    selectionElement.classList.add('hidden');
    toolbarElement.classList.add('hidden');
    dimElement.classList.remove('is-hidden');
    hintElement.classList.remove('hidden');
  }

  function confirmSelection() {
    if (!hasConfirmableSelection || !currentRectangle) return;
    window.clickItRegion.confirm(currentRectangle);
  }

  document.addEventListener('mousedown', (mouseEvent) => {
    if (mouseEvent.button !== 0) return;
    if (toolbarElement.contains(mouseEvent.target)) return; // clicks on the buttons are handled below
    dragStartPoint = { x: mouseEvent.clientX, y: mouseEvent.clientY };
    hasConfirmableSelection = false;
    toolbarElement.classList.add('hidden');
    currentRectangle = { x: dragStartPoint.x, y: dragStartPoint.y, width: 0, height: 0 };
  });

  document.addEventListener('mousemove', (mouseEvent) => {
    if (!dragStartPoint) return;
    currentRectangle = rectangleFromPoints(dragStartPoint, { x: mouseEvent.clientX, y: mouseEvent.clientY });
    if (currentRectangle.width > 2 || currentRectangle.height > 2) drawSelection(currentRectangle);
  });

  document.addEventListener('mouseup', (mouseEvent) => {
    if (!dragStartPoint || mouseEvent.button !== 0) return;
    currentRectangle = rectangleFromPoints(dragStartPoint, { x: mouseEvent.clientX, y: mouseEvent.clientY });
    dragStartPoint = null;

    if (currentRectangle.width >= MINIMUM_SELECTION_SIZE && currentRectangle.height >= MINIMUM_SELECTION_SIZE) {
      drawSelection(currentRectangle);
      hasConfirmableSelection = true;
      placeToolbar(currentRectangle);
    } else {
      resetSelection(); // a click without a real drag
    }
  });

  element('snap-button').addEventListener('click', confirmSelection);
  element('cancel-button').addEventListener('click', () => window.clickItRegion.cancel());

  document.addEventListener('keydown', (keyboardEvent) => {
    if (keyboardEvent.key === 'Escape') {
      window.clickItRegion.cancel();
    } else if (keyboardEvent.key === 'Enter') {
      confirmSelection();
    } else {
      return;
    }
    keyboardEvent.preventDefault();
  });

  document.addEventListener('contextmenu', (contextEvent) => {
    contextEvent.preventDefault();
    window.clickItRegion.cancel(); // right-click cancels, like the Windows screenshot tool
  });

  window.clickItRegion.onInit((payload) => {
    screenWidth = payload.width;
    screenHeight = payload.height;
    frozenPictureElement.src = payload.pictureDataUrl;
  });
})();
