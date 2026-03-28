"""
Helium Gateway Monitor — Dashboard & Email Notifications
Polls the helium-multi-gateway API, tracks status changes,
and sends email alerts via AWS SES.
"""

import asyncio
import json
import logging
import os
import re
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import boto3
import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from botocore.exceptions import ClientError
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
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
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(email, mac)
        );
        CREATE TABLE IF NOT EXISTS status_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mac TEXT NOT NULL,
            status TEXT NOT NULL,
            timestamp TEXT DEFAULT (datetime('now'))
        );
    """)
    # Migrate: add new columns if upgrading from older schema
    try:
        conn.execute("ALTER TABLE gateways ADD COLUMN friendly_name TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE gateways ADD COLUMN connected_seconds REAL DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE gateways ADD COLUMN last_uplink_seconds_ago REAL DEFAULT -1")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE gateways ADD COLUMN uplinks INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE gateways ADD COLUMN downlinks INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass
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
        # Match lines like: metric_name{mac="AABB..."} 1234
        m = re.match(r'(\w+)\{.*?mac="(\w+)".*?\}\s+([\d.]+)', line)
        if m:
            metric_name, mac, value = m.group(1), m.group(2), m.group(3)
            if mac not in metrics:
                metrics[mac] = {}
            metrics[mac][metric_name] = float(value)
    return metrics


# ---------------------------------------------------------------------------
# AWS SES email sender
# ---------------------------------------------------------------------------
def send_email(to_email: str, subject: str, body_html: str):
    """Send an email via AWS SES. Fails silently with a log warning."""
    try:
        ses = boto3.client("ses", region_name=SES_REGION)
        ses.send_email(
            Source=SES_FROM_EMAIL,
            Destination={"ToAddresses": [to_email]},
            Message={
                "Subject": {"Data": subject, "Charset": "UTF-8"},
                "Body": {"Html": {"Data": body_html, "Charset": "UTF-8"}},
            },
        )
        logger.info(f"Email sent to {to_email}: {subject}")
    except ClientError as e:
        logger.warning(f"SES send failed for {to_email}: {e}")
    except Exception as e:
        logger.warning(f"Email send error for {to_email}: {e}")


def build_notification_email(gateway_name: str, mac: str, new_status: str) -> tuple[str, str]:
    """Return (subject, html_body) for a status change notification."""
    status_color = "#22C55E" if new_status == "online" else "#EF4444"
    status_label = "Online" if new_status == "online" else "Offline"
    display_name = gateway_name if gateway_name else mac

    subject = f"Gateway {display_name} is now {status_label}"

    html = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background:#F1F5F9;font-family:'Poppins',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:40px 0;">
        <tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,0.08);">
            <tr><td style="background:#1E293B;padding:24px 32px;">
              <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">SatTrack Gateway Monitor</h1>
            </td></tr>
            <tr><td style="padding:32px;">
              <div style="text-align:center;margin-bottom:24px;">
                <span style="display:inline-block;background:{status_color};color:#fff;font-size:14px;font-weight:600;padding:8px 20px;border-radius:20px;">
                  {status_label.upper()}
                </span>
              </div>
              <p style="color:#1E293B;font-size:16px;margin:0 0 8px 0;"><strong>{display_name}</strong></p>
              <p style="color:#64748B;font-size:14px;margin:0 0 4px 0;">MAC: {mac}</p>
              <p style="color:#64748B;font-size:14px;margin:0 0 24px 0;">Time: {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")}</p>
              <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;">
              <p style="color:#94A3B8;font-size:12px;margin:0;">You're receiving this because you subscribed to gateway alerts on SatTrack Gateway Monitor.</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
    """
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

            # Also fetch Prometheus metrics for uplink/downlink counts
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

        # Get uplink/downlink from Prometheus metrics
        gw_metrics = prom_metrics.get(mac, {})
        uplinks = int(gw_metrics.get("helium_multi_gateway_uplinks_total",
                      gw_metrics.get("uplinks_total",
                      gw_metrics.get("uplinks", 0))))
        downlinks = int(gw_metrics.get("helium_multi_gateway_downlinks_total",
                        gw_metrics.get("downlinks_total",
                        gw_metrics.get("downlinks", 0))))

        existing = conn.execute("SELECT * FROM gateways WHERE mac = ?", (mac,)).fetchone()

        if existing is None:
            # New gateway — insert and log
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

            # Status changed — log and notify
            if old_connected != connected:
                new_status = "online" if connected else "offline"
                conn.execute("INSERT INTO status_log (mac, status) VALUES (?, ?)", (mac, new_status))
                logger.info(f"Gateway {mac} status changed to {new_status}")

                gateway_name = existing["friendly_name"] or existing["public_key"] or ""
                notify_field = "notify_online" if connected else "notify_offline"

                subscribers = conn.execute(
                    f"SELECT email FROM subscribers WHERE (mac = ? OR mac = '__ALL__') AND {notify_field} = 1",
                    (mac,),
                ).fetchall()

                for sub in subscribers:
                    subject, html = build_notification_email(gateway_name, mac, new_status)
                    send_email(sub["email"], subject, html)

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
    scheduler.start()
    # Run an initial poll on startup
    await poll_gateways()
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
    return templates.TemplateResponse("index.html", {"request": request, "region": REGION})


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


@app.post("/api/gateways/{mac}/friendly-name")
async def api_set_friendly_name(mac: str, request: Request):
    body = await request.json()
    name = body.get("friendly_name", "").strip()
    conn = get_db()
    conn.execute("UPDATE gateways SET friendly_name = ? WHERE mac = ?", (name, mac))
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})


@app.get("/api/subscribers")
async def api_subscribers():
    conn = get_db()
    rows = conn.execute("SELECT * FROM subscribers ORDER BY created_at DESC").fetchall()
    result = [dict(r) for r in rows]
    conn.close()
    return JSONResponse(result)


@app.post("/api/subscribers")
async def api_add_subscriber(request: Request):
    body = await request.json()
    email = body.get("email", "").strip().lower()
    mac = body.get("mac", "__ALL__").strip()
    notify_online = 1 if body.get("notify_online", True) else 0
    notify_offline = 1 if body.get("notify_offline", True) else 0

    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email address")

    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO subscribers (email, mac, notify_online, notify_offline) VALUES (?, ?, ?, ?)",
            (email, mac, notify_online, notify_offline),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.execute(
            "UPDATE subscribers SET notify_online=?, notify_offline=? WHERE email=? AND mac=?",
            (notify_online, notify_offline, email, mac),
        )
        conn.commit()
    conn.close()
    return JSONResponse({"ok": True})


@app.delete("/api/subscribers/{sub_id}")
async def api_delete_subscriber(sub_id: int):
    conn = get_db()
    conn.execute("DELETE FROM subscribers WHERE id = ?", (sub_id,))
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=APP_HOST, port=APP_PORT, reload=False)
