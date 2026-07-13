# Load Distribution — plano de deploy da frota

## 0. Inventário VIVO da frota (Claude mantém isto a cada VM que entra)

> Modelo de gestão: **tu** crias a VM + corres `deploy/bootstrap-vm.sh` (Docker+Tailscale+repo);
> **Claude** faz o deploy do role (compose+env) via tailnet e atualiza esta tabela. Ambos com SSH.

| Hostname (Tailscale) | Tailnet IP | Servidor | Role/stack | Imagem | Réplicas | Estado |
| --- | --- | --- | --- | --- | ---: | --- |
| *(HEL1 monolito)* `hel1-docker` | 100.108.94.126 | hel1 | App + `browser` + `base` + NATS/Redis/Directus/ClickHouse | ambas | 4H+5B | ✅ a correr |
| **np-db** | 100.77.60.44 | hel1 | Postgres + PgBouncer | — | — | ✅ a correr |
| **np-wk-de1** | 100.120.214.45 | de1 | `base` (whois) + fila dedicada — projeto `/root/np-worker` (`.env.worker`) | worker-base | 4 | ✅ a correr |
| **np-wk-de1** | 100.120.214.45 | de1 | `security` (nuclei/wpscan) + `ai` — projeto `/root/np-worker-heavy` (`.env.heavy`) | worker | 3 | ✅ a correr |
| **de-minio** | 100.124.43.117 | de1 | MinIO — 500G storage-zfs / ext4 (VMID 300) | minio | 1 | ✅ **MIGRADO — toda a frota escreve aqui** |
| **hel1-ollama** | 100.126.196.112 (LAN `10.10.10.53`) | hel1 | Ollama (CPU, sem GPU) — LXC CT, nativo | — | — | ✅ a servir on-demand |
| **de-analytics** | 100.115.240.35 | de1 | ClickHouse (10,2M observações) — 200G ext4 (VMID 301) | clickhouse | 1 | ✅ **MIGRADO** |
| **de1-pve** | 100.87.226.117 | de1 | *host Proxmox* (não é da stack — exit node, `tag:proxmox`) | — | — | ✅ |
| **gpedro-laptop** | *(no tailnet)* | laptop | `residential` (**GMB** — IP residencial) + overflow opcional | worker | 1 | 🟡 daily-driver; **intermitente**, entra a pedido ⁸ |

*Ainda por criar:* **np-server** (VMID 801) · Worker VMs (decompor o HEL1) · **PostHog** (na de-analytics,
opt-in) · oracle A1-1/A1-2/AMD-1/AMD-2 · gcp e2-micro.

> **O que está a bloquear os 3 deploys pendentes** (o compose+env de cada um **já existe** em
> `deploy/{server,analytics,ollama}/` → o deploy é 1 comando assim que houver acesso):
>
> | VM | Bloqueio | Quem desbloqueia |
> | --- | --- | --- |
> | `np-server` | VM não existe | **tu** — [runbook](docs/runbook-server-hel1.md) §1-2 (criar + bootstrap) |

> ### ⚠️ Convenções de provisionamento — aplicar a TODA a VM nova
>
> - **Bridge:** sempre **`vmbr1`** (HEL1 e DE1). A `vmbr0` está reservada para a VM da WHM (fora da stack).
> - **IP LAN estático:** último octeto = o **VMID sem o dígito das dezenas** → `300`→`10.10.10.30`,
>   `301`→`.31`, `801`→`.81`, `900`→`.90`. Gateway `10.10.10.1`, /24. **Nunca DHCP.**
> - **Storage:** HEL1 = `local-zfs` · DE1 = `storage-zfs`. Dentro da VM usa-se **ext4** (não ZFS-on-ZFS).
> - **CPU type = `host`** (`qm create ... --cpu host`). O default `kvm64` é x86-64-**v1**, e o MinIO /
>   ClickHouse / PostHog exigem **v2** → arrancam com `Fatal glibc error: CPU does not support x86-64-v2`.
>   Já criada? `qm set <id> --cpu host` + **cold-boot** (`qm stop`+`qm start`; um reboot interno não chega).
> - **`qemu-guest-agent`:** o `--agent 1` só abre o canal — o pacote instala-se **dentro** da VM
>   (`apt install -y qemu-guest-agent`). O `bootstrap-vm.sh` já o faz.
> - 🚫 **NUNCA corras o `bootstrap-vm.sh` no host Proxmox** — ele instala o Docker, que põe a chain
>   `FORWARD` a `DROP`, e como as VMs saem para a internet *encaminhadas pelo host*, **todas** perdem
>   internet→tailnet de uma vez. (Aconteceu no DE1.) O script agora recusa-se a correr se vir `/etc/pve`.
> - Cross-datacenter só pela **tailnet** — as LANs `10.10.10.0/24` do HEL1 e do DE1 são **separadas**.

---

> **Princípio único:** cada peça vive onde o seu **perfil de I/O** encaixa — não onde "sobra espaço".
> Foi provado por medição, não por palpite (ver a coluna *evidência*). Mover a coisa errada custa
> throughput: os workers remotos morriam à fome quando competiam com o HEL1 na workqueue partilhada
> do NATS, e o Ollama sozinho comia 14 de 18 cores.

---

## 1. As 4 classes de worker (o que decide ONDE cada job corre)

| Classe | Role(s) | Jobs | Perfil | **Evidência (medida)** | Corre bem em |
| --- | --- | --- | --- | --- | --- |
| **B — Base** | `base` | enrich, contacts, fetch, dns, geoip, whois, ssl, dnsprovider, fingerprint, traffic, score, subdomains | Network-bound + CPU leve | whois 2.676/h a load ~1; o `fingerprint` é o único CPU-médio (parse wappalyzer) | Qualquer VM (free incluído) |
| **L — Light/Security** | `security` | nuclei, wpscan | **Network-bound puro (~0 CPU)** | **DE1 a 1.092 nuclei/h com load 0,30** | **VMs FRACAS/free** ⭐ |
| **H — Heavy/Browser** | `browser` | lighthouse, gmb | **CPU-BOUND (Chromium ~1,5 core/job)** | HEL1 864 lighthouse/h; a load passa 15 se a conc subir | **VMs com cores a sério** |
| **AI** | `ai` | industry | **CPU-BOUND** (sem GPU) | Ollama em CPU: **107 s/job** (26 dias p/ o batch) → o **batch usa o heurístico** (6.640/h, 154×) | `hel1-ollama` — só on-demand |
| **R — Residential** | `residential` | gmb | **precisa de IP residencial** (o Google bloqueia datacenter) | GMB em Hetzner → página `/sorry/` (envenenava a DB) | **só o `gpedro-laptop`** |

**A chave:** **B e L são network-bound → cabem nas free clouds.** Só **H** precisa de cores a sério.
E cada VM extra traz o **seu IP** → quota própria de rate-limit (registries do whois, APIs de verify).

### Imagens Docker

- **`worker-base`** (664 MB): role `base`. Leve, arm64-fácil → free VMs.
- **`worker-security`** *(A CRIAR — node + nuclei + wpscan, SEM Chromium)*: role `security`. Hoje o
  nuclei vive na imagem pesada (2,46 GB, com Chromium a peso morto). Uma imagem só-security (~1 GB)
  desbloqueia pôr o `security` nas free VMs → **é a peça que falta para escalar o Nuclei**.
- **`worker`** (2,46 GB): roles `browser` + `ai` (Chromium + Ollama). Só VMs fortes.

---

## 2. Colocação da infraestrutura (containers não-worker)

| Container | Perfil | → Vai para | Prioridade | Estado |
| --- | --- | --- | --- | --- |
| **postgres + pgbouncer** | disco rápido + latência à app | **np-db** | — | ✅ **FEITO** |
| **minio** | **disco-pesado**, escreve-1×/lê-raro, latency-**tolerante** | **de-minio** (HDD/DE1) | — | ✅ **FEITO** ² |
| **nats** | ⚡ **latência-CRÍTICA** (workers puxam em loop) | **np-server** (central) | ⛔ nunca sair do centro | separar ¹ |
| **redis** | latência-sensível (cache+telemetria), minúsculo | **np-server** | ⛔ nunca sair do centro | separar ¹ |
| **directus** | REST sobre a DB (os workers já a contornam via A2) | **np-server** | 🟡 | separar ¹ |
| **dashboard** | leve, user-facing | **np-server** | 🟢 | separar ¹ |
| **clickhouse** (+ posthog opt-in) | disco-pesado, analítico (a Fase E tem **10,2M observações**) | **de-analytics** (DE1) | — | ✅ **FEITO** ³ |
| **ollama** | CPU-bound — **sem GPU** (decisão de custo: fica em CPU) | **hel1-ollama** | — | ✅ **FEITO** ⁴ |

<sub>
¹ **np-server** (nova VM no HEL1, VMID 801 → `10.10.10.81`) leva Directus + Dashboard + NATS + Redis.
Fica no MESMO host Proxmox dos workers de Helsínquia → LAN (~0,1 ms), porque estes 4 estão no *hot-path*.
O único estado a migrar é o JetStream do NATS. Runbook: <a href="docs/runbook-server-hel1.md">docs/runbook-server-hel1.md</a>.
<br>
² **Feito** (2026-07): 16.929 reports + 20 snapshots (843 MB) migrados para a `de-minio`; HEL1 e DE1
(ambos os projetos compose) escrevem lá; round-trip `putReport`/`getReport` validado das duas pontas.
Runbook: <a href="docs/runbook-minio-de1.md">docs/runbook-minio-de1.md</a>. O MinIO local do HEL1 fica
parado como rollback (dados intactos em <code>docker/.data/minio</code>).
<br>
³ **Feito** (2026-07): ClickHouse migrado para a <strong>de-analytics</strong> (DE1) — 10.236.938
observations + 43.106 change_events, contagem exata; escrita+leitura remotas validadas; o CH local do
HEL1 desmantelado (rollback em <code>docker/.data/clickhouse</code>). O <strong>PostHog</strong> (opt-in
pesado, +4-6 GB) fica para depois, na mesma VM. Runbook: <a href="docs/runbook-analytics-de.md">docs/runbook-analytics-de.md</a>.
<br>
⁴ **Sem GPU (decisão de custo).** O Ollama fica em CPU no `hel1-ollama` (VM dedicada → não rouba CPU ao
Lighthouse). Inferência lenta (~107 s/job) mas a custo 0 → o **batch** de `industry` usa o
<strong>classificador heurístico</strong> (<code>lib/audit/industry-heuristic.js</code>, 154× mais rápido) e o
Ollama serve o <em>on-demand</em> / casos difíceis, com <code>OLLAMA_TIMEOUT_MS</code> alto.
Runbook: <a href="docs/runbook-ollama-hel1.md">docs/runbook-ollama-hel1.md</a>.
</sub>

---

## 3. Tabela de VMs (alvo)

> `Deployed`: ✅ a correr · 🟡 existe no monolito HEL1 (a separar) · ❌ por criar.
> CPU/RAM das VMs a criar são **propostas** — ajustar à capacidade dos Proxmox.

| Server | VM | VMID | CPU | RAM | Disk | Type | Jobs / Containers | Deployed | Created |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hel1 | **np-db** | 900 | 14 | 64 GB | NVMe | DB | Postgres + PgBouncer | ✅ | ✅ |
| hel1 | **np-server** | 801 | 4 | 8 GB | 40G local-zfs | App | Directus, Dashboard, **NATS**, Redis | 🟡 | ✅ |
| hel1 | **hel1-ollama** | 503 | 6 | 8 GB | — | AI | Ollama CPU — on-demand (o batch usa o heurístico) | ✅ | ✅ |
| hel1 | **Worker H** | — | 6 | 16 GB | — | Heavy | `browser` (lighthouse) — imagem pesada | 🟡 | ✅ |
| hel1 | **Worker B** | — | 2 | 8 GB | — | Base | `base` (pipeline) | 🟡 | ✅ |
| hel1 | **Worker L** | — | 2 | 4 GB | — | Light | `security` (nuclei/wpscan) | ❌ | ❌ |
| de1 | **de-minio** | 300 | 2 | 4 GB | 500G storage-zfs | Storage | MinIO (reports + snapshots) | ✅ | ✅ |
| de1 | **de-analytics** | 301 | 6 | 16 GB ⁵ | ~200G storage-zfs | Analytics | **ClickHouse** ✅ (+ PostHog opt-in) | ✅ | ✅ |
| de1 | **Worker H** | — | 4 | 8 GB | — | Heavy | `browser` (lighthouse) | ❌ | ❌ |
| de1 | **Worker B** | — | 2 | 4 GB | — | Base | `base` | ✅ | ✅ |
| de1 | **Worker L** | — | 3 | 6 GB | — | Light | `security` (nuclei/wpscan) | ✅ | ✅ |
| laptop | **gpedro-laptop** | — | 22 | 16 GB | 30 GB | **Residential** | `residential` (GMB) + overflow opcional | 🟡 | ✅ |
| oracle | **A1-1** | — | 1 (ARM) | 6 GB | 48 GB | Light+Base | `security` + `base` *(imagem arm64)* | ❌ | ❌ |
| oracle | **A1-2** | — | 1 (ARM) | 6 GB | 48 GB | Light+Base | `security` + `base` | ❌ | ❌ |
| oracle | **AMD-1** | — | 1/8 | 1 GB | 48 GB | Light | whois / verify (baixa conc) | ❌ | ❌ |
| oracle | **AMD-2** | — | 1/8 | 1 GB | 48 GB | Light | whois / verify | ❌ | ❌ |
| gcp | **e2-micro** | — | 2 | 1 GB | 30 GB | Light | **só whois/verify** (egress 1 GB/mês) ⁶ | ❌ | ❌ |

<sub>
⁵ 8 GB chegam se correres SÓ o ClickHouse do NetProspect; o PostHog quer +4-6 GB (traz o seu próprio
ClickHouse+Kafka+Postgres) → 16 GB se forem os dois.
<br>
⁶ O egress de 1 GB/mês do GCP proíbe jobs que descarregam páginas (lighthouse ~1-3 MB/site). O whois
(~3 KB) e o verify (bytes) cabem à vontade. O nuclei dispara muitos pedidos → só nas Oracle (10 TB).
<br>
⁸ **`gpedro-laptop`** (Windows + Docker Desktop) é o daily-driver do Gonçalo → <strong>IP residencial</strong>,
algo que nenhuma outra máquina tem. Corre por defeito SÓ o role <code>residential</code> (o <strong>GMB</strong>, que o
Google bloqueia em IPs de datacenter). É <strong>intermitente</strong> (ele precisa dele para trabalhar) → nada crítico
depende dele; a workqueue segura os jobs quando está offline. Pode receber <code>security</code>/<code>base</code> como
overflow quando estiver livre e o Claude pedir. Runbook: <a href="docs/runbook-laptop.md">docs/runbook-laptop.md</a>.
</sub>

---

## 4. Estratégia das free VMs (o valor é o IP, não os cores)

Cada VM free traz **1 IP público** → **quota própria** onde há rate-limit **por IP**:

- **whois** — as registries limitam por IP → +N IPs = +N× throughput (o backlog são 283k).
- **verify** (email) — as APIs free limitam por IP/conta → cada VM = uma quota free.
- **nuclei** — espalha o scan por IPs (menos hipótese de um IP ser flagged).

**Fila dedicada vs role-split:** para os jobs **network-bound** (base/security) não é preciso fila
dedicada — basta darem-se **roles diferentes** por VM (consumers diferentes = sem competição no pull).
A fila dedicada (`JOB_STREAM`/feeder, commit `73f06a7`) fica reservada para quando se quiser dar a um
host remoto uma fatia de um job que os locais **também** consomem.

---

## 5. Plano de ataque (por valor/risco)

**~~Fase 2 — MinIO → de-minio~~** · ✅ **FEITO** *(2026-07)*

- 16.929 reports + 20 snapshots (843 MB) na `de-minio`; NVMe do HEL1 libertado.
- Toda a frota (HEL1 + os DOIS projetos compose do DE1) escreve lá; round-trip validado.
- Falta só: parar o MinIO local do HEL1 (rollback intacto) — ver [`docs/runbook-minio-de1.md`](docs/runbook-minio-de1.md) §8.

**Fase 1 — Free VMs como Worker L (security + whois)** · *risco baixo, valor alto, add-only*

- Construir a imagem **`worker-security`** (arm64 + amd64) sem Chromium.
- Oracle A1-1/A1-2: `security` + `base`. GCP/AMD: `whois`/`verify`.
- Ganho: o nuclei escala para lá do DE1 + o whois drena muito mais depressa (mais IPs).
- Padrão **já provado** com o DE1 hoje. Sem tocar no HEL1.

**~~Fase 3 — Analytics + IA para fora do HEL1~~** · ✅ **FEITO** *(2026-07)*

- `hel1-ollama` (Ollama CPU, nativo num LXC CT) a servir o on-demand; Ollama local do HEL1 desmantelado.
- `de-analytics` (ClickHouse, 10,2M observações) migrado e validado; CH local do HEL1 desmantelado.
- Resultado: o HEL1 largou o Ollama **e** o ClickHouse → mais CPU + disco para o Lighthouse.
- Falta só o **PostHog** (opt-in) na `de-analytics`, quando/se quiseres product-analytics.

**Fase 4 — Decompor o HEL1 monolítico** · *risco médio (mexe no que corre) → fazer com os backfills drenados*

- `np-server` (Directus+Dashboard+NATS+Redis) → [`docs/runbook-server-hel1.md`](docs/runbook-server-hel1.md).
- Depois `Worker H` (browser) e `Worker B` (base) em VMs próprias.
- Cada um numa VM → o Directus deixa de competir com o Chromium (o "under pressure" desaparece).
- ⚠️ A janela crítica é a migração do JetStream do NATS → fazer com o backlog baixo.

---

## 6. Decisões — estado

| # | Decisão | Estado |
| --- | --- | --- |
| 1 | **Método de deploy** | ✅ **Tu** crias a VM + corres o `bootstrap-vm.sh`; o **Claude** faz o deploy do role e mantém este inventário. Ambos com SSH. |
| 2 | **ClickHouse — usar ou desmantelar?** | ✅ **Manter** (10M observações) → vai para a `de-analytics`. |
| 3 | **industry (IA) — GPU ou heurístico?** | ✅ **Heurístico** no batch (154× mais rápido, custo 0). O Ollama fica em CPU no `hel1-ollama` para on-demand. **Sem compra de GPU.** |
| 4 | **Directus — np-server ou co-localizar no np-db?** | ✅ **np-server** (os workers já escrevem direto ao PG via A2 → a chattiness dele importa menos). |
| 5 | **Oracle A1 = ARM** | 🟡 **Aberto** — construir a `worker-security` multi-arch (arm64)? Sem Chromium é trivial. É o que desbloqueia a Fase 1. |
| 6 | **WPScan API key** | 🟡 **Aberto** — 25 pedidos/dia no free → só dá para on-demand, não batch. Chave em <https://wpscan.com/register>. |
| 7 | **PostHog** | 🟡 **Aberto** — opt-in pesado (+4-6 GB). Arrancar já com a `de-analytics`, ou só o ClickHouse primeiro? |
