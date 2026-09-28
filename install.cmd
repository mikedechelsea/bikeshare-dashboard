@echo off
REM Use npm.cmd so Windows does not open npm.ps1 (Avast blocks that)
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  pause
  exit /b 1
)

echo Installing packages with npm.cmd ...
call npm.cmd install
echo.
echo If that succeeded, double-click run.cmd next.
pause
