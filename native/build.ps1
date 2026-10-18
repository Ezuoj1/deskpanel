# Build the small native helpers used by DeskPanel.
#
# We deliberately avoid Visual Studio: Windows ships with the .NET Framework
# compiler (csc.exe), which is enough for these three tiny tools.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File native\build.ps1
#
# IMPORTANT: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 files
# as ANSI when there is no BOM, so non-ASCII characters here would break parsing.

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

$csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
  $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
  Write-Host '[build] csc.exe not found (.NET Framework 4.x is required, ships with Windows)' -ForegroundColor Red
  exit 1
}

function Build($out, $target, $src, $refs) {
  $cargs = @('/nologo', "/target:$target", "/out:$out")
  foreach ($r in $refs) { $cargs += "/r:$r" }
  $cargs += $src
  & $csc $cargs
  if ($LASTEXITCODE -ne 0) { throw "build failed: $src" }
  Write-Host "[build] ok  $([System.IO.Path]::GetFileName($out))" -ForegroundColor Green
}

# 1) Icon fallback: Electron's getFileIcon returns a generic blank icon for some
#    executables, so we ask Windows for the real one and save it as PNG.
Build (Join-Path $here 'IconGrab.exe') 'exe' (Join-Path $here 'IconGrab.cs') @(
  'System.Drawing.dll'
)

# 2) Per-application volume via Core Audio ISimpleAudioVolume.
Build (Join-Path $here 'AudioVol.dll') 'library' (Join-Path $here 'AudioVol.cs') @()

# 3) Album art from SMTC. PowerShell cannot unwrap the WinRT thumbnail stream,
#    so this one is a tiny C# program that polls IAsyncOperation by hand.
$winmd = Join-Path $env:SystemRoot 'System32\WinMetadata'
if (Test-Path (Join-Path $winmd 'Windows.Media.winmd')) {
  $fw = Split-Path $csc -Parent
  Build (Join-Path $here 'SmtcCover.exe') 'exe' (Join-Path $here 'SmtcCover.cs') @(
    (Join-Path $fw 'System.Runtime.dll'),
    (Join-Path $winmd 'Windows.Foundation.winmd'),
    (Join-Path $winmd 'Windows.Media.winmd'),
    (Join-Path $winmd 'Windows.Storage.winmd')
  )
} else {
  Write-Host '[build] skipped SmtcCover.exe (no Windows MetaData; album art will use the placeholder)' -ForegroundColor Yellow
}

Write-Host '[build] done' -ForegroundColor Cyan
