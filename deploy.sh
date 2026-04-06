#!/usr/bin/env bash
#
# deploy.sh — pull latest code and restart the gateway-monitor service.
#
# Assumes this repo is cloned at ~/helium-gateway-monitor and the service
# runs from /opt/helium-gateway-monitor (as set up by setup.sh).
#
# Usage: ./deploy.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/helium-gateway-monitor"
SERVICE="gateway-monitor.service"

echo "==> Pulling latest from origin/main"
git -C "$SCRIPT_DIR" pull --ff-only

echo "==> Copying app files to $APP_DIR"
sudo cp "$SCRIPT_DIR/app.py" "$APP_DIR/"
sudo cp "$SCRIPT_DIR/requirements.txt" "$APP_DIR/"
sudo cp "$SCRIPT_DIR/logo-transparent.png" "$APP_DIR/"
sudo cp -r "$SCRIPT_DIR/templates" "$APP_DIR/"

if [ -d "$SCRIPT_DIR/onboard-service" ]; then
    sudo mkdir -p "$APP_DIR/onboard-service"
    sudo cp "$SCRIPT_DIR/onboard-service/index.js" "$APP_DIR/onboard-service/" 2>/dev/null || true
    sudo cp "$SCRIPT_DIR/onboard-service/package.json" "$APP_DIR/onboard-service/" 2>/dev/null || true
fi

echo "==> Fixing ownership"
sudo chown -R gateway-monitor:gateway-monitor "$APP_DIR"

echo "==> Installing/refreshing Python deps"
sudo "$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

echo "==> Restarting $SERVICE"
sudo systemctl restart "$SERVICE"
sleep 2
sudo systemctl status "$SERVICE" --no-pager | head -10

echo "==> Done."
