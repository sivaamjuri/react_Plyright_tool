# Start backend + frontend for local development (Windows).
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

Write-Host "============================================" -ForegroundColor Green
Write-Host "  Visual UI Checker — local dev" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Green

if (-not (Test-Path (Join-Path $backend "node_modules"))) {
    Write-Host "[*] Installing backend dependencies..." -ForegroundColor Yellow
    Push-Location $backend
    npm install
    npx playwright install chromium
    Pop-Location
} else {
    Write-Host "[*] Backend node_modules present; run 'npx playwright install chromium' in backend if browsers are missing." -ForegroundColor DarkGray
}

$master = Join-Path $backend "master_project"
$masterMarker = Join-Path $master "node_modules\@vitejs\plugin-react\package.json"
if (-not (Test-Path $masterMarker)) {
    Write-Host "[*] Installing backend/master_project (shared deps for uploaded Vite apps)..." -ForegroundColor Yellow
    Push-Location $master
    npm install --no-audit --no-fund --legacy-peer-deps
    Pop-Location
}

if (-not (Test-Path (Join-Path $frontend "node_modules"))) {
    Write-Host "[*] Installing frontend dependencies..." -ForegroundColor Yellow
    Push-Location $frontend
    npm install
    Pop-Location
}

Write-Host "[+] Starting backend on http://localhost:3000 ..." -ForegroundColor Magenta
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-NoProfile",
    "-Command",
    "Set-Location -LiteralPath '$backend'; npm start"
)

Start-Sleep -Seconds 2

Write-Host "[+] Starting Vite on http://localhost:5173 ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-NoProfile",
    "-Command",
    "Set-Location -LiteralPath '$frontend'; npm run dev"
)

Start-Sleep -Seconds 3
Start-Process "http://localhost:5173"
Write-Host "[OK] Opened browser. Close the two new PowerShell windows to stop servers." -ForegroundColor Green
