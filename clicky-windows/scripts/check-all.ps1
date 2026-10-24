# Syntax-checks every JS file under src and runs the parser check.
Set-Location (Join-Path $PSScriptRoot '..')
$failed = $false
Get-ChildItem src -Recurse -Filter *.js | ForEach-Object {
  $output = node --check $_.FullName 2>&1
  if ($LASTEXITCODE -ne 0) {
    $failed = $true
    "FAIL $($_.FullName)"
    $output
  }
}
node scripts/check-parser.js
if ($failed) { "SYNTAX ERRORS FOUND"; exit 1 } else { "all files OK" }
