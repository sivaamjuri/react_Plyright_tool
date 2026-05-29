#!/usr/bin/env bash
# Apply once per EC2 (or after disk resize): open-file limits, PM2 systemd limits, daily cleanup.
# Must run as root: sudo bash deploy/ec2-server-tuning.sh --repo-root /opt/ui-similarity
set -euo pipefail

REPO_ROOT="/opt/ui-similarity"
DEPLOY_USER="ubuntu"

usage() {
  echo "Usage: sudo $0 [--repo-root PATH] [--user LOGIN]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --user) DEPLOY_USER="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0 --repo-root $REPO_ROOT --user $DEPLOY_USER" >&2
  exit 1
fi

CLEANUP_SCRIPT="${REPO_ROOT}/deploy/cleanup-disk.sh"
if [[ ! -f "$CLEANUP_SCRIPT" ]]; then
  echo "ERROR: cleanup script not found: $CLEANUP_SCRIPT" >&2
  exit 1
fi
chmod +x "$CLEANUP_SCRIPT"

echo "=== PAM limits (${DEPLOY_USER}) ==="
install -d -m 0755 /etc/security/limits.d
LIMITS_FILE="/etc/security/limits.d/90-nofile-${DEPLOY_USER}.conf"
tmp="$(mktemp)"
if printf '%s\n' "${DEPLOY_USER} soft nofile 65535" "${DEPLOY_USER} hard nofile 65535" >"$tmp" 2>/dev/null; then
  mv "$tmp" "$LIMITS_FILE"
  chmod 0644 "$LIMITS_FILE"
  echo "Wrote $LIMITS_FILE"
else
  rm -f "$tmp"
  echo "WARN: could not write $LIMITS_FILE (disk full?). Free space and re-run this script."
fi

echo "=== systemd manager DefaultLimitNOFILE ==="
install -d -m 0755 /etc/systemd/system.conf.d
cat >/etc/systemd/system.conf.d/90-nofile.conf <<'UNIT'
[Manager]
DefaultLimitNOFILE=65535:65535
UNIT
echo "Wrote /etc/systemd/system.conf.d/90-nofile.conf"

echo "=== PM2 systemd unit drop-in (LimitNOFILE) ==="
PM2_UNIT="pm2-${DEPLOY_USER}.service"
DROP_DIR="/etc/systemd/system/${PM2_UNIT}.d"
install -d -m 0755 "$DROP_DIR"
cat >"${DROP_DIR}/override.conf" <<'UNIT'
[Service]
LimitNOFILE=65535:65535
UNIT
echo "Wrote ${DROP_DIR}/override.conf (applies when ${PM2_UNIT} is enabled)"

echo "=== Daily cleanup cron (/etc/cron.d/ui-similarity-cleanup) ==="
CRON_PATH="/etc/cron.d/ui-similarity-cleanup"
cat >"$CRON_PATH" <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
MAILTO=""

# Prune backend/temp older than 24h, pm2 flush; root section vacuums journal + apt cache
0 3 * * * ${DEPLOY_USER} /bin/bash ${CLEANUP_SCRIPT} ${REPO_ROOT}
CRON
chmod 0644 "$CRON_PATH"
echo "Wrote $CRON_PATH"

echo "=== Reload systemd ==="
systemctl daemon-reexec 2>/dev/null || systemctl daemon-reload
echo "If limits still show 1024 in a new SSH session, reboot once: sudo reboot"

echo "[DONE] After reboot (or new login), check: ulimit -n"
echo "         PM2: sudo systemctl restart ${PM2_UNIT}   # or: pm2 restart all"
