# Run from repo root:
#   powershell -ExecutionPolicy Bypass -File deploy/preflight.ps1
# Steps: local .env from examples, npm install (backend, master_project, frontend), Playwright Chromium.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not (Test-Path (Join-Path $root "backend\server.js"))) {
    Write-Error "Could not find backend\server.js. Run from repo root: deploy\preflight.ps1"
}

Write-Host "=== Repo root: $root ===" -ForegroundColor Cyan

# Step: local .env files (do not commit; .gitignore covers backend/.env)
$beEnv = Join-Path $root "backend\.env"
if (-not (Test-Path $beEnv)) {
    Copy-Item (Join-Path $root "backend\.env.example") $beEnv
    Write-Host "[OK] Created backend/.env from .env.example" -ForegroundColor Green
} else {
    Write-Host "[skip] backend/.env already exists" -ForegroundColor DarkGray
}

$feEnv = Join-Path $root "frontend\.env"
if (-not (Test-Path $feEnv)) {
    Copy-Item (Join-Path $root "frontend\.env.example") $feEnv
    Write-Host "[OK] Created frontend/.env from .env.example" -ForegroundColor Green
} else {
    Write-Host "[skip] frontend/.env already exists" -ForegroundColor DarkGray
}

Write-Host "`n=== npm install: backend ===" -ForegroundColor Cyan
Push-Location (Join-Path $root "backend")
npm install
Pop-Location

Write-Host "`n=== npm install: backend/master_project ===" -ForegroundColor Cyan
Push-Location (Join-Path $root "backend\master_project")
npm install --no-audit --no-fund --legacy-peer-deps
Pop-Location

Write-Host "`n=== npm install: frontend ===" -ForegroundColor Cyan
Push-Location (Join-Path $root "frontend")
npm install
Pop-Location

Write-Host "`n=== Playwright (Chromium) in backend ===" -ForegroundColor Cyan
Push-Location (Join-Path $root "backend")
npx playwright install chromium
Pop-Location

Write-Host "`n[DONE] Next: push to GitHub, then on EC2 run: bash deploy/ec2-bootstrap.sh   See DEPLOYMENT.md" -ForegroundColor Green
