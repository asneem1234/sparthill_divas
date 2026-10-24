// Brings a window the user picked to the front, and reports where it is on screen.
// Talks to window-control.ps1 (a long-running Windows PowerShell process) so each switch
// is fast. Windows only lets a program raise another program's window under certain
// conditions; the helper is started by ClickIt, which is in front when the user picks
// a window, so the switch is allowed.

const path = require('path');
const { spawn } = require('child_process');
const { screen } = require('electron');

const CONTROL_SCRIPT_PATH = path.join(__dirname, 'window-control.ps1');
const WINDOWS_POWERSHELL_PATH = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);
const STARTUP_TIMEOUT_MILLISECONDS = 15000;
const REQUEST_TIMEOUT_MILLISECONDS = 8000;

class WindowControlService {
  constructor() {
    this.helperProcess = null;
    this.helperReadyPromise = null;
    this.pendingResponseHandlers = [];
    this.requestQueue = Promise.resolve();
    this.partialOutputLine = '';
  }

  ensureStarted() {
    if (this.helperReadyPromise) return this.helperReadyPromise;

    this.helperReadyPromise = new Promise((resolve) => {
      const helperProcess = spawn(
        WINDOWS_POWERSHELL_PATH,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CONTROL_SCRIPT_PATH],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      this.helperProcess = helperProcess;
      helperProcess.stdout.setEncoding('utf8');

      const startupTimeoutId = setTimeout(resolve, STARTUP_TIMEOUT_MILLISECONDS);
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
            resolve();
          } else {
            const responseHandler = this.pendingResponseHandlers.shift();
            if (responseHandler) responseHandler(parsedMessage);
          }
        }
      });
      helperProcess.on('error', () => {
        clearTimeout(startupTimeoutId);
        resolve();
      });
      helperProcess.on('exit', () => {
        clearTimeout(startupTimeoutId);
        while (this.pendingResponseHandlers.length > 0) {
          this.pendingResponseHandlers.shift()({ ok: false, error: 'The window helper stopped.' });
        }
        this.helperProcess = null;
        this.helperReadyPromise = null;
        this.partialOutputLine = '';
        resolve();
      });
    });
    return this.helperReadyPromise;
  }

  sendCommand(commandLine) {
    const resultPromise = this.requestQueue.then(() => this.sendCommandNow(commandLine));
    this.requestQueue = resultPromise.catch(() => {});
    return resultPromise;
  }

  async sendCommandNow(commandLine) {
    await this.ensureStarted();
    if (!this.helperProcess) return { ok: false, error: 'The window helper is not running.' };

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        const handlerIndex = this.pendingResponseHandlers.indexOf(handleResponse);
        if (handlerIndex >= 0) this.pendingResponseHandlers.splice(handlerIndex, 1);
        if (this.helperProcess) this.helperProcess.kill(); // replaced on the next call
        resolve({ ok: false, error: 'The window helper timed out.' });
      }, REQUEST_TIMEOUT_MILLISECONDS);

      const handleResponse = (message) => {
        clearTimeout(timeoutId);
        resolve(message);
      };
      this.pendingResponseHandlers.push(handleResponse);
      this.helperProcess.stdin.write(`${commandLine}\n`);
    });
  }

  /**
   * Brings the window with this capture-source id (like "window:1182450:0") to the front.
   * @returns {Promise<{ok: boolean, isInFront: boolean, boundsInDips: ({x:number,y:number,width:number,height:number}|null), error?: string}>}
   */
  async bringWindowToFront(sourceId) {
    const idParts = String(sourceId).split(':');
    const windowHandle = idParts[0] === 'window' ? Number(idParts[1]) : NaN;
    if (!Number.isFinite(windowHandle)) {
      return { ok: false, isInFront: false, boundsInDips: null, error: 'That is not a window.' };
    }

    const response = await this.sendCommand(`focus ${windowHandle}`);
    if (!response.ok) return { ok: false, isInFront: false, boundsInDips: null, error: response.error };

    let boundsInDips = null;
    if (response.rect) {
      // The helper reports physical pixels; Electron places windows in DIPs.
      boundsInDips = screen.screenToDipRect(null, {
        x: response.rect.left,
        y: response.rect.top,
        width: response.rect.right - response.rect.left,
        height: response.rect.bottom - response.rect.top,
      });
    }
    return { ok: true, isInFront: Boolean(response.focused), boundsInDips };
  }

  /**
   * Makes one of ClickIt's own windows the active one. Windows often refuses plain focus()
   * calls from a program the user isn't currently using, which would leave the picker or
   * the gem menu visible but deaf to the keyboard. The helper gets around that.
   */
  async focusOwnWindow(browserWindow) {
    if (!browserWindow || browserWindow.isDestroyed()) return false;
    const nativeHandleBytes = browserWindow.getNativeWindowHandle();
    const windowHandle = Number(nativeHandleBytes.length >= 8 ? nativeHandleBytes.readBigUInt64LE(0) : nativeHandleBytes.readUInt32LE(0));
    const response = await this.sendCommand(`focus ${windowHandle}`);
    return Boolean(response.ok && response.focused);
  }

  /** Window handle currently in front (used by tests). */
  async getForegroundWindowHandle() {
    const response = await this.sendCommand('foreground');
    return response.ok ? response.handle : null;
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

module.exports = { WindowControlService };
