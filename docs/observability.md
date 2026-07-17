# Observabilidade & Telemetria da Frota

Como o NetProspect recolhe telemetria de **toda** a frota (workers, VMs, hosts Proxmox, PBS/PDM) e a
liga à stack de observabilidade (Prometheus → Grafana/Alertmanager → ntfy). Complementa
[[fleet-autodeploy]] (deploy) e [[servers-page-telemetry]] (página Servidores).

## 1. Panorama

```
  Agentes (por host)                    Dashboard (np-server)              Stack de obs (hel1-pve)
  ┌────────────────────┐   POST /api/    ┌──────────────────┐   scrape     ┌────────────────────┐
  │ pull-deploy.sh      │   fleet/metrics │ Redis partilhado │◄── /metrics ─┤ hel1-prometheus     │
  │ metrics-report.sh   │────────────────►│ (np:host:*,      │              │  + regras de alerta │
  │ proxmox-report.sh   │                 │  np:wk:*, np:job)│              └─────────┬──────────┘
  │ pbs-report.sh       │                 └────────┬─────────┘                        │
  │ (metrics-lib.sh)    │                          │ /api/workers, /api/queues        ▼
  └────────────────────┘                          ▼                          hel1-grafana (dashboards)
                                          Página Servidores/VMs/Workers       hel1-alertmanager → ntfy
```

- **Recolha**: cada host corre um agente (~5 min) que reúne `/proc` + serviços systemd + containers
  Docker + (Proxmox) LXC/VMs/storage/ZFS + (PBS) datastores, e faz **POST** ao dashboard.
- **Estado**: o dashboard grava tudo no **Redis partilhado do np-server** (`redis://100.114.17.74:6379`).
- **Visão interna**: a página **Servidores/VMs/Workers** lê o Redis (`/api/workers`).
- **Visão externa**: o dashboard expõe **`GET /metrics`** (Prometheus) que o **hel1-prometheus** faz
  scrape → **Grafana** visualiza, **Alertmanager** alerta, **ntfy** notifica.

## 2. Agentes (recolha)

Tudo em `deploy/agent/`. A recolha vive na lib partilhada **`metrics-lib.sh`** (sourceada pelos vários
reporters), com um hook `extra_units_json` para telemetria específica.

| Reporter | Onde corre | Como | Reporta |
|---|---|---|---|
| `pull-deploy.sh` (passo 4) | hosts com repo+docker (hel1, de1, oracle, np-server, de-minio, de-analytics) | systemd/user timer | host + serviços + containers Docker |
| `metrics-report.sh` | infra sem repo (np-db, de1-pdm) | systemd timer (root) | host + serviços |
| `proxmox-report.sh` | hel1-pve, de1-pve (user **npmetrics**, não-root) | systemd timer | host + serviços + **LXC + VMs + storage + ZFS** |
| `pbs-report.sh` | de1-pbs (dentro do LXC) | systemd timer (root) | host + serviços + **datastores** |

**Recolha comum** (`metrics-lib.sh` `collect_and_post`): 2 amostras de `/proc` (~1 s) → CPU% real,
rede/IO (MB/s), RAM (`MemAvailable`), disco (`df /`), load, uptime; latências (curl ao Directus, `/dev/tcp`
ao Postgres, curl ao MinIO); **containers** (`docker ps/stats/logs` → cpu/mem/rede/blkIO + tail de logs em
base64) e **serviços systemd** (`systemctl show` cgroup RAM/CPU + `journalctl` tail). Cada "unidade" tem um
`kind`: `container|service|lxc|vm|storage|zfs|datastore`.

**Proxmox (least-privilege)**: o PVE não traz `sudo`. Um oneshot **ROOT** `np-pve-units.service` corre
`np-pve-collect` (só `pvesh get` — LXC/VMs/storage/ZFS/snapshots) e escreve `/run/np-pve-units.json`; o
reporter **não-root** (`npmetrics`, no grupo `systemd-journal`) lê esse ficheiro. Ver a topologia e as
exceções em [[fleet-autodeploy]].

### Onboarding de um host novo

- **Com repo + docker**: `agent.env` com `METRICS_ENABLED=1` + `DIRECTUS_PING_URL/PG_HOST/...` → o
  `pull-deploy.sh` já reporta.
- **Infra sem repo** (LXC/CT): copiar `metrics-lib.sh` + `metrics-report.sh` (ou `pbs-report.sh`), criar
  `/etc/netprospect-metrics.env`, instalar `netprospect-metrics.{service,timer}`. Para guests num Proxmox
  sem SSH direto (ACL): `pct push` + `pct exec` a partir do nó pve.
- **Nó Proxmox**: criar user `npmetrics`, `/opt/np/{metrics-lib,proxmox-report}.sh`,
  `/usr/local/bin/np-pve-collect`, `np-pve-units.{service,timer}` (root) + `netprospect-pve-metrics.{service,timer}`
  (npmetrics), pôr `npmetrics` no grupo `systemd-journal`.

## 3. Esquema no Redis

| Chave | Tipo | Conteúdo | TTL |
|---|---|---|---|
| `np:host:index` | ZSET | hosts que reportam métricas (score=último report) | — |
| `np:host:<h>:metrics` | HASH | cpu/load/cores/mem_*/disk_*/io_*/net_*/lat_*/uptime/reported | 15 min |
| `np:host:<h>:containers` | STRING(JSON) | unidades (containers+serviços+lxc+vm+storage+zfs+datastore) | 15 min |
| `np:host:<h>:done:<hora>` / `:dday:<dia>` / `:dur` | counters/list | throughput + duração por host | 26 h / 32 d |
| `np:wk:<id>` / `np:wk:index` | HASH/ZSET | heartbeat, role, conc, logs do worker | 26 h |
| `np:job:<consumer>:*` | counters/list | throughput + duração por tipo de job | 26 h / 32 d |

## 4. Endpoint Prometheus (`/metrics`)

`dashboard/server.mjs` → `GET /metrics` (formato Prometheus, fonte Redis, sem NATS). Métricas expostas:

- `np_up`, `np_workers_up`
- `np_host_cpu_percent`, `np_host_mem_used_bytes`, `np_host_mem_total_bytes`,
  `np_host_disk_used_bytes`, `np_host_disk_total_bytes`, `np_host_load1`, `np_host_cores`,
  `np_host_net_rx_mbps`, `np_host_net_tx_mbps`, `np_host_io_read_mbps`, `np_host_io_write_mbps`,
  `np_host_latency_ms{target=directus|postgres|minio}`, `np_host_uptime_seconds`,
  `np_host_metrics_age_seconds`, `np_host_workers`, `np_host_jobs_done_1h`,
  `np_host_units{kind=...}` — todas com labels `host` e `dc`.

**Scrape** (no `hel1-prometheus`, `/etc/prometheus/prometheus.yml`):

```yaml
  - job_name: 'netprospect'
    metrics_path: /metrics
    scrape_interval: 30s
    static_configs:
      - targets: ['100.114.17.74:3001']
        labels: { service: 'netprospect' }
```

## 5. Alertas

`deploy/observability/netprospect.rules.yml` → instalado em `/etc/prometheus/rules/netprospect.yml`
(o `rule_files` já é `/etc/prometheus/rules/*.yml`). Encaminhados pelo **Alertmanager** (CT 203) →
receivers default/warning/critical. Alertas: `NetProspectDashboardDown`, `NetProspectNoWorkers`,
`NetProspectHostMetricsStale`, `NetProspectHostHighCPU/HighMem/DiskFull`, `NetProspectHighDirectusLatency`,
`NetProspectHostOverloaded`.

## 6. Grafana

Dashboard em `deploy/observability/grafana-netprospect.json` (datasource Prometheus). Importar em
`hel1-grafana` (Import → cola o JSON) ou provisionar por ficheiro em
`/etc/grafana/provisioning/dashboards/`. Painéis: CPU/RAM/disco por host, latências, throughput (jobs/h),
workers vivos, unidades por tipo.

## 7. Tracing (OpenTelemetry) — LIVE

- **Colector**: `jaeger` (jaegertracing/all-in-one) em `deploy/server/docker-compose.yml` (np-server) —
  recebe OTLP (`:4317`/`:4318`, internos à rede compose) e serve a UI em `:16686` (menu **Observabilidade
  → OpenTelemetry**).
- **Instrumentação do dashboard**: `dashboard/tracing.mjs` (`@opentelemetry/sdk-node` +
  `auto-instrumentations-node` → HTTP/Express/Redis/PG/NATS), carregado via `node --import ./tracing.mjs`
  no Dockerfile. Exporta OTLP para `http://jaeger:4318`. **Fail-soft** (se as libs/colector falharem o
  dashboard corre na mesma) e `OTEL_ENABLED=0` desliga. Service name `netprospect-dashboard`.
- **Por fazer**: instrumentar os **workers** (mesmo padrão, `worker/worker.mjs`) e ligar um datasource
  Tempo/Jaeger ao Grafana (a UI do Jaeger já serve os traces).

## 8. Menus & acessos rápidos

O menu do dashboard tem os submenus **Observabilidade** (AlertManager, Prometheus, Grafana,
OpenTelemetry/Jaeger, UptimeKuma, Ntfy, PostHog) e **Data** (Directus, MinIO, **Adminer**) — abrem em
nova aba (URLs tailnet). O **Adminer** (`deploy/server/docker-compose.yml`, `:8080`) liga ao PostgreSQL do
np-db (`ADMINER_DEFAULT_SERVER`) para gestão manual da DB (login com as credenciais PG).

## 9. Estado & próximos passos

**Live**: recolha em todos os hosts; `/metrics` scraped; 8 alertas → Alertmanager; dashboard Grafana
provisionado; **tracing do dashboard → Jaeger**; menus de acesso + Adminer.

**Por fazer**: instrumentar os **workers** (OTel); **uptime-kuma** (monitores HTTP a `/api/config`,
`/metrics`, Directus, MinIO); confirmar o **receiver ntfy** no Alertmanager (CT 203); **datasource
Prometheus/Tempo** provisionado por ficheiro no Grafana; **PDM** e Oracle/GCP por API.
