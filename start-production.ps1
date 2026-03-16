# 🚀 Visual UI Checker Production Launch Script

Write-Host "============================================" -ForegroundColor Green
Write-Host "   🚀 STARTING VISUAL UI CHECKER (PRO)   " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Green

# 1. Kill any existing instances on standard ports
Write-Host "[*] Checking for existing instances on ports 3000 and 5173..."
$p3000 = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
$p5173 = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue

if ($p3000) { 
    Write-Host "[!] Port 3000 is occupied. Attempting to kill process (PID: $($p3000[0].OwningProcess))..." -ForegroundColor Yellow
    Stop-Process -Id $p3000[0].OwningProcess -Force -ErrorAction SilentlyContinue
}
if ($p5173) { 
    Write-Host "[!] Port 5173 is occupied. Attempting to kill process (PID: $($p5173[0].OwningProcess))..." -ForegroundColor Yellow
    Stop-Process -Id $p5173[0].OwningProcess -Force -ErrorAction SilentlyContinue
}

# 2. Build Check
if (-not (Test-Path "$PSScriptRoot\frontend\dist")) {
    Write-Host "[ERROR] Frontend 'dist' folder not found! Please run 'npm run build' first." -ForegroundColor Red
    pause
    exit
}

# 3. Start Backend in separate window
Write-Host "[+] Launching Backend API (Port 3000)..." -ForegroundColor Magenta
Start-Process "node" -ArgumentList "$PSScriptRoot\backend\server.js" -WindowStyle Normal

# 4. Start Frontend
Write-Host "[+] Serving Frontend (Port 5173)..." -ForegroundColor Cyan
Start-Process "http://localhost:5173"
cd "$PSScriptRoot\frontend"
npx serve -s dist -p 5173
