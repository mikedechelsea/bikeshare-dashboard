@echo off
REM Dock Pulse — run Node without PowerShell (Avast-safe)
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install LTS from https://nodejs.org then double-click this file again.
  pause
  exit /b 1
)

echo.
echo Dock Pulse pipeline
echo Using node.exe — not PowerShell
echo Folder: %cd%
echo.

node.exe pipeline_engine.js
set ERR=%ERRORLEVEL%

echo.
if %ERR%==0 (
  echo Done. KV was updated. Refresh the dashboard.
) else (
  echo Pipeline stopped with code %ERR%.
  echo If it says 0 rides, run sql\01_check_and_fix_inventory.sql in BigQuery first.
)
echo.
pause
exit /b %ERR%
