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
    triangle.style.transform = `rotate(${frame.angle.toFixed(1)}deg) scale(${frame.scale.toFixed(3)})`;
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
