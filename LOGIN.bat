@echo off
title fomo-tracker login
cd /d "%~dp0"

if exist "%CD%\.node\node.exe" set "PATH=%CD%\.node;%PATH%"
where node >nul 2>nul || set "PATH=%ProgramFiles%\nodejs;%PATH%"
if not exist node_modules\.setup-done (
  echo Open START.bat once first so it can install everything, then run LOGIN.bat again.
  pause
  exit /b 1
)

node src\login.js
pause
