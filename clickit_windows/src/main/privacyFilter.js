// Keeps sensitive screens away from the AI in the voice flow. Each captured screen is
// read on this PC and checked; screens that look sensitive are withheld, and the AI
// is only given the rest.
//
// The voice flow has no place to ask "send anyway?", so this is stricter than the
// Click It window check: a soft warning (such as a sign-in form) also withholds the
// screen, and so does an unavailable text check.

const { scanText } = require('./sensitiveContent');

/**
 * @param {object} options
 * @param {import('./ocr/ocrService').OcrService} options.ocrService
 * @param {object[]} options.screenCaptures captures with imageBuffer and scanImageBuffer
 * @returns {Promise<{sendableCaptures: object[], withheldCaptures: {capture: object, reasons: string[]}[]}>}
 */
async function filterScreenCapturesForPrivacy({ ocrService, screenCaptures }) {
  const sendableCaptures = [];
  const withheldCaptures = [];

  for (const screenCapture of screenCaptures) {
    const ocrResult = await ocrService.recognizeText(screenCapture.scanImageBuffer || screenCapture.imageBuffer);

    if (!ocrResult.isAvailable) {
      console.warn('[ClickIt] Local privacy check unavailable, withholding the screen:', ocrResult.error);
      withheldCaptures.push({ capture: screenCapture, reasons: ["the on-device privacy check couldn't run"] });
      continue;
    }

    const { verdict, findings } = scanText(ocrResult.text);
    if (verdict === 'ok') {
      sendableCaptures.push(screenCapture);
    } else {
      withheldCaptures.push({ capture: screenCapture, reasons: findings.map((finding) => finding.label) });
    }
  }

  return { sendableCaptures, withheldCaptures };
}

module.exports = { filterScreenCapturesForPrivacy };
