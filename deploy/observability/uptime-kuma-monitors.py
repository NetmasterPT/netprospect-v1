#!/usr/bin/env python3
"""NetProspect — cria os monitores no uptime-kuma (hel1-uptimekuma) para os endpoints-chave da stack.

O uptime-kuma NÃO tem REST API para gerir monitores (só socket.io autenticado), por isso este script usa
a lib `uptime-kuma-api`. Corre-o com as TUAS credenciais (o agente não as tem):

    pip install uptime-kuma-api
    KUMA_URL=http://100.76.94.112:3001 KUMA_USER=admin KUMA_PASS=... python3 uptime-kuma-monitors.py

Idempotente: salta monitores com o mesmo nome. Ver docs/observability.md.
"""
import os
import sys

try:
    from uptime_kuma_api import UptimeKumaApi, MonitorType
except ImportError:
    sys.exit("falta a lib: pip install uptime-kuma-api")

URL = os.environ.get("KUMA_URL", "http://100.76.94.112:3001")
USER = os.environ.get("KUMA_USER")
PASS = os.environ.get("KUMA_PASS")
if not (USER and PASS):
    sys.exit("define KUMA_USER e KUMA_PASS no ambiente")

# (nome, tipo, alvo). HTTP → url; PORT → hostname+porta.
HTTP = MonitorType.HTTP
PORT = MonitorType.PORT
MONITORS = [
    ("NP Dashboard", HTTP, "http://100.114.17.74:3001/api/config"),
    ("NP /metrics", HTTP, "http://100.114.17.74:3001/metrics"),
    ("Directus", HTTP, "http://100.114.17.74:8056/server/ping"),
    ("MinIO", HTTP, "http://100.124.43.117:9000/minio/health/live"),
    ("Jaeger UI", HTTP, "http://100.114.17.74:16686/"),
    ("Adminer", HTTP, "http://100.114.17.74:8080/"),
    ("Prometheus", HTTP, "http://100.125.24.44:9090/-/healthy"),
    ("Grafana", HTTP, "http://100.68.203.121:3000/api/health"),
    ("Alertmanager", HTTP, "http://100.96.102.84:9093/-/healthy"),
    ("ntfy", HTTP, "http://100.118.244.35/v1/health"),
    ("PostgreSQL (np-db)", PORT, ("100.77.60.44", 5432)),
    ("NATS", PORT, ("100.114.17.74", 4222)),
    ("Redis", PORT, ("100.114.17.74", 6379)),
    ("PBS de1", HTTP, "https://100.65.117.95:8007/"),
]

api = UptimeKumaApi(URL)
api.login(USER, PASS)
existing = {m["name"] for m in api.get_monitors()}
created = skipped = 0
for name, mtype, target in MONITORS:
    if name in existing:
        skipped += 1
        continue
    kw = dict(type=mtype, name=name, interval=60, retryInterval=60, maxretries=2)
    if mtype == HTTP:
        kw.update(url=target, ignoreTls=True, expiryNotification=False)
    else:
        kw.update(hostname=target[0], port=target[1])
    api.add_monitor(**kw)
    created += 1
    print(f"+ {name}")
api.disconnect()
print(f"criados {created}, saltados {skipped} (já existiam)")
