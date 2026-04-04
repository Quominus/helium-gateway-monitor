#!/bin/bash
# -------------------------------------------------------------------
# Helium Gateway Monitor — Setup Script
# Run this on the same EC2 instance as helium-multi-gateway
#
# Usage:
#   sudo ./setup.sh your-domain.com your-email@example.com
# -------------------------------------------------------------------

set -e

# ---- Parse arguments ----
if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: sudo ./setup.sh <domain> <email>"
    echo ""
    echo "  domain  — the domain name pointing at this server (for nginx + SSL)"
    echo "  email   — your email address (for Let's Encrypt notifications)"
    echo ""
    echo "Example:"
    echo "  sudo ./setup.sh gateway.mysite.com me@example.com"
    exit 1
fi

DOMAIN="$1"
EMAIL="$2"

echo "======================================"
echo " Helium Gateway Monitor — Setup"
echo "======================================"
echo "  Domain: $DOMAIN"
echo "  Email:  $EMAIL"
echo ""

APP_DIR="/opt/helium-gateway-monitor"
DATA_DIR="/var/lib/helium-gateway-monitor"
SERVICE_USER="gateway-monitor"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- 1. System dependencies ----
echo "[1/9] Installing system dependencies..."
sudo apt update -qq
sudo apt install -y python3 python3-pip python3-venv nginx certbot python3-certbot-nginx

# Install Node.js 18+ (for the onboard service)
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
    echo "  -> Installing Node.js 18..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt install -y nodejs
fi
echo "  -> Node.js $(node -v)"

# ---- 2. Create service user ----
echo "[2/9] Creating service user..."
if ! id "$SERVICE_USER" &>/dev/null; then
    sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# ---- 3. Copy application files ----
echo "[3/9] Setting up application directory..."
sudo mkdir -p "$APP_DIR" "$DATA_DIR"

# Copy Python app
sudo cp "$SCRIPT_DIR/app.py" "$APP_DIR/"
sudo cp "$SCRIPT_DIR/requirements.txt" "$APP_DIR/"
sudo cp "$SCRIPT_DIR/logo-transparent.png" "$APP_DIR/"
sudo cp -r "$SCRIPT_DIR/templates" "$APP_DIR/"

# Copy onboard service
sudo mkdir -p "$APP_DIR/onboard-service"
sudo cp "$SCRIPT_DIR/onboard-service/index.js" "$APP_DIR/onboard-service/"
sudo cp "$SCRIPT_DIR/onboard-service/package.json" "$APP_DIR/onboard-service/"

# ---- 4. Create virtual environment and install Python deps ----
echo "[4/9] Installing Python dependencies..."
sudo python3 -m venv "$APP_DIR/venv"
sudo "$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
sudo "$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# ---- 5. Install Node.js deps for onboard service ----
echo "[5/9] Installing Node.js dependencies..."
cd "$APP_DIR/onboard-service"
sudo npm install --production 2>&1 | tail -1
cd "$SCRIPT_DIR"

# ---- 6. Create environment file ----
echo "[6/9] Creating environment config..."
if [ ! -f "$APP_DIR/.env" ]; then
    sudo cp "$SCRIPT_DIR/.env.example" "$APP_DIR/.env"
    echo ""
    echo "  ============================================================"
    echo "  IMPORTANT: A default .env has been created at $APP_DIR/.env"
    echo "  You MUST edit it before the app will work properly:"
    echo ""
    echo "    sudo nano $APP_DIR/.env"
    echo ""
    echo "  At minimum, fill in:"
    echo "    - SOLANA_RPC_URL / DAS_RPC_URL (your Helius API key)"
    echo "    - MULTI_GW_READ_KEY (from your helium-multi-gateway config)"
    echo "  ============================================================"
    echo ""
else
    echo "  -> .env already exists, skipping (edit manually if needed)"
fi

# ---- 7. Set permissions ----
sudo chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR" "$DATA_DIR"

# Give the service user read access to gateway keys
if [ -d /var/lib/helium-multi-gateway/keys ]; then
    sudo usermod -aG helium-multi-gateway "$SERVICE_USER" 2>/dev/null || true
fi

# ---- 8. Create systemd services ----
echo "[7/9] Installing systemd services..."

# Python gateway monitor service
sudo tee /etc/systemd/system/gateway-monitor.service > /dev/null <<EOF
[Unit]
Description=Helium Gateway Monitor
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

# Node.js onboard service
sudo tee /etc/systemd/system/helium-onboard.service > /dev/null <<EOF
[Unit]
Description=Helium IoT Onboarding Service
After=network.target gateway-monitor.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR/onboard-service
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=5
Environment=ONBOARD_PORT=3001
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable gateway-monitor helium-onboard
sudo systemctl start gateway-monitor
sudo systemctl start helium-onboard

# ---- 9. Configure nginx + SSL ----
echo "[8/9] Configuring nginx..."

# Generate nginx config with the user's domain
sudo tee /etc/nginx/sites-available/gateway-monitor > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        return 301 https://\$host\$request_uri;
    }

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/gateway-monitor /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

echo "[9/9] Obtaining SSL certificate..."

# Temporary HTTP-only config for certbot verification
sudo tee /etc/nginx/sites-available/gateway-monitor-temp > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 200 'Setting up SSL...';
        add_header Content-Type text/plain;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/gateway-monitor-temp /etc/nginx/sites-enabled/gateway-monitor
sudo nginx -t && sudo systemctl restart nginx

# Get the SSL certificate
sudo certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL"

# Switch to the full nginx config with SSL
sudo ln -sf /etc/nginx/sites-available/gateway-monitor /etc/nginx/sites-enabled/gateway-monitor
sudo rm -f /etc/nginx/sites-available/gateway-monitor-temp
sudo nginx -t && sudo systemctl restart nginx

# Enable auto-renewal
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer

echo ""
echo "======================================"
echo " Setup complete!"
echo "======================================"
echo ""
echo "  Dashboard:       https://$DOMAIN"
echo ""
echo "  Service status:"
echo "    sudo systemctl status gateway-monitor"
echo "    sudo systemctl status helium-onboard"
echo ""
echo "  Logs:"
echo "    sudo journalctl -u gateway-monitor -f"
echo "    sudo journalctl -u helium-onboard -f"
echo ""
echo "  Config:  sudo nano $APP_DIR/.env"
echo "           (restart both services after changes)"
echo ""
echo "  SSL auto-renewal is enabled via certbot timer."
echo ""
