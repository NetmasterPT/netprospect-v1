---
title: "Auditoria de Documentação — NetProspect"
type: working
tags: [docs, meta, audit]
related: []
owner: plataforma
status: living
updated: 2026-07-19
visibility: internal
---

# Auditoria de Documentação — NetProspect

> **Última atualização:** 2026-07-19 · **Método:** 6 agentes paralelos (1 por domínio) a cruzar
> código↔docs com evidência `file:line`, + verificação meta da navegação. Documento **vivo** —
> marca `[x]` à medida que corriges. Prioridades: **P1** engana/quebra, **P2** desatualizado, **P3** cosmético.

**Veredito:** o problema nº1 **não é falta de conteúdo** (233 `.md`, 9 runbooks, README de 87KB) — é
**(a) falta de índice/navegação**, **(b) drift concentrado nas zonas de maior churn** (Reacher, job DAG,
runbooks de infra), e **(c) dois subsistemas inteiros sem qualquer doc de uso** (a **API do dashboard**
e as **integrações** Moloni/pagamentos/agenda). O código mexeu ~2× mais que os docs nos últimos 14 dias.

---

## A. Estrutural / navegação (a base)

- [x] **Índice criado** — `docs/README.md` (F0): organizado por Diátaxis, standard em `docs/CONTRIBUTING.md`.
- [x] **26 órfãos resolvidos** — o índice `docs/README.md` linka os 35 docs de `docs/` **e** os da raiz
  (`TODO`/`GMB-README`/`BENCHMARK`/…). Frontmatter (type/tags/status/visibility) aplicado a todos (F0).

---

## B. DRIFT — corrigir (doc diz A, código faz B)

### P1 — engana ou quebra copy-paste

- [ ] **Reacher `socksmethod:none` aplicado só a meio.** O `danted.conf` mudou (commit `c0035b7`), mas ainda
  mandam criar `proxyuser`+password: `docs/outreach-ops/01-validation-fleet.md:49-99` (danted example +
  verify-proxies.json + smoke-test), `config/verify-proxies.example.json` (2 entradas com `user/pass`),
  `docs/outreach-ops/02-reacher.md:64-65` (request shape), `deploy/reacher/README.md:63` (smoke-test
  contradiz a própria Fase 1), comentários `deploy/reacher/danted.conf:3`, `docker-compose.yml:14-15,24-26`,
  cabeçalho `activate.sh:5,12`. Também **referências penduradas "README §2"** (secção já inexistente) e o
  ficheiro órfão `deploy/reacher/.proxy-pass`.
- [ ] **README §4 — roles errados** (enganam quem coloca workers): `gmb` diz `browser`, real `residential`
  (`jobs.js:140`); `industry` diz `ai|Ollama`, real `base`+heurístico (`jobs.js:123`, Ollama só com
  `INDUSTRY_LLM=true`); `campaign.generate` diz `base`, real `ai` (`jobs.js:116`).
- [ ] **`runbook-server-hel1.md` — VMID/IP errados** no cabeçalho e no repoint §5: diz `VMID 200`/`10.10.10.20`,
  real **`801`/`10.10.10.81`** (o próprio corpo usa `qm create 801`). Quebra o copy-paste.
- [ ] **`runbook-analytics-de.md` — host morto.** Descreve `de-analytics`/DE1/VMID 301; o ClickHouse foi
  re-consolidado em **`hel1-analytics`** (`100.120.43.49`, VMID 509) e a DE1 apagada. Renomear/reescrever.
- [ ] **README §7:549-552 — "name-only people kept" é FALSO.** O caminho foi removido (`lib/contacts.js:228`);
  agora exige sinal positivo + **corroboração obrigatória** (email/LinkedIn ou honorífico) — não documentado.

### P2 — desatualizado

- [ ] **`docs/outreach-ops/02-reacher.md` — compose stale:** prefixo `RCH_` vs real `RCH__` (duplo),
  `image :latest` vs real `:v0.11.6`, `ports localhost` vs real `network_mode: host`+`RCH__HTTP_HOST=tailnet`.
- [ ] **README §4 — estado dos jobs desatualizado:** `subdomains` está `paused:true` (`jobs.js:109`) mas
  listado como ativo; `wpscan` mal enquadrado (não está no fan-out do `score` — corre batch **keyless** +
  enriquecimento Wordfence + `WPSCAN_PROXY` residencial, `maxAckPending:48`).
- [ ] **README §10 + runbooks 00/01/02 não conhecem o `activate.sh` nem o `blocklist-guard`** — encaminham
  o leitor para o fluxo manual (que é o que está stale).
- [ ] **README WHOIS contradiz-se:** `README.md:915` diz `jobs.whois` "✗ deferred", mas `:988-989` diz
  "Done in Phase D" e `:999` diz "`.pt` returns null" (já faz best-effort via WhoisXML).
- [ ] **`docs/distributed-fleet.md` aponta ao monólito desmantelado:** §1.1 manda subir NATS via
  `docker/docker-compose.yml` (onde NATS/Redis/Directus/MinIO/Postgres estão **comentados** — migraram p/
  `np-server`); §2.6 usa o padrão legado `docker-compose.worker.yml` em vez de `deploy/worker/` (volume-mount).
- [ ] **`runbook-db-host.md` — IP tailnet placeholder** `100.100.1.10` nunca substituído (real `100.77.60.44`).
- [ ] **`docs/comercial/{subscricoes,empresas}.md`** não listam os campos Moloni adicionados
  (`moloni_service_id`; `moloni_customer_id`+`nif` — `bootstrap-directus.js:355-356,410`).
- [ ] **Pipeline:** contactos-pessoa levam sempre `phone:null` (telefones ficam a nível-empresa) mas
  README §7:554/§6:513 diz que a pessoa tem telefone; `role_category` tem 6 valores (falta `general`),
  README documenta 5.

### P3 — cosmético / higiene

- [ ] **Decisão PostHog divergente em 3 docs** (`runbook-posthog-cloud.md`=Cloud EU feito;
  `LOAD-DISTRIBUTION.md:269`=pendente; `runbook-analytics-de.md`=self-host parado). O Cloud venceu.
- [ ] **Pipeline menor:** sinais do lead-score omitem `has_email`(8)/`has_phone`(4); "~26 roles" omite
  "Managing Director" (são 27); "m2m all detected" exagera (só as 8 plataformas dos fingerprints).
- [ ] **Meta-docs obsoletas:** `docs/orphan-offenders.md` (49KB — log rolante de rondas; a tabela POISON
  prometida está vazia → podar); `posthog-setup-report.md` (output one-shot do wizard → arquivar);
  `BENCHMARK.md` (8 dias estagnado, não conhece as oracle-e2 nem a migração ClickHouse → atualizar/histórico).

---

## C. EM FALTA — documentação nova

### P1 — subsistemas inteiros sem doc de uso

- [x] **API HTTP documentada (F1)** — gerado `docs/reference/http-api.md` (88 endpoints por família) +
  `docs/reference/modules.md` (65 módulos). Falta só o detalhe por-endpoint (request/response) via `@openapi` incremental. Contexto original: `dashboard/server.mjs` expõe **~88 endpoints** e **não há nenhum
  ficheiro de API**. Só ~7 aparecem em prosa. Famílias não-documentadas: frota/filas (`/api/queues*`,
  `/api/workers`, `/api/fleet/*`, `/api/autoscale`), cobertura/telemetria (`/api/coverage`,
  `/api/data-coverage`, `/api/config`, `/metrics`), Moloni (11), Agendamentos, tracking público
  (`/t/o|/t/c|/t/u`, `/r/:token`, `/api/report/:id`), import/campanhas. → criar `docs/api.md`.
- [ ] **Setup das integrações** (vivem só no plano `.claude/` + comentários). Criar **`docs/integracoes/`**:
  tabela env→integração (derivar de `server.mjs:1315-1344` `/api/config`), runbook **Moloni** (série/tipos
  de doc no UI, `M99`, `status=1` irreversível, VD não suportada), runbook **Agendamentos** (SA + domain-wide
  delegation + Notion), e o estado "portado-mas-não-ligado" de Stripe/PayPal/EuPago/CoinGate/Wise/Documenso/
  OpenProvider (env + o que falta: webhooks, páginas). Atualizar o README §11/§12 para reconhecer a Fase F/G.
- [ ] **Reacher no `de-minio`** — serviço de produção invisível: acrescentar ao `runbook-minio-de1.md`
  (o host corre agora `dante`+`reacher`, egress SMTP:25 por `49.12.120.250`, escuta `100.124.43.117:8080`)
  e a `docs/observability.md` (não está nas unidades monitorizadas do de-minio).
- [ ] **Troubleshooting "fetch failed" (worker-na-bridge→tailnet).** O worker corre na bridge Docker mas o
  `REACHER_URL` é um IP tailnet `100.x`; só funciona por SNAT+rota `tailscale0` do host. Sintoma e requisito
  não documentados em lado nenhum.

### P2 — buracos operacionais

- [ ] **README §4 — jobs invisíveis:** `ssllabs` (job inteiro ausente), `result_site`/`jobs.result.site`
  (write-behind A3, role `writer`), `wordfence` (enriquece o wpscan keyless), `subdomains` multi-fonte
  (certspotter/crt.sh/securitytrails/censys/subfinder). Completar a tabela de roles com `residential`/
  `verify`/`writer` e enumerar os **marcadores "job correu"** (`*_checked_at`, `wp_vuln_count`, `hostnames`,
  `security_findings`, `mobile_score`/`perf_desktop`).
- [ ] **`blocklist-guard.sh` nos docs de ops** (`00-port25-and-ips.md` só tem o check manual mensal). Documentar
  a auto-pausa (move `verify-proxies.json`→`.paused`), o alerta ntfy, e que **não re-ativa sozinho**.
- [ ] **Routing WHOIS/RDAP por-TLD** (RDAP `.nl/.no/.fi`, port-43 `.se`, WhoisXML `.pt`) — só em comentários
  de código. Documentar (sítio natural: `docs/subdomain-sources-keys.md`) + `WHOISXML_API_KEYS` e
  `config/whois-providers.json`.
- [ ] **Autoscaler/recommender (`/api/autoscale`)** — sem runbook (Fase 1 read-only: preso-no-teto vs
  teto-com-folga; estado da Fase 2 auto-apply a confirmar).
- [ ] **`cleanup-contacts.js`** — passo real de higiene (purga por junk, por frequência, dedup por riqueza)
  ausente do fluxo do README §7/§8.

### P3 — completude

- [ ] **Gate FCrDNS via DoH** (não `dig`) — o porto 53 está bloqueado no hel1-docker; os runbooks ainda só
  ensinam `dig`. Documentar o porquê.
- [ ] **`np-server` acumulou serviços** além do runbook (Jaeger, Adminer, Documenso+postgres).
- [ ] **Egresso residencial via exit-node do laptop** (retoma do WPScan) — só num incidente, sem runbook.
- [ ] **Páginas do dashboard** — sem doc por-página (a UI é auto-explicativa; gap registado).

---

## D. O que está BEM documentado (referência, para confiança)

- **Núcleo do pipeline:** qualificação v2, merge de empresas, descoberta Common Crawl, GeoIP, taxonomia de
  22 indústrias, `load_bucket`, dedup/gdpr_basis de contactos — README §5-9 exato vs código.
- **Job DAG (parcial):** root `fetch`, `score` como convergência, domain-health `ssl/whois/dnsprovider`,
  drain por prioridade — exatos.
- **Fontes de subdomínios + Wordfence:** `docs/subdomain-sources-keys.md` bate 1:1 com `lib/subdomains.js`.
- **GMB:** `GMB-README.md` é referência viva e exata (estratégia v6, colunas, gating residential).
- **Infra:** `docs/observability.md` (abrangente e atual), runbooks ollama/minio/worker-vms/laptop,
  auto-deploy PULL (fiel ao `pull-deploy.sh`), `stack-isolation.md`, `deploy-watch.md`.
- **Verify routing** (big→API/corp→Reacher) e o mapa resposta-Reacher→`email_status` — exatos.
- **Incidentes** `20260716`/`20260717` — post-mortems fechados, manter.

---

## E. Sequência recomendada (maior alavancagem primeiro)

1. **Fechar o drift do Reacher** (P1-B) — barato e propaga uma mudança já feita; apagar `proxyuser`/password
   dos docs+comentários e as "README §2" penduradas. *(Grande parte foi introduzida nesta sessão — fix rápido.)*
2. **Corrigir os roles do README §4** (P1-B) — enganam operação.
3. **Corrigir os 2 runbooks de infra** (server-hel1 IP/VMID; analytics-de→hel1-analytics) (P1-B).
4. **Criar o índice `docs/README.md`** (A) — resolve a descoberta de 26 docs de uma vez.
5. **`docs/api.md` + `docs/integracoes/`** (C-P1) — os dois grandes buracos de conteúdo.
6. Restante P2/P3 conforme houver tempo; podar as meta-docs obsoletas.
