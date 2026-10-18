@echo off
setlocal

rem ============================================================
rem  DeskPanel launcher.
rem
rem  ELECTRON_RUN_AS_NODE must be cleared: some environments set it
rem  globally, and Electron then starts in plain Node mode without
rem  ever creating a window (error: "Cannot read properties of
rem  undefined (reading 'getPath')").
rem ============================================================

set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"

if not exist "native\IconGrab.exe" (
  echo [start] building native helpers...
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "native\build.ps1"
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [start] installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [start] npm install failed. Install Node.js 18+ first.
    pause
    exit /b 1
  )
)

start "" "node_modules\electron\dist\electron.exe" "%~dp0."
