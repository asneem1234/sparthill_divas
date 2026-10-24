# Long-running helper that brings another program's window to the front and reports where it is.
# Windows doesn't let one app raise another's window directly, so this uses the Windows API
# (user32 / dwmapi) from PowerShell.
#
# Protocol (one request/response per line):
#   in : focus <windowHandle>      bring the window to the front (restoring it if minimized)
#   in : foreground                report which window is in front now
#   out: {"ok":true,"focused":true,"rect":{"left":..,"top":..,"right":..,"bottom":..}}
#        {"ok":false,"error":"..."}
# The first line printed is {"ready":true}. Rectangles are in physical pixels.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class ClickItWindowControl {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr windowHandle);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr windowHandle);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr windowHandle, int command);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr windowHandle);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr windowHandle);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr windowHandle, bool isAltTab);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint threadId, uint otherThreadId, bool attach);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr windowHandle, out Rect rect);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr windowHandle, int attribute, out Rect rect, int size);

  const int SW_RESTORE = 9;
  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

  /// The visible frame of the window, without the invisible resize borders Windows adds.
  public static bool TryGetVisibleBounds(IntPtr windowHandle, out Rect rect) {
    if (DwmGetWindowAttribute(windowHandle, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(Rect))) == 0) return true;
    return GetWindowRect(windowHandle, out rect);
  }

  public static bool Focus(IntPtr windowHandle) {
    if (!IsWindow(windowHandle)) return false;
    if (IsIconic(windowHandle)) ShowWindow(windowHandle, SW_RESTORE);

    // Borrow the input state of whatever is in front now, so Windows allows the switch.
    IntPtr currentForeground = GetForegroundWindow();
    uint ignoredProcessId;
    uint foregroundThread = GetWindowThreadProcessId(currentForeground, out ignoredProcessId);
    uint ownThread = GetCurrentThreadId();
    bool isAttached = foregroundThread != 0 && foregroundThread != ownThread && AttachThreadInput(ownThread, foregroundThread, true);

    BringWindowToTop(windowHandle);
    SetForegroundWindow(windowHandle);
    if (isAttached) AttachThreadInput(ownThread, foregroundThread, false);

    if (GetForegroundWindow() != windowHandle) SwitchToThisWindow(windowHandle, true);
    return GetForegroundWindow() == windowHandle;
  }
}
"@

function Write-JsonLine($object) {
  [Console]::Out.WriteLine(($object | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

function Get-RectObject([IntPtr]$handle) {
  $rect = New-Object ClickItWindowControl+Rect
  if ([ClickItWindowControl]::TryGetVisibleBounds($handle, [ref]$rect)) {
    return @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
  }
  return $null
}

Write-JsonLine @{ ready = $true }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim().Split(' ')
  try {
    switch ($parts[0]) {
      'focus' {
        $handle = [IntPtr]([int64]$parts[1])
        $wasFocused = [ClickItWindowControl]::Focus($handle)
        Start-Sleep -Milliseconds 60
        Write-JsonLine @{ ok = $true; focused = $wasFocused; rect = (Get-RectObject $handle) }
      }
      'foreground' {
        $handle = [ClickItWindowControl]::GetForegroundWindow()
        Write-JsonLine @{ ok = $true; handle = $handle.ToInt64() }
      }
      default { Write-JsonLine @{ ok = $false; error = "Unknown command: $($parts[0])" } }
    }
  } catch {
    Write-JsonLine @{ ok = $false; error = $_.Exception.Message }
  }
}
