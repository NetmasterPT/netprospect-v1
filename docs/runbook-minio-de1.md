# Runbook — MinIO numa VM dedicada no DE1 (object storage em disco barato)

> **Porquê.** O MinIO é *object storage*: escreve-se **uma vez** (fire-and-forget no fim da
> auditoria), lê-se **raramente** (só ao gerar o relatório do cliente). É o perfil de I/O que
> MENOS precisa de disco rápido e o que MAIS vai crescer → tirá-lo do NVMe do HEL1 é ganho puro.
>
> **Escala medida:** o relatório integral de Lighthouse (sem screenshots) são **71 KB gzip/site**
> → ~52 GB aos 729k qualificados, ~71 GB por 1M. Com screenshots seriam ~396 GB/M (82% do peso são
> base64 de JPEG, que não comprimem — ver `lib/audit/lighthouse.js:leanLhr`). O HEL1 já está a 88%
> de disco: **não cabe**. A VM nova leva **500 GB**.
>
> **Latência não importa aqui:** acesso fora do hot-path → os ~35 ms de WAN FI↔DE são irrelevantes
> (ao contrário do NATS/Redis/Directus, que TÊM de ficar ao pé dos workers).

## Parâmetros desta migração

|                                   |                                      |
| --------------------------------- | ------------------------------------ |
| **VMID**                    | **300**                        |
| **Nome / hostname tailnet** | `de-minio`                         |
| **Host Proxmox**            | DE1 (Alemanha)                       |
| **Storage**                 | `storage-zfs` (ZFS)                |
| **Disco de dados**          | **500 GB**                     |
| **CPU / RAM**               | 2 vCPU / 4 GB                        |
| **SO**                      | Debian 12 (cloud image + cloud-init) |

---

## 1. Criar a VM + instalar o SO (no host Proxmox DE1)

Método cloud-image + cloud-init (headless, sem ISO/GUI). Correr como root no host Proxmox.

```bash
# 1.1 — Baixar a cloud image do Debian 12 (uma vez; inclui cloud-init)
cd /var/lib/vz/template/iso
wget -nc https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2

# 1.2 — Criar a VM 300 (disco de arranque importado a seguir)
qm create 300 --name de-minio --memory 4096 --cores 2 --cpu host \
  --net0 virtio,bridge=vmbr1 --ostype l26 --scsihw virtio-scsi-single --agent 1

# 1.3 — Importar a cloud image como disco de arranque, no storage-zfs
qm importdisk 300 debian-12-genericcloud-amd64.qcow2 storage-zfs
qm set 300 --scsi0 storage-zfs:vm-300-disk-0        # (confirma o nome com: qm config 300)
qm resize 300 scsi0 20G                              # a cloud image vem com ~2G → cresce p/ 20G

# 1.4 — Disco de DADOS de 500 GB, no storage-zfs (é onde vive o MinIO)
qm set 300 --scsi1 storage-zfs:500

# 1.5 — cloud-init: consola série + user/SSH + rede DHCP
qm set 300 --ide2 storage-zfs:cloudinit
qm set 300 --boot order=scsi0 --serial0 socket --vga serial0
qm set 300 --ciuser root --cipassword '<define-uma-password>' \
  --sshkeys ~/.ssh/authorized_keys                  # a TUA chave (+ a do Claude, se separada)
qm set 300 --ipconfig0  ip=10.10.10.30/24,gw=10.10.10.1

# 1.6 — Arrancar (IP LAN estático = 10.10.10.30, pela convenção — ver abaixo)
qm start 300
# aguardar ~30s pelo cloud-init; consola série se preciso: qm terminal 300 (Ctrl+O p/ sair)
```

> **Convenção de IP LAN da frota:** o último octeto = o **VMID sem o dígito do meio** (das dezenas).
> `300`→`10.10.10.30` · `301`→`10.10.10.31` · `501`→`10.10.10.51`. Gateway sempre `10.10.10.1`, /24.
> (Estático em cloud-init: `--ipconfig0 ip=10.10.10.30/24,gw=10.10.10.1`.) A `vmbr0` é da VM da WHM → usar **`vmbr1`**.

> **Nota (memory/CPU a quente):** mudanças de CPU/RAM em VMs Proxmox só pegam com **cold-boot do
> qemu** (`qm stop` + `qm start`), NÃO com um `reboot` de dentro da VM. (Aprendido à força nesta frota.)

> **qemu-guest-agent (toda a VM, não os CTs):** o `--agent 1` só abre o canal; o pacote instala-se
> DENTRO da VM: `apt update && apt install -y qemu-guest-agent`. O `bootstrap-vm.sh` (§2) já o faz.

---

## 2. Bootstrap da VM (Docker + Tailscale + repo)

SSH para a VM (IP LAN estático `10.10.10.30`, a partir de uma máquina na LAN do DE1 — ex.: o host
Proxmox; o HEL1 NÃO alcança a LAN do DE1) e corre o bootstrap. Após ele, a VM fica no tailnet e o
Claude assume o resto (§3+) pelo `<DEMINIO_IP>` (100.x).

```bash
ssh root@10.10.10.30
curl -fsSL https://raw.githubusercontent.com/NetmasterPT/netprospect-v1/main/deploy/bootstrap-vm.sh \
  | bash -s -- <TAILSCALE_AUTHKEY> de-minio tag:storage
```

Isto instala o Docker + Tailscale, junta ao tailnet como `de-minio`, clona o repo em
`/root/netprospect-v1`, e **imprime o tailnet IP** — guarda-o (chamemos-lhe `<DEMINIO_IP>`).

---

## 3. Preparar o disco de dados — ext4 (decidido)

> **Porquê ext4 e não ZFS na VM:** o `storage-zfs` do Proxmox JÁ é ZFS — o disco da VM é um *zvol*
> em cima de ZFS. Pôr ZFS outra vez dentro da VM (ZFS-on-ZFS) dobra o COW, os checksums e o consumo
> de RAM (ARC no host + na VM), sem ganho: o Proxmox já dá checksums/compressão/snapshots ao nível do
> host. Logo, ext4 simples na VM; a integridade/snapshots geram-se no Proxmox.

```bash
lsblk                                          # confirmar o disco de dados (ex.: /dev/sdb, 500G)
mkfs.ext4 -L minio /dev/sdb
mkdir -p /srv/minio
echo 'LABEL=minio /srv/minio ext4 defaults,noatime 0 2' >> /etc/fstab
mount -a && df -h /srv/minio                   # deve mostrar ~500G montados em /srv/minio
```

*(Snapshot do lado do host, se quiseres: `zfs snapshot storage-zfs/vm-300-disk-1@$(date +%F)`.)*

---

## 4. Deploy do MinIO (usa o `deploy/minio/` do repo)

```bash
cd /root/netprospect-v1/deploy/minio
cp .env.example .env
# preencher .env:
#   MINIO_ROOT_USER      = netprospect        (igual ao HEL1)
#   MINIO_ROOT_PASSWORD  = <copiar de docker/.env do HEL1>   (MESMA pass → app não muda)
#   TAILNET_IP           = <DEMINIO_IP>       (tailscale ip -4)
chmod 600 .env
docker compose up -d && docker compose ps
```

O MinIO fica em `<DEMINIO_IP>:9000` (API, só tailnet) e `127.0.0.1:9001` (consola, só por túnel SSH).
Os buckets `snapshots` e `reports` são criados pela app no arranque (`ensureBucket`/`ensureReportsBucket`).

---

## 5. Migrar os dados existentes (HEL1 → de-minio)

> Hoje são ~571 MB de reports + ~10 MB de snapshots. Fazer **agora**, antes de encher.

```bash
# No HEL1. Password = a de docker/.env (MINIO_ROOT_PASSWORD). SRC = MinIO local; DST = de-minio.
PASS=$(grep -oP '(?<=^MINIO_ROOT_PASSWORD=).*' /root/Github/netprospect-v1/docker/.env)
docker run --rm --network host \
  -e MC_HOST_src="http://netprospect:${PASS}@127.0.0.1:9000" \
  -e MC_HOST_dst="http://netprospect:${PASS}@<DEMINIO_IP>:9000" \
  minio/mc mirror --preserve src/reports dst/reports
docker run --rm --network host \
  -e MC_HOST_src="http://netprospect:${PASS}@127.0.0.1:9000" \
  -e MC_HOST_dst="http://netprospect:${PASS}@<DEMINIO_IP>:9000" \
  minio/mc mirror --preserve src/snapshots dst/snapshots

# Verificar que as contagens batem certo
for H in "http://netprospect:${PASS}@127.0.0.1:9000|SRC" "http://netprospect:${PASS}@<DEMINIO_IP>:9000|DST"; do
  docker run --rm --network host -e MC_HOST_x="${H%|*}" minio/mc ls --recursive x/reports | wc -l
done
```

---

## 6. Repontar a app (no HEL1)

```bash
cd /root/Github/netprospect-v1
sed -i 's|^MINIO_URL=.*|MINIO_URL=http://<DEMINIO_IP>:9000|' docker/.env   # era http://minio:9000

# recriar os serviços que falam com o MinIO (workers pesados + dashboard) p/ apanharem a env nova
cd docker && docker compose up -d --force-recreate worker dashboard
```

---

## 7. Verificação (OBRIGATÓRIA antes de desmantelar o do HEL1)

```bash
# 1) Escrita: forçar uma auditoria (o lighthouse escreve o report integral no MinIO)
node enqueue-audits.js --domain=<um-dominio-qualificado>          # ou o fine: --only=lighthouse

# 2) O objeto novo aparece no de-minio?
ssh root@<DEMINIO_IP> 'ls -la /srv/minio/reports/ | tail'

# 3) O ponteiro _full ficou no Postgres (bucket/key/bytes)?
ssh root@100.77.60.44 "sudo -u postgres psql -d netprospect -tAc \
  \"SELECT report->'_full' FROM site_reports WHERE kind='lighthouse_seo' ORDER BY id DESC LIMIT 1\""

# 4) Leitura ponta-a-ponta (o que gera o PDF do cliente)
node -e "import('./lib/artifacts.js').then(async m => console.log(await m.getReport('<siteId>/lighthouse_seo.json.gz') ? 'LEU OK' : 'null'))"
```

---

## 8. Desmantelar o MinIO do HEL1 (só depois do §7 passar)

```bash
cd /root/Github/netprospect-v1/docker
docker compose stop minio && docker compose rm -f minio
# comentar o serviço `minio` no docker-compose.yml (mantém o volume p/ rollback)
# NÃO apagar ./docker/.data/minio ainda — é o rollback.
```

## Rollback

`sed -i 's|^MINIO_URL=.*|MINIO_URL=http://minio:9000|' docker/.env` + `docker compose up -d minio worker dashboard`.
Os dados locais continuam intactos em `docker/.data/minio`.

## Depois: atualizar o inventário

Marcar `de-minio` como ✅ na §0 da [`LOAD-DISTRIBUTION.md`](../LOAD-DISTRIBUTION.md) com o `<DEMINIO_IP>`.

## Notas operacionais

- **Fail-soft:** `putReport()` (`lib/artifacts.js`) devolve `null` se o storage falhar → a auditoria
  **nunca** morre por causa do MinIO; o `site_reports` fica só com o resumo (`_full` a null).
- **Backup:** os relatórios são **regeneráveis** (re-auditar). Não justificam RAID; se o custo de
  re-auditar subir, um `mc mirror` periódico para outra VM chega. Com a Opção B (ZFS-na-VM), snapshots
  locais: `zfs snapshot minio@$(date +%F)`.
- **Lifecycle:** expiração por bucket, ex. snapshots a 90 dias: `mc ilm rule add --expire-days 90 dst/snapshots`.
- **Consola web:** por túnel `ssh -L 9001:127.0.0.1:9001 root@<DEMINIO_IP>` → http://localhost:9001,
  **ou** em https://netprospect.minio.netmaster.pt (NPMPlus + Authentik). Para o reverse-proxy chegar à
  consola, ela tem de bindar o **tailnet** (`${TAILNET_IP}:9001`), não só `127.0.0.1` — o NPMPlus aponta
  a `http://<DEMINIO_IP>:9001` e é preciso `MINIO_BROWSER_REDIRECT_URL=https://netprospect.minio.netmaster.pt`
  no `.env` (senão o login redireciona para o host interno e parte). **Não** era a firewall do DE1.
