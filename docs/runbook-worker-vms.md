# Runbook — VMs de Workers (Docker + Tailscale)

Lança **workers da frota** em VMs que NÃO têm o stack central: juntam-se à **Tailnet**, drenam jobs do
**NATS central** e escrevem no **Postgres central** (via PgBouncer do CT `np-db`, ver `runbook-db-host.md`).
Alvos: **host Proxmox da Alemanha** (backup host, SSD/HDD, +recursos → workers `base`/pesados) e **VMs free
das clouds** (Oracle/GCP/AWS, pequenas, 1 IP cada → workers `verify`/`whois`).

> **Porquê esta forma:** os workers são **network-bound e baratos em CPU** (~1-2 cores); o que escala é
> **espalhá-los por muitos IPs** (fetch + verificação de email + WHOIS/RDAP, cada um limitado por IP). O
> gargalo (Postgres) fica no CT dedicado. Ver a distribuição de load no plano
> [postgres-scaling-and-whois-rdap.md](../.claude/plans/dev/postgres-scaling-and-whois-rdap.md).

```
  host Alemanha (Proxmox)              clouds free (1 IP cada)
  ┌── VM base ×N ───────┐             ┌── VM verify ──┐ ┌── VM verify ──┐ …
  │ enrich/contacts     │             │ email verify  │ │ email verify  │
  │ DIRECT_PG_WRITE→CT  │             │ quota/IP      │ │ + whois RDAP  │
  └─────────┬───────────┘             └───────┬───────┘ └───────┬───────┘
            └──────────── Tailnet ────────────┴─────────────────┘
                 NATS:4222 · PgBouncer:6432 · MinIO:9000 · Directus:8056 (do host central)
```

---

## 0. Papéis por host (planeamento)
| Host | Recursos | `WORKER_ROLES` | Notas |
|---|---|---|---|
| **Alemanha (Proxmox)** | +cores, SSD/HDD | `base` (2-4 réplicas) | enrich/contacts pela fila; escrita direta no CT. Disco lento é irrelevante (I/O vai p/ o CT/MinIO). Opcional: 1 VM `browser,security,ai` p/ auditorias pesadas (precisa ~2 GB + Chromium). |
| **Oracle free** (4 VM/conta: 2×Ampere A1, 2×AMD) | 1 OCPU / 1-6 GB | `verify` (Ampere: `verify,base`) | 1 IP = 1 quota free de verificação. Ampere (6 GB) aguenta `base` também. Servem de exit-nodes/proxies. |
| **GCP e2-micro / AWS t2/t3.micro** | 1 vCPU / 1 GB | `verify` | só verificação + `whois` (RDAP/port-43 distribuído por IP). NÃO `base` (1 GB é pouco p/ o contexto de crawl). |

**Segurança (crítico):** o NATS **não tem auth** → o host central expõe NATS/PgBouncer/MinIO/Redis
**APENAS na Tailnet** (`NATS_BIND=<ip-tailnet>` no `.env` central; PgBouncer `listen_addr` só tailnet +
ACLs). Nunca `0.0.0.0` público. As ACLs do Tailscale restringem `tag:worker → tag:db/tag:app`.

## 1. Provisionar o VM
- **Proxmox (Alemanha):** VM Debian 12, base = **2 vCPU / 3 GB / 12 GB disco**; verify = **1 vCPU / 1 GB**.
- **Cloud free:** imagem Debian/Ubuntu 12/22.04. Abrir só SSH de entrada (o resto sai pela Tailnet).

## 2. Docker + Compose (no VM)
```bash
apt update && apt -y install curl ca-certificates git
curl -fsSL https://get.docker.com | sh
# (opcional) correr sem root: usermod -aG docker $USER
```

## 3. Tailscale (juntar à Tailnet)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey tskey-... --hostname np-wk-$(hostname) --advertise-tags=tag:worker
# confirmar que alcança o host de DB:
tailscale ping np-db
```

## 4. Obter o código/imagem
**Opção A — clonar + build no VM** (simples, +lento; bom p/ poucos VMs):
```bash
git clone <repo-url> netprospect && cd netprospect
```
**Opção B — registry (escalável p/ muitos VMs):** build UMA vez no host central e push p/ GHCR/Docker Hub;
os VMs fazem `pull`. No host central:
```bash
docker build -f worker/Dockerfile.base -t ghcr.io/<org>/netprospect-worker-base:latest .
docker push ghcr.io/<org>/netprospect-worker-base:latest
```
No VM: usar `image: ghcr.io/<org>/netprospect-worker-base:latest` no `docker-compose.worker.yml`
(em vez do bloco `build:`) + `docker login ghcr.io`.

## 5. Config do worker (`.env.worker`)
```bash
cp docker/.env.worker.example docker/.env.worker
# editar: NATS_URL/DIRECTUS_URL/PG_WRITE_* com o IP TAILNET do host central/CT (tailscale ip -4 lá)
```
Preencher conforme o papel:
- **Todos:** `NATS_URL=nats://<host-central-tailnet>:4222`, `DIRECTUS_URL=http://<host-central-tailnet>:8056`,
  `DIRECTUS_TOKEN=<static token do .env central>`.
- **base:** `WORKER_ROLES=base`, `DIRECT_PG_WRITE=true`, `PG_WRITE_HOST=<np-db-tailnet>` `PG_WRITE_PORT=6432`
  `PG_WRITE_USER/PASSWORD/DB`, `MINIO_URL=http://<host-central-tailnet>:9000` (+creds), `ENRICH/CONTACTS_CONCURRENCY`.
- **verify:** `WORKER_ROLES=verify`, montar `config/verify-providers.json` (as keys free DESTE IP — gitignored,
  tem de existir antes do `up`). `DIRECT_PG_WRITE` fica `false` (verify escreve só `contacts.email_status`
  via Directus). Opcional `WHOISXML_API_KEYS` se este VM também fizer whois.
- **Telemetria (opcional):** `REDIS_URL=redis://<host-central-tailnet>:6379` (expor o redis no tailnet).

## 6. Arrancar
```bash
docker compose --env-file docker/.env.worker -f docker/docker-compose.worker.yml up -d --build
docker compose --env-file docker/.env.worker -f docker/docker-compose.worker.yml logs -f
```
Escalar num VM com cores (só `base`): `WORKER_REPLICAS=3` no `.env.worker` (verify fica sempre 1 = 1 IP/quota).

## 7. Verificação
- Logs: `consumers ativos: ...` + jobs a serem processados (`✓`/sem `✗`).
- **Dashboard → Workers** (se `REDIS_URL` definido): o worker aparece com role, tarefas/h, duração.
- Escrita direta: no CT, `SHOW POOLS` no PgBouncer mostra clientes deste VM; `sites`/`contacts` a crescer.
- `verify`: `contacts.email_status` a preencher para os domínios do lote.

## 8. Onde corre o quê (resumo operacional)
- **Host central (Finlândia, Docker):** directus, dashboard, nats, redis, minio, **worker-writer (A3 — perto do
  CT)**, + opcionalmente alguns `worker-base`. **NÃO** o Postgres (agora no CT `np-db`).
- **CT np-db (Finlândia):** Postgres + PgBouncer (+ réplica de leitura A5 pode viver na Alemanha).
- **Alemanha (Proxmox):** `worker-base` ×N (enrich/contacts) + opcional auditorias pesadas + **réplica
  streaming (A5)** do Postgres (backup vivo + leituras do dashboard).
- **Clouds free:** `verify` (+`whois`) — 1 VM = 1 IP = 1 quota. Ver README §10 p/ os limites free por cloud + a
  matemática da frota (≈30 VMs → ~38k verificações/dia).

## 9. Réplica de leitura A5 (opcional, no host da Alemanha)
Depois do CT `np-db` estar de pé (com o `replicator` no pg_hba):
```bash
# no host/VM da Alemanha (Debian + postgres-16):
systemctl stop postgresql && rm -rf /var/lib/postgresql/16/main/*
PGPASSWORD=<REPL_PASSWORD> pg_basebackup -h <np-db-tailnet> -U replicator \
  -D /var/lib/postgresql/16/main -Fp -Xs -P -R          # -R escreve standby.signal + primary_conninfo
systemctl start postgresql                               # arranca como hot-standby (read-only)
```
Depois: apontar as leituras pesadas do dashboard a esta réplica (raw SQL — o Directus **não** serve de
standby; ver A5 nos Follow-Ups do README). Backup vivo + escala de leituras, sem tocar no primário.
