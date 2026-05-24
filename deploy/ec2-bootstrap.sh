#!/usr/bin/env bash
# Run on Ubuntu EC2 AFTER: git clone <repo> && cd <repo>/backend
# Usage: bash deploy/ec2-bootstrap.sh
set -euo pipefail

echo "=== Node version ==="
node -v

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND="$REPO_ROOT/backend"

cd "$BACKEND"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "=== Created backend/.env — EDIT CORS_ORIGINS for your Vercel URL, then: nano .env ==="
fi

echo "=== npm install (backend) ==="
npm install

# Ubuntu 26.x: Playwright has no official chromium build yet — use 24.04 binaries (Microsoft-documented workaround).
PW_EXTRA_ENV=()
if [[ -f /etc/os-release ]] && grep -qE '^VERSION_ID="?26' /etc/os-release; then
  export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64
  PW_EXTRA_ENV=(env PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64)
  echo "=== Ubuntu 26.x detected: using PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 for Playwright ==="
fi

echo "=== Playwright Chromium + system deps ==="
if "${PW_EXTRA_ENV[@]}" npx playwright install --with-deps chromium; then
  echo "=== Playwright install OK ==="
else
  echo "=== WARN: playwright install --with-deps failed; retrying without --with-deps ==="
  "${PW_EXTRA_ENV[@]}" npx playwright install chromium
fi

echo "=== npm install (master_project) ==="
cd master_project
npm install --no-audit --no-fund --legacy-peer-deps
cd "$BACKEND"

if [[ -n "${PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-}" ]]; then
  cat > "$REPO_ROOT/deploy/pm2.ecosystem.cjs" <<EOF
module.exports = {
  apps: [{
    name: 'ui-similarity-api',
    cwd: '$BACKEND',
    script: 'server.js',
    env: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'ubuntu24.04-x64' },
  }],
};
EOF
  echo "=== Wrote $REPO_ROOT/deploy/pm2.ecosystem.cjs (Playwright override for PM2) ==="
fi

echo "=== Install PM2 globally (optional) ==="
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
fi

echo ""
echo "[DONE] Next steps (you run manually):"
echo "  1. nano $BACKEND/.env   # set CORS_ORIGINS=https://YOUR-APP.vercel.app,http://localhost:5173"
if [[ -n "${PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-}" ]]; then
  echo "  2. pm2 start $REPO_ROOT/deploy/pm2.ecosystem.cjs   # required on Ubuntu 26.x (Playwright host override)"
else
  echo "  2. cd $BACKEND && pm2 start server.js --name ui-similarity-api"
fi
echo "  3. pm2 save && pm2 startup  # follow the printed sudo command"
echo "  4. On Vercel: root=frontend, env VITE_API_URL=http://THIS_SERVER_IP:3000"
