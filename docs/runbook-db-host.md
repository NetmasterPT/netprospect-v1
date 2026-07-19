---
title: Runbook — Host de DB dedicado (Postgres + PgBouncer + Tailscale) num CT Proxmox
type: how-to
tags: [infra, runbook]
related: []
owner: infra
status: stable
updated: 2026-07-13
visibility: internal
---

# Runbook — Host de DB dedicado (Postgres + PgBouncer + Tailscale) num CT Proxmox

Migra o **Postgres + PgBouncer** do host Docker partilhado para um **LXC CT dedicado** no Proxmox
(Finlândia, NVMe/ZFS), acessível pelo stack da app e pela frota de workers **via Tailnet**. Objetivo:
o Postgres deixa de disputar CPU/I/O com os workers/ClickHouse (era ~70% da load) e passa a ter cores +
NVMe só para si. Ver o plano [postgres-scaling-and-whois-rdap.md](../.claude/plans/dev/postgres-scaling-and-whois-rdap.md)
(Part A) e [runbook-worker-vms.md](runbook-worker-vms.md) para os workers.

> **Alvo:** CT `np-db` · Debian 12 · **14 vCPU / 64 GB RAM** (12 fáceis, 14-16 se acomodável) · rootfs NVMe
> (ZFS) · Postgres 16 + PostGIS 3 **nativo** (não Docker — I/O e tuning mais limpos) · PgBouncer nativo ·
> Tailscale. DB atual = **~10 GB** → migração rápida (`pg_dump | pg_restore`, janela de minutos).

```
                    Tailnet (100.64.0.0/10)
  ┌── np-db CT (Finlândia, NVMe) ──┐        ┌── host app (Docker, atual) ──┐
  │  Postgres 16 :5432 (só tailnet)│◄───────│ directus · dashboard · nats  │
  │  PgBouncer  :6432 (txn pool)   │◄───┐   │ redis · minio · worker-base  │
  │  Tailscale (tag:db)            │    │   │ worker-writer (A3, perto DB) │
  └────────────────────────────────┘    │   └──────────────────────────────┘
                                         └── frota de workers (Alemanha + clouds free) → PgBouncer:6432
```

---

## 0. Pré-requisitos
- Acesso ao host Proxmox (Finlândia) com um pool ZFS em NVMe (ex.: `rpool` ou `nvme-pool`).
- Uma **auth key** do Tailscale (reutilizável, tag `tag:db`) — cria em https://login.tailscale.com/admin/settings/keys.
- As credenciais atuais do Postgres (do `docker/.env`: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`).

## 1. Criar o CT no Proxmox
No host Proxmox (shell):
```bash
# Template Debian 12 (se ainda não tiver)
pveam update && pveam download local debian-12-standard_*_amd64.tar.zst

# Dataset ZFS dedicado para os dados do Postgres (rootfs à parte, dados aqui)
zfs create -o mountpoint=/np-db-data <nvme-pool>/np-db-data
# Tuning ZFS p/ Postgres: recordsize 16K (casa bem com páginas 8K), lz4, sem atime, latência baixa
zfs set recordsize=16K compression=lz4 atime=off logbias=latency xattr=sa <nvme-pool>/np-db-data

# Criar o CT (unprivileged, 14 cores, 64G RAM, 8G swap, rootfs 20G no NVMe)
pct create 900 local:vztmpl/debian-12-standard_*_amd64.tar.zst \
  --hostname np-db --cores 14 --memory 65536 --swap 8192 \
  --rootfs <nvme-pool>:20 --net0 name=eth0,bridge=vmbr1,ip=10.10.10.90/24,gw=10.10.10.1 \
  --features nesting=1 --unprivileged 1 --onboot 1
# Montar o dataset de dados no CT
pct set 900 --mp0 /np-db-data,mp=/var/lib/postgresql
```

### 1a. Passar o device TUN ao CT (para o Tailscale)
```bash
cat >> /etc/pve/lxc/900.conf <<'EOF'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF
pct start 900 && pct enter 900
```

### 1b. Cap ao ARC do ZFS (no HOST Proxmox, não no CT)
Deixa RAM para o Postgres (shared_buffers) sem o ARC do ZFS a competir. Ex.: limitar o ARC a ~16 GB:
```bash
echo "options zfs zfs_arc_max=17179869184" > /etc/modprobe.d/zfs.conf   # 16 GiB
update-initramfs -u   # aplica no próximo boot; ou: echo 17179869184 > /sys/module/zfs/parameters/zfs_arc_max
```

## 2. Base OS (dentro do CT)
```bash
apt update && apt -y full-upgrade
apt -y install locales curl gnupg ca-certificates lsb-release rsync
sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
timedatectl set-timezone UTC
```

## 3. Instalar Postgres 16 + PostGIS
```bash
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list
apt update && apt -y install postgresql-16 postgresql-16-postgis-3 pgbouncer
systemctl stop postgresql
# Reinicializar o data dir no dataset ZFS montado (vem vazio via mp0)
rm -rf /var/lib/postgresql/16/main
pg_dropcluster 16 main 2>/dev/null || true
pg_createcluster 16 main -d /var/lib/postgresql/16/main
```

## 4. `postgresql.conf` — tuning para 64 GB RAM / NVMe
Editar `/etc/postgresql/16/main/postgresql.conf` (ou `conf.d/`):
```conf
listen_addresses = '*'            # restringido pelo pg_hba (tailnet) + firewall
max_connections = 200             # PgBouncer multiplexa; poucas ligações reais
shared_buffers = 16GB             # ~25% da RAM
effective_cache_size = 44GB       # ~70% (conta com ARC + page cache)
work_mem = 64MB
maintenance_work_mem = 2GB
max_worker_processes = 14
max_parallel_workers = 8
max_parallel_workers_per_gather = 4
# WAL / checkpoints (write-heavy)
wal_compression = on
wal_buffers = 64MB
max_wal_size = 16GB
min_wal_size = 2GB
checkpoint_completion_target = 0.9
checkpoint_timeout = 15min
synchronous_commit = off          # grande ganho de throughput (perde ≤poucas transações num crash)
# NVMe
random_page_cost = 1.1
effective_io_concurrency = 200
# ZFS é copy-on-write com escrita atómica → podemos desligar full_page_writes (menos WAL).
# SÓ em ZFS! Manter 'on' em ext4/xfs. Testar num staging antes de produção.
full_page_writes = off
```
> **Huge pages (opcional, avançado):** para `shared_buffers=16GB`, `huge_pages=try` reduz pressão de TLB;
> exige reservar hugepages no host Proxmox. Deixar para uma 2.ª iteração.

## 5. `pg_hba.conf` — acesso pela Tailnet + replicação
Editar `/etc/postgresql/16/main/pg_hba.conf`:
```conf
local   all             all                                     peer
host    all             all             127.0.0.1/32            scram-sha-256
host    all             <appuser>       100.64.0.0/10           scram-sha-256   # app + frota (tailnet)
host    replication     replicator      100.64.0.0/10           scram-sha-256   # A5 réplica (host Alemanha)
```
```bash
systemctl start postgresql
# Recriar o utilizador/DB da app + PostGIS (mesmas credenciais do docker/.env)
sudo -u postgres psql -c "CREATE ROLE <appuser> LOGIN PASSWORD '<POSTGRES_PASSWORD>' SUPERUSER;"
sudo -u postgres createdb -O <appuser> <POSTGRES_DB>
sudo -u postgres psql -d <POSTGRES_DB> -c "CREATE EXTENSION IF NOT EXISTS postgis;"
sudo -u postgres psql -c "CREATE ROLE replicator LOGIN REPLICATION PASSWORD '<REPL_PASSWORD>';"
```

## 6. PgBouncer (transaction pool) — mesmo papel do serviço Docker A1
`/etc/pgbouncer/pgbouncer.ini`:
```ini
[databases]
* = host=127.0.0.1 port=5432
[pgbouncer]
listen_addr = *
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 2000          # dezenas de workers da frota
default_pool_size = 30
min_pool_size = 5
reserve_pool_size = 5
max_db_connections = 40         # ≤ max_connections do Postgres
server_reset_query = DISCARD ALL
ignore_startup_parameters = extra_float_digits,search_path,options,application_name
admin_users = <appuser>
```
`userlist.txt` (gerar o hash SCRAM a partir do pg_shadow):
```bash
sudo -u postgres psql -tAc "SELECT '\"'||rolname||'\" \"'||rolpassword||'\"' FROM pg_authid WHERE rolname='<appuser>';" \
  | sudo tee /etc/pgbouncer/userlist.txt
systemctl restart pgbouncer && systemctl enable pgbouncer
```
> Limite de FDs: `systemctl edit pgbouncer` → `[Service]\nLimitNOFILE=65536` (2000 clientes ≈ 2100 fds).

## 7. Tailscale no CT
```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey tskey-... --hostname np-db --advertise-tags=tag:db
tailscale ip -4      # → anota o IP tailnet do host de DB, ex. 100.100.1.10
```
**ACLs (admin do Tailscale):** só a app + workers alcançam `np-db:5432/6432`. Ex.:
```json
{"action":"accept","src":["tag:app","tag:worker"],"dst":["tag:db:5432","tag:db:6432"]}
```

## 8. Migrar os dados (DB ~10 GB) — janela de manutenção curta
No **host Docker atual**:
```bash
cd /root/Github/netprospect-v1/docker
# 1) parar quem ESCREVE (deixa o Directus p/ o dump ler; ou pára tudo p/ consistência total)
docker compose stop worker-base worker-writer
pkill -f orchestrate- 2>/dev/null || true
# 2) dump comprimido direto do container Postgres
docker exec netprospect-postgres-1 pg_dump -U <appuser> -Fc -Z3 <POSTGRES_DB> > /tmp/np.dump
ls -lh /tmp/np.dump
# 3) enviar para o CT (via tailnet)
rsync -avP /tmp/np.dump root@100.100.1.10:/tmp/np.dump
```
No **CT np-db**:
```bash
sudo -u postgres pg_restore -U <appuser> -d <POSTGRES_DB> --no-owner --role=<appuser> -j4 /tmp/np.dump
sudo -u postgres psql -d <POSTGRES_DB> -c "ANALYZE;"        # atualizar estatísticas
sudo -u postgres psql -d <POSTGRES_DB> -tAc "SELECT count(*) FROM sites;"   # sanity (deve dar ~1.1M)
```

## 9. Repointar o stack da app para o CT
No `docker/.env` do host da app:
```bash
# apontar o Directus + workers ao Postgres/PgBouncer do CT (tailnet)
PG_WRITE_HOST=100.100.1.10        # IP tailnet do np-db
PG_WRITE_PORT=6432                # PgBouncer
```
No `docker/docker-compose.yml` do host da app:
- **Directus** `DB_HOST: 100.100.1.10` `DB_PORT: '6432'` (via PgBouncer) — ou `5432` direto se preferires
  o Directus sem pool (ele precisa de sessão; 6432 em transaction mode funciona p/ o Directus com os
  `ignore_startup_parameters` acima, mas **testa**; em dúvida usa `5432` direto no CT).
- **Comentar/remover** os serviços `postgres` e `pgbouncer` locais (a DB agora é o CT).
- worker-base / worker-writer já leem `PG_WRITE_HOST` do `.env`.
```bash
docker compose up -d directus worker-base worker-writer
docker compose logs -f directus | grep -i "database\|error"    # confirmar ligação
```

## 10. Backups
- **Snapshots ZFS** (no host Proxmox): `sanoid` ou `zfs-auto-snapshot` no dataset `np-db-data`
  (ex.: 24 horárias + 14 diárias). Rollback instantâneo.
- **pg_dump noturno** → host de backups (Alemanha) via tailnet: cron no CT
  `pg_dump -Fc <db> | ssh root@<alemanha-tailnet> 'cat > /backups/np-$(date +\%F).dump'`.
- **Réplica streaming (A5)** no host da Alemanha = backup vivo + escala de leituras — ver o fim do
  `runbook-worker-vms.md`.

## 11. Verificação
```bash
# do host da app + de um worker da frota:
PGPASSWORD=... psql -h 100.100.1.10 -p 6432 -U <appuser> <db> -c "SELECT count(*) FROM sites;"
# PgBouncer a servir?
psql -h 100.100.1.10 -p 6432 -U <appuser> pgbouncer -c "SHOW POOLS;"
# load do CT deve subir e a do host da app deve CAIR ~8-9 cores
```

## 12. Rollback
Reverter `docker/.env` (`PG_WRITE_HOST=pgbouncer`) + descomentar os serviços `postgres`/`pgbouncer`
locais + `docker compose up -d postgres pgbouncer directus worker-base`. Os dados locais continuam
intactos até confirmares o CT (não apagar o `./.data/postgres` antes da validação).
