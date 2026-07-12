# Runbook — migrar o MinIO para disco HDD barato no DE1

> **Porquê.** O MinIO é *object storage*: escreve-se **uma vez**, lê-se **raramente** (só ao gerar
> o relatório do cliente). Não tem qualquer benefício em estar em **NVMe** no HEL1 — é o perfil
> de I/O que MENOS precisa de disco rápido, e é o que MAIS vai crescer.
>
> **Escala medida:** o relatório integral de Lighthouse (sem screenshots) são **71 KB gzip/site**.
> A 729k qualificados ≈ **52 GB**; a 1M sites ≈ **71 GB**. Com screenshots seriam **396 GB/M**
> (82% do peso são base64 de JPEG, que não comprimem — ver `lib/audit/lighthouse.js:leanLhr`).
> O HEL1 tem ~34 GB livres: **não cabe**. O DE1 tem HDD barato por usar.
>
> **Latência não é problema aqui:** o MinIO é acedido fora do hot-path (escrita fire-and-forget
> no fim da auditoria, leitura só quando se gera o PDF). Os ~35 ms de WAN FI↔DE são irrelevantes
> — ao contrário do NATS/Redis/Directus, que **têm** de ficar ao pé dos workers.

---

## 0. Pré-requisitos
- DE1 (VM Alemanha, tailnet `100.120.214.45`) com Docker + Tailscale (já tem — ver `docs/runbook-worker-vms.md`).
- Um disco HDD adicional no host Proxmox alemão, por atribuir à VM.
- Acesso SSH root ao DE1 e ao host Proxmox.

## 1. Adicionar o disco HDD à VM (no host Proxmox alemão)
```bash
# Ver os storages disponíveis e escolher o HDD (não o SSD/NVMe)
pvesm status

# Adicionar um disco de 200G à VM 800 no storage HDD (ajusta o nome do storage)
qm set 800 --scsi1 <storage-hdd>:200

# Aplica a quente (SCSI hotplug); se não aparecer, faz cold-boot:
#   qm stop 800 && qm start 800   ← ATENÇÃO: um `reboot` de DENTRO da VM NÃO aplica
```

## 2. Formatar e montar (no DE1)
```bash
lsblk                                  # confirmar o disco novo (ex.: /dev/sdb)
mkfs.ext4 -L minio /dev/sdb            # ext4 chega (é object storage, não é DB)
mkdir -p /srv/minio
echo 'LABEL=minio /srv/minio ext4 defaults,noatime 0 2' >> /etc/fstab
mount -a && df -h /srv/minio           # deve mostrar o HDD montado
```

## 3. Subir o MinIO no DE1 (ligado só à tailnet)
```bash
mkdir -p /root/np-minio && cd /root/np-minio
TS_IP=$(tailscale ip -4)               # ex.: 100.120.214.45

cat > docker-compose.yml <<EOF
services:
  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD}
    volumes:
      - /srv/minio:/data           # ← o HDD
    ports:
      # SÓ na tailnet. NUNCA público (o MinIO tem as credenciais em env).
      - '${TS_IP}:9000:9000'
      - '127.0.0.1:9001:9001'      # consola: só por túnel SSH
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 30s
      timeout: 10s
      retries: 5
EOF

# As MESMAS credenciais do HEL1 (para não haver reconfiguração do lado da app)
cat > .env <<'EOF'
MINIO_ROOT_USER=netprospect
MINIO_ROOT_PASSWORD=<copiar de docker/.env do HEL1>
EOF
chmod 600 .env

docker compose up -d && docker compose ps
```

## 4. Migrar os dados existentes (do HEL1 para o DE1)
> Hoje são apenas ~10 MB (snapshots). Fazer **antes** de os relatórios encherem o bucket.

```bash
# No HEL1 — usar o cliente `mc` do próprio container do MinIO
docker run --rm --network host -e MC_HOST_src=http://netprospect:<PASS>@127.0.0.1:9000 \
  -e MC_HOST_dst=http://netprospect:<PASS>@100.120.214.45:9000 \
  minio/mc mirror --preserve src/snapshots dst/snapshots

# Repetir para o bucket dos relatórios se já existir
docker run --rm --network host -e MC_HOST_src=... -e MC_HOST_dst=... \
  minio/mc mirror --preserve src/reports dst/reports

# Verificar contagens dos dois lados
docker run --rm --network host -e MC_HOST_x=... minio/mc ls --recursive x/reports | wc -l
```

## 5. Repontar a app (no HEL1)
```bash
cd /root/Github/netprospect-v1
# docker/.env
#   MINIO_URL=http://100.120.214.45:9000     ← tailnet do DE1 (era http://minio:9000)
sed -i 's|^MINIO_URL=.*|MINIO_URL=http://100.120.214.45:9000|' docker/.env

# O compose passa MINIO_URL aos workers e ao dashboard; o serviço `minio` local deixa de ser
# preciso → comentar/remover do docker/docker-compose.yml (mantém o volume p/ rollback).
docker compose -f docker/docker-compose.yml up -d worker worker-base dashboard
```

## 6. Verificação (obrigatória antes de desmantelar)
```bash
# 1) O worker consegue escrever? (força uma auditoria on-demand)
node enqueue-audits.js --domain=<um-dominio-qualificado>

# 2) O objeto aparece no DE1?
ssh root@100.120.214.45 'ls -la /srv/minio/reports/ | head'

# 3) O ponteiro ficou no Postgres?
#    site_reports.report->'_full' deve ter { bucket, key, bytes }
psql -c "SELECT report->'_full' FROM site_reports WHERE kind='lighthouse_seo' ORDER BY id DESC LIMIT 1"

# 4) Leitura ponta-a-ponta (o que gera o PDF do cliente)
node -e "import('./lib/artifacts.js').then(async m => console.log(Object.keys(await m.getReport('<siteId>/lighthouse_seo.json.gz'))))"
```

## 7. Desmantelar o MinIO do HEL1
> **Só depois** do passo 6 passar. O volume local fica para rollback.
```bash
docker compose -f docker/docker-compose.yml stop minio
docker compose -f docker/docker-compose.yml rm -f minio
# NÃO apagar ./docker/.data/minio ainda — é o rollback.
```

## Rollback
`MINIO_URL=http://minio:9000` no `docker/.env` + `docker compose up -d minio worker dashboard`.
Os dados locais continuam em `docker/.data/minio`.

## Notas operacionais
- **Fail-soft:** `putReport()` (`lib/artifacts.js`) devolve `null` se o storage falhar — a auditoria
  **nunca** morre por causa do MinIO. O `site_reports` fica só com o resumo e o `_full` a null.
- **Backup:** o HDD do DE1 não tem redundância. Os relatórios são **regeneráveis** (basta re-auditar),
  logo não justificam RAID — mas vale a pena um `mc mirror` periódico se o custo de re-auditar subir.
- **Lifecycle:** dá para pôr expiração por bucket (ex.: snapshots a 90 dias) com
  `mc ilm rule add --expire-days 90 dst/snapshots`.
