# Lists top-level windows whose title matches a pattern (test helper).
# Usage: powershell -File scripts\list-windows.ps1 -Pattern ClickIt
param([string]$Pattern = 'ClickIt')

Add-Type @"
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class WinList {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  public static List<string> Find(string pattern) {
    var results = new List<string>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      string t = sb.ToString();
      if (t.Length > 0 && t.IndexOf(pattern, StringComparison.OrdinalIgnoreCase) >= 0) {
        RECT r; GetWindowRect(h, out r);
        bool topmost = (GetWindowLong(h, -20) & 0x8) != 0;
        results.Add(t + " | visible=" + IsWindowVisible(h) + " minimized=" + IsIconic(h) + " topmost=" + topmost + " rect=" + r.L + "," + r.T + "," + r.R + "," + r.B);
      }
      return true;
    }, IntPtr.Zero);
    return results;
  }
}
"@
$found = [WinList]::Find($Pattern)
if ($found.Count -eq 0) { "no windows match '$Pattern'" } else { $found }
