// Local text recognition. Talks to windows-ocr.ps1 (a long-running Windows PowerShell
// process) so the OCR engine is loaded once. Everything stays on this PC.

const path = require('path');
const { spawn } = require('child_process');

const OCR_SCRIPT_PATH = path.join(__dirname, 'windows-ocr.ps1');
const WINDOWS_POWERSHELL_PATH = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);
const STARTUP_TIMEOUT_MILLISECONDS = 20000;
const REQUEST_TIMEOUT_MILLISECONDS = 20000;

class OcrService {
  constructor() {
    this.helperProcess = null;
    this.helperReadyPromise = null;
    this.isOcrAvailable = false;
    this.unavailableReason = null;
    this.pendingResponseHandlers = [];
    this.requestQueue = Promise.resolve();
    this.partialOutputLine = '';
  }

  /** Starts the helper (once) and resolves when it says whether OCR works on this PC. */
  ensureStarted() {
    if (this.helperReadyPromise) return this.helperReadyPromise;

    this.helperReadyPromise = new Promise((resolve) => {
      const helperProcess = spawn(
        WINDOWS_POWERSHELL_PATH,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT_PATH],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      this.helperProcess = helperProcess;
      helperProcess.stdout.setEncoding('utf8');

      const startupTimeoutId = setTimeout(() => {
        this.markUnavailable('The local text check took too long to start.');
        resolve();
      }, STARTUP_TIMEOUT_MILLISECONDS);

      let hasReceivedReadyLine = false;
      helperProcess.stdout.on('data', (outputChunk) => {
        this.partialOutputLine += outputChunk;
        const completeLines = this.partialOutputLine.split('\n');
        this.partialOutputLine = completeLines.pop();

        for (const outputLine of completeLines) {
          const trimmedLine = outputLine.trim();
          if (trimmedLine === '') continue;

          let parsedMessage;
          try {
            parsedMessage = JSON.parse(trimmedLine);
          } catch (error) {
            continue;
          }

          if (!hasReceivedReadyLine && parsedMessage.ready) {
            hasReceivedReadyLine = true;
            clearTimeout(startupTimeoutId);
            this.isOcrAvailable = Boolean(parsedMessage.available);
            if (!this.isOcrAvailable) {
              this.unavailableReason = parsedMessage.error || 'Text recognition is not available in Windows.';
            }
            resolve();
          } else {
            const responseHandler = this.pendingResponseHandlers.shift();
            if (responseHandler) responseHandler(parsedMessage);
          }
        }
      });

      helperProcess.on('error', (error) => {
        clearTimeout(startupTimeoutId);
        this.markUnavailable(`Could not start the local text check: ${error.message}`);
        resolve();
      });
      helperProcess.on('exit', () => {
        clearTimeout(startupTimeoutId);
        // Fail anything still waiting, and let the next call start a fresh helper.
        while (this.pendingResponseHandlers.length > 0) {
          this.pendingResponseHandlers.shift()({ ok: false, error: 'The local text check stopped.' });
        }
        this.helperProcess = null;
        this.helperReadyPromise = null;
        this.partialOutputLine = '';
        resolve();
      });
    });

    return this.helperReadyPromise;
  }

  markUnavailable(reason) {
    this.isOcrAvailable = false;
    this.unavailableReason = reason;
  }

  /**
   * Reads the text in an image (JPEG or PNG bytes).
   * @returns {Promise<{isAvailable: boolean, text: string, error?: string}>}
   */
  recognizeText(imageBuffer) {
    // One request at a time: the helper answers in order.
    const resultPromise = this.requestQueue.then(() => this.recognizeTextNow(imageBuffer));
    this.requestQueue = resultPromise.catch(() => {});
    return resultPromise;
  }

  async recognizeTextNow(imageBuffer) {
    if (!imageBuffer || imageBuffer.length === 0) {
      return { isAvailable: false, text: '', error: 'There was no image to check.' };
    }
    await this.ensureStarted();
    if (!this.isOcrAvailable || !this.helperProcess) {
      return { isAvailable: false, text: '', error: this.unavailableReason || 'Text recognition is unavailable.' };
    }

    const response = await new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        const handlerIndex = this.pendingResponseHandlers.indexOf(handleResponse);
        if (handlerIndex >= 0) this.pendingResponseHandlers.splice(handlerIndex, 1);
        // A stuck helper is replaced on the next call.
        if (this.helperProcess) this.helperProcess.kill();
        resolve({ ok: false, error: 'The local text check timed out.' });
      }, REQUEST_TIMEOUT_MILLISECONDS);

      const handleResponse = (message) => {
        clearTimeout(timeoutId);
        resolve(message);
      };
      this.pendingResponseHandlers.push(handleResponse);
      this.helperProcess.stdin.write(`${imageBuffer.toString('base64')}\n`);
    });

    if (!response.ok) {
      return { isAvailable: false, text: '', error: response.error || 'The local text check failed.' };
    }
    return { isAvailable: true, text: response.text || '' };
  }

  destroy() {
    if (this.helperProcess) {
      this.helperProcess.removeAllListeners('exit');
      this.helperProcess.kill();
    }
    this.helperProcess = null;
    this.helperReadyPromise = null;
  }
}

module.exports = { OcrService };
