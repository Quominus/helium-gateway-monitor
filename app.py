"""
Helium Gateway Monitor — Dashboard & Email Notifications
Polls the helium-multi-gateway API, tracks status changes,
and sends email alerts via AWS SES.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import boto3
import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from botocore.exceptions import ClientError
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

# ---------------------------------------------------------------------------
# Configuration (override via environment variables)
# ---------------------------------------------------------------------------
MULTI_GW_API = os.getenv("MULTI_GW_API", "http://127.0.0.1:4468")
MULTI_GW_READ_KEY = os.getenv("MULTI_GW_READ_KEY", "")
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "30"))
DB_PATH = os.getenv("DB_PATH", "/var/lib/helium-gateway-monitor/monitor.db")
SES_REGION = os.getenv("SES_REGION", "eu-west-2")
SES_FROM_EMAIL = os.getenv("SES_FROM_EMAIL", "alerts@sattrack.co.uk")
REGION = os.getenv("LORAWAN_REGION", "EU868")
APP_HOST = os.getenv("APP_HOST", "0.0.0.0")
APP_PORT = int(os.getenv("APP_PORT", "8080"))
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "hello@sattrack.co.uk")
BASE_URL = os.getenv("BASE_URL", "https://gateway.sattrack.co.uk")
NOTIFICATION_CHECK_SECONDS = int(os.getenv("NOTIFICATION_CHECK_SECONDS", "3600"))  # 1 hour
NOTIFICATION_COOLDOWN_HOURS = int(os.getenv("NOTIFICATION_COOLDOWN_HOURS", "24"))  # 1 email/day/gw
ONBOARD_API = os.getenv("ONBOARD_API", "http://127.0.0.1:3001")
SOLANA_RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

logger = logging.getLogger("gateway-monitor")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def get_db() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS gateways (
            mac TEXT PRIMARY KEY,
            friendly_name TEXT DEFAULT '',
            public_key TEXT DEFAULT '',
            connected INTEGER DEFAULT 0,
            connected_seconds REAL DEFAULT 0,
            last_uplink_seconds_ago REAL DEFAULT -1,
            uplinks INTEGER DEFAULT 0,
            downlinks INTEGER DEFAULT 0,
            last_seen TEXT DEFAULT '',
            first_seen TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS subscribers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            mac TEXT DEFAULT '__ALL__',
            notify_online INTEGER DEFAULT 1,
            notify_offline INTEGER DEFAULT 1,
            unsubscribe_token TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(email, mac)
        );
        CREATE TABLE IF NOT EXISTS status_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mac TEXT NOT NULL,
            status TEXT NOT NULL,
            timestamp TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS notification_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            mac TEXT NOT NULL,
            status TEXT NOT NULL,
            sent_at TEXT DEFAULT (datetime('now'))
        );
    """)
    # Migrate: add new columns if upgrading from older schema
    for col, typedef in [
        ("friendly_name", "TEXT DEFAULT ''"),
        ("connected_seconds", "REAL DEFAULT 0"),
        ("last_uplink_seconds_ago", "REAL DEFAULT -1"),
        ("uplinks", "INTEGER DEFAULT 0"),
        ("downlinks", "INTEGER DEFAULT 0"),
    ]:
        try:
            conn.execute(f"ALTER TABLE gateways ADD COLUMN {col} {typedef}")
        except sqlite3.OperationalError:
            pass
    # Migrate subscribers: add unsubscribe_token
    try:
        conn.execute("ALTER TABLE subscribers ADD COLUMN unsubscribe_token TEXT NOT NULL DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    # Backfill any empty tokens
    rows = conn.execute("SELECT id FROM subscribers WHERE unsubscribe_token = ''").fetchall()
    for row in rows:
        conn.execute("UPDATE subscribers SET unsubscribe_token = ? WHERE id = ?",
                     (secrets.token_urlsafe(32), row["id"]))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Prometheus metrics parser
# ---------------------------------------------------------------------------
def parse_prometheus_metrics(text: str) -> dict:
    """Parse Prometheus text format into per-gateway uplink/downlink counts."""
    metrics = {}
    for line in text.strip().split("\n"):
        if line.startswith("#") or not line.strip():
            continue
        m = re.match(r'(\w+)\{.*?mac="(\w+)".*?\}\s+([\d.]+)', line)
        if m:
            metric_name, mac, value = m.group(1), m.group(2), m.group(3)
            if mac not in metrics:
                metrics[mac] = {}
            metrics[mac][metric_name] = float(value)
    return metrics


# ---------------------------------------------------------------------------
# SatTrack branded email wrapper
# ---------------------------------------------------------------------------
def sattrack_email_wrapper(content_html: str, footer_extra: str = "") -> str:
    """Wrap content in the standard SatTrack email template."""
    year = datetime.now().year
    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;font-family:'Helvetica Neue',Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F1F5F9;padding:30px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,0.08);">
          <!-- Header -->
          <tr>
            <td align="center" style="background-color:#ffffff;padding:32px 40px 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;">
                <tr>
                  <td align="center">
                    <img src="cid:sattrack-logo" alt="SatTrack" width="220" height="66" style="width:220px;height:auto;max-width:220px;" />
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-top:6px;">
                    <p style="margin:0;color:#64748B;font-size:13px;">Gateway Monitor</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Accent stripe -->
          <tr>
            <td style="background-color:#E22936;height:4px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              {content_html}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#F8FAFC;padding:24px 40px;text-align:center;border-top:1px solid #E2E8F0;">
              {footer_extra}
              <p style="color:#94A3B8;font-size:12px;margin:0;">
                Copyright &copy; {year} Quominus Limited (trading as <strong>sattrack.co.uk</strong>). All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


# ---------------------------------------------------------------------------
# AWS SES email sender
# ---------------------------------------------------------------------------
_logo_data: bytes | None = None

def _get_logo_data() -> bytes:
    """Read and cache the SatTrack logo PNG for CID embedding."""
    global _logo_data
    if _logo_data is None:
        logo_path = Path(__file__).parent / "logo-transparent.png"
        _logo_data = logo_path.read_bytes()
    return _logo_data


def send_email(to_email: str, subject: str, body_html: str):
    """Send an email via AWS SES with CID-embedded logo. Fails silently with a log warning."""
    try:
        # Build multipart/related MIME message so the logo renders inline
        msg = MIMEMultipart("related")
        msg["Subject"] = subject
        msg["From"] = SES_FROM_EMAIL
        msg["To"] = to_email

        # HTML body
        msg_html = MIMEText(body_html, "html", "utf-8")
        msg.attach(msg_html)

        # Inline logo attachment
        logo_data = _get_logo_data()
        logo_img = MIMEImage(logo_data, _subtype="png")
        logo_img.add_header("Content-ID", "<sattrack-logo>")
        logo_img.add_header("Content-Disposition", "inline", filename="logo.png")
        msg.attach(logo_img)

        ses = boto3.client("ses", region_name=SES_REGION)
        ses.send_raw_email(
            Source=SES_FROM_EMAIL,
            Destinations=[to_email],
            RawMessage={"Data": msg.as_string()},
        )
        logger.info(f"Email sent to {to_email}: {subject}")
    except ClientError as e:
        logger.warning(f"SES send failed for {to_email}: {e}")
    except Exception as e:
        logger.warning(f"Email send error for {to_email}: {e}")


def send_confirmation_email(email: str, gateway_name: str, mac: str, unsubscribe_token: str):
    """Send a subscription confirmation email."""
    display_name = gateway_name or mac
    unsub_url = f"{BASE_URL}/unsubscribe/{unsubscribe_token}"

    content = f"""
    <h2 style="color:#1E293B;margin:0 0 16px;font-size:22px;font-weight:700;">Subscription Confirmed</h2>
    <p style="color:#334155;font-size:15px;line-height:1.7;margin:0 0 24px;">
      You'll now receive email alerts when the following gateway changes status:
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F8FAFC;border-radius:8px;border:1px solid #E2E8F0;margin:0 0 24px;">
      <tr>
        <td style="padding:20px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td width="120" style="color:#1E293B;font-size:14px;font-weight:700;padding:0 0 10px;vertical-align:top;">Gateway</td>
              <td style="padding:0 0 10px;vertical-align:top;">
                <span style="color:#0F172A;font-size:14px;font-weight:600;">{display_name}</span>
              </td>
            </tr>
            <tr>
              <td width="120" style="color:#1E293B;font-size:14px;font-weight:700;padding:0;vertical-align:top;">MAC</td>
              <td style="padding:0;vertical-align:top;">
                <code style="background-color:#E2E8F0;padding:3px 10px;border-radius:4px;font-size:14px;color:#0F172A;font-weight:600;">{mac}</code>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <p style="color:#334155;font-size:15px;line-height:1.7;margin:0 0 28px;">
      You can view all gateway statuses at any time on the <a href="{BASE_URL}" style="color:#E22936;text-decoration:none;font-weight:600;">gateway dashboard</a>.
    </p>
    """

    footer = f"""
    <p style="color:#94A3B8;font-size:12px;margin:0 0 12px;">
      <a href="{unsub_url}" style="color:#94A3B8;text-decoration:underline;">Unsubscribe from this gateway's alerts</a>
    </p>
    """

    html = sattrack_email_wrapper(content, footer)
    send_email(email, f"Subscribed: {display_name} alerts", html)


def build_notification_email(gateway_name: str, mac: str, new_status: str,
                              unsubscribe_token: str = "") -> tuple[str, str]:
    """Return (subject, html_body) for a status change notification."""
    status_color = "#22C55E" if new_status == "online" else "#DC2626"
    status_label = "Online" if new_status == "online" else "Offline"
    status_icon = "&#x2705;" if new_status == "online" else "&#x26A0;&#xFE0F;"
    display_name = gateway_name if gateway_name else mac
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    subject = f"Gateway {display_name} is now {status_label}"

    content = f"""
    <div style="text-align:center;margin-bottom:28px;">
      <span style="display:inline-block;background:{status_color};color:#ffffff;font-size:14px;font-weight:700;padding:10px 28px;border-radius:24px;letter-spacing:0.5px;">
        {status_label.upper()}
      </span>
    </div>
    <h2 style="color:#1E293B;margin:0 0 8px;font-size:20px;font-weight:700;">{display_name}</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F8FAFC;border-radius:8px;border:1px solid #E2E8F0;margin:16px 0 24px;">
      <tr>
        <td style="padding:20px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td width="100" style="color:#64748B;font-size:14px;padding:0 0 8px;vertical-align:top;">Status</td>
              <td style="padding:0 0 8px;vertical-align:top;">
                <span style="color:{status_color};font-size:14px;font-weight:700;">{status_label}</span>
              </td>
            </tr>
            <tr>
              <td width="100" style="color:#64748B;font-size:14px;padding:0 0 8px;vertical-align:top;">MAC</td>
              <td style="padding:0 0 8px;vertical-align:top;">
                <code style="background-color:#E2E8F0;padding:3px 10px;border-radius:4px;font-size:13px;color:#0F172A;font-weight:600;">{mac}</code>
              </td>
            </tr>
            <tr>
              <td width="100" style="color:#64748B;font-size:14px;padding:0;vertical-align:top;">Time</td>
              <td style="padding:0;vertical-align:top;">
                <span style="color:#334155;font-size:14px;">{now_str}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
      <tr>
        <td style="background-color:#E22936;border-radius:8px;">
          <a href="{BASE_URL}" target="_blank" style="display:inline-block;padding:14px 36px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;letter-spacing:0.3px;">
            View Dashboard
          </a>
        </td>
      </tr>
    </table>
    """

    # Build footer with unsubscribe link if token provided
    footer = ""
    if unsubscribe_token:
        unsub_url = f"{BASE_URL}/unsubscribe/{unsubscribe_token}"
        footer = f"""
        <p style="color:#94A3B8;font-size:12px;margin:0 0 12px;">
          <a href="{unsub_url}" style="color:#94A3B8;text-decoration:underline;">Unsubscribe from this gateway's alerts</a>
        </p>
        """
    else:
        footer = """
        <p style="color:#94A3B8;font-size:12px;margin:0 0 12px;">
          You're receiving this as the SatTrack admin.
        </p>
        """

    html = sattrack_email_wrapper(content, footer)
    return subject, html


def build_new_gateway_email(gateway_name: str, mac: str) -> tuple[str, str]:
    """Return (subject, html_body) for a new gateway registration notification."""
    display_name = gateway_name if gateway_name else mac
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    subject = f"New Gateway Registered: {display_name}"

    content = f"""
    <div style="text-align:center;margin-bottom:28px;">
      <span style="display:inline-block;background:#3B82F6;color:#ffffff;font-size:14px;font-weight:700;padding:10px 28px;border-radius:24px;letter-spacing:0.5px;">
        NEW GATEWAY
      </span>
    </div>
    <h2 style="color:#1E293B;margin:0 0 8px;font-size:20px;font-weight:700;">New Gateway Registered</h2>
    <p style="color:#334155;font-size:15px;line-height:1.7;margin:0 0 16px;">
      A new LoRaWAN gateway has connected to the multi-gateway aggregator for the first time.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F8FAFC;border-radius:8px;border:1px solid #E2E8F0;margin:16px 0 24px;">
      <tr>
        <td style="padding:20px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td width="100" style="color:#64748B;font-size:14px;padding:0 0 8px;vertical-align:top;">Name</td>
              <td style="padding:0 0 8px;vertical-align:top;">
                <span style="color:#0F172A;font-size:14px;font-weight:600;">{display_name}</span>
              </td>
            </tr>
            <tr>
              <td width="100" style="color:#64748B;font-size:14px;padding:0 0 8px;vertical-align:top;">MAC</td>
              <td style="padding:0 0 8px;vertical-align:top;">
                <code style="background-color:#E2E8F0;padding:3px 10px;border-radius:4px;font-size:13px;color:#0F172A;font-weight:600;">{mac}</code>
              </td>
            </tr>
            <tr>
              <td width="100" style="color:#64748B;font-size:14px;padding:0;vertical-align:top;">Time</td>
              <td style="padding:0;vertical-align:top;">
                <span style="color:#334155;font-size:14px;">{now_str}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
      <tr>
        <td style="background-color:#E22936;border-radius:8px;">
          <a href="{BASE_URL}" target="_blank" style="display:inline-block;padding:14px 36px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;letter-spacing:0.3px;">
            View Dashboard
          </a>
        </td>
      </tr>
    </table>
    """

    footer = """
    <p style="color:#94A3B8;font-size:12px;margin:0 0 12px;">
      You're receiving this as the SatTrack admin.
    </p>
    """

    html = sattrack_email_wrapper(content, footer)
    return subject, html


# ---------------------------------------------------------------------------
# Gateway poller
# ---------------------------------------------------------------------------
async def poll_gateways():
    """Fetch gateway status from multi-gateway API, detect changes, notify."""
    headers = {}
    if MULTI_GW_READ_KEY:
        headers["X-API-Key"] = MULTI_GW_READ_KEY

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{MULTI_GW_API}/gateways", headers=headers, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            prom_metrics = {}
            try:
                metrics_resp = await client.get(f"{MULTI_GW_API}/metrics", headers=headers, timeout=10)
                if metrics_resp.status_code == 200:
                    prom_metrics = parse_prometheus_metrics(metrics_resp.text)
            except Exception as e:
                logger.debug(f"Could not fetch metrics: {e}")

    except Exception as e:
        logger.warning(f"Failed to poll multi-gateway API: {e}")
        return

    now = datetime.now(timezone.utc).isoformat()
    conn = get_db()

    for gw in data.get("gateways", []):
        mac = gw["mac"]
        connected = 1 if gw.get("connected", False) else 0
        public_key = gw.get("public_key", "")
        connected_seconds = gw.get("connected_seconds", 0) or 0
        last_uplink_seconds_ago = gw.get("last_uplink_seconds_ago", -1)
        if last_uplink_seconds_ago is None:
            last_uplink_seconds_ago = -1

        gw_metrics = prom_metrics.get(mac, {})
        uplinks = int(gw_metrics.get("packets_uplink_total",
                      gw_metrics.get("helium_multi_gateway_uplinks_total",
                      gw_metrics.get("uplinks_total",
                      gw_metrics.get("uplinks", 0)))))
        downlinks = int(gw_metrics.get("packets_downlink_total",
                        gw_metrics.get("helium_multi_gateway_downlinks_total",
                        gw_metrics.get("downlinks_total",
                        gw_metrics.get("downlinks", 0)))))

        existing = conn.execute("SELECT * FROM gateways WHERE mac = ?", (mac,)).fetchone()

        if existing is None:
            conn.execute(
                """INSERT INTO gateways
                   (mac, public_key, connected, connected_seconds, last_uplink_seconds_ago,
                    uplinks, downlinks, last_seen, first_seen)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (mac, public_key, connected, connected_seconds, last_uplink_seconds_ago,
                 uplinks, downlinks, now, now),
            )
            conn.execute("INSERT INTO status_log (mac, status) VALUES (?, ?)",
                         (mac, "online" if connected else "offline"))
            logger.info(f"New gateway discovered: {mac} (connected={connected})")

            # Notify admin of new gateway registration (always immediate)
            new_gw_subject, new_gw_html = build_new_gateway_email(public_key or mac, mac)
            send_email(ADMIN_EMAIL, new_gw_subject, new_gw_html)
        else:
            old_connected = existing["connected"]
            conn.execute(
                """UPDATE gateways SET
                   public_key=?, connected=?, connected_seconds=?, last_uplink_seconds_ago=?,
                   uplinks=?, downlinks=?, last_seen=?
                   WHERE mac=?""",
                (public_key, connected, connected_seconds, last_uplink_seconds_ago,
                 uplinks, downlinks, now, mac),
            )

            # Status changed — log it (emails handled by check_notifications)
            if old_connected != connected:
                new_status = "online" if connected else "offline"
                conn.execute("INSERT INTO status_log (mac, status) VALUES (?, ?)", (mac, new_status))
                logger.info(f"Gateway {mac} status changed to {new_status}")

    conn.commit()
    conn.close()


async def check_notifications():
    """
    Runs every NOTIFICATION_CHECK_SECONDS (default 1 hour).
    Looks at status_log for changes that haven't been notified yet, then sends
    at most ONE email per gateway per subscriber per 24 hours.
    """
    conn = get_db()
    now_utc = datetime.now(timezone.utc)
    cutoff = (now_utc - timedelta(hours=NOTIFICATION_COOLDOWN_HOURS)).isoformat()

    # Get the most recent status per gateway, comparing current DB state
    # to what we've already notified about (avoids missing events between checks)
    gateways_list = conn.execute("SELECT mac, connected FROM gateways").fetchall()

    latest_per_gw = {}
    for gw_row in gateways_list:
        mac = gw_row["mac"]
        current_status = "online" if gw_row["connected"] else "offline"

        # Check if we already notified about this exact status recently
        already_notified = conn.execute(
            """SELECT 1 FROM notification_log
               WHERE mac = ? AND status = ? AND sent_at > ?""",
            (mac, current_status, cutoff),
        ).fetchone()
        if not already_notified:
            # Also verify there's a status_log entry for this state
            has_log = conn.execute(
                "SELECT 1 FROM status_log WHERE mac = ? AND status = ? ORDER BY timestamp DESC LIMIT 1",
                (mac, current_status),
            ).fetchone()
            if has_log:
                latest_per_gw[mac] = current_status

    if not latest_per_gw:
        conn.close()
        return

    logger.info(f"Notification check: {len(latest_per_gw)} gateway(s) with unnotified status changes")

    for mac, new_status in latest_per_gw.items():
        gw = conn.execute("SELECT * FROM gateways WHERE mac = ?", (mac,)).fetchone()
        if not gw:
            continue

        gateway_name = gw["friendly_name"] or mac
        notify_field = "notify_online" if new_status == "online" else "notify_offline"

        # Get per-gateway subscribers
        subs = conn.execute(
            f"SELECT email, unsubscribe_token FROM subscribers WHERE mac = ? AND {notify_field} = 1",
            (mac,),
        ).fetchall()

        notified_emails = set()
        for sub in subs:
            # Check 24-hour cooldown for this email + gateway
            already_sent = conn.execute(
                "SELECT 1 FROM notification_log WHERE email = ? AND mac = ? AND sent_at > ?",
                (sub["email"], mac, cutoff),
            ).fetchone()
            if already_sent:
                logger.debug(f"Skipping {sub['email']} for {mac} — already notified in last {NOTIFICATION_COOLDOWN_HOURS}h")
                continue

            subject, html = build_notification_email(
                gateway_name, mac, new_status, sub["unsubscribe_token"])
            send_email(sub["email"], subject, html)
            conn.execute(
                "INSERT INTO notification_log (email, mac, status) VALUES (?, ?, ?)",
                (sub["email"], mac, new_status),
            )
            notified_emails.add(sub["email"])

        # Always send to admin (with cooldown too)
        if ADMIN_EMAIL not in notified_emails:
            already_sent = conn.execute(
                "SELECT 1 FROM notification_log WHERE email = ? AND mac = ? AND sent_at > ?",
                (ADMIN_EMAIL, mac, cutoff),
            ).fetchone()
            if not already_sent:
                subject, html = build_notification_email(gateway_name, mac, new_status)
                send_email(ADMIN_EMAIL, subject, html)
                conn.execute(
                    "INSERT INTO notification_log (email, mac, status) VALUES (?, ?, ?)",
                    (ADMIN_EMAIL, mac, new_status),
                )

    # Housekeeping: purge notification_log entries older than 48h
    purge_cutoff = (now_utc - timedelta(hours=48)).isoformat()
    conn.execute("DELETE FROM notification_log WHERE sent_at < ?", (purge_cutoff,))

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler.add_job(poll_gateways, "interval", seconds=POLL_INTERVAL_SECONDS, id="poll")
    scheduler.add_job(check_notifications, "interval", seconds=NOTIFICATION_CHECK_SECONDS, id="notify")
    scheduler.start()
    await poll_gateways()
    await check_notifications()
    yield
    scheduler.shutdown()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="SatTrack Gateway Monitor", lifespan=lifespan)

templates_dir = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(templates_dir))


# ---- Pages ----------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "region": REGION, "solana_rpc_url": SOLANA_RPC_URL})


@app.get("/unsubscribe/{token}", response_class=HTMLResponse)
async def unsubscribe_page(token: str, request: Request):
    """Handle unsubscribe link — remove subscriber and show confirmation."""
    conn = get_db()
    sub = conn.execute("SELECT * FROM subscribers WHERE unsubscribe_token = ?", (token,)).fetchone()

    if sub:
        conn.execute("DELETE FROM subscribers WHERE unsubscribe_token = ?", (token,))
        conn.commit()

        # Get gateway name for display
        gw = conn.execute("SELECT * FROM gateways WHERE mac = ?", (sub["mac"],)).fetchone()
        gateway_name = ""
        if gw:
            gateway_name = gw["friendly_name"] or sub["mac"]
        else:
            gateway_name = sub["mac"]

        conn.close()
        return templates.TemplateResponse("unsubscribed.html", {
            "request": request,
            "email": sub["email"],
            "gateway_name": gateway_name,
            "success": True,
        })
    else:
        conn.close()
        return templates.TemplateResponse("unsubscribed.html", {
            "request": request,
            "email": "",
            "gateway_name": "",
            "success": False,
        })


# ---- API ------------------------------------------------------------------
@app.get("/api/gateways")
async def api_gateways():
    conn = get_db()
    gateways = conn.execute(
        "SELECT * FROM gateways ORDER BY connected DESC, friendly_name, mac"
    ).fetchall()
    result = [dict(gw) for gw in gateways]
    conn.close()
    return JSONResponse(result)


@app.get("/api/gateways/{mac}/history")
async def api_gateway_history(mac: str):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM status_log WHERE mac = ? ORDER BY timestamp DESC LIMIT 50", (mac,)
    ).fetchall()
    result = [dict(r) for r in rows]
    conn.close()
    return JSONResponse(result)



@app.post("/api/subscribers")
async def api_add_subscriber(request: Request):
    body = await request.json()
    email = body.get("email", "").strip().lower()
    mac = body.get("mac", "").strip()
    notify_online = 1 if body.get("notify_online", True) else 0
    notify_offline = 1 if body.get("notify_offline", True) else 0

    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email address")

    if not mac or mac == "__ALL__":
        raise HTTPException(status_code=400, detail="Please select a specific gateway")

    unsubscribe_token = secrets.token_urlsafe(32)

    conn = get_db()

    # Check if already subscribed
    existing = conn.execute(
        "SELECT id FROM subscribers WHERE email = ? AND mac = ?", (email, mac)
    ).fetchone()

    if existing:
        conn.execute(
            "UPDATE subscribers SET notify_online=?, notify_offline=?, unsubscribe_token=? WHERE email=? AND mac=?",
            (notify_online, notify_offline, unsubscribe_token, email, mac),
        )
    else:
        conn.execute(
            "INSERT INTO subscribers (email, mac, notify_online, notify_offline, unsubscribe_token) VALUES (?, ?, ?, ?, ?)",
            (email, mac, notify_online, notify_offline, unsubscribe_token),
        )

    conn.commit()

    # Get gateway name for confirmation email
    gw = conn.execute("SELECT * FROM gateways WHERE mac = ?", (mac,)).fetchone()
    gateway_name = ""
    if gw:
        gateway_name = gw["friendly_name"] or mac

    conn.close()

    # Send confirmation email
    send_confirmation_email(email, gateway_name, mac, unsubscribe_token)

    return JSONResponse({"ok": True})


# ---- Onboarding proxy endpoints (proxied to Onboard service API) -------------
@app.post("/api/onchain")
async def api_onchain(request: Request):
    """Batch check on-chain status for gateway public keys."""
    body = await request.json()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{ONBOARD_API}/onchain",
                json=body,
                timeout=15,
            )
            return JSONResponse(resp.json(), status_code=resp.status_code)
    except Exception as e:
        logger.warning(f"Onboard service onchain proxy error: {e}")
        raise HTTPException(status_code=502, detail="Failed to reach onboard service")


@app.post("/api/gateways/{mac}/issue")
async def api_issue_gateway(mac: str, request: Request):
    """Proxy issue-entity transaction generation to Onboard service."""
    body = await request.json()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{ONBOARD_API}/gateways/{mac}/issue",
                json=body,
                timeout=30,
            )
            return JSONResponse(resp.json(), status_code=resp.status_code)
    except Exception as e:
        logger.warning(f"Onboard service issue proxy error for {mac}: {e}")
        raise HTTPException(status_code=502, detail="Failed to reach onboard service")


@app.post("/api/gateways/{mac}/onboard")
async def api_onboard_gateway(mac: str, request: Request):
    """Proxy onboard transaction generation to Onboard service."""
    body = await request.json()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{ONBOARD_API}/gateways/{mac}/onboard",
                json=body,
                timeout=30,
            )
            return JSONResponse(resp.json(), status_code=resp.status_code)
    except Exception as e:
        logger.warning(f"Onboard service onboard proxy error for {mac}: {e}")
        raise HTTPException(status_code=502, detail="Failed to reach onboard service")


@app.post("/api/gateways/{mac}/update-location")
async def api_update_location(mac: str, request: Request):
    """Proxy update-location (reassert) transaction to Onboard service."""
    body = await request.json()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{ONBOARD_API}/gateways/{mac}/update-location",
                json=body,
                timeout=30,
            )
            return JSONResponse(resp.json(), status_code=resp.status_code)
    except Exception as e:
        logger.warning(f"Onboard service update-location proxy error for {mac}: {e}")
        raise HTTPException(status_code=502, detail="Failed to reach onboard service")


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=APP_HOST, port=APP_PORT, reload=False)
