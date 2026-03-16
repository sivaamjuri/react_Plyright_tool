@echo off
TITLE Visual UI Checker (Production)
echo ============================================
echo   🚀 STARTING VISUAL UI CHECKER (PRO)
echo ============================================

:: Start Backend
echo [*] Launching API Server on Port 3000...
cd "%~dp0backend"
start /b cmd /c "node server.js"

:: Give backend a moment
timeout /t 2 /nobreak > nul

:: Start Production Frontend
echo [*] Serving Frontend on Port 5173...
cd "%~dp0frontend"
if not exist "dist" (
    echo [ERROR] Frontend build folder "dist" is missing!
    echo Please run "npm run build" in the frontend folder first.
    pause
    exit /b
)
start "" "http://localhost:5173"
npx serve -s dist -p 5173

pause
