'use strict';

const buddy = document.getElementById('buddy');
const triangle = document.getElementById('triangle');
const spinner = document.getElementById('spinner');
const wave = document.getElementById('wave');
const label = document.getElementById('label');
const bars = Array.from(wave.querySelectorAll('span'));

// Per-bar multipliers so the waveform looks organic rather than uniform.
const BAR_SHAPE = [0.55, 0.85, 1, 0.8, 0.5];
let smoothedLevel = 0;
let sizeScale = 1;

window.clickyOverlay.onFrame((frame) => {
  if (!frame.visible) {
    buddy.style.display = 'none';
    return;
  }

  buddy.style.display = 'block';
  buddy.style.transform = `translate(${frame.x.toFixed(1)}px, ${frame.y.toFixed(1)}px)`;

  // While pointing, always show the triangle so the flight is visible.
  const showWave = !frame.pointing && frame.mode === 'listening';
  const showSpinner = !frame.pointing && frame.mode === 'processing';
  const showTriangle = !showWave && !showSpinner;

  triangle.style.display = showTriangle ? 'block' : 'none';
  spinner.style.display = showSpinner ? 'block' : 'none';
  wave.style.display = showWave ? 'flex' : 'none';

  if (showTriangle) {
    triangle.style.transform = `rotate(${frame.angle.toFixed(1)}deg) scale(${(frame.scale * sizeScale).toFixed(3)})`;
  }

  if (showWave) {
    smoothedLevel += (frame.level - smoothedLevel) * 0.4;
    bars.forEach((bar, index) => {
      const height = 4 + smoothedLevel * 16 * BAR_SHAPE[index];
      bar.style.height = `${height.toFixed(1)}px`;
    });
  }

  if (frame.label) {
    label.textContent = frame.label;
    label.style.display = 'block';
  } else {
    label.style.display = 'none';
  }
});

// Handle cursor customization settings
window.clickyOverlay.onCursorSettings((settings) => {
  // Apply color
  if (settings.color) {
    triangle.querySelector('polygon').style.fill = settings.color;
    spinner.style.borderTopColor = settings.color;
    bars.forEach(bar => {
      bar.style.background = settings.color;
      bar.style.boxShadow = `0 0 5px ${settings.color}`;
    });
    triangle.querySelector('polygon').style.stroke = settings.color;
    label.style.background = settings.color;
    label.style.color = '#0b0b0b';
    wave.style.color = settings.color;
  }

  if (typeof settings.glow === 'number') {
    const glowAmount = settings.glow / 100;
    const glowColor = settings.color || '#3b82f6';
    triangle.style.filter = `drop-shadow(0 0 ${(2 + glowAmount * 12).toFixed(1)}px ${glowColor})`;
    spinner.style.filter = `drop-shadow(0 0 ${(2 + glowAmount * 10).toFixed(1)}px ${glowColor})`;
  }

  if (typeof settings.size === 'number') {
    sizeScale = settings.size / 24; // 24 is the base size
  }
});
