---
title: Frota distribuída de workers (VMs cloud, free-tier)
type: explanation
tags: [infra, architecture]
related: []
owner: infra
status: stable
updated: 2026-07-13
visibility: internal
---

# Frota distribuída de workers (VMs cloud, free-tier)

Como pôr **workers a correr noutras VMs** (Oracle, GCP, etc.) que reportam à **mesma
stack central** (Directus + NATS + Postgres). Caso de uso principal: **verificação de
email à escala** — cada VM traz **1 IP + as suas contas free** de APIs de verificação,
multiplicando a quota gratuita. As VMs também podem ajudar no **enrich / extract**.

> **Modelo mental.** O recurso escasso NÃO é CPU — é **quota free por IP/conta**. Cada
> VM = 1 IP = N chaves QEV (100/dia cada). Muitas VMs pequenas grátis > 1 VM grande.
> Ver o **README § “Frota de verificação — a matemática”** para calcular a capacidade.

Assume-se **Debian 12 (bookworm)** nas VMs. Tudo o que é secreto (token do Directus,
chaves das APIs) fica em ficheiros **gitignored**, nunca na imagem.

---

## 0. Arquitetura em 30 segundos

```
        ┌─────────────── HOST CENTRAL (a tua máquina) ───────────────┐
        │  Directus(:8056) · NATS JetStream(:4222) · Redis            │
        │  (Postgres → np-db · MinIO → de-minio, VMs próprias)        │
        │  enqueue-email-verification.js  ──publica──▶  jobs.verify   │
        └───────────────▲───────────────────────────▲────────────────┘
                        │ Tailnet (WireGuard)        │ Directus REST (token)
          ┌─────────────┴───────┐        ┌───────────┴─────────────┐
          │  VM Oracle (IP #1)  │        │   VM GCP (IP #2)  …      │
          │  worker WORKER_ROLES│        │  worker WORKER_ROLES     │
          │  =verify            │        │  =verify                 │
          │  config/verify-     │        │  config/verify-          │
          │  providers.json (K1)│        │  providers.json (K2)     │
          └─────────────────────┘        └──────────────────────────┘
```

- O worker liga-se ao **NATS central** (fila) e ao **Directus central** (dados). **Não**
  precisa de Postgres nem — para verify puro — de MinIO.
- A fila é **workqueue**: cada job vai a **um** worker. Acrescentar/remover VMs
  reparte automaticamente, sem sobreposição.
- **Auto-throttle:** quando um worker esgota a quota free do dia, os jobs voltam à fila
  (nak) e os contactos ficam por verificar (`email_status=null`) → entram no lote seguinte.

---

## 1. Lado CENTRAL (fazer uma vez)

### 1.1 Expor o NATS na Tailnet
O NATS está publicado só em `127.0.0.1:4222`. Para as VMs remotas o alcançarem, publica-o
na **interface Tailscale deste host** (nunca `0.0.0.0` — o NATS aqui não tem auth):

```bash
tailscale ip -4                      # ex.: 100.101.102.103  (IP tailnet do host central)
# em docker/.env:
echo 'NATS_BIND=100.101.102.103' >> docker/.env
docker compose -f docker/docker-compose.yml up -d nats   # recria o container com o novo bind
```

O Directus (`:8056`) já escuta em todas as interfaces → acessível pela tailnet
(`http://100.101.102.103:8056`) **ou** pelo URL público (npmPlus/Authentik).

### 1.2 Auth key da Tailscale para as VMs
No admin da Tailscale (**Settings → Keys**) gera uma **auth key** reutilizável (idealmente
com tag `tag:worker`). Guarda-a — vais colá-la em cada VM (`tailscale up --authkey=...`).

### 1.3 Firewall
Garante que o host central **só** aceita `:4222` pela interface tailnet (o bind acima já
o limita ao IP tailnet). Confirma que a tailnet ACL permite `tag:worker → host:4222,8056`.

---

## 2. Provisionar UMA VM (Debian 12)

Repetir por cada VM da frota. (Que VMs free escolher → README § clouds free-tier.)

### 2.1 Base do SO + swap (essencial em VMs de 1 GB)
```bash
sudo apt-get update && sudo apt-get -y upgrade
# Swap de 2 GB — evita OOM no build da imagem e dá folga ao Node numa micro de 1 GB.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2.2 Docker + Docker Compose plugin
```bash
curl -fsSL https://get.docker.com | sh          # Docker Engine + plugin compose (oficial)
sudo usermod -aG docker "$USER"                 # correr docker sem sudo (re-login depois)
newgrp docker
docker compose version                          # confirma o plugin v2
```
<details><summary>Alternativa manual (sem o script get.docker.com)</summary>

```bash
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```
</details>

### 2.3 Tailscale (juntar à tailnet)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --authkey=tskey-auth-XXXX --hostname=np-worker-oracle-1
tailscale ping 100.101.102.103                  # confirma alcance ao host central
```

### 2.4 Código do repo
```bash
# Opção A — git (se tiveres o repo em git/GitHub):
git clone <repo-url> netprospect && cd netprospect
# Opção B — sem git: no host central, rsync p/ a VM (pela tailnet):
#   rsync -az --exclude node_modules --exclude .data --exclude out ./ np-worker:~/netprospect/
```

### 2.5 Chaves free DESTE VM (uma quota por IP)
Cria **`config/verify-providers.json`** com as contas free **deste** IP (ver
`config/verify-providers.example.json` para o formato multi-key / keyless):
```json
[
  { "provider": "quickemailverification", "apiKey": "CHAVE_QEV_1_DESTE_IP", "dailyLimit": 100 },
  { "provider": "quickemailverification", "apiKey": "CHAVE_QEV_2_DESTE_IP", "dailyLimit": 100 },
  { "provider": "quickemailverification", "apiKey": "CHAVE_QEV_3_DESTE_IP", "dailyLimit": 100 },
  { "provider": "disify" }
]
```
> Uma conta free por IP: cria as contas QEV **a partir deste IP** (ou aceita que sejam
> por-chave — ver README). `disify` é keyless e conta por-IP (1000/dia) → grátis extra.

### 2.6 Configurar e arrancar o worker
```bash
cp docker/.env.worker.example docker/.env.worker
# editar docker/.env.worker:
#   NATS_URL=nats://100.101.102.103:4222
#   DIRECTUS_URL=http://100.101.102.103:8056        (ou o URL público)
#   DIRECTUS_TOKEN=<o mesmo static token do docker/.env central>
#   WORKER_ROLES=verify
docker compose --env-file docker/.env.worker -f docker/docker-compose.worker.yml up -d --build
docker compose --env-file docker/.env.worker -f docker/docker-compose.worker.yml logs -f
```
Deves ver: `ligado ao NATS`, `consumers ativos: verify`, e (quando houver jobs)
`verify <domínio>: {...}`.

---

## 3. Operação diária (no host central)

Enfileira um lote ≈ **capacidade da frota**, priorizando as leads mais valiosas
(`lead_score` desc). Corre **uma vez por dia** (cron):
```bash
# capacidade(domínios) ≈ capacidade_diária_emails / 5.5   (média de contactos/domínio)
node enqueue-email-verification.js --limit=300            # ex.: ~1500 emails/dia
node enqueue-email-verification.js --tld=pt --limit=200   # só .pt
node enqueue-email-verification.js --dry-run --limit=20   # ver o que enfileiraria
```
Exemplo de cron (07:00 diário):
```
0 7 * * *  cd /caminho/netprospect && /usr/bin/node enqueue-email-verification.js --limit=300 >> out/enqueue-verify.log 2>&1
```
Os workers da frota drenam `jobs.verify` ao seu ritmo; ao esgotar a quota, param e
retomam no lote do dia seguinte. Sem intervenção.

---

## 4. Ajudar também no ENRICH / EXTRACT (opcional)

Duas formas de repartir enrich/extract por várias VMs **sem sobreposição**:

**(a) Sharding do script standalone** — determinístico, sem fila. Em cada VM (com o repo
+ o ficheiro de domínios ou acesso ao Directus). Numa frota grande (até ~30 VMs) usa
`--shard=i/30` — cada VM é lenta sozinha mas 30× em paralelo = muito mais jobs/s que o host:
```bash
# 30 VMs a enriquecer o NL, cada uma 1/30 dos domínios:
node enrich-sites.js --input=out/dominios_nl.txt --shard=0/30 --concurrency=4   # VM 1
node enrich-sites.js --input=out/dominios_nl.txt --shard=1/30 --concurrency=4   # VM 2  … etc.
# 30 VMs a extrair contactos .pt:
node extract-contacts.js --tld=pt --shard=0/30 --concurrency=4                  # VM 1 … etc.
```
`hash(domínio)%N==i` → cada domínio cai sempre no mesmo shard; resume via `checked_at`.

> **Exit nodes / proxies (só Oracle).** As VMs Oracle (10 TB egress) podem servir de
> **Tailscale exit node** e/ou proxy HTTP para dar **diversidade de IP** ao crawling e ao
> routing das APIs de verificação (`config/verify-proxies.json`). **NÃO uses o GCP** para
> isto — o limite de 1 GB/mês de egress esgota num instante. Ver o perfil `egress` em
> `docker/docker-compose.yml` (`tailscale-egress`, `TS_EXIT_NODE`).

**(b) Fila** — `WORKER_ROLES=base` (ou `verify,base`) no `.env.worker`; no host central
`node enqueue-enrich.js …` publica `jobs.enrich`; os workers base drenam. (Precisa de
`MINIO_URL` no `.env.worker`, a apontar à VM `de-minio` — o enrich/contacts lêem snapshots.)

Uma VM Oracle A1 (2 OCPU/12 GB) aguenta `WORKER_ROLES=verify,base` (verifica **e** ajuda
no crawling). VMs micro de 1 GB → só `verify`.

---

## 5. Monitorizar / escalar / desmontar

```bash
# Profundidade da fila (no host central):
node -e "import('./lib/jobs.js').then(async m=>{const nc=await m.connectJobs('nats://localhost:4222');const jsm=await nc.jetstreamManager();const c=await jsm.consumers.info('NP_JOBS','verify');console.log('verify pendentes:',c.num_pending,'| a processar:',c.num_ack_pending);await nc.drain();})"

# Logs de um worker:
docker compose --env-file docker/.env.worker -f docker/docker-compose.worker.yml logs --tail=50 -f
# Atualizar código numa VM:  git pull && docker compose … up -d --build
# Parar/remover:            docker compose --env-file docker/.env.worker -f docker/docker-compose.worker.yml down
```
**Escalar** = provisionar mais uma VM (repetir §2) com **novas** contas free. Cada VM
soma a sua quota. Ver a matemática no README.

---

## 6. Troubleshooting

| Sintoma | Causa provável | Resolução |
|---|---|---|
| Worker: `ligado ao NATS` nunca aparece | NATS não exposto na tailnet / firewall | §1.1 (`NATS_BIND`), `tailscale ping` ao host, ACL |
| `consumers ativos: verify` mas 0 jobs | Fila vazia | Correr `enqueue-email-verification.js` no central |
| Verifica tudo como `unknown` | `config/verify-providers.json` vazio/ausente no VM | §2.5; confirmar que o ficheiro EXISTE antes do `up` |
| Muitos `no_mx` | Domínios parqueados/sem MX (correto, não é bug) | Nada — são leads sem email real |
| Jobs voltam sempre (nak) | Quota free esgotada | Normal ao fim do dia; retomam amanhã. Ou juntar mais chaves/IPs |
| Oracle A1 desapareceu | Idle-reclamation (7 dias <20% CPU+rede+RAM) | Manter carga (o worker já consome); ou um cron `lookbusy` |
| `403`/CAPTCHA a chamar APIs | Reputação do IP de datacenter | Rotear por proxy (config/verify-proxies.json) ou outro IP |

> **Porta 25 / SMTP:** todas as clouds free bloqueiam a saída na porta 25. **Não afeta** a
> verificação (usa APIs HTTPS) nem o crawling. Só afeta o **envio** de email — esse fica
> nas VMs de IP limpo do outreach (ver `docs/outreach-ops/`), não nesta frota.
