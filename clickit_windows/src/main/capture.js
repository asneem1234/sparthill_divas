// Multi-monitor screenshot capture. Port of CompanionScreenCaptureUtility.
// Each display is captured as a JPEG with its longest side at 1280px, labeled so
// the model knows which screen the cursor is on.

const path = require('path');
const { desktopCapturer, screen } = require('electron');

const MAX_SCREENSHOT_DIMENSION = 1280;
const SCAN_THUMBNAIL_DIMENSION = 1920;
const JPEG_QUALITY_PERCENT = 80;

/**
 * @typedef {object} CompanionScreenCapture
 * @property {Buffer} imageBuffer
 * @property {string} label
 * @property {boolean} isCursorScreen
 * @property {number} displayWidthInPoints
 * @property {number} displayHeightInPoints
 * @property {{x:number,y:number,width:number,height:number}} displayFrame
 * @property {number} screenshotWidthInPixels
 * @property {number} screenshotHeightInPixels
 */

/**
 * Captures all connected displays as JPEG data, cursor screen first.
 * The app's own overlay windows are excluded by window content protection
 * (see OverlayManager), so the model only sees the user's content.
 * @returns {Promise<CompanionScreenCapture[]>}
 */
async function captureAllScreensAsJpeg() {
  const allDisplays = screen.getAllDisplays();
  if (allDisplays.length === 0) {
    throw new Error('No display available for capture');
  }

  const mouseLocation = screen.getCursorScreenPoint();

  // Captured larger than what the AI gets, so the on-device text check can read small text.
  const captureSources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: SCAN_THUMBNAIL_DIMENSION, height: SCAN_THUMBNAIL_DIMENSION },
  });

  // Match each capture source to its display. display_id can be empty on some
  // driver setups, in which case the source order follows the display order.
  function findCaptureSourceForDisplay(display, displayIndex) {
    const sourceMatchingDisplayId = captureSources.find(
      (captureSource) => captureSource.display_id && captureSource.display_id === String(display.id)
    );
    return sourceMatchingDisplayId || captureSources[displayIndex];
  }

  function frameContainsPoint(frame, point) {
    return point.x >= frame.x && point.x < frame.x + frame.width && point.y >= frame.y && point.y < frame.y + frame.height;
  }

  const displaysWithSources = allDisplays
    .map((display, displayIndex) => ({
      display,
      captureSource: findCaptureSourceForDisplay(display, displayIndex),
      isCursorScreen: frameContainsPoint(display.bounds, mouseLocation),
    }))
    .filter((entry) => entry.captureSource && !entry.captureSource.thumbnail.isEmpty());

  // Sort so the cursor screen is always first.
  displaysWithSources.sort((entryA, entryB) => {
    if (entryA.isCursorScreen !== entryB.isCursorScreen) return entryA.isCursorScreen ? -1 : 1;
    return 0;
  });

  const capturedScreens = displaysWithSources.map((entry, displayIndex) => {
    const fullThumbnail = entry.captureSource.thumbnail;
    const { width: fullWidth, height: fullHeight } = fullThumbnail.getSize();

    // Image for the AI: longest side at most 1280. Its size is what the model's coordinates refer to.
    const longestSide = Math.max(fullWidth, fullHeight);
    const aiScale = longestSide > MAX_SCREENSHOT_DIMENSION ? MAX_SCREENSHOT_DIMENSION / longestSide : 1;
    const aiImage = aiScale < 1
      ? fullThumbnail.resize({ width: Math.round(fullWidth * aiScale), height: Math.round(fullHeight * aiScale), quality: 'good' })
      : fullThumbnail;
    const thumbnailSize = aiImage.getSize();

    let screenLabel;
    if (displaysWithSources.length === 1) {
      screenLabel = "user's screen (cursor is here)";
    } else if (entry.isCursorScreen) {
      screenLabel = `screen ${displayIndex + 1} of ${displaysWithSources.length} — cursor is on this screen (primary focus)`;
    } else {
      screenLabel = `screen ${displayIndex + 1} of ${displaysWithSources.length} — secondary screen`;
    }

    return {
      imageBuffer: aiImage.toJPEG(JPEG_QUALITY_PERCENT),
      // Only ever used by the on-device privacy check, never sent anywhere.
      scanImageBuffer: fullThumbnail.toJPEG(90),
      label: screenLabel,
      isCursorScreen: entry.isCursorScreen,
      displayWidthInPoints: entry.display.bounds.width,
      displayHeightInPoints: entry.display.bounds.height,
      displayFrame: { ...entry.display.bounds },
      screenshotWidthInPixels: thumbnailSize.width,
      screenshotHeightInPixels: thumbnailSize.height,
    };
  });

  if (capturedScreens.length === 0) {
    throw new Error('Failed to capture any screen');
  }

  return capturedScreens;
}

// ---------------------------------------------------------------------------
// Choosing and capturing ONE window (used by the Click It window picker)
// ---------------------------------------------------------------------------

const { execFile } = require('child_process');
const { BrowserWindow } = require('electron');
const { assessWindowIdentity } = require('./sensitiveContent');

const WINDOWS_POWERSHELL_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const MAXIMUM_LISTED_WINDOWS = 18;
const PICKER_THUMBNAIL_SIZE = { width: 480, height: 300 };
// Windows with these titles are shell plumbing, not something a person would pick.
const IGNORED_WINDOW_TITLES = new Set(['Program Manager', 'Windows Input Experience', 'Microsoft Text Input Application', 'Settings']);
// Text recognition needs reasonably large text. Smaller captures are enlarged before scanning.
const MINIMUM_SCAN_IMAGE_WIDTH = 1400;

/**
 * Maps window handles to the app that owns them, so a password manager can be recognised
 * by its app name and not only by its title. Resolves to an empty map if this fails.
 * @returns {Promise<Map<number, {processName: string}>>}
 */
function getProcessNamesByWindowHandle() {
  // Asks Windows which program owns each visible window. (Get-Process only knows a program's
  // MAIN window, so a browser's other windows would be missed and could dodge the
  // password-manager check.) The script is passed encoded to avoid any quoting problems.
  const enumerateWindowsScript = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ClickItWindowEnumerator {
  public delegate bool EnumWindowsCallback(IntPtr windowHandle, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr windowHandle);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);
  public static List<string> ListVisibleWindows() {
    var visibleWindows = new List<string>();
    EnumWindows((windowHandle, parameter) => {
      if (IsWindowVisible(windowHandle)) {
        uint processId;
        GetWindowThreadProcessId(windowHandle, out processId);
        visibleWindows.Add(windowHandle.ToInt64() + "," + processId);
      }
      return true;
    }, IntPtr.Zero);
    return visibleWindows;
  }
}
"@
$processNamesById = @{}
Get-Process | ForEach-Object { $processNamesById[[uint32]$_.Id] = $_.ProcessName }
[ClickItWindowEnumerator]::ListVisibleWindows() | ForEach-Object {
  $parts = $_.Split(',')
  [pscustomobject]@{ Hwnd = [int64]$parts[0]; ProcessName = [string]$processNamesById[[uint32]$parts[1]] }
} | ConvertTo-Json -Compress
`;
  const encodedScript = Buffer.from(enumerateWindowsScript, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    execFile(
      WINDOWS_POWERSHELL_PATH,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
      { windowsHide: true, timeout: 12000, maxBuffer: 4 * 1024 * 1024 },
      (error, standardOutput) => {
        const processNamesByHandle = new Map();
        if (error || !standardOutput) return resolve(processNamesByHandle);
        try {
          const parsedOutput = JSON.parse(standardOutput);
          const processEntries = Array.isArray(parsedOutput) ? parsedOutput : [parsedOutput];
          for (const processEntry of processEntries) {
            processNamesByHandle.set(Number(processEntry.Hwnd), { processName: String(processEntry.ProcessName || '') });
          }
        } catch (parseError) {
          // Fall back to titles only.
        }
        resolve(processNamesByHandle);
      }
    );
  });
}

/** Window handle from a capture source id such as "window:1182450:0". */
function windowHandleFromSourceId(sourceId) {
  const idParts = String(sourceId).split(':');
  return idParts[0] === 'window' ? Number(idParts[1]) : NaN;
}

function toJpegDataUrl(image, quality) {
  return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`;
}

/**
 * Lists the screens and open windows the user can choose from, with small previews.
 * ClickIt's own windows are left out. Windows whose title or app looks like a password
 * manager are marked as blocked so they can't be picked.
 * @returns {Promise<{sourceId: string, kind: 'screen'|'window', name: string, processName: string,
 *   thumbnailDataUrl: string, iconDataUrl: string|null, isBlocked: boolean, blockedReason: string|null}[]>}
 */
async function listCaptureTargets() {
  const ownWindowSourceIds = new Set(
    BrowserWindow.getAllWindows()
      .filter((browserWindow) => !browserWindow.isDestroyed())
      .map((browserWindow) => browserWindow.getMediaSourceId())
  );

  const [captureSources, processNamesByHandle] = await Promise.all([
    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: PICKER_THUMBNAIL_SIZE,
      fetchWindowIcons: true,
    }),
    getProcessNamesByWindowHandle(),
  ]);

  const screenTargets = [];
  const windowTargets = [];
  // Stand-in preview for blocked windows: their contents are never even sent to the picker.
  const blockedPreviewDataUrl =
    'data:image/svg+xml;base64,' +
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="10"><rect width="16" height="10" fill="#1a1c1b"/></svg>').toString('base64');

  captureSources.forEach((captureSource) => {
    if (ownWindowSourceIds.has(captureSource.id)) return;
    if (captureSource.thumbnail.isEmpty()) return; // minimized or not drawable

    if (captureSource.id.startsWith('screen:')) {
      screenTargets.push({
        sourceId: captureSource.id,
        kind: 'screen',
        name: 'Entire screen',
        processName: '',
        thumbnailDataUrl: toJpegDataUrl(captureSource.thumbnail, 70),
        iconDataUrl: null,
        isBlocked: false,
        blockedReason: null,
      });
      return;
    }

    const windowTitle = String(captureSource.name || '').trim();
    if (windowTitle === '' || IGNORED_WINDOW_TITLES.has(windowTitle)) return;

    const processName = (processNamesByHandle.get(windowHandleFromSourceId(captureSource.id)) || {}).processName || '';
    const identityAssessment = assessWindowIdentity({ title: windowTitle, processName });
    windowTargets.push({
      sourceId: captureSource.id,
      kind: 'window',
      name: windowTitle,
      processName,
      thumbnailDataUrl: identityAssessment.isBlocked ? blockedPreviewDataUrl : toJpegDataUrl(captureSource.thumbnail, 70),
      iconDataUrl: captureSource.appIcon && !captureSource.appIcon.isEmpty()
        ? captureSource.appIcon.resize({ width: 24, height: 24 }).toDataURL()
        : null,
      isBlocked: identityAssessment.isBlocked,
      blockedReason: identityAssessment.reason,
    });
  });

  // With several monitors, number the screens so they can be told apart.
  if (screenTargets.length > 1) {
    screenTargets.forEach((screenTarget, screenIndex) => {
      screenTarget.name = `Screen ${screenIndex + 1}`;
    });
  }
  return [...screenTargets, ...windowTargets.slice(0, MAXIMUM_LISTED_WINDOWS)];
}

/**
 * Captures exactly the chosen window or screen, freshly, at the moment it's needed.
 * Returns the image to send to the AI (at most 1280 px) and a separate larger image that
 * is only ever used for the on-device sensitive-content scan.
 */
async function captureTarget(target) {
  const captureSources = await desktopCapturer.getSources({
    types: [target.kind === 'screen' ? 'screen' : 'window'],
    thumbnailSize: { width: 1920, height: 1920 },
  });
  const chosenSource = captureSources.find((captureSource) => captureSource.id === target.sourceId);
  if (!chosenSource || chosenSource.thumbnail.isEmpty()) {
    throw new Error('That window is no longer available. It may have been closed or minimized.');
  }

  const label = target.kind === 'screen'
    ? "user's screen"
    : `the window "${target.name}"${target.processName ? ` (${target.processName})` : ''}`;
  return buildCaptureFromImage(chosenSource.thumbnail, label);
}

/**
 * Turns a captured image into what the rest of the app works with: a JPEG for the AI
 * (longest side at most 1280) and a separate, larger JPEG used only by the on-device
 * sensitive-content scan.
 * @param {Electron.NativeImage} fullImage
 * @param {string} label how the image is described to the AI
 */
function buildCaptureFromImage(fullImage, label) {
  const { width: fullWidth, height: fullHeight } = fullImage.getSize();

  // Image for the AI: longest side at most 1280, like the voice screenshots.
  const longestSide = Math.max(fullWidth, fullHeight);
  const aiScale = longestSide > MAX_SCREENSHOT_DIMENSION ? MAX_SCREENSHOT_DIMENSION / longestSide : 1;
  const aiImage = aiScale < 1
    ? fullImage.resize({ width: Math.round(fullWidth * aiScale), height: Math.round(fullHeight * aiScale), quality: 'good' })
    : fullImage;
  const aiImageSize = aiImage.getSize();

  // Image for the local scan: enlarge small captures so small text stays readable.
  const scanImage = fullWidth < MINIMUM_SCAN_IMAGE_WIDTH
    ? fullImage.resize({ width: fullWidth * 2, height: fullHeight * 2, quality: 'best' })
    : fullImage;

  return {
    imageBuffer: aiImage.toJPEG(JPEG_QUALITY_PERCENT),
    scanImageBuffer: scanImage.toJPEG(90),
    label,
    isCursorScreen: true,
    screenshotWidthInPixels: aiImageSize.width,
    screenshotHeightInPixels: aiImageSize.height,
  };
}

/**
 * One display at its full native resolution, as it looks right now. Used to "freeze" the
 * screen while the user drags out an area to snap.
 * @param {Electron.Display} display
 * @returns {Promise<Electron.NativeImage>}
 */
async function captureDisplayImage(display) {
  const nativeWidth = Math.round(display.bounds.width * display.scaleFactor);
  const nativeHeight = Math.round(display.bounds.height * display.scaleFactor);
  const captureSources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: nativeWidth, height: nativeHeight },
  });

  const allDisplays = screen.getAllDisplays();
  const displayIndex = allDisplays.findIndex((candidate) => candidate.id === display.id);
  const matchingSource =
    captureSources.find((captureSource) => captureSource.display_id && captureSource.display_id === String(display.id)) ||
    captureSources[displayIndex];
  if (!matchingSource || matchingSource.thumbnail.isEmpty()) {
    throw new Error("Couldn't capture that screen.");
  }
  return matchingSource.thumbnail;
}

module.exports = { captureAllScreensAsJpeg, listCaptureTargets, captureTarget, captureDisplayImage, buildCaptureFromImage };
