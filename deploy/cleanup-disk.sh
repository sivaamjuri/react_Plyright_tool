#!/usr/bin/env bash
# Prune old compare temp dirs, trim PM2 logs, optionally vacuum journal/apt cache (when root).
# Usage: cleanup-disk.sh [REPO_ROOT]
# Cron: 0 3 * * * ubuntu /opt/ui-similarity/deploy/cleanup-disk.sh /opt/ui-similarity
set -euo pipefail

REPO_ROOT="${1:-${REPO_ROOT:-/opt/ui-similarity}}"
TEMP="${REPO_ROOT}/backend/temp"

if [[ -d "$TEMP" ]]; then
  # Job folders older than ~36h (mtime +1 = strictly more than 24h; safe for stuck runs)
  find "$TEMP" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
fi

if command -v pm2 &>/dev/null; then
  pm2 flush 2>/dev/null || true
fi

if [[ "$(id -u)" -eq 0 ]]; then
  journalctl --vacuum-time=7d 2>/dev/null || true
  apt-get clean 2>/dev/null || true
fi
