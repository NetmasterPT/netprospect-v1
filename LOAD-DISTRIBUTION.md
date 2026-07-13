# Load Distribution — plano de deploy da frota

## 0. Inventário VIVO da frota (Claude mantém isto a cada VM que entra)

> Modelo de gestão: **tu** crias a VM + corres `deploy/bootstrap-vm.sh` (Docker+Tailscale+repo);
> **Claude** faz o deploy do role (compose+env) via tailnet e atualiza esta tabela. Ambos com SSH.

| Hostname (Tailscale) | Tailnet IP | Servidor | Role/stack | Imagem | Réplicas | Estado |
|----------------------|-----------|----------|-----------|--------|---------:|--------|
| *(HEL1 monolito)* | 100.108.94.126 | hel1 | App + browser + base + NATS/Redis/Directus/MinIO/ClickHouse | ambas | 4H+5B | ✅ a correr |
| np-db | 100.77.60.44 | hel1 | Postgres + PgBouncer | — | — | ✅ a correr |
| *(DE1 base)* | 100.120.214.45 | de1 | `base` (whois) + fila dedicada | worker-base | 4 | ✅ a correr |
| *(DE1 heavy)* | 100.120.214.45 | de1 | `security` (nuclei/wpscan) | worker | 3 | ✅ a correr |
| **de-minio** | *(a criar)* | de1 | MinIO — 500G storage-zfs / ext4 | minio | 1 | ❌ **Fase 2 — VM por criar (VMID 300)** |

*Ainda por criar:* de-clickhouse · hel1-ollama · np-server (decompor) · oracle A1-1/A1-2/AMD-1/AMD-2 · gcp e2-micro.

---


> **Princípio único:** cada peça vive onde o seu **perfil de I/O** encaixa — não onde "sobra espaço".
> Foi provado por medição, não por palpite (ver a coluna *evidência*). Mover a coisa errada custa
> throughput: os workers remotos morriam à fome quando competiam com o HEL1 na workqueue partilhada
> do NATS, e o Ollama sozinho comia 14 de 18 cores.

---

## 1. As 4 classes de worker (o que decide ONDE cada job corre)

Medido hoje, por ferramenta:

| Classe | Role(s) | Jobs | Perfil | **Evidência (medida)** | Corre bem em |
|--------|---------|------|--------|------------------------|--------------|
| **B — Base** | `base` | enrich, contacts, fetch, dns, geoip, whois, ssl, dnsprovider, fingerprint, traffic, score, subdomains | Network-bound + CPU leve | whois 2.676/h a load ~1; fingerprint é o único CPU-médio (parse wappalyzer) | Qualquer VM (free incluído) |
| **L — Light/Security** | `security` | nuclei, wpscan | **Network-bound puro (~0 CPU)** | **DE1 a 1.092 nuclei/h com load 0,30** | **VMs FRACAS/free** ⭐ |
| **H — Heavy/Browser** | `browser` | lighthouse, gmb | **CPU-BOUND (Chromium ~1,5 core/job)** | HEL1 864 lighthouse/h, load sobe a 15+ se a conc passar | **VMs com cores a sério** |
| **AI** | `ai` | industry (Ollama) | **CPU-BOUND puro (GPU-ideal)** | **107 s/classificação em CPU → 26 dias; roubava CPU ao Lighthouse** | **VM de IA (GPU) — parado** |

**A chave:** **B e L são network-bound → cabem nas free clouds.** Só **H e AI** precisam de cores.
E cada VM extra traz o **seu IP** → quota própria de rate-limit (registries do whois, APIs de verify).

### Imagens Docker (uma refinação a fazer)
- **`worker-base`** (664 MB): role `base`. Leve, arm64-fácil → free VMs.
- **`worker-security`** *(A CRIAR — node + nuclei + wpscan, SEM Chromium)*: role `security`. Hoje o
  nuclei está na imagem pesada (2,46 GB, com Chromium a peso morto). Uma imagem só-security (~1 GB)
  desbloqueia pôr o `security` nas free VMs. → é a peça que falta para escalar o Nuclei.
- **`worker`** (2,46 GB): roles `browser` + `ai` (Chromium + Ollama). Só VMs fortes.

---

## 2. Colocação da infraestrutura (containers não-worker)

| Container | Perfil | → Vai para | Prioridade | Estado |
|-----------|--------|-----------|-----------|--------|
| **postgres + pgbouncer** | disco rápido + latência à app | **np-db** | — | ✅ **FEITO** |
| **nats** | ⚡ **latência-CRÍTICA** (workers puxam em loop) | **np-server** (central) | ⛔ **nunca mover** | fica |
| **redis** | latência-sensível (cache+telemetria), minúsculo | **np-server** | ⛔ **nunca mover** | fica |
| **directus** | REST sobre a DB (workers já contornam via A2) | **np-server** ¹ | 🟡 | separar |
| **dashboard** | leve, user-facing | **np-server** | 🟢 | separar |
| **minio** | **disco-pesado**, escreve-1×/lê-raro, latency-**tolerante** | **de-minio (HDD)** | 🔴 **ALTA** | runbook pronto ² |
| **clickhouse** | disco-pesado, analítico | **de-clickhouse (HDD)** *ou desmantelar* | 🟠 | decidir ³ |
| **ollama** | **CPU/GPU-bound** | **hel1-ollama** (idealmente GPU) | 🟠 | parado (CPU não chega) |

<sub>¹ Directus pode ir para np-server (com NATS/Redis) OU co-localizar em np-db (poupa o round-trip à DB).
Como os workers agora escrevem direto ao PG (A2), a chattiness dele importa menos → np-server serve. Se
voltar a ser gargalo, mover para np-db. · ² [`docs/runbook-minio-de1.md`](docs/runbook-minio-de1.md) ·
³ Se a Fase E (analytics) nunca arrancou a sério, o ClickHouse é 3 GB a não fazer nada → desmantelar.</sub>

---

## 3. Tabela de VMs (alvo)

> `Deployed`: ✅ a correr · 🟡 existe no monolito HEL1 (a separar) · ❌ por criar.
> CPU/RAM das VMs a criar são **propostas** — ajustar à capacidade dos Proxmox.

| Server | VM | CPU | RAM | Disk | Egress | Type | Jobs / Containers | Deployed | Created |
|--------|-----|-----|-----|------|--------|------|-------------------|----------|---------|
| hel1 | **np-db** | 14 | 64 GB | NVMe | Unlimited | DB | Postgres + PgBouncer | ✅ | ✅ |
| hel1 | **np-server** | 4 | 16 GB | NVMe | Unlimited | App | Directus, Redis, **NATS**, dashboard | 🟡 | ✅ |
| hel1 | **hel1-ollama** | 6 | 8 GB | — | Unlimited | AI | `ai` (industry) — *só útil c/ GPU* | ❌ | ✅ |
| hel1 | **Worker H** | 6 | 16 GB | — | Unlimited | Heavy | `browser` (lighthouse) — imagem pesada | 🟡 | ✅ |
| hel1 | **Worker B** | 2 | 8 GB | — | Unlimited | Base | `base` (pipeline) | 🟡 | ✅ |
| hel1 | **Worker L** | 2 | 4 GB | — | Unlimited | Light | `security` (nuclei/wpscan) | ❌ | ❌ |
| de1 | **de-minio** | 2 | 4 GB | **HDD grande** | Unlimited | Storage | MinIO (reports + snapshots) | ❌ | ❌ |
| de1 | **de-clickhouse** | 2 | 8 GB | **HDD grande** | Unlimited | Analytics | ClickHouse *(ou desmantelar)* | ❌ | ❌ |
| de1 | **Worker H** | 4 | 8 GB | — | Unlimited | Heavy | `browser` (lighthouse) | ❌ | ❌ |
| de1 | **Worker B** | 2 | 4 GB | — | Unlimited | Base | `base` | ✅ | ✅ |
| de1 | **Worker L** | 3 | 6 GB | — | Unlimited | Light | `security` (nuclei/wpscan) | ✅ | ✅ |
| oracle | **A1-1** | 1 (ARM) | 6 GB | 48 GB | 10 TB | Light+Base | `security` + `base` *(imagem arm64)* | ❌ | ✅ |
| oracle | **A1-2** | 1 (ARM) | 6 GB | 48 GB | 10 TB | Light+Base | `security` + `base` | ❌ | ✅ |
| oracle | **AMD-1** | 1/8 | 1 GB | 48 GB | 10 TB | Light | whois / verify (baixa conc) | ❌ | ✅ |
| oracle | **AMD-2** | 1/8 | 1 GB | 48 GB | 10 TB | Light | whois / verify | ❌ | ✅ |
| gcp | **e2-micro** | 2 | 1 GB | 30 GB | **1 GB** | Light | **só whois/verify** (egress minúsculo) ⁴ | ❌ | ✅ |

<sub>⁴ O egress de 1 GB/mês do GCP proíbe jobs que descarregam páginas (lighthouse ~1-3 MB/site). whois
(~3 KB) e verify (bytes) cabem à vontade. Nuclei dispara muitos pedidos → só nas Oracle (10 TB).</sub>

---

## 4. Estratégia das free VMs (o valor é o IP, não os cores)

Cada VM free traz **1 IP público** → **quota própria** onde há rate-limit **por IP**:
- **whois** — as registries limitam por IP → +N IPs = +N× throughput de whois (o backlog são 283k).
- **verify** (email) — as APIs free limitam por IP/conta → cada VM = uma quota free.
- **nuclei** — espalha o scan por IPs (menos hipótese de um IP ser flagged).

**Fila dedicada vs role-split:** para os jobs **network-bound** (base/security), não é preciso a fila
dedicada — basta darem-se **roles diferentes** por VM (consumers diferentes = sem competição no pull).
A fila dedicada (`JOB_STREAM`/feeder, commit `73f06a7`) fica reservada para quando se quiser dar a um
host remoto uma fatia de um job que os locais **também** consomem.

---

## 5. Plano de ataque (por valor/risco)

**Fase 1 — Free VMs como Worker L (security + whois)** · *risco baixo, valor alto, add-only*
- Construir a imagem **`worker-security`** (arm64 + amd64) sem Chromium.
- Oracle A1-1/A1-2: `security` + `base`. GCP/AMD: `whois`/`verify`.
- Ganho: nuclei escala para lá do DE1 + o whois drena muito mais depressa (IPs).
- Padrão **já provado** com o DE1 hoje. Sem tocar no HEL1.

**Fase 2 — MinIO → de-minio (HDD)** · *risco quase nulo (fail-soft), runbook pronto*
- Atribuir o HDD à VM, seguir [`docs/runbook-minio-de1.md`](docs/runbook-minio-de1.md).
- Liberta o NVMe do HEL1 (os reports já vão em 571 MB e crescem).

**Fase 3 — Decompor o HEL1 monolítico** · *risco médio (mexe no que corre) → fazer com os backfills drenados*
- Separar `np-server` (Directus/Redis/NATS/dashboard), `Worker H` (browser), `Worker B` (base).
- Cada um numa VM → o Directus deixa de competir com o Chromium (o "under pressure" desaparece).

**Fase 4 — Decisões finais**
- ClickHouse: usar (→ de-clickhouse) ou desmantelar?
- Ollama/industry: adquirir GPU ou trocar por classificador heurístico?
- Directus: np-server ou co-localizar em np-db?

---

## 6. Decisões em aberto (precisam de ti)
1. **Método de deploy** — hoje é docker-compose manual por VM (`np-worker`, `np-worker-heavy`). Escalar
   para ~10 VMs pede algo sistemático: repo + `.env` por-VM + script/Makefile de deploy? cloud-init?
2. **ClickHouse** — está a ser usado? Se não → desmantelar (poupa 3 GB + um container).
3. **Oracle A1 = ARM** — construir imagem multi-arch (arm64)? (nuclei/wpscan/node suportam; sem Chromium é trivial.)
4. **industry (IA)** — vale uma VM com GPU, ou trocamos o Ollama por regras/keywords (barato, "bom o suficiente")?
5. **WPScan API key** — 25 pedidos/dia no free → só dá para on-demand, não batch.
