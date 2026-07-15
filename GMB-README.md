# GMB (Google My Business) — estado e o que falta

Extração de dados de negócio do Google Maps **via browser** (sem Places API), correndo **só no laptop**
(IP residencial — o Google bloqueia IPs de datacenter com a página `/sorry/`). Código: `lib/audit/gmb-lookup.js`
+ handler em `worker/worker.mjs` (`gmb`). Só corre no role `residential` com `GMB_ENABLED=true`.

## Estratégia atual (v6 — `CODE_VERSION=gmb-addr-name-v6`)

Decisão de produto: **evitar falsos positivos por IDENTIDADE**, não pela query. Duas estratégias, por ordem:

1. **Morada** (âncora física) — se o site tiver `business_address` (rua+nº): pesquisa a morada no Maps e
   clica num negócio da secção **"Neste local"**. Guarda leniente (aceita mesmo sem site próprio no GMB).
2. **Nome + guarda ESTRITA** (fallback, ~89% dos sites não têm morada): pesquisa `nome+cidade`, resolve a
   ficha (auto-redirect ou clica no 1.º resultado) e **ACEITA SÓ SE o site do negócio no GMB (authority URL)
   bater com o domínio auditado**. Assim clicar no 1.º resultado é seguro — um negócio errado é rejeitado.

Em ambas, o resultado é validado por `buildFromPage()`: nome (via `aria-label` do `[role=main]`, senão um
`h1` que não seja o do anúncio, senão a própria URL `/maps/place/<Nome>,<morada>/`), + rating/categoria/
telefone/morada, e a guarda de domínio (`authority URL` vs domínio).

## O que está FEITO e provado

- ✅ **Bloqueio `/sorry/`** detetado → degrada para null (não envenena com "Porquê este anúncio?").
- ✅ **Consent wall** contornado (cookies SOCS/CONSENT + clique "Aceitar tudo").
- ✅ **Nome correto** — deixou de apanhar o `h1` do bloco de anúncio; usa `aria-label`/URL. Provado: 7/16 no
  1.º lote (Universidade Autónoma, Ceibas, CNIS, IPS, ISVOUGA, OHA, Chapim Azul) com nome+rating+cidade+site.
- ✅ **Falso positivo eliminado** — `grillsymbol.fi` casava em `homestagingportugal.com`; a guarda de domínio
  rejeita (o site do negócio ≠ domínio auditado).
- ✅ **Via morada provada** — autonoma + ceibas resolveram via "Neste local" com dados completos e corretos.
- ✅ **UA desktop + viewport** (o Maps mobile tinha DOM diferente); **backoff/ackWait** do gmb corrigidos
  (consumer `ack_wait=180s`, não morre a meio); `_debug` de cada null vai para o **Redis** (telemetria).
- ✅ **Diagnóstico**: `pesquisa por DOMÍNIO não resolve em headless` (0/6, nem a Livraria Lello) → removida.
- ✅ Fix do telefone (deixou de trazer `": "` à cabeça).

## O que FALTA (continuar depois — precisa do laptop)

1. **Validar o v6 no laptop.** O laptop tem de estar na versão nova:
   ```bash
   git pull && docker compose -f deploy/laptop/docker-compose.yml up -d --force-recreate
   ```
   (O compose do laptop agora **monta `lib/` e `worker/` como volume** → daqui para a frente é só
   `git pull && docker compose -f deploy/laptop/docker-compose.yml restart`, **sem rebuild**.)
   Confirmar a versão: no Redis, a linha de arranque do worker residential deve ter `v=gmb-addr-name-v6`.

2. **Re-enfileirar + medir** (a partir do HEL1, contra o laptop):
   ```bash
   docker exec netprospect-worker-2 node /app/enqueue-fine-audits.js --only=gmb --limit=30 --no-dedup --by-score
   # ler razões (Redis): docker exec netprospect-worker-2 node /app/redis-raw.mjs | grep -iE "✓ gmb|gmb.*null:"
   # ler dados (BD): scratchpad/gmb-check.mjs (ajustar a lista de domínios)
   ```
   Esperado: os que têm morada resolvem via `via:address`; os sem morada resolvem via `via:name` **só** se o
   GMB do negócio listar o próprio domínio. Razões de null novas: `name-not-unique`, `no-identity`,
   `domain-mismatch`, `no-signal`, `blocked-sorry-or-recaptcha`.

3. **Afinar** conforme os `_debug`:
   - Se muitos `no-identity` → o negócio existe mas o GMB não lista o site → decidir se aceitamos com outra
     corroboração (ex.: cidade/telefone a bater) ou ficamos conservadores (null).
   - Se `name-not-unique` alto → a `company.name` pode ser o título verboso do site; considerar limpar a query.
   - A categoria (`gmb_category`) ainda falha em alguns (seletor) — secundário.

4. **Cobertura de morada é baixa** — só **181/1691** sites qualificados (lead≥60) têm `business_address`.
   A via-morada (a mais precisa) só cobre ~11%. Melhorar `lib/audit/locality.js` (JSON-LD, footer, contactos)
   aumentaria muito a precisão do GMB. Ver [`TODO.md`].

5. **Enqueue em massa** só depois de o v6 validar bem (o utilizador dá a ordem, por bandas de lead-score).

## Notas operacionais

- **Colunas na BD**: `gmb` (bool), `gmb_name`, `gmb_category`, `gmb_rating`, `gmb_reviews`, `gmb_phone`,
  `gmb_url`, `gmb_place_id`, `gmb_checked_at` (marca "o job correu"), + `business_city/region/address`.
- **Cobertura = "job correu"**: `gmb_checked_at IS NOT NULL`. Um site com `gmb_checked_at` mas `gmb_name` null
  = correu e não encontrou (ou não confiámos) — é o esperado, não é erro.
- **Estale gmb=true**: alguns sites têm `gmb=true` de runs antigos (envenenados) que o null novo não limpa
  (o handler só escreve `gmb_checked_at`, não limpa `gmb`). Limpar em massa quando o v6 estiver validado.
- **Só o laptop** faz `ensureConsumer(gmb)` → se o laptop tiver `jobs.js` antigo, reverte o `ack_wait` do gmb.
