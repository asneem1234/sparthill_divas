# Sends real key presses to Windows to test the global hotkeys.
# Usage: powershell -File scripts\send-keys.ps1 -Mode tap|menu
param([ValidateSet('tap', 'menu', 'voice')][string]$Mode = 'tap')

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class K {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);
}
"@

$LCTRL = 0xA2; $LALT = 0xA4; $M = 0x4D; $KEYUP = 2

function Down($k) { [K]::keybd_event($k, 0, 0, 0) }
function Up($k) { [K]::keybd_event($k, 0, $KEYUP, 0) }

if ($Mode -eq 'voice') {
  Down $LCTRL; Down $LALT; Start-Sleep -Milliseconds 80
  Down 0x20; Start-Sleep -Milliseconds 60; Up 0x20
  Up $LALT; Up $LCTRL
} elseif ($Mode -eq 'tap') {
  Down $LCTRL; Start-Sleep -Milliseconds 60
  Down $LALT; Start-Sleep -Milliseconds 120
  Up $LALT; Start-Sleep -Milliseconds 30
  Up $LCTRL
} else {
  # RegisterHotKey-based shortcuts match the generic Ctrl (0x11) and Alt (0x12) codes.
  Down 0x11; Down 0x12; Start-Sleep -Milliseconds 100
  Down $M; Start-Sleep -Milliseconds 100; Up $M
  Up 0x12; Up 0x11
}
"sent $Mode"
