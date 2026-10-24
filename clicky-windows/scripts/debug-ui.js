'use strict';

// Opens the radial menu and the area selector, saves a screenshot of each,
// and reports whether the global keyboard hook loads.
// Run with: npx electron scripts/debug-ui.js   (results in %USERPROFILE%\clickit-debug)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const outDir = path.join(os.homedir(), 'clickit-debug');
const log = [];
const say = (message) => {
  log.push(message);
  console.log(message);
};

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    require('uiohook-napi');
    say('uiohook-napi: loads OK');
  } catch (error) {
    say(`uiohook-napi: FAILED to load -> ${error.message}`);
  }

  const { RadialMenu } = require('../src/main/radialMenu');
  const { ScreenshotSelector } = require('../src/main/screenshotSelector');

  const radial = new RadialMenu();
  let picked = null;
  radial.show((action) => {
    picked = action;
  });
  await wait(2500);
  say(`radial window exists: ${Boolean(radial.window)}, visible: ${radial.isVisible()}`);
  if (radial.window) {
    const image = await radial.window.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'radial.png'), image.toPNG());
    say(`radial screenshot size: ${JSON.stringify(image.getSize())}`);
    const gems = await radial.window.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll(".gem")).map(g => { const r = g.getBoundingClientRect(); return [g.dataset.action, Math.round(r.x), Math.round(r.y), Math.round(r.width), getComputedStyle(g).opacity]; })'
    );
    say(`gems (action,x,y,w,opacity): ${JSON.stringify(gems)}`);
    // Click the first gem like a user would.
    const first = gems[0];
    radial.window.webContents.sendInputEvent({ type: 'mouseDown', x: first[1] + 30, y: first[2] + 30, button: 'left', clickCount: 1 });
    radial.window.webContents.sendInputEvent({ type: 'mouseUp', x: first[1] + 30, y: first[2] + 30, button: 'left', clickCount: 1 });
    await wait(500);
    say(`gem click selected action: ${picked}`);
  }
  radial.close();

  const selector = new ScreenshotSelector();
  let region = null;
  selector.show((display, rect) => {
    region = rect;
  });
  await wait(2000);
  say(`selector window exists: ${Boolean(selector.window)}`);
  if (selector.window) {
    const wc = selector.window.webContents;
    wc.sendInputEvent({ type: 'mouseDown', x: 200, y: 200, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseMove', x: 500, y: 400 });
    await wait(300);
    const image = await wc.capturePage();
    fs.writeFileSync(path.join(outDir, 'selector.png'), image.toPNG());
    wc.sendInputEvent({ type: 'mouseUp', x: 500, y: 400, button: 'left', clickCount: 1 });
    await wait(800);
    say(`selector reported region: ${JSON.stringify(region)}`);
  }

  fs.writeFileSync(path.join(outDir, 'result.txt'), log.join('\n'));
  app.quit();
});
