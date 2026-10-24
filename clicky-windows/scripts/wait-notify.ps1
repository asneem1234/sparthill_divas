# Waits for the app's debug notify log to grow, then screenshots immediately (test helper).
# Usage: powershell -File scripts\wait-notify.ps1 -Out C:\Users\ASUS\toast.png
param([string]$Out = "$env:USERPROFILE\toast.png", [int]$TimeoutSeconds = 60)

$log = "$env:USERPROFILE\clickit-notify.log"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$seen = 0
if (Test-Path $log) { $seen = (Get-Content $log | Measure-Object).Count }
while ((Get-Date) -lt $deadline) {
  $now = 0
  if (Test-Path $log) { $now = (Get-Content $log | Measure-Object).Count }
  if ($now -gt $seen) {
    Start-Sleep -Milliseconds 1200   # let the toast animate in
    powershell -NoProfile -File (Join-Path $PSScriptRoot 'screen-shot.ps1') -Path $Out
    "notification logged:"
    Get-Content $log | Select-Object -Last ($now - $seen)
    exit 0
  }
  Start-Sleep -Milliseconds 300
}
"no notification within $TimeoutSeconds s"
