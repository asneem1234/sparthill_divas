'use strict';

// Click a gem to run its action. Click the center orb, click outside the
// menu, or press Escape to close.
document.querySelectorAll('.gem').forEach((gem) => {
  gem.addEventListener('click', () => {
    window.clickitRadial.selectAction(gem.getAttribute('data-action'));
  });
});

document.addEventListener('mousemove', (event) => {
  document.body.style.setProperty('--mouse-x', `${(event.clientX / window.innerWidth) * 100}%`);
  document.body.style.setProperty('--mouse-y', `${(event.clientY / window.innerHeight) * 100}%`);
});

document.addEventListener('click', (event) => {
  const onGem = Boolean(event.target.closest('.gem'));
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  console.log(
    `click at ${event.clientX},${event.clientY} target=${event.target.tagName}#${event.target.id}.${event.target.className} ` +
      `onGem=${onGem} elementFromPoint=${hit ? hit.tagName + '.' + hit.className : 'none'} viewport=${window.innerWidth}x${window.innerHeight}`
  );
  if (!onGem) window.clickitRadial.close();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.clickitRadial.close();
});
