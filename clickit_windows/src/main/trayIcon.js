// Draws the Clicky triangle as the tray icon, using the same shape and -35
// degree tilt as the in-app cursor (see makeClickyMenuBarIcon in the macOS
// MenuBarPanelManager). Rendered in code so no image asset is needed.

const { nativeImage } = require('electron');

const CURSOR_PINK = { red: 0xff, green: 0x4f, blue: 0xa3 };

function buildTrayIcon() {
  const iconPixelSize = 32; // drawn at 2x, displayed as 16 DIP
  const supersampleGridSize = 4;
  const triangleSideLength = iconPixelSize * 0.78;
  const triangleHeight = (triangleSideLength * Math.sqrt(3)) / 2;
  const tiltRadians = (-35 * Math.PI) / 180;
  const centerX = iconPixelSize / 2;
  const centerY = iconPixelSize / 2;

  function rotateAroundCenter(pointRelativeToCenter) {
    const rotatedX = Math.cos(tiltRadians) * pointRelativeToCenter.x - Math.sin(tiltRadians) * pointRelativeToCenter.y;
    const rotatedY = Math.sin(tiltRadians) * pointRelativeToCenter.x + Math.cos(tiltRadians) * pointRelativeToCenter.y;
    return { x: centerX + rotatedX, y: centerY + rotatedY };
  }

  const topVertex = rotateAroundCenter({ x: 0, y: -triangleHeight / 1.5 });
  const bottomLeftVertex = rotateAroundCenter({ x: -triangleSideLength / 2, y: triangleHeight / 3 });
  const bottomRightVertex = rotateAroundCenter({ x: triangleSideLength / 2, y: triangleHeight / 3 });

  function edgeSign(pointA, pointB, testPoint) {
    return (testPoint.x - pointB.x) * (pointA.y - pointB.y) - (pointA.x - pointB.x) * (testPoint.y - pointB.y);
  }

  function isInsideTriangle(testPoint) {
    const signOne = edgeSign(testPoint, topVertex, bottomLeftVertex);
    const signTwo = edgeSign(testPoint, bottomLeftVertex, bottomRightVertex);
    const signThree = edgeSign(testPoint, bottomRightVertex, topVertex);
    const hasNegative = signOne < 0 || signTwo < 0 || signThree < 0;
    const hasPositive = signOne > 0 || signTwo > 0 || signThree > 0;
    return !(hasNegative && hasPositive);
  }

  // Electron expects BGRA on Windows for createFromBitmap.
  const bitmapBuffer = Buffer.alloc(iconPixelSize * iconPixelSize * 4);
  for (let pixelY = 0; pixelY < iconPixelSize; pixelY += 1) {
    for (let pixelX = 0; pixelX < iconPixelSize; pixelX += 1) {
      let coveredSampleCount = 0;
      for (let sampleY = 0; sampleY < supersampleGridSize; sampleY += 1) {
        for (let sampleX = 0; sampleX < supersampleGridSize; sampleX += 1) {
          const samplePoint = {
            x: pixelX + (sampleX + 0.5) / supersampleGridSize,
            y: pixelY + (sampleY + 0.5) / supersampleGridSize,
          };
          if (isInsideTriangle(samplePoint)) coveredSampleCount += 1;
        }
      }
      const coverage = coveredSampleCount / (supersampleGridSize * supersampleGridSize);
      const byteOffset = (pixelY * iconPixelSize + pixelX) * 4;
      bitmapBuffer[byteOffset] = CURSOR_PINK.blue;
      bitmapBuffer[byteOffset + 1] = CURSOR_PINK.green;
      bitmapBuffer[byteOffset + 2] = CURSOR_PINK.red;
      bitmapBuffer[byteOffset + 3] = Math.round(coverage * 255);
    }
  }

  return nativeImage.createFromBitmap(bitmapBuffer, {
    width: iconPixelSize,
    height: iconPixelSize,
    scaleFactor: 2,
  });
}

module.exports = { buildTrayIcon };
