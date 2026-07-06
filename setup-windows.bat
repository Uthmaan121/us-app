@echo off
cd /d "%~dp0"
cls
echo ========================================
echo          Setting up us. app
echo ========================================
echo.
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo X  Node.js is not installed.
    echo    Install it from: https://nodejs.org
    echo    Then double-click this file again.
    pause
    exit /b 1
)
echo Installing dependencies...
call npm install
echo.
echo Building app...
call npm run build
echo.
echo ========================================
echo Done! The 'dist' folder is ready.
echo Follow STEP 2 in the guide to deploy.
echo ========================================
explorer dist
pause
