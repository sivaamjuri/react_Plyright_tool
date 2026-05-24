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

echo "=== Playwright Chromium + system deps ==="
npx playwright install --with-deps chromium

echo "=== npm install (master_project) ==="
cd master_project
npm install --no-audit --no-fund --legacy-peer-deps
cd "$BACKEND"

echo "=== Install PM2 globally (optional) ==="
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
fi

echo ""
echo "[DONE] Next steps (you run manually):"
echo "  1. nano $BACKEND/.env   # set CORS_ORIGINS=https://YOUR-APP.vercel.app,http://localhost:5173"
echo "  2. pm2 start server.js --name ui-similarity-api"
echo "  3. pm2 save && pm2 startup  # follow the printed sudo command"
echo "  4. On Vercel: root=frontend, env VITE_API_URL=http://THIS_SERVER_IP:3000"
