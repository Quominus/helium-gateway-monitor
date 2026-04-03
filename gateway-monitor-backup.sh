#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Helium Gateway Monitor – Full Backup Script
# Backs up: entire /opt/helium-gateway-monitor directory
# (code, .env, configs, node_modules, templates, etc.)
# then uploads to Storj S3-compatible storage.
#
# Usage:
#   chmod +x gateway-monitor-backup.sh
#   sudo ./gateway-monitor-backup.sh
#
# Prerequisites:
#   - aws cli installed (sudo apt install awscli)
#   - Run as root / sudo (to read all files in /opt)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration ──────────────────────────────────────────
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/tmp/gateway-monitor-backup-${TIMESTAMP}"
ARCHIVE_NAME="gateway-monitor-backup-${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="/tmp/${ARCHIVE_NAME}"

# S3-compatible storage (Storj)
# Credentials are loaded from /opt/helium-gateway-monitor/.env.backup
# Create this file with:
#   AWS_ACCESS_KEY_ID=your-key
#   AWS_SECRET_ACCESS_KEY=your-secret
S3_ENDPOINT="https://gateway.storjshare.io"
S3_BUCKET="${S3_BUCKET:-chirpstack-backups}"
S3_PREFIX="${S3_PREFIX:-gateway-monitor}"

CREDENTIALS_FILE="${APP_DIR}/.env.backup"
if [ -f "${CREDENTIALS_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${CREDENTIALS_FILE}"
  export AWS_ACCESS_KEY_ID
  export AWS_SECRET_ACCESS_KEY
else
  error "Credentials file not found: ${CREDENTIALS_FILE}"
  error "Create it with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
  exit 1
fi

# What to back up
APP_DIR="/opt/helium-gateway-monitor"

# UptimeRobot heartbeat (update this URL once you create the monitor)
HEARTBEAT_URL="${HEARTBEAT_URL:-}"

# ── Colours ────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Pre-flight checks ─────────────────────────────────────
check_prerequisites() {
  info "Running pre-flight checks..."

  if [ ! -d "${APP_DIR}" ]; then
    error "Application directory not found: ${APP_DIR}"
    exit 1
  fi

  if ! command -v aws &>/dev/null; then
    error "AWS CLI is not installed — needed for Storj upload"
    error "Install with: sudo apt install awscli"
    exit 1
  fi

  info "Pre-flight checks passed"
}

# ── Create backup directory ───────────────────────────────
create_backup_dir() {
  info "Creating backup directory: ${BACKUP_DIR}"
  mkdir -p "${BACKUP_DIR}"
}

# ── 1. Back up full /opt/helium-gateway-monitor ───────────
backup_app() {
  info "Backing up ${APP_DIR}..."

  # Exclude .git directory and any large temp/cache files
  tar czf "${BACKUP_DIR}/helium-gateway-monitor.tar.gz" \
    --exclude='.git' \
    --exclude='node_modules/.cache' \
    -C /opt \
    helium-gateway-monitor

  local app_size
  app_size=$(du -sh "${BACKUP_DIR}/helium-gateway-monitor.tar.gz" | cut -f1)
  info "Application backup complete (${app_size})"
}

# ── 2. Back up systemd / PM2 service config ───────────────
backup_service_config() {
  info "Backing up service configurations..."

  mkdir -p "${BACKUP_DIR}/service-config"

  # Systemd unit files (if any)
  for unit in /etc/systemd/system/*gateway* /etc/systemd/system/*helium*; do
    if [ -f "$unit" ]; then
      cp "$unit" "${BACKUP_DIR}/service-config/"
      info "Copied systemd unit: $(basename "$unit")"
    fi
  done

  # PM2 ecosystem config (if PM2 is used)
  if command -v pm2 &>/dev/null; then
    pm2 save --force 2>/dev/null || true
    if [ -f /root/.pm2/dump.pm2 ]; then
      cp /root/.pm2/dump.pm2 "${BACKUP_DIR}/service-config/pm2-dump.json"
      info "PM2 process dump saved"
    fi
    if [ -f /home/ubuntu/.pm2/dump.pm2 ]; then
      cp /home/ubuntu/.pm2/dump.pm2 "${BACKUP_DIR}/service-config/pm2-dump-ubuntu.json"
      info "PM2 process dump (ubuntu user) saved"
    fi
  fi

  # Crontab entries
  crontab -l -u root > "${BACKUP_DIR}/service-config/crontab-root.txt" 2>/dev/null || true
  crontab -l -u ubuntu > "${BACKUP_DIR}/service-config/crontab-ubuntu.txt" 2>/dev/null || true

  info "Service config backup complete"
}

# ── 3. Create final archive ──────────────────────────────
create_archive() {
  info "Creating compressed archive..."
  tar czf "${ARCHIVE_PATH}" -C /tmp "gateway-monitor-backup-${TIMESTAMP}"

  local archive_size
  archive_size=$(du -sh "${ARCHIVE_PATH}" | cut -f1)
  info "Archive created: ${ARCHIVE_PATH} (${archive_size})"
}

# ── 4. Upload to Storj (S3-compatible) ───────────────────
upload_to_s3() {
  local S3_FLAGS="--endpoint-url ${S3_ENDPOINT}"

  info "Uploading to s3://${S3_BUCKET}/${S3_PREFIX}/${ARCHIVE_NAME}..."
  aws s3 cp ${S3_FLAGS} "${ARCHIVE_PATH}" "s3://${S3_BUCKET}/${S3_PREFIX}/${ARCHIVE_NAME}"
  info "Upload complete"

  # Prune old backups (keep last 30)
  info "Checking for old backups to prune (keeping last 30)..."
  local count
  count=$(aws s3 ls ${S3_FLAGS} "s3://${S3_BUCKET}/${S3_PREFIX}/" | wc -l)
  if [ "$count" -gt 30 ]; then
    local to_delete
    to_delete=$((count - 30))
    aws s3 ls ${S3_FLAGS} "s3://${S3_BUCKET}/${S3_PREFIX}/" \
      | sort \
      | head -n "${to_delete}" \
      | awk '{print $4}' \
      | while read -r file; do
          aws s3 rm ${S3_FLAGS} "s3://${S3_BUCKET}/${S3_PREFIX}/${file}"
          info "Pruned old backup: ${file}"
        done
  fi
}

# ── 5. Cleanup ───────────────────────────────────────────
cleanup() {
  info "Cleaning up temporary files..."
  rm -rf "${BACKUP_DIR}"
  rm -f "${ARCHIVE_PATH}"
  info "Cleanup complete"
}

# ── Summary ──────────────────────────────────────────────
print_summary() {
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Gateway Monitor Backup Complete"
  echo "═══════════════════════════════════════════════════"
  echo "  Timestamp:  ${TIMESTAMP}"
  echo "  Storj:      s3://${S3_BUCKET}/${S3_PREFIX}/${ARCHIVE_NAME}"
  echo ""
  echo "  Contents:"
  echo "    - Full /opt/helium-gateway-monitor (excl .git)"
  echo "    - Systemd / PM2 service configs"
  echo "    - Crontab entries"
  echo "═══════════════════════════════════════════════════"
  echo ""
}

# ── Main ─────────────────────────────────────────────────
main() {
  echo ""
  info "Starting Gateway Monitor backup — ${TIMESTAMP}"
  echo ""

  check_prerequisites
  create_backup_dir
  backup_app
  backup_service_config
  create_archive
  upload_to_s3
  cleanup
  print_summary

  # Ping UptimeRobot heartbeat to confirm successful completion
  if [ -n "${HEARTBEAT_URL}" ]; then
    info "Pinging UptimeRobot heartbeat..."
    curl -fsS -m 10 --retry 3 "${HEARTBEAT_URL}" > /dev/null 2>&1 \
      && info "Heartbeat ping sent successfully" \
      || warn "Heartbeat ping failed (non-critical)"
  else
    warn "No HEARTBEAT_URL set — skipping heartbeat ping"
  fi
}

main "$@"
