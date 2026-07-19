---
title: "Runbook — np-server: Directus + Dashboard + NATS + Redis numa VM dedicada (HEL1)"
type: how-to
tags: [infra, runbook]
related: []
owner: infra
status: stable
updated: 2026-07-13
visibility: internal
---

# Runbook — `np-server`: Directus + Dashboard + NATS + Redis numa VM dedicada (HEL1)

> **Porquê.** Hoje o HEL1 corre um **monólito**: o control-plane (Directus, Dashboard, NATS, Redis)
> vive na MESMA VM que os workers pesados (Lighthouse/Chromium). Quando os workers saturam os cores,
> o event loop do Directus e o NATS competem por CPU → o control-plane treme (503 "Under pressure",
> pulls de NATS a atrasar). Separar o control-plane numa VM própria dá-lhe CPU **garantido** e deixa a
> VM de workers ser 100% músculo.
>
> **Latência IMPORTA aqui** (ao contrário do MinIO): NATS/Redis/Directus estão no *hot-path* de cada
> job. Por isso a `np-server` fica no **mesmo host Proxmox (HEL1)** que os workers de Helsínquia →
> alcançável por LAN (`10.10.10.20`, ~0.1 ms). Os workers remotos (DE1, free VMs) já falam com o NATS
> por tailnet hoje — para eles nada muda no perfil de latência.
>
> **Estado:** os 4 serviços são praticamente *stateless* — o Directus aponta para o `np-db` (Postgres
> em `100.77.60.44`), o Redis é só-cache (sem persistência), o Dashboard não guarda nada. **O ÚNICO
> estado a migrar é o JetStream do NATS** (`docker/.data/nats` — a workqueue com o backlog em ficheiro).

## Parâmetros

|                                   |                                                   |
| --------------------------------- | ------------------------------------------------- |
| **VMID**                    | **200** (confirma livre: `qm status 200`) |
| **Nome / hostname tailnet** | `np-server`                                     |
| **Host Proxmox**            | HEL1 (Finlândia)                                 |
| **IP LAN**                  | `10.10.10.20/24` (gw `10.10.10.1`)            |
| **Storage**                 | `storage-zfs` (ZFS)                             |
| **Disco**                   | 40 GB (só SO + uploads Directus +`.data/nats`) |
| **CPU / RAM**               | 4 vCPU / 8 GB (`--cpu host`)                    |
| **SO**                      | Debian 12 (cloud image + cloud-init)              |

---

## 1. Criar a VM + instalar o SO (no host Proxmox HEL1) — **TU fazes**

```bash
cd /var/lib/vz/template/iso
wget -nc https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2

qm create 801 --name np-server --memory 8192 --cores 4 --cpu host \
  --net0 virtio,bridge=vmbr1 --ostype l26 --scsihw virtio-scsi-single --agent 1

qm importdisk 801 debian-12-genericcloud-amd64.qcow2 local-zfs
qm set 801 --scsi0 local-zfs:vm-801-disk-0        # confirma o nome: qm config 200
qm resize 801 scsi0 40G

qm set 801 --ide2 local-zfs:cloudinit
qm set 801 --boot order=scsi0 --serial0 socket --vga serial0
qm set 801 --ciuser root --cipassword '<define-uma-password>' \
  --sshkeys ~/.ssh/authorized_keys
qm set 801 --ipconfig0 ip=10.10.10.81/24,gw=10.10.10.1
qm start 801
```

> **`--cpu host` é obrigatório** — o default `kvm64` é x86-64-v1; imagens modernas falham com
> `Fatal glibc error: CPU does not support x86-64-v2`. (Aqui os serviços toleram v1, mas mantém a
> convenção da frota.) Mudanças de CPU/RAM só pegam com **cold-boot** (`qm stop`+`qm start`), não com reboot interno.

## 2. Bootstrap (Docker + Tailscale + repo) — **TU fazes**

```bash
ssh root@10.10.10.81
curl -fsSL https://raw.githubusercontent.com/NetmasterPT/netprospect-v1/main/deploy/bootstrap-vm.sh \
  | bash -s -- <TAILSCALE_AUTHKEY> np-server tag:control
```

Imprime o tailnet IP — guarda-o (`<NPSRV_IP>`). A partir daqui o **Claude assume** (§3+) por `ssh root@np-server`.

---

## 3. Deploy do control-plane — **Claude faz**

Um compose enxuto (só os 4 serviços) na `np-server`, reusando o `docker/.env` do repo. O NATS e o
Redis ligam ao **IP LAN** (`10.10.10.20`, para os workers HEL1) **e** ao **tailnet** (para os remotos).

1. Copiar o `docker/.env` do monólito → `np-server` (mesmas chaves: `DIRECTUS_*`, `POSTGRES_*`, `REDIS_URL`, `CLICKHOUSE_*`, `OLLAMA_URL`).
2. Ajustar binds: `TAILNET_IP=<NPSRV_IP>` e (novo) `LAN_IP=10.10.10.20` para o NATS/Redis exporem as duas interfaces.
3. `docker compose -f deploy/server/docker-compose.yml up -d directus dashboard redis` (NATS ainda **não** — migra-se em §4).

*(O `deploy/server/docker-compose.yml` já existe no repo — Directus + Dashboard + NATS + Redis, com o NATS/Redis/Directus a bindar `${LAN_IP}` (workers HEL1, rápido) **e** `${TAILNET_IP}` (workers remotos). Preencher o `.env` a partir de `deploy/server/.env.example`.)*

---

## 4. Migrar o JetStream do NATS (o único estado) — **Claude faz, janela curta**

> O JetStream do NATS 2.10 é *file-backed* e **portável** entre servidores da mesma versão: basta
> copiar `/data` com o NATS **parado** dos dois lados. Isto preserva streams, consumers e o backlog.

```bash
# 4.1 — parar produtores + workers (não perdem nada: o backlog está no ficheiro)
#        no monólito HEL1: docker compose stop worker worker-base ; pkill -f enqueue- ; pkill -f orchestrate

# 4.2 — parar o NATS do monólito e sincronizar o /data para a np-server
#        (HEL1 → np-server pela LAN, rápido)
docker compose -f docker/docker-compose.yml stop nats
rsync -a --delete docker/.data/nats/ root@10.10.10.20:/root/netprospect-v1/deploy/server/.data/nats/

# 4.3 — arrancar o NATS na np-server (agora dono da workqueue)
ssh root@np-server 'cd netprospect-v1/deploy/server && docker compose up -d nats'
ssh root@np-server 'docker exec <nats-cid> nats stream ls'   # confirma NP_JOBS + backlog intactos
```

---

## 5. Repontar TODA a frota para a `np-server` — **Claude faz**

Cada host que fala com NATS/Redis/Directus troca os URLs internos pelos da `np-server`:

| Host                              | NATS_URL / REDIS_URL / DIRECTUS_URL                                                        | Interface               |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------- |
| Workers**HEL1** (mesma LAN) | `nats://10.10.10.20:4222` · `redis://10.10.10.20:6379` · `http://10.10.10.20:8056` | **LAN** (rápido) |
| Workers**DE1** + free VMs   | `nats://<NPSRV_IP>:4222` · `redis://<NPSRV_IP>:6379` · `http://<NPSRV_IP>:8056`    | tailnet                 |

```bash
# monólito HEL1 — os workers que lá ficam passam a apontar p/ a np-server (LAN)
cd /root/Github/netprospect-v1/docker
sed -i 's|NATS_URL=.*|NATS_URL=nats://10.10.10.20:4222|;
        s|REDIS_URL=.*|REDIS_URL=redis://10.10.10.20:6379|;
        s|DIRECTUS_URL=.*|DIRECTUS_URL=http://10.10.10.20:8056|' .env
docker compose up -d worker worker-base worker-writer   # só os workers; directus/nats/redis já NÃO cá vivem

# DE1 + remotos — no .env.worker de cada VM, os mesmos 3 URLs com <NPSRV_IP> (tailnet)
```

Os produtores `enqueue-*.js` no host lêem `NATS_URL`/`DIRECTUS_URL` do `docker/.env` → apanham a mudança automaticamente.

---

## 6. Verificação (antes de desmantelar do monólito)

```bash
# 1) control-plane vivo na np-server
curl -s http://10.10.10.20:8056/server/health          # Directus {"status":"ok"}
curl -s http://10.10.10.20:3001/api/workers | jq length # dashboard lista os workers de novo

# 2) a workqueue drena? (um worker apanha um job da np-server)
node scripts/queue-depth.mjs                            # backlog a descer

# 3) telemetria: todos os workers (HEL1 + DE1) reaparecem com metadata (host/role)
```

## 7. Desmantelar do monólito (só depois do §6 passar)

```bash
cd /root/Github/netprospect-v1/docker
docker compose stop directus dashboard nats redis
# comentar esses 4 serviços no docker-compose.yml (mantém ./.data/nats como rollback)
```

## Rollback

Reverter os 3 URLs no `.env` para os nomes internos (`nats://nats:4222`, etc.) + `docker compose up -d directus dashboard nats redis worker worker-base`. O `.data/nats` do monólito continua intacto.

## Depois

Marcar `np-server` ✅ na [`LOAD-DISTRIBUTION.md`](../LOAD-DISTRIBUTION.md) §0 com o `<NPSRV_IP>`; atualizar o inventário de VMs.

## Notas

- **Fazer com o backlog baixo** — a janela do §4 pára os workers uns minutos; quanto menor o backlog, menor a paragem (o backlog **não se perde**, só fica em espera).
- **NATS/Redis nunca públicos** — só LAN + tailnet (não têm auth). Nunca `0.0.0.0`.
- **Directus é o único com uploads locais** (`./.data/directus`) — hoje só ~alguns MB; migram no rsync se necessário (ou ficam no `np-db`? não — uploads são ficheiro; copiar `./.data/directus` no §4 se houver conteúdo).
