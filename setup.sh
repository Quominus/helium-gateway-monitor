#!/bin/bash
# -------------------------------------------------------------------
# SatTrack Gateway Monitor — Setup Script
# Run this on the same EC2 instance as helium-multi-gateway
# -------------------------------------------------------------------

set -e

echo "======================================"
echo " SatTrack Gateway Monitor — Setup"
echo "======================================"

APP_DIR="/opt/helium-gateway-monitor"
DATA_DIR="/var/lib/helium-gateway-monitor"
SERVICE_USER="gateway-monitor"

# ---- 1. System dependencies ----
echo "[1/6] Installing system dependencies..."
sudo apt update -qq
sudo apt install -y python3 python3-pip python3-venv

# ---- 2. Create service user ----
echo "[2/6] Creating service user..."
if ! id "$SERVICE_USER" &>/dev/null; then
    sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# ---- 3. Copy application files ----
echo "[3/6] Setting up application directory..."
sudo mkdir -p "$APP_DIR" "$DATA_DIR"

# Copy files from current directory
sudo cp app.py "$APP_DIR/"
sudo cp requirements.txt "$APP_DIR/"
sudo cp -r templates "$APP_DIR/"

# ---- 4. Create virtual environment and install deps ----
echo "[4/6] Installing Python dependencies..."
sudo python3 -m venv "$APP_DIR/venv"
sudo "$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
sudo "$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# ---- 5. Create environment file ----
echo "[5/6] Creating environment config..."
if [ ! -f "$APP_DIR/.env" ]; then
    cat <<'ENVEOF' | sudo tee "$APP_DIR/.env" > /dev/null
# Helium multi-gateway API (localhost since we're on the same box)
MULTI_GW_API=http://127.0.0.1:4468
MULTI_GW_READ_KEY=REDACTED_READ_KEY

# Polling interval in seconds
POLL_INTERVAL_SECONDS=30

# Database path
DB_PATH=/var/lib/helium-gateway-monitor/monitor.db

# AWS SES settings (update these with your values)
SES_REGION=eu-west-1
SES_FROM_EMAIL=alerts@sattrack.com.au

# Web server
APP_HOST=0.0.0.0
APP_PORT=8080
ENVEOF
    echo "  -> Created $APP_DIR/.env — EDIT THIS with your AWS SES settings!"
else
    echo "  -> .env already exists, skipping"
fi

# ---- 6. Set permissions ----
sudo chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR" "$DATA_DIR"

# ---- 7. Create systemd service ----
echo "[6/6] Installing systemd service..."
sudo tee /etc/systemd/system/gateway-monitor.service > /dev/null <<EOF
[Unit]
Description=SatTrack Gateway Monitor
After=network.target helium-multi-gateway.service
Wants=helium-multi-gateway.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/venv/bin/python -m uvicorn app:app --host \${APP_HOST} --port \${APP_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable gateway-monitor
sudo systemctl start gateway-monitor

echo ""
echo "======================================"
echo " Setup complete!"
echo "======================================"
echo ""
echo "  Dashboard: http://<your-elastic-ip>:8080"
echo "  Status:    sudo systemctl status gateway-monitor"
echo "  Logs:      sudo journalctl -u gateway-monitor -f"
echo "  Config:    sudo nano $APP_DIR/.env"
echo ""
echo "  IMPORTANT: Edit $APP_DIR/.env to configure your AWS SES"
echo "  settings, then restart: sudo systemctl restart gateway-monitor"
echo ""
