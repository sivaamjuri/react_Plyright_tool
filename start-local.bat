@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Visual UI Checker - local dev
echo ============================================

if not exist "backend\node_modules\" (
  echo [*] Installing backend...
  pushd backend
  call npm install
  call npx playwright install chromium
  popd
)

if not exist "backend\master_project\node_modules\@vitejs\plugin-react\package.json" (
  echo [*] Installing backend\master_project ^(shared deps for Vite uploads^)...
  pushd backend\master_project
  call npm install --no-audit --no-fund --legacy-peer-deps
  popd
)

if not exist "frontend\node_modules\" (
  echo [*] Installing frontend...
  pushd frontend
  call npm install
  popd
)

echo [+] Backend http://localhost:3000
start "UI Checker - Backend" /D "%~dp0backend" cmd /k npm start

timeout /t 2 /nobreak >nul

echo [+] Frontend http://localhost:5173
start "UI Checker - Frontend" /D "%~dp0frontend" cmd /k npm run dev

timeout /t 4 /nobreak >nul
start http://localhost:5173
echo Done. Close the Backend and Frontend windows to stop.
pause
