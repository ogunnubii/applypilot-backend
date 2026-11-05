@echo off
rem ApplyPilot for Windows. Double-click to start. Other commands:
rem   ApplyPilot.cmd stop ^| status ^| restart ^| package ^| shortcut
rem   ApplyPilot.cmd import -File "C:\path\to\applypilot-import.json"
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1" start
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1" %*
)
if errorlevel 1 (
  echo.
  echo ApplyPilot reported a problem. See the message above.
  pause
  exit /b 1
)
if "%~1"=="" timeout /t 8 >nul
