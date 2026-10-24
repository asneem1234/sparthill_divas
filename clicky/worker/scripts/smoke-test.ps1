# Smoke test for a running worker (wrangler dev or deployed).
# Usage: powershell -File scripts\smoke-test.ps1 [-BaseUrl http://localhost:8787]
param([string]$BaseUrl = "http://localhost:8787")

$body = @{
  model = "gemini-3.5-flash"
  max_tokens = 200
  system = "Reply in one short sentence."
  messages = @(@{ role = "user"; content = "Say hello and name one color." })
} | ConvertTo-Json -Depth 5

try {
  $response = Invoke-WebRequest -Uri "$BaseUrl/chat" -Method POST -ContentType "application/json" `
    -Body $body -UseBasicParsing -TimeoutSec 60
  "STATUS $($response.StatusCode)"
  $response.Content
} catch {
  "ERROR: $($_.Exception.Message) $($_.ErrorDetails.Message)"
}
