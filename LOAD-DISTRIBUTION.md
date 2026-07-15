# Load Distribution — plano de deploy da frota

## 0. Inventário VIVO da frota (Claude mantém isto a cada VM que entra)

> Modelo de gestão: **tu** crias a VM + corres `deploy/bootstrap-vm.sh` (Docker+Tailscale+repo);
> **Claude** faz o deploy do role (compose+env) via tailnet e atualiza esta tabela. Ambos com SSH.

| Hostname (Tailscale) | Tailnet IP | Servidor | Role/stack | Imagem | Réplicas | Estado |
| --- | --- | --- | --- | --- | ---: | --- |
| `hel1-docker` (ex-monólito) | 100.108.94.126 | hel1 | `browser` + `base` workers + MinIO-rollback (control-plane **desmantelado** → np-server) | ambas | 4H+5B | ✅ a correr |
| **np-db** | 100.77.60.44 | hel1 | Postgres + PgBouncer | — | — | ✅ a correr |
| **np-server** | 100.114.17.74 (LAN `10.10.10.81`) | hel1 | Directus + Dashboard + NATS + Redis (control-plane) | — | — | ✅ **a servir a frota** |
| **np-wk-de1** | 100.120.214.45 | de1 | `base` (whois) + fila dedicada — projeto `/root/np-worker` (`.env.worker`) | worker-base | 4 | ✅ a correr |
| **np-wk-de1** | 100.120.214.45 | de1 | `security` (nuclei/wpscan) + `ai` — projeto `/root/np-worker-heavy` (`.env.heavy`) | worker | 3 | ✅ a correr |
| **de-minio** | 100.124.43.117 | de1 | MinIO — 500G storage-zfs / ext4 (VMID 300) | minio | 1 | ✅ **MIGRADO — toda a frota escreve aqui** |
| **hel1-ollama** | 100.126.196.112 (LAN `10.10.10.53`) | hel1 | Ollama (CPU, sem GPU) — LXC CT, nativo | — | — | ✅ a servir on-demand |
| **de-analytics** | 100.115.240.35 | de1 | ClickHouse (10,2M observações) — 200G ext4 (VMID 301) | clickhouse | 1 | ✅ **MIGRADO** |
| **de1-pve** | 100.87.226.117 | de1 | *host Proxmox* (não é da stack — exit node, `tag:proxmox`) | — | — | ✅ |
| **gpedro-laptop** | 100.107.10.15 | laptop | `residential` (**GMB** — IP residencial) + overflow opcional | worker | 1 | ✅ a correr (intermitente ⁸) |
| **oracle-e2-1** | 100.75.209.61 | oracle (free) | `base` → só **whois** (E2.1.Micro 2 vCPU/950 MB) — proj. `~/np-worker` | worker-base | 1 | ✅ a correr (2026-07-14) |
| **oracle-e2-2** | 100.123.27.23 | oracle (free) | `base` → só **whois** (E2.1.Micro 2 vCPU/950 MB) — proj. `~/np-worker` | worker-base | 1 | ✅ a correr (2026-07-14) |

*Ainda por criar:* Worker VMs dedicadas (decompor os workers do HEL1) · oracle A1-1/A1-2/AMD-1/AMD-2 · gcp e2-micro.

> **Dashboard + control-plane agora no `np-server`** (o do monólito parou). Acessos públicos (atrás do
> Authentik/NPMPlus): dashboard **https://netprospect.netmaster.pt** · Directus
> **https://netprospect.directus.netmaster.pt** · consola MinIO **https://netprospect.minio.netmaster.pt**
> (o NPMPlus aponta a `http://100.124.43.117:9001` — a consola passou a estar no tailnet; antes só em
> `127.0.0.1`, e era ESSE o motivo de não abrir, não a firewall do DE1). O control-plane do monólito
> (directus/dashboard/nats/redis) foi **desmantelado** (dados em `docker/.data/*` como rollback). O HEL1
> largou control-plane + Ollama + ClickHouse → load caiu para ~0,2.

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
| **nats** | ⚡ **latência-CRÍTICA** (workers puxam em loop) | **np-server** (central) | — | ✅ **FEITO** ¹ |
| **redis** | latência-sensível (cache+telemetria), minúsculo | **np-server** | — | ✅ **FEITO** ¹ |
| **directus** | REST sobre a DB (os workers já a contornam via A2) | **np-server** | — | ✅ **FEITO** ¹ |
| **dashboard** | leve, user-facing | **np-server** | — | ✅ **FEITO** ¹ |
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

## 3. Tabela de VMs

> **A correr** (specs reais) em cima; **por criar** (a decomposição-alvo dos workers + free VMs) em baixo.
> Os workers do HEL1/DE1 correm HOJE nos hosts `hel1-docker`/`np-wk-de1` (não em VMs dedicadas ainda).

### A correr

| Servidor | VM / host | VMID | CPU | RAM | Disco | Papel | Deployed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hel1 | **np-db** | 900 | 14 | 64 GB | NVMe | Postgres + PgBouncer | ✅ |
| hel1 | **np-server** | 801 | 4 | 8 GB | 40 GB local-zfs | Directus + Dashboard + NATS + Redis | ✅ |
| hel1 | **hel1-docker** *(ex-monólito)* | — | 18 | 251 GB | 99 GB NVMe | Workers `browser`+`base`+`security`+`ai` (4H+5B) + MinIO-rollback | ✅ |
| hel1 | **hel1-ollama** | 503 | 6 | 8 GB | 300 GB (CT/ZFS) | Ollama CPU (LXC CT) — on-demand | ✅ |
| de1 | **de-minio** | 300 | 2 | 4 GB | 500 GB storage-zfs | MinIO (reports + snapshots) | ✅ |
| de1 | **de-analytics** | 301 | 6 | 16 GB | 20 GB root + **200 GB** dados | ClickHouse ✅ (PostHog ⏸️ — ver §6) | ✅ |
| de1 | **np-wk-de1** | — | 6 | 23 GB | 99 GB | Workers `base` (proj. `np-worker`) + `security`+`ai` (proj. `np-worker-heavy`) | ✅ |
| laptop | **gpedro-laptop** | — | 22 | 16 GB | 30 GB | `residential` (GMB) + overflow opcional — Windows/Docker Desktop | ✅ ⁸ |
| oracle (free) | **oracle-e2-1** | — | 2 | 950 MB | 46 GB + 1 GB swap | Worker `base`→**whois** (E2.1.Micro always-free ⁹) | ✅ (2026-07-14) |
| oracle (free) | **oracle-e2-2** | — | 2 | 950 MB | 46 GB + 1 GB swap | Worker `base`→**whois** (E2.1.Micro always-free ⁹) | ✅ (2026-07-14) |

### Por criar (decomposição-alvo dos workers + free VMs)

| Servidor | VM | CPU | RAM | Disco | Papel | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| hel1 | Worker H (browser) | 6 | 16 GB | — | tirar o `browser` do `hel1-docker` p/ VM própria | ❌ (corre no hel1-docker) |
| hel1 | Worker B (base) | 2 | 8 GB | — | idem, `base` | ❌ (corre no hel1-docker) |
| de1 | Worker H (browser) | 4 | 8 GB | — | `browser` no DE1 | ❌ |
| oracle | A1-1 / A1-2 (ARM) | 1 | 6 GB | 48 GB | `security` + `base` *(imagem arm64)* | ❌ ⁵ |
| oracle | AMD-1 / AMD-2 | 1/8 | 1 GB | 48 GB | whois / verify | ❌ |
| gcp | e2-micro | 2 | 1 GB | 30 GB | **só** whois / verify (egress 1 GB/mês) ⁶ | ❌ |

<sub>
⁵ Falta a imagem `worker-security` (arm64, sem Chromium) — é o que desbloqueia as free VMs e acelera o
batch WPScan (24,8k em curso, hoje só HEL1+DE1).
<br>
⁶ O egress de 1 GB/mês do GCP proíbe jobs que descarregam páginas (lighthouse ~1-3 MB/site). O whois
(~3 KB) e o verify (bytes) cabem à vontade. O nuclei dispara muitos pedidos → só nas Oracle (10 TB).
<br>
⁸ **`gpedro-laptop`** (Windows + Docker Desktop) é o daily-driver do Gonçalo → <strong>IP residencial</strong>,
algo que nenhuma outra máquina tem. Corre por defeito SÓ o role <code>residential</code> (o <strong>GMB</strong>, que o
Google bloqueia em IPs de datacenter). É <strong>intermitente</strong> → nada crítico depende dele; a workqueue
segura os jobs quando está offline. Runbook: <a href="docs/runbook-laptop.md">docs/runbook-laptop.md</a>.
</sub>

---

> ⁹ **oracle-e2-1/2** (2026-07-14): 2× VM.Standard.E2.1.Micro *always-free* (2 vCPU / 950 MB) — minúsculas, por isso só **whois** (network-bound, limitado por IP → +IPs = +throughput; não por CPU). Stream **principal NP_JOBS** (juntam-se ao pool do HEL1). Setup: `docker save worker-base | ssh | docker load` + Tailscale `tag:worker`. Chaves SSH em `deploy/E2-micro-{1,2}/` (gitignored). **Upgrade PAYG bloqueado no arranque → o Gonçalo repete +1 dia p/ desbloquear as VMs Oracle A1/AMD maiores.**

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

## 5b. Cobertura de jobs na DB (2026-07)

> **Nada se perdeu na migração do NATS** — o backlog estava a **0** no momento do cutover (o pipeline
> base tinha drenado). A fila só ter WPScan é porque (a) o pipeline base terminou os lotes enfileirados
> e (b) as auditorias **nunca foram enfileiradas à escala** (só agora o WPScan). Cobertura sobre **1.567.798** sites:

| Camada | Job / campo | Cobertos | % | Falta correr |
| --- | --- | ---: | ---: | --- |
| Base | `score` (lead_score) | 1.567.798 | 100% | — ✅ |
| Base | `is_live` | 1.442.139 | 92% | — |
| Base | `fingerprint` (tech_detected) | 1.439.176 | 92% | — |
| Base | plataforma/CMS | 882.060 | 56% | resto: sem CMS detetável |
| Base | `ssl` | 739.821 | 51% | **~700k** |
| Base | `dnsprovider` | 739.128 | 51% | **~700k** |
| Base | **`whois`** | 262.512 | 18% | **~1,18M** ⚠️ (precisa de +IPs → free VMs) |
| Contactos | sites c/ email | 787.360 | 55% | resto: sem email público |
| Contactos | contactos (linhas) | 1.534.885 | — | — |
| Contactos | **`verify`** (email_status) | 75 | ~0% | **~156k** com email ⚠️ (precisa das keys/IPs free) |
| Auditoria | **`industry`** | 19.690 | 1,3% | **~1,4M** (heurístico é rápido → enfileirar) |
| Auditoria | **`lighthouse`** (seo_score) | 11.261 | 0,7% | os leads qualificados (~724k) |
| Auditoria | **`nuclei`** | 6.759 | 0,4% | **~1,4M** (network-bound → free VMs) |
| Auditoria | **`wpscan`** | 545 | 0,03% | **24.813 em curso** (WP+Woo score≥50); faltam ~730k WP |
| Auditoria | **`gmb`** | 5.178 | 0,3% | só via portátil (residential), on-demand p/ bons leads |

**O que falta, por prioridade de valor:** (1) `industry` — barato (heurístico), enche a segmentação;
(2) `lighthouse`+`nuclei` nos qualificados — material do relatório; (3) `whois`+`verify` — precisam das
**free VMs** (quota por IP); (4) `wpscan` — a drenar; escala com as free VMs de security.

---

## 6. Decisões — estado

| # | Decisão | Estado |
| --- | --- | --- |
| 1 | **Método de deploy** | ✅ **Tu** crias a VM + corres o `bootstrap-vm.sh`; o **Claude** faz o deploy do role e mantém este inventário. Ambos com SSH. |
| 2 | **ClickHouse — usar ou desmantelar?** | ✅ **Manter** (10M observações) → vai para a `de-analytics`. |
| 3 | **industry (IA) — GPU ou heurístico?** | ✅ **Heurístico** no batch (154× mais rápido, custo 0). O Ollama fica em CPU no `hel1-ollama` para on-demand. **Sem compra de GPU.** |
| 4 | **Directus — np-server ou co-localizar no np-db?** | ✅ **np-server** (os workers já escrevem direto ao PG via A2 → a chattiness dele importa menos). |
| 5 | **Oracle A1 = ARM** | 🟡 **Aberto** — construir a `worker-security` multi-arch (arm64)? Sem Chromium é trivial. **Prioridade subiu:** é o que acelera o batch WPScan (24,8k em curso, só HEL1+DE1). |
| 6 | **WPScan** | ✅ **Resolvido** — **batch keyless** (`enqueue-wpscan.js`) p/ todos os ~1,57M sites WP (enumera, sem vuln-DB); a **API key fica só p/ on-demand** (1 key por host, 25/dia). |
| 7 | **PostHog** | ⛔ **Precisa de VM própria.** O compose hand-rolled partia no bootstrap do CH; o `install.sh` **oficial** é o caminho certo MAS o stack "hobby" são **~40 serviços** (Elasticsearch, Temporal, Kafka, Zookeeper, 2× ClickHouse, browserless, SeaweedFS…) — não cabe na `de-analytics` (6c/16GB, que já corre o ClickHouse de analytics **em uso**); ia dar OOM. **Decisão pendente:** VM dedicada `de-posthog` (~8c/32GB) **ou** PostHog Cloud (free tier) **ou** deixar de fora (a analítica do NetProspect NÃO depende disto). |

## 7. Concorrência DINÂMICA por core (padrão auto-escala) — 2026-07-14

O `worker.mjs` calcula a concorrência de cada job a partir dos **cores + RAM da própria VM**, por
isso uma VM nova só precisa de `WORKER_ROLES` (+ `WORKER_REPLICAS`) — ajusta-se sozinha. Loga no
arranque: `conc auto (cores=… RAM_free=… rep=…): …`.

**Fórmula:** `conc[job] = min( cores × fator[job] , teto_RAM , teto_abs ) ÷ réplicas`  (env override → ganha)

| Perfil I/O | Jobs (fator/core) | Teto RAM/instância |
| --- | --- | ---: |
| Fetch/parse-bound | enrich·3 contacts·5 fingerprint·5 fetch·1.5 | — |
| Lookups de rede | dns·2 geoip·2 ssl·2 dnsprovider·2 emailauth·2 traffic·3 social·1.5 locality·1.5 | — |
| Network-scan | **nuclei·1.5** | 250 MB |
| CPU/RAM-bound | **wpscan·0.5** **lighthouse·0.4** industry·0.2 | 450 / 550 / 300 MB |
| Recurso externo | whois·0.5 (IP) verify·0.75 (quota) gmb·0.5 (residencial) | gmb 400 MB |

**O teto de RAM salva as VMs pequenas:** numa VM de 950MB, nuclei/wpscan/lighthouse/gmb auto-limitam
a **1** (RAM_livre 404MB ÷ 250MB) — foi a falta disto que crashou a `oracle-e2-1`.

**⚠️ hel1 usa `environment:` (não `env_file`)** → tem de passar `WORKER_REPLICAS` + cada `*_CONC` ao
container explicitamente, senão o padrão vê `rep=1` e cada réplica pega o total inteiro (oversubscrição Nx).

### Overrides finos ATUAIS (2026-07-14)

| Host | Override | Porquê |
| --- | --- | --- |
| **hel1 heavy** (18c, host partilhado) | LIGHTHOUSE_CONC=3 · WPSCAN_CONC=4 · nuclei=auto(28) | ≤14 de load p/ proteger np-db/np-server no mesmo host físico (steady ~10-13) |
| **DE1 heavy** (6c) | roles `security,ai,`**`browser`** · réplicas **1** · nuclei=24 · wpscan=6 · LIGHTHOUSE=1 | +browser partilha o lighthouse (offload do hel1); réplicas 1 senão o Chromium dá load 8.5. Steady ~4.5-5 (~80%) |
| **Oracle e2-1/2** (2c/950MB) | role `base` (whois-only) · mem_limit **550m** | 950MB pequeno demais p/ nuclei; o whois (IP-limitado) é o uso útil e seguro |
| **laptop** (temp.) | roles +`security` · nuclei=8 · wpscan=5 | drenar wpscan temporariamente (cores rápidos) — reverter depois |

**Lições do rebalanceamento (2026-07-14):** (1) o pico de load 23 do hel1 era o **fingerprint** (base,
wappalyzer CPU) — agora drenado; o que resta (lighthouse/nuclei/wpscan) é I/O-bound e não satura CPU.
(2) o **lighthouse (Chromium ~1.5 core/job) só corria no hel1** → sobrecarregava-o; distribuí-o p/ o DE1
(tem a imagem heavy c/ Chromium). (3) DE1/Oracle ficam subutilizados no nuclei/whois porque o **hel1
(0ms ao NATS) agarra os jobs antes** deles (35ms+) → mais IPs, não mais conc, escala o whois. (4)
`mem_limit` < RAM_total − OS (senão o container enche RAM+swap e a VM inteira thrasha, como a oracle-e2-1).

## 8. Lições de fleet-ops (2026-07-15) — LER ANTES DE AFINAR LOAD/DEPLOY

1. **O load average ENGANA nesta frota (I/O-inflado).** lighthouse (Chromium) e nuclei passam a maior
   parte do tempo à espera da rede (carregar páginas / HTTP) → ficam em **D-state (uninterruptible)**, que
   **conta para o load mas NÃO usa CPU**. Vimos **load 19 em 18 cores com 40% de CPU idle**, e **load 4 no
   de1 com CPU a bursts de 15→60%**. Para afinar, MEDIR O CPU REAL, não o load nem snapshots do `top`:
   ```bash
   set -- $(head -1 /proc/stat); u1=$2;n1=$3;s1=$4;id1=$5;io1=$6; sleep 30
   set -- $(head -1 /proc/stat); u2=$2;n2=$3;s2=$4;id2=$5;io2=$6
   b=$(((u2-u1)+(n2-n1)+(s2-s1))); echo "CPU usado: $((100*b/(b+(id2-id1)+(io2-io1))))%"   # id=$5, NÃO iowait=$6
   ```
   (erro comum: usar o campo **iowait ($6)** como idle — o idle é o **$5**.)
2. **Cap-starvation no workqueue partilhado.** O `maxAckPending` de um consumer é o teto FLEET-WIDE de
   jobs em-voo. Um host agressivo (hel1, 0ms ao NATS, muita conc) **agarra todo o teto** e esfomeia os
   pequenos (o de1 ficou a **load 0.5**). Fix: **subir o teto** para os pequenos terem quinhão (nuclei
   96→256 pôs o de1 a ~70%). Subir a conc por-worker de um host esfomeado NÃO resolve — é o teto.
3. **Deploy por VOLUME-MOUNT elimina o inferno das imagens stale.** Montar `lib/`+`worker/` do repo git
   (em vez de imagem baked + `docker cp`) → deploy = `git pull && docker compose … restart`, SEM rebuild,
   e a máquina NUNCA corre código baked antigo (o de1 tinha `maxAckPending:8` e sem gmb-v7 baked na imagem).
   É o padrão do `deploy/worker/docker-compose.yml`. `data/` (geoip/tranco, gitignored) provisiona-se à parte.
4. **`ensureConsumer` faz flip-flop da config.** ackWait/maxAckPending/backoff do consumer são postos por
   quem correu `ensureConsumer` no arranque. Um worker com `jobs.js` antigo REVERTE a config no restart. Por
   isso: mudar no `jobs.js` (deployado a TODA a frota, agora via volume-mount) OU one-off `consumers.update`
   e não recriar workers com código antigo. Um one-off dura até o próximo restart de um worker stale.
5. **O NATS força `ack_wait = backoff[0]`** quando há backoff. Um backoff fixo de 5s matava jobs Chromium
   (15-97s) aos 5s → órfãos no workqueue (nunca ACK, nunca removidos). Backoff agora escala do ackWait; e o
   stream tem `MaxAge 48h` para órfãos auto-expirarem. Ver `lib/jobs.js`.
