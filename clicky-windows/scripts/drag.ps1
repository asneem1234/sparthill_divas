# Real mouse drag in physical pixels (test helper).
# Usage: powershell -File scripts\drag.ps1 -X1 300 -Y1 300 -X2 900 -Y2 600
param([int]$X1, [int]$Y1, [int]$X2, [int]$Y2)

Add-Type @"
using System.Runtime.InteropServices;
public class Dr {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
}
"@
[Dr]::SetProcessDPIAware() | Out-Null
[Dr]::SetCursorPos($X1, $Y1) | Out-Null
Start-Sleep -Milliseconds 300
[Dr]::mouse_event(0x02, 0, 0, 0, 0)
$steps = 12
for ($i = 1; $i -le $steps; $i++) {
  [Dr]::SetCursorPos([int]($X1 + ($X2 - $X1) * $i / $steps), [int]($Y1 + ($Y2 - $Y1) * $i / $steps)) | Out-Null
  Start-Sleep -Milliseconds 40
}
Start-Sleep -Milliseconds 200
[Dr]::mouse_event(0x04, 0, 0, 0, 0)
"dragged"
