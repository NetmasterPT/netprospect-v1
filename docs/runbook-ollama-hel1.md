# Runbook — `hel1-ollama`: Ollama numa máquina dedicada (CPU, sem GPU) — ✅ FEITO

> **Porquê tirá-lo do HEL1.** O llama.cpp usa **todos** os cores por inferência — medimos **1427 % de
> CPU (14 de 18 cores)** — e estrangulava o Chromium das auditorias. Numa máquina só dele, o cgroup
> limita-o e ele deixa de roubar CPU a ninguém. **É a alavanca de CPU mais barata que temos.**
>
> **Decisão: sem GPU (custo 0).** A inferência fica lenta, o que tem uma consequência arquitetural:
>
> - o **batch** de `industry` **NÃO** usa o Ollama — usa o `lib/audit/industry-heuristic.js`
>   (6.640/h vs 43/h → **154× mais rápido**). Em Ollama-CPU o batch levaria **26 dias**.
> - o Ollama serve o **on-demand**: os agentes IA do dashboard (B4) e os casos difíceis.
> - quem o chama leva **`OLLAMA_TIMEOUT_MS=240000`**. Os defaults antigos (45 s / 60 s) rebentavam.

## ⚠️ É um LXC CT, não uma VM

Ao contrário do resto da frota, o `hel1-ollama` é um **container LXC** no Proxmox do HEL1
(`systemd-detect-virt` → `lxc`). Duas consequências:

- **Docker dentro dele exigiria `nesting=1`** no CT + reinício. Para uma máquina de propósito único
  não compensa → o Ollama está instalado **nativamente** (systemd), não em Docker.
- O `lsblk` lá dentro mostra os **zvols e NVMe do host** (é normal em LXC, o CT vê os block devices do
  host). Mas o `nproc`/`free` mostram os limites reais do CT (6 cores / 8 GB), porque o lxcfs os mascara.

## Estado

| | |
| --- | --- |
| **Máquina** | LXC CT no HEL1 — tailnet `100.126.196.112`, LAN `10.10.10.53` |
| **Ollama** | ✅ 0.31.2, nativo (systemd), CPU-only |
| **Modelo** | ✅ `gemma3:4b` (3,3 GB) |
| **Bind** | `100.126.196.112:11434` — **só tailnet** (o Ollama não tem auth) |
| **Frota repontada** | ✅ dashboard + workers do HEL1 |
| **Ollama do HEL1** | ✅ desmantelado (rollback em `docker/.data/ollama`) |

---

## Como foi instalado (para reproduzir)

```bash
# 1) Ollama nativo
curl -fsSL https://ollama.com/install.sh | sh

# 2) systemd override — as 3 definições que tornam o CPU-only utilizável
TS_IP=$(tailscale ip -4 | head -1)
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<EOF
[Service]
# Bind SÓ na tailnet: o Ollama não tem auth → nunca 0.0.0.0.
Environment="OLLAMA_HOST=${TS_IP}:11434"
# Em CPU o cold-load do modelo é caríssimo → mantê-lo residente é o que torna isto usável.
Environment="OLLAMA_KEEP_ALIVE=24h"
# Paralelizar inferência em CPU só faz thrashing de cores.
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
EOF
systemctl daemon-reload && systemctl restart ollama

# 3) modelo
OLLAMA_HOST=${TS_IP}:11434 ollama pull gemma3:4b
```

*(O `deploy/ollama/docker-compose.yml` existe no repo com a MESMA configuração, para o dia em que isto
for uma VM com Docker. Hoje não é usado — o CT corre nativo.)*

## Repontar a app

```bash
# docker/.env do HEL1 (e, quando existir, o np-server)
OLLAMA_URL=http://100.126.196.112:11434
OLLAMA_TIMEOUT_MS=240000
```

> ⚠️ **Armadilha que apanhámos:** o `worker` e o `worker-base` faziam **hardcode** de
> `OLLAMA_URL: http://ollama:11434` no compose, ignorando o `.env` (o mesmo bug que o `MINIO_URL`
> tinha). Já está parametrizado (`${OLLAMA_URL:-...}`) — sem isso, o repoint não pegava.

---

## Desempenho medido (e porque é assim)

| | |
| --- | --- |
| 1.ª chamada (cold, carrega o modelo) | **64 s** |
| chamada warm (10 tokens) | **58 s** |
| CPU do `llama-server` | 515 % (≈5 dos 6 cores — usa bem a alocação) |
| threads | 6 (= o limite do CT; **sem thrashing**) |
| swap | 0 (RSS 3,65 GB em 8 GB — **sem paginação**) |

**Não é má configuração.** O CPU (Xeon W-2295) tem AVX2/AVX512, as threads estão certas, não há swap.
A inferência LLM em CPU é **limitada pela largura de banda de memória**, e essa está a ser consumida
pelos workers Chromium no mesmo host físico. Bate certo com os **107 s/job** que já tínhamos medido —
e é exatamente por isso que o batch usa o heurístico.

👉 **Se um dia houver GPU**, passa a valer a pena o Ollama no batch de `industry` (a classificação LLM
é de melhor qualidade que a heurística). Sem GPU, não compensa: 26 dias vs 5 h.

## Notas

- **Fail-soft:** `OLLAMA_URL` vazio = agentes IA desligados; a app corre à mesma (`lib/ollama.js`
  devolve `{ok:false}` e os callers caem no fallback). Nada morre por causa do Ollama.
- **Não mudes o modelo** sem re-testar os prompts — o `gemma3:4b` é o que está afinado.
- **`OLLAMA_KEEP_ALIVE=24h` é essencial:** sem ele, cada chamada paga os ~64 s do cold-load.
