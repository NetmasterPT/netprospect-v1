# Runbook — `de-analytics`: ClickHouse + PostHog numa VM dedicada (DE1)

> ✅ **FEITO (2026-07):** ClickHouse migrado — 10.236.938 observations + 43.106 change_events
> (contagem exata), escrita+leitura remotas validadas, CH local do HEL1 desmantelado. O disco de dados
> ficou no **`/dev/sda` (200G)** — o root da VM é o `sdb`. **NOTA:** o `bootstrap-vm.sh` não tinha
> `rsync`; a cópia foi por `rsync` num container Alpine (o HEL1 não é root p/ `apt`). PostHog: pendente.

> **Porquê.** O ClickHouse guarda a Fase E — a série temporal de observações por site (**~10 M linhas**
> hoje, cresce sem parar). É disco-pesado, colunar, analítico: o perfil que MENOS precisa de estar ao
> pé dos workers e o que MAIS cresce → como o MinIO, pertence ao **disco barato do DE1**, não ao NVMe
> do HEL1. O PostHog (product analytics do dashboard) é um opt-in ainda mais pesado (traz Postgres +
> Redis + Kafka + ClickHouse **próprios**) → mesma VM, mesma lógica.
>
> **Latência NÃO importa** — as queries analíticas correm fora do hot-path (timeline de um site ao
> abrir o relatório, funis no dashboard). Os ~35 ms FI↔DE são irrelevantes.
>
> **Estado a migrar:** o `docker/.data/clickhouse` (as ~10 M observações). O PostHog arranca **de raiz**
> (nunca correu a sério) → sem migração.

## Parâmetros

|                             |                                      |
| --------------------------- | ------------------------------------ |
| **VMID**                    | **301** (a seguir ao `de-minio`=300) |
| **Nome / hostname tailnet** | `de-analytics`                       |
| **Host Proxmox**            | DE1 (Alemanha)                       |
| **IP LAN**                  | `10.10.10.31/24` (gw `10.10.10.1`)   |
| **Storage**                 | `storage-zfs` (ZFS)                  |
| **Disco de dados**          | **200 GB** (2.º disco, ext4 → `/srv/analytics`) |
| **CPU / RAM**               | **6 vCPU / 16 GB** (`--cpu host`) — ver nota RAM |
| **SO**                      | Debian 12 (cloud image + cloud-init) |

> **Nota RAM.** Só o ClickHouse do NetProspect cabe folgado em 8 GB. O **PostHog** quer +4–6 GB
> (traz o SEU ClickHouse + Kafka + Postgres). Se vais correr os dois → **16 GB**. Se por agora só
> queres a analítica do NetProspect (recomendado), 8 GB chegam e o PostHog fica para quando houver RAM.

---

## 1. Criar a VM + SO (no host Proxmox DE1) — **TU fazes**

```bash
cd /var/lib/vz/template/iso
wget -nc https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2

qm create 301 --name de-analytics --memory 16384 --cores 6 --cpu host \
  --net0 virtio,bridge=vmbr1 --ostype l26 --scsihw virtio-scsi-single --agent 1

qm importdisk 301 debian-12-genericcloud-amd64.qcow2 storage-zfs
qm set 301 --scsi0 storage-zfs:vm-301-disk-0        # confirma: qm config 301
qm resize 301 scsi0 20G

qm set 301 --scsi1 storage-zfs:200                  # disco de DADOS (ClickHouse + PostHog)

qm set 301 --ide2 storage-zfs:cloudinit
qm set 301 --boot order=scsi0 --serial0 socket --vga serial0
qm set 301 --ciuser root --cipassword '<define-uma-password>' \
  --sshkeys ~/.ssh/authorized_keys
qm set 301 --ipconfig0 ip=10.10.10.31/24,gw=10.10.10.1
qm start 301
```

> **`--cpu host` obrigatório** — o ClickHouse e o PostHog exigem **x86-64-v2**; o default `kvm64`
> (v1) → `Fatal glibc error: CPU does not support x86-64-v2`. (Foi exatamente o que travou o `de-minio`.)

> **qemu-guest-agent (toda a VM, não os CTs):** o `--agent 1` só abre o canal; o pacote instala-se
> DENTRO da VM: `apt update && apt install -y qemu-guest-agent`. O `bootstrap-vm.sh` (§2) já o faz.

## 2. Bootstrap (Docker + Tailscale + repo) — **TU fazes**

```bash
ssh root@10.10.10.31
curl -fsSL https://raw.githubusercontent.com/NetmasterPT/netprospect-v1/main/deploy/bootstrap-vm.sh \
  | bash -s -- <TAILSCALE_AUTHKEY> de-analytics tag:analytics
```

Imprime o tailnet IP (`<ANALYTICS_IP>`). A partir daqui o **Claude assume** (§3+).

## 3. Disco de dados — ext4 — **Claude faz**

Mesma lógica do `de-minio` (não pôr ZFS-on-ZFS; o `storage-zfs` já dá checksums/snapshots no host):

```bash
lsblk                                          # confirmar o disco de dados (ex.: /dev/sdb, 200G)
mkfs.ext4 -L analytics /dev/sdb
mkdir -p /srv/analytics
echo 'LABEL=analytics /srv/analytics ext4 defaults,noatime 0 2' >> /etc/fstab
mount -a && df -h /srv/analytics
```

---

## 4. Deploy do ClickHouse (a analítica do NetProspect) — **Claude faz**

```bash
# na de-analytics — compose só-ClickHouse, dados em /srv/analytics/clickhouse, bind tailnet
cd /root/netprospect-v1/deploy/analytics
cp .env.example .env      # CLICKHOUSE_USER/PASSWORD/DB (iguais ao HEL1) + TAILNET_IP=<ANALYTICS_IP>
docker compose up -d clickhouse
```

*(O `deploy/analytics/docker-compose.yml` já existe no repo — ClickHouse 24.3-alpine (a MESMA versão do HEL1, para o data-dir migrar por rsync), dados em `/srv/analytics/clickhouse`, schema e `listen-ipv4.xml` montados do repo, porta 8123 só em tailnet + localhost.)*

## 5. Migrar as ~10 M observações (HEL1 → de-analytics) — **Claude faz**

> O data-dir do ClickHouse 24.3 é portável entre servidores da mesma versão com o CH **parado** dos
> dois lados. (Single-node, mesma imagem → rsync do `/var/lib/clickhouse` é o caminho simples.)

```bash
# no HEL1 — parar o CH de origem (é profile-gated 'analytics'; pode já estar parado)
cd /root/Github/netprospect-v1/docker
docker compose --profile analytics stop clickhouse

# rsync do data-dir p/ a de-analytics (parar também o destino durante a cópia)
ssh root@de-analytics 'cd netprospect-v1/deploy/analytics && docker compose stop clickhouse'
rsync -a --delete docker/.data/clickhouse/ root@de-analytics:/srv/analytics/clickhouse/
ssh root@de-analytics 'chown -R 101:101 /srv/analytics/clickhouse && cd netprospect-v1/deploy/analytics && docker compose up -d clickhouse'

# validar a contagem no destino
ssh root@de-analytics "docker exec <ch-cid> clickhouse-client -q 'SELECT count() FROM netprospect.observations'"
```

## 6. Repontar a app (no HEL1) — **Claude faz**

```bash
cd /root/Github/netprospect-v1
sed -i 's|^CLICKHOUSE_URL=.*|CLICKHOUSE_URL=http://<ANALYTICS_IP>:8123|' docker/.env
# o dashboard constrói o host do CH a partir de CLICKHOUSE_URL → recriar p/ apanhar a env
cd docker && docker compose up -d --force-recreate dashboard worker
```

## 7. PostHog (OPT-IN, só quando houver RAM) — **Claude faz, adiado**

> Só arrancar se a VM tiver os 16 GB. O PostHog é o `docker/posthog.compose.yml` (Postgres + Redis +
> Kafka + ClickHouse próprios). Passa a correr na `de-analytics`, **não** no HEL1.

```bash
# na de-analytics: definir POSTHOG_SECRET_KEY (>=32 chars) + POSTHOG_DB_PASSWORD no .env
docker compose -f posthog.compose.yml up -d
docker compose -f posthog.compose.yml run --rm posthog-web python manage.py migrate   # 1.ª vez
# abrir por túnel SSH http://localhost:8000, criar conta, copiar a Project API Key →
#   POSTHOG_HOST=http://<ANALYTICS_IP>:8000 + POSTHOG_KEY=<key> no docker/.env do HEL1
```

## 8. Verificação

```bash
# ClickHouse responde por tailnet e tem os dados
curl -s "http://<ANALYTICS_IP>:8123/?query=SELECT%20count()%20FROM%20netprospect.observations"
# o dashboard mostra a timeline de um site (usa o CH remoto)
curl -s http://localhost:3001/api/site/<id>/timeline | jq '.[0]'
```

## 9. Desmantelar do HEL1 (só depois do §8)

```bash
cd /root/Github/netprospect-v1/docker
docker compose --profile analytics rm -f clickhouse
# comentar o serviço clickhouse no docker-compose.yml; manter ./.data/clickhouse como rollback
```

## Rollback

`sed -i 's|^CLICKHOUSE_URL=.*|CLICKHOUSE_URL=http://clickhouse:8123|' docker/.env` +
`docker compose --profile analytics up -d clickhouse dashboard`. O data-dir local fica intacto.

## Notas

- **Fail-soft:** `CLICKHOUSE_URL` vazio = analítica desligada (o dashboard corre tudo sem timeline). A app nunca morre por causa do CH.
- **PostHog é independente** da série temporal do NetProspect (essa vive no CH do §4). O PostHog só serve product-analytics do próprio dashboard → prescindível.
- **Backup:** as observações são um log append-only regenerável em parte; se quiseres durabilidade, snapshot ZFS no host: `zfs snapshot storage-zfs/vm-301-disk-1@$(date +%F)`.
