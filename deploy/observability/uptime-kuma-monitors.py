#!/usr/bin/env python3
"""NetProspect — cria os monitores no uptime-kuma (v2) + notificação ntfy, via socket.io direto.

O uptime-kuma NÃO tem REST API (só socket.io autenticado). A lib `uptime-kuma-api` só suporta v1; o nosso
servidor é **v2** → falamos socket.io diretamente (python-socketio). Corre com as credenciais do admin (gpedro):

    pip install "python-socketio[client]"
    KUMA_URL=http://100.76.94.112:3001 KUMA_USER=gpedro KUMA_PASS=... python3 uptime-kuma-monitors.py

Idempotente: salta monitores/notificação com o mesmo nome. Ver docs/observability.md.
"""
import os
import sys
import time

try:
    import socketio
except ImportError:
    sys.exit('falta a lib: pip install "python-socketio[client]"')

URL = os.environ.get("KUMA_URL", "http://100.76.94.112:3001")
USER = os.environ.get("KUMA_USER", "gpedro")
PASS = os.environ.get("KUMA_PASS")
if not PASS:
    sys.exit("define KUMA_PASS no ambiente")
NTFY_URL = os.environ.get("NTFY_URL", "http://100.118.244.35")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "netprospect-alerts")
NOTIF_NAME = "ntfy-netprospect-alerts"

# (nome, tipo, alvo). "http" → url; "port" → (hostname, porta).
MONITORS = [
    # --- App / control-plane (np-server) ---
    ("NP Dashboard", "http", "http://100.114.17.74:3001/api/config"),
    ("NP /metrics", "http", "http://100.114.17.74:3001/metrics"),
    ("Directus", "http", "http://100.114.17.74:8056/server/ping"),
    ("NATS", "port", ("100.114.17.74", 4222)),
    ("Redis", "port", ("100.114.17.74", 6379)),
    ("Jaeger UI", "http", "http://100.114.17.74:16686/"),
    ("Adminer", "http", "http://100.114.17.74:8080/"),
    # --- Dados ---
    ("PostgreSQL (np-db)", "port", ("100.77.60.44", 5432)),
    ("MinIO", "http", "http://100.124.43.117:9000/minio/health/live"),
    ("ClickHouse", "http", "http://100.120.43.49:8123/ping"),          # hel1-analytics (migrado de de-analytics)
    ("Ollama", "http", "http://100.126.196.112:11434/"),
    # --- Exporters Prometheus (C5, np-server) ---
    ("NATS exporter", "http", "http://100.114.17.74:7777/metrics"),
    ("Redis exporter", "http", "http://100.114.17.74:9121/metrics"),
    ("Postgres exporter", "http", "http://100.114.17.74:9187/metrics"),
    # --- Stack de observabilidade ---
    ("Prometheus", "http", "http://100.125.24.44:9090/-/healthy"),
    ("Grafana", "http", "http://100.68.203.121:3000/api/health"),
    ("Alertmanager", "http", "http://100.96.102.84:9093/-/healthy"),
    ("ntfy", "http", "http://100.118.244.35/v1/health"),
    # --- Infra ---
    ("PBS de1", "http", "https://100.65.117.95:8007/"),
]

state = {"monitors": {}, "notifications": []}
sio = socketio.Client(reconnection=False)


@sio.on("monitorList")
def _ml(data):
    state["monitors"] = data or {}


@sio.on("notificationList")
def _nl(data):
    state["notifications"] = data or []


sio.connect(URL, wait_timeout=15)
time.sleep(1)  # deixa o handshake assentar antes do login (evita timeout do ack)
res = None
for attempt in range(3):
    try:
        res = sio.call("login", {"username": USER, "password": PASS, "token": ""}, timeout=25)
        break
    except socketio.exceptions.TimeoutError:
        print(f"login timeout (tentativa {attempt + 1}/3) — a repetir")
        time.sleep(2)
if not (isinstance(res, dict) and res.get("ok")):
    sys.exit(f"login falhou: {res}")
time.sleep(3)  # o servidor empurra monitorList/notificationList após o login

# --- notificação ntfy (criar se não existir; ligar aos monitores) ---
notif_id = next((n.get("id") for n in state["notifications"] if n.get("name") == NOTIF_NAME), None)
if notif_id is None:
    notif = {
        "name": NOTIF_NAME, "type": "ntfy", "isDefault": True, "applyExisting": True,
        "ntfyserverurl": NTFY_URL, "ntfytopic": NTFY_TOPIC, "ntfyPriority": 5,
        "ntfyAuthenticationMethod": "none",
    }
    # v2: addNotification(notification, notificationID, callback) → 2 args ⇒ passar como tuplo
    r = sio.call("addNotification", (notif, None), timeout=25)
    notif_id = r.get("id") if isinstance(r, dict) else None
    print(f"+ notificação ntfy '{NOTIF_NAME}' (id {notif_id}): {str(r)[:120]}")
else:
    print(f"notificação '{NOTIF_NAME}' já existe (id {notif_id})")

# --- monitores ---
existing = {m.get("name") for m in state["monitors"].values()}
notif_list = {notif_id: True} if notif_id is not None else {}
created = skipped = failed = 0
for name, mtype, target in MONITORS:
    if name in existing:
        skipped += 1
        continue
    mon = {
        "type": mtype, "name": name, "interval": 60, "retryInterval": 60, "resendInterval": 0,
        "maxretries": 2, "timeout": 48, "maxredirects": 10, "upsideDown": False,
        "accepted_statuscodes": ["200-299"], "conditions": [], "notificationIDList": notif_list,
    }
    if mtype == "http":
        mon.update(url=target, method="GET", ignoreTls=True, expiryNotification=False)
    else:
        mon.update(hostname=target[0], port=target[1])
    r = sio.call("add", mon, timeout=20)
    if isinstance(r, dict) and r.get("ok"):
        created += 1
        print(f"+ {name}")
    else:
        failed += 1
        print(f"x {name}: {str(r)[:200]}")
sio.disconnect()
print(f"criados {created}, saltados {skipped}, falhados {failed}")
