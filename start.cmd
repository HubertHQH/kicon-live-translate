@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer.
  pause
  exit /b 1
)
if not exist node_modules\ws (
  call npm install
  if errorlevel 1 exit /b 1
)
echo KiCon Live: http://localhost:3210
call npm start
pause
