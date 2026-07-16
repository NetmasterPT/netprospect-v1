# Runbook — `gpedro-laptop`: worker residencial (Windows + Docker Desktop)

> **Propósito.** É o daily-driver do Gonçalo (Windows), com **IP residencial** — algo que **nenhuma
> outra máquina da frota tem**. Serve para o que os IPs de datacenter **não conseguem** e para
> capacidade extra pontual:
>
> 1. **GMB** (Google My Business) — o Google **bloqueia** os IPs Hetzner (serve a página `/sorry/`, que
>    já envenenou a DB). Só um IP residencial o consegue fazer. → é o **valor único** do portátil.
> 2. **Overflow opcional** — quando estiver online e livre e o Claude disser que há trabalho a mais,
>    pode ligar `security`/`base` para dar uma ajuda. Mas **é intermitente** (é o portátil de trabalho)
>    → nada crítico depende dele.

> **Auto-deploy (2026-07-16).** O laptop é o único host **sem SSH de entrada** (Tailscale SSH no WSL
> "abre e fecha" — ACL). Mantém-se via **PULL**: uma Tarefa Agendada corre git pull + puxa o `.env` do
> np-server e recria se mudou. O `.env` fica editável no dashboard como os outros. **Setup (manual, tu):**
> ver [runbook-laptop-autodeploy.md](runbook-laptop-autodeploy.md) §2.

## Porque é que o GMB precisa disto (o desenho)

O consumer `gmb` tem agora um **role próprio: `residential`** ([`lib/jobs.js`](../lib/jobs.js)). Como os
consumers da workqueue têm filtros disjuntos, **só um worker com `WORKER_ROLES=residential` puxa GMB** —
os workers de datacenter (HEL1/DE1) nunca lhe tocam, nem sequer para descartar. Sem este role, o HEL1
apanhava os jobs de GMB e deitava-os fora (`GMB_ENABLED=false`).

---

## Pré-requisitos (no portátil, uma vez)

1. **Docker Desktop** (com backend WSL2) a correr.
2. **Tailscale** para Windows, ligado ao tailnet (o worker fala com a frota por IPs `100.x`).
3. **Git** + o repo já clonado em `C:\Users\Gonçalo Pedro\Documents\GitHub\netprospect-v1`.
4. As bases `data/geoip` + `data/tranco` (não estão no git — geram-se):
   ```powershell
   cd "C:\Users\Gonçalo Pedro\Documents\GitHub\netprospect-v1"
   npm install
   npm run geoip          # descarrega as GeoIP DBs para data/geoip
   ```

   *(O `data/tranco` também é preciso para o contexto `base`; para SÓ GMB não é usado, mas o volume é
   montado — se a pasta não existir, cria-a vazia: `mkdir data\tranco`.)*

## Deploy

```powershell
cd "C:\Users\Gonçalo Pedro\Documents\GitHub\netprospect-v1"
git pull

copy deploy\laptop\.env.example deploy\laptop\.env
notepad deploy\laptop\.env     # preencher (ver abaixo)

# construir a imagem (traz o Chromium, ~2,5 GB — a 1ª vez demora) e arrancar
docker compose -f deploy\laptop\docker-compose.yml build
docker compose -f deploy\laptop\docker-compose.yml up -d
docker compose -f deploy\laptop\docker-compose.yml logs -f worker
```

### `.env` — o que preencher

| Chave              | Valor                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| `NATS_URL`       | `nats://100.114.17.74:4222` (**np-server**) |
| `DIRECTUS_URL`   | `http://100.114.17.74:8056` (np-server)                                                  |
| `DIRECTUS_TOKEN` | o`DIRECTUS_ADMIN_TOKEN` do `docker/.env` do HEL1                            |
| `MINIO_URL`      | `http://100.124.43.117:9000` (de-minio) + `MINIO_ROOT_USER/PASSWORD`        |
| `REDIS_URL`      | `redis://100.114.17.74:6379` (np-server, telemetria)            |
| `WORKER_ROLES`   | `residential` (defeito) — só GMB                                            |

> O `docker-compose.yml` do portátil já força `GMB_ENABLED=true` e `AUDIT_ENABLED=true` (o GMB é um
> consumer "pesado" → sem `AUDIT_ENABLED` nem sequer arrancava).

## Dar-lhe mais carga (quando estiver online e livre, a pedido do Claude)

No `.env`, alarga os roles e/ou réplicas, depois `up -d` outra vez:

```
WORKER_ROLES=residential,security,base
WORKER_REPLICAS=2
GMB_CONC=2
```

`security` (nuclei/wpscan) e `base` (whois/enrich) são network-bound → o portátil aguenta-os bem.
**Não** ligar `browser` (lighthouse) a menos que queiras mesmo — é CPU-pesado e é o teu daily-driver.

## Parar / tirar da frota (quando precisares do portátil só para ti)

```powershell
docker compose -f deploy\laptop\docker-compose.yml down
```

A frota nem dá por isso — o `residential`/GMB simplesmente fica à espera na fila até o portátil voltar
(a workqueue retém os jobs). Nada se perde.

## Enfileirar GMB (do HEL1, quando o portátil estiver online)

```bash
node enqueue-fine-audits.js --only=gmb --min-score=60      # só os leads bons; on-demand
```

> O GMB é frágil e lento — enfileirar em lotes pequenos e só para leads que valham a pena.

## Verificação

```powershell
# o worker apanhou o role certo?
docker compose -f deploy\laptop\docker-compose.yml logs worker | Select-String "roles="
# → deve dizer roles=residential
```

No dashboard (`/api/workers`) aparece um worker novo com host `gpedro-laptop` e role `residential`.
Um GMB bem-sucedido escreve `gmb_name`/`gmb_rating`/… no site (e **não** "Por que esse anúncio?", que
era o sintoma do bloqueio Hetzner).

## Notas

- **IP residencial = trunfo, mas frágil:** não enfileirar dezenas de milhares de GMB — o Google acaba
  por apresentar captcha mesmo a IPs residenciais se o volume for alto. Lotes pequenos, leads bons.
- **Intermitente por design:** o portátil pode ir abaixo a qualquer momento; a workqueue segura os jobs.
  Nada na frota depende dele estar online.
- **Sem escrita direta ao PG** (`DIRECT_PG_WRITE=false`): é residencial/intermitente → escreve via
  Directus, não abre ligações ao Postgres.
