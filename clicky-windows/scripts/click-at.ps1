# Moves the real mouse to a pixel position and left-clicks (test helper).
# Usage: powershell -File scripts\click-at.ps1 -X 960 -Y 393
param([int]$X, [int]$Y)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
}
"@
[M]::SetProcessDPIAware() | Out-Null
[M]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 300
[M]::mouse_event(0x02, 0, 0, 0, 0)
Start-Sleep -Milliseconds 80
[M]::mouse_event(0x04, 0, 0, 0, 0)
"clicked $X,$Y"
