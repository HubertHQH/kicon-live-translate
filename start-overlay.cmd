@echo off
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  echo Installing desktop caption dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)
call npm run overlay
if errorlevel 1 pause
