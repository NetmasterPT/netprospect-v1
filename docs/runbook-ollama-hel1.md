# Runbook — `hel1-ollama`: Ollama numa VM dedicada (CPU, sem GPU)

> **Porquê tirá-lo do HEL1.** O llama.cpp usa **todos** os cores por inferência — medimos **1427 % de
> CPU (14 de 18 cores)** — e estrangulava o Chromium das auditorias. Numa VM só dele pode comer os
> cores *dela* à vontade sem roubar nada a ninguém. **É a alavanca de CPU mais barata que temos.**
>
> **Decisão: sem GPU (custo 0).** A inferência fica lenta (**~107 s/job**), o que tem uma consequência
> arquitetural importante:
>
> - o **batch** de `industry` **NÃO** usa o Ollama — usa o `lib/audit/industry-heuristic.js`
>   (6.640/h vs 43/h → **154× mais rápido**). Em Ollama-CPU, o batch levaria **26 dias**.
> - o Ollama serve o **on-demand**: os agentes IA do dashboard (B4) e os casos difíceis.
> - quem o chama tem de levar **`OLLAMA_TIMEOUT_MS` alto** (150000). O `lib/ollama.js` e o dashboard
>   já leem essa env — os defaults antigos (45 s / 60 s) rebentavam com a inferência em CPU.

## Estado

| | |
| --- | --- |
| **VM** | ✅ **já existe** — no tailnet como `hel1-ollama`, LAN `10.10.10.53` |
| **Bootstrap** | ❌ **por fazer** (não tem Docker/repo, e o Claude não tem acesso SSH) |
| **Deploy** | ⏸️ bloqueado pelo acesso |

---

## 1. Dar acesso ao Claude — **TU fazes** (é o que falta)

A VM está no tailnet, mas o Claude **não consegue entrar**:

- `tailscale ssh` → *"tailnet policy does not permit you to SSH to this node"* — o nó é do utilizador
  `gpedro.work@`, não `tagged-devices` como o resto da frota, e a ACL não permite.
- SSH direto por `10.10.10.53` → `Permission denied (publickey)`.

**A via limpa** (alinha-o com o resto da frota: Docker + repo + tag + `--ssh`):

```bash
ssh root@10.10.10.53      # ou pela consola do Proxmox
curl -fsSL https://raw.githubusercontent.com/NetmasterPT/netprospect-v1/main/deploy/bootstrap-vm.sh \
  | bash -s -- <TAILSCALE_AUTHKEY> hel1-ollama tag:ai
```

> Se a ACL não tiver `tag:ai` definida em `tagOwners`, usa **`tag:worker`** (essa já existe — é a do
> `np-wk-de1`). O script mantém o hostname `hel1-ollama`, instala o `qemu-guest-agent`, e imprime o
> tailnet IP — guarda-o (`<OLLAMA_IP>`).

*(Alternativa mínima, se não quiseres re-bootstrapar: acrescenta a chave pública SSH do Claude a
`/root/.ssh/authorized_keys` da VM. Mas aí falta o Docker — o bootstrap trata disso.)*

---

## 2. Deploy do Ollama — **Claude faz**

```bash
ssh root@hel1-ollama
cd /root/netprospect-v1/deploy/ollama
cp .env.example .env      # TAILNET_IP=<OLLAMA_IP>  (o resto tem defaults bons)
docker compose up -d      # arranca o ollama + puxa o gemma3:4b (ollama-init)
```

O `docker-compose.yml` já traz o essencial para CPU:

- **`OLLAMA_KEEP_ALIVE=24h`** — em CPU o *cold-load* do modelo é caríssimo; mantê-lo residente evita
  pagar esse custo a cada chamada (a VM tem RAM de sobra para o gemma3:4b).
- **`OLLAMA_NUM_PARALLEL=1`** — paralelizar inferências em CPU só faz *thrashing* de cores.
- Bind **só na tailnet** + `127.0.0.1` (o Ollama **não tem auth** → nunca `0.0.0.0`).

## 3. Repontar quem o usa — **Claude faz**

```bash
# no HEL1 (docker/.env) — e, quando existir, no np-server
sed -i 's|^OLLAMA_URL=.*|OLLAMA_URL=http://<OLLAMA_IP>:11434|' docker/.env
grep -q '^OLLAMA_TIMEOUT_MS=' docker/.env || echo 'OLLAMA_TIMEOUT_MS=150000' >> docker/.env
cd docker && docker compose up -d --force-recreate dashboard worker
```

## 4. Verificação

```bash
# 1) o modelo está lá e responde (a 1.ª chamada a frio pode levar minutos em CPU)
curl -s http://<OLLAMA_IP>:11434/api/tags | jq '.models[].name'

# 2) inferência ponta-a-ponta, cronometrada
time curl -s http://<OLLAMA_IP>:11434/api/generate \
  -d '{"model":"gemma3:4b","prompt":"responde só: ok","stream":false}' | jq -r .response

# 3) os agentes IA do dashboard deixaram de dar timeout
curl -s -X POST http://localhost:3001/api/agents/... # (ver dashboard/server.mjs)
```

## 5. Desmantelar o Ollama do HEL1 (só depois do §4 passar)

```bash
cd /root/Github/netprospect-v1/docker
docker compose --profile audit stop ollama ollama-init
# comentar os 2 serviços no docker-compose.yml (mantém ./.data/ollama como rollback)
```

👉 **O CPU libertado no HEL1 vai todo para o Lighthouse** — é o ponto de toda esta mudança.

## Notas

- **Fail-soft:** `OLLAMA_URL` vazio = agentes IA desligados; a app corre à mesma (`lib/ollama.js`
  devolve `{ok:false}` e os callers caem no fallback). Nada morre por causa do Ollama.
- **Não mudes o modelo** sem re-testar os prompts — o `gemma3:4b` é o que está afinado.
- Se um dia houver GPU: passa a valer a pena o Ollama no **batch** de `industry` (a qualidade da
  classificação LLM é superior à do heurístico). Sem GPU, não compensa — 26 dias vs 5 h.
