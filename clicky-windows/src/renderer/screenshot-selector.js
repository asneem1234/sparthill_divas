'use strict';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const dimensions = document.getElementById('dimensions');

let isSelecting = false;
let startX = 0;
let startY = 0;
let currentX = 0;
let currentY = 0;

// Resize canvas to window size
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// Mouse down - start selection
document.addEventListener('mousedown', (e) => {
  isSelecting = true;
  startX = e.clientX;
  startY = e.clientY;
  currentX = e.clientX;
  currentY = e.clientY;
  updateSelection();
});

// Mouse move - update selection
document.addEventListener('mousemove', (e) => {
  if (!isSelecting) return;
  
  currentX = e.clientX;
  currentY = e.clientY;
  updateSelection();
});

// Mouse up - complete selection
document.addEventListener('mouseup', (e) => {
  if (!isSelecting) return;
  
  isSelecting = false;
  
  const x = Math.min(startX, currentX);
  const y = Math.min(startY, currentY);
  const width = Math.abs(currentX - startX);
  const height = Math.abs(currentY - startY);
  
  if (width > 10 && height > 10) {
    // Valid selection
    window.clickitSelector.captureArea({ x, y, width, height });
  } else {
    // Too small, cancel
    window.clickitSelector.cancel();
  }
});

// ESC to cancel
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.clickitSelector.cancel();
  }
});

function updateSelection() {
  const x = Math.min(startX, currentX);
  const y = Math.min(startY, currentY);
  const width = Math.abs(currentX - startX);
  const height = Math.abs(currentY - startY);
  
  selectionBox.style.display = 'block';
  selectionBox.style.left = `${x}px`;
  selectionBox.style.top = `${y}px`;
  selectionBox.style.width = `${width}px`;
  selectionBox.style.height = `${height}px`;
  
  // Show dimensions
  dimensions.style.display = 'block';
  dimensions.style.left = `${currentX + 15}px`;
  dimensions.style.top = `${currentY + 15}px`;
  dimensions.textContent = `${width} × ${height}`;
}
