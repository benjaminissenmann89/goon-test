@echo off
title fomo-tracker
cd /d "%~dp0"

call :find_node
if errorlevel 1 (
  call :install_node
  call :find_node
  if errorlevel 1 (
    echo.
    echo Could not install Node.js automatically. Install it from https://nodejs.org then open START.bat again.
    pause
    exit /b 1
  )
)

if not exist node_modules\.setup-done (
  echo First run: installing what the tracker needs. This takes a few minutes...
  call npm ci --no-audit --no-fund || goto setup_failed
  call npx playwright install chromium || goto setup_failed
  echo done> node_modules\.setup-done
)

if not exist .env (
  set "UNLOCK_KEY=%~1"
  if "%~1"=="" set /p "UNLOCK_KEY=Enter the unlock key: "
  call node src\secrets.js unlock "%%UNLOCK_KEY%%" || (
    pause
    exit /b 1
  )
)

:run
echo.
echo fomo-tracker is running. Keep this window open (minimizing is fine). Close it to stop tracking.
echo.
node src\tracker.js
if %errorlevel%==3 (
  pause
  exit /b 0
)
echo.
echo The tracker stopped. Restarting in 15 seconds...
ping -n 16 127.0.0.1 >nul
goto run

:setup_failed
echo.
echo Setup failed. Check the internet connection and open START.bat again.
pause
exit /b 1

:find_node
where node >nul 2>nul && exit /b 0
if exist "%CD%\.node\node.exe" (
  set "PATH=%CD%\.node;%PATH%"
  exit /b 0
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  exit /b 0
)
exit /b 1

:install_node
where winget >nul 2>nul
if not errorlevel 1 (
  echo Node.js is not installed. Installing it now - click Yes if Windows asks for permission...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  exit /b 0
)
rem No winget (e.g. Windows Server): use a portable Node.js inside this folder.
echo Node.js is not installed. Downloading it...
curl -L --fail -o "%TEMP%\fomo-node.zip" https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip || exit /b 1
mkdir .node 2>nul
tar -xf "%TEMP%\fomo-node.zip" -C .node --strip-components=1 || exit /b 1
del "%TEMP%\fomo-node.zip"
exit /b 0
