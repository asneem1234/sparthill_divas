# Long-running local OCR helper. Uses the text recognition built into Windows
# (Windows.Media.Ocr), so nothing is downloaded and nothing leaves this PC.
#
# Protocol (one request/response per line on stdin/stdout):
#   in : base64 of an image file (PNG/JPEG), one line
#   out: {"ok":true,"text":"line1\nline2"}  or  {"ok":false,"error":"..."}
# The first line printed is {"ready":true,"available":true|false}.
# Images are decoded in memory and never written to disk.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

function Write-JsonLine($object) {
  [Console]::Out.WriteLine(($object | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  function Await($operation, $resultType) {
    $task = $script:asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $null = $task.Wait(-1)
    $task.Result
  }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('en-US')))
  }
  if ($null -eq $engine) {
    Write-JsonLine @{ ready = $true; available = $false; error = 'No OCR language is installed in Windows.' }
    exit 0
  }
} catch {
  Write-JsonLine @{ ready = $true; available = $false; error = $_.Exception.Message }
  exit 0
}

Write-JsonLine @{ ready = $true; available = $true }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }

  try {
    $bytes = [Convert]::FromBase64String($line)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
    $writer.WriteBytes($bytes)
    $null = Await ($writer.StoreAsync()) ([uint32])
    $stream.Seek(0)

    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lineTexts = @($result.Lines | ForEach-Object { $_.Text })
    Write-JsonLine @{ ok = $true; text = ($lineTexts -join "`n") }

    $bitmap.Dispose()
    $stream.Dispose()
  } catch {
    Write-JsonLine @{ ok = $false; error = $_.Exception.Message }
  }
}
