# Helium Gateway Monitor

A self-hosted web dashboard for monitoring and onboarding Helium IoT hotspots running on [helium-multi-gateway](https://github.com/quominus/helium-multi-gateway).

Features:

- Live status dashboard for all your gateways (uptime, packets, rewards)
- Browser-based onboarding flow — issue entity + assert location using a Phantom/Solflare wallet
- Email alerts when gateways go offline
- On-chain status checks (issued, onboarded, location asserted)

---

## Prerequisites

Before you start, you'll need:

1. **An Ubuntu EC2 instance** (or similar VPS) with `helium-multi-gateway` already installed and running. This is a separate package that aggregates multiple LoRaWAN gateways into the Helium network. You install it from a `.deb` file:
   ```bash
   sudo dpkg -i helium-multi-gateway_0.1.0-1_amd64.deb
   ```
   Ask Will for the `.deb` if you don't have it. Once installed, it runs as a systemd service on port 4468 and creates its config at `/etc/helium-multi-gateway/settings.toml`.

2. **A domain name** pointed at your server's public IP (e.g. via an A record in your DNS provider). This is needed for HTTPS/SSL via Let's Encrypt.

3. **A Helius API key** (free tier is fine). Helius provides a Solana RPC endpoint with DAS (Digital Asset Standard) support, which is needed to look up compressed NFTs on the Helium network.
   - Sign up at https://www.helius.dev/
   - Create a new project and copy your API key
   - Your RPC URL will be: `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`

4. **Your multi-gateway read key**. This is generated automatically when `helium-multi-gateway` is installed. To find it:
   ```bash
   sudo cat /etc/helium-multi-gateway/settings.toml
   ```
   Copy the value next to `read_api_key`. This is what the monitor uses to pull gateway status from the multi-gateway API.

5. **Node.js 18+** (for the onboard service). The setup script installs this automatically.

6. **(Optional) AWS account with SES** if you want email alerts when gateways go offline. The app sends notifications via AWS Simple Email Service (SES). You'll need to verify a sender email/domain in SES and make sure AWS credentials are available on the server (e.g. an IAM role on EC2, or `~/.aws/credentials`). See https://docs.aws.amazon.com/ses/latest/dg/setting-up.html

---

## Quick Start

### 1. Clone the repo on your server

```bash
ssh ubuntu@your-server-ip
git clone https://github.com/quominus/helium-gateway-monitor.git
cd helium-gateway-monitor
```

### 2. Create your environment file

```bash
cp .env.example .env
nano .env
```

Fill in the values — at minimum you need:

- `SOLANA_RPC_URL` and `DAS_RPC_URL` — paste your Helius RPC URL (same value for both)
- `MULTI_GW_READ_KEY` — your multi-gateway read key (see prerequisites above)
- `GATEWAY_KEYS_DIR` — path to your gateway `.key` files (usually `/var/lib/helium-multi-gateway/keys`)

The rest have sensible defaults. See `.env.example` for descriptions of every option.

### 3. Run the setup script

```bash
chmod +x setup.sh
sudo ./setup.sh your-domain.com your-email@example.com
```

The two arguments are:

- **Domain** — the domain name pointing at this server (used for nginx + SSL cert)
- **Email** — your email address (used for Let's Encrypt certificate notifications)

The script will:

- Install system dependencies (Python 3, nginx, certbot, Node.js)
- Create a `gateway-monitor` service user
- Set up a Python virtual environment and install dependencies
- Copy your `.env` into the app directory
- Install and start the systemd services (both the Python monitor and the Node.js onboard service)
- Configure nginx as a reverse proxy with HTTPS
- Obtain an SSL certificate via Let's Encrypt

### 4. Verify everything is running

```bash
sudo systemctl status gateway-monitor
sudo systemctl status helium-onboard
```

Then open `https://your-domain.com` in a browser — you should see the dashboard.

---

## Onboarding a Gateway

1. Open the dashboard and find your gateway in the list
2. Click the **Onboard** badge next to it
3. Connect your Phantom or Solflare wallet (the wallet that will pay the onboarding fee)
4. Click **Issue Entity** — this creates the hotspot's on-chain identity. Approve the transaction in your wallet.
5. Set the gateway's location on the map and click **Onboard** — this asserts the location on-chain. Approve the transaction in your wallet.

The onboarding fee is paid in SOL from your connected wallet (currently around 1 USD worth).

---

## Useful Commands

```bash
# View logs
sudo journalctl -u gateway-monitor -f        # Python app logs
sudo journalctl -u helium-onboard -f          # Onboard service logs

# Restart services
sudo systemctl restart gateway-monitor
sudo systemctl restart helium-onboard

# Edit config
sudo nano /opt/helium-gateway-monitor/.env
# Then restart both services after changes

# Check SSL cert renewal
sudo certbot renew --dry-run
```

---

## Project Structure

```
helium-gateway-monitor/
├── app.py                        # Main FastAPI application (dashboard, API, notifications)
├── requirements.txt              # Python dependencies
├── setup.sh                      # Automated server setup script
├── nginx.conf                    # Nginx reverse proxy config (HTTPS)
├── .env.example                  # Environment variable template
├── onboard-service/
│   ├── index.js                  # Express.js service for Solana onboarding transactions
│   ├── package.json              # Node.js dependencies
│   └── helium-onboard.service    # Systemd unit file for the onboard service
└── templates/
    ├── index.html                # Web dashboard (single-page app)
    └── unsubscribed.html         # Email unsubscribe confirmation page
```

---

## Troubleshooting

**Dashboard loads but shows no gateways** — Check that `helium-multi-gateway` is running (`sudo systemctl status helium-multi-gateway`) and that `MULTI_GW_READ_KEY` in your `.env` matches the key in your multi-gateway config.

**Onboard button does nothing** — Check the onboard service is running (`sudo systemctl status helium-onboard`) and look at its logs for errors. The most common issue is a missing or invalid Helius API key.

**SSL certificate errors** — Make sure your domain's DNS A record points to the server's public IP, and that ports 80 and 443 are open in your security group / firewall.

**"Entity already exists" during onboarding** — This is normal if the gateway was previously issued. Just proceed to the location step.
