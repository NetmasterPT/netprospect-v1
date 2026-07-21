# Plan: Cobertura de Dados — usável vs possivelmente-usável por indicador

> Ficheiro NOVO, criado de raiz. NÃO reescreve nem toca em `linear-weaving-quail.md` nem em
> `jobs-coverage-audit.md`. Sem overwrites.

## Context

A página **Cobertura de Dados** mostra hoje, por indicador, UM só número ("o campo tem valor" = existe dado).
O utilizador quer, **em relação ao dado que EXISTE na DB**, distinguir por indicador e por cada filtro de score:
- **Usável** = validado / confirmado (temos a certeza que serve).
- **Possivelmente usável** = existe mas **não está 100% validado** (pode servir, mas não está confirmado).

É o mesmo eixo que já fizemos no `verify` (válido=verde vs catch-all=roxo), agora **generalizado a todos os
indicadores que têm uma dimensão de confiança de validação**. Ficheiros: `dashboard/server.mjs`
(`DATA_COVERAGE_SQL` ~1769-1802, `CONTACT_VERIFY_SQL` ~1807-1819, endpoint `/api/data-coverage`),
`dashboard/public/index.html` (`viewDataCoverage`, `DCOV_FIELDS`, `covBar2` já existe, `verifySum`),
e (só se optarmos por schema novo) `lib/pgwrite.js` + `bootstrap-directus.js`.

## Achados — eixo de validação por indicador (verificado no código + magnitudes na DB)

**Divisível JÁ (colunas existentes, nível-SITE, sem schema):**
- **industry** — usável = `industry_confidence >= <T>`; possível = `< <T>`. (gmb-override=0.9, humano=≥1, heurística
  0.4-0.95.) DB: alta(≥0.6)=**305k** vs baixa=**362k** de 667k classificados. → `T` é decisão (ver abaixo).
- **gmb** — usável = `gmb_name IS NOT NULL` (ficha Google confirmada por lookup); possível = `gmb`/`gmb_signal`
  sem nome (só sinal detetado no HTML). DB: **4.604** confirmados vs **135k** com sinal. ⚠️ isto EXPANDE o que a
  linha gmb conta (hoje só conta os 4.604 confirmados; a camada "possível" acrescenta os de-sinal).
- **whatsapp** — usável = `whatsapp_number IS NOT NULL` (número captado); possível = `social_whatsapp` só com
  link wa.me e `whatsapp_number` NULL.

**Divisível JÁ mas nível-CONTACTO (denominador ≠ site):**
- **email** — usável = `email_status='valid'` (`email_verified`); possível = `catch_all` + com-email-mas-`status
  NULL`. DB: **161** válidos vs **~157k** por-verificar/catch-all. **Já existe** a secção "Contactos (verificação
  de email)" com verde/roxo (`CONTACT_VERIFY_SQL`) — falta reforçar o rótulo "usável/possível".
- **decision_maker** — usável = `role_category='decision_maker'` **E** `email_status='valid'`; possível = DM sem
  email verificado. Precisa de uma query contact-level (à la `CONTACT_VERIFY_SQL`, filtrada a DMs).

**Precisa de coluna NOVA (não dá para dividir com o schema atual):**
- **phone** — os telefones guardados já passam pelo gate E.164 `isValid()` (`lib/phone.js`), mas NÃO há
  `phone_status`/`phone_verified`/`phone_source` nem se persiste a proveniência (`tel:`-href vs texto). Split
  limpo exige coluna nova (ex.: `phone_type` MOBILE/FIXED, ou `phone_source`).
- **city / address** — sem `business_city_source`/`business_address_source`; "GMB-confirmado vs heurístico" só
  via o proxy impreciso `gmb_name IS NOT NULL`. Split limpo exige coluna de proveniência.

**Eixo de QUALIDADE (≠ validação — o valor está confirmado, é só bom/mau) — tratar à parte, opcional:**
- **ssl** (`ssl_grade='F'` vs A-D), **spf**/**dmarc** (`missing`/`invalid` vs `ok`), **cms_version** (`cms_outdated`).
  Não encaixa no "possivelmente usável por não estar validado" (sabemos o valor). Opcional: uma 2ª cor de
  QUALIDADE, mas é decisão separada — por defeito NÃO incluir no eixo usável/possível.

**Binários (temos a certeza — sem split):** geoip, social, tech, dns_provider, lighthouse_mobile/desktop, seo,
security, wpscan, whois, traffic (o `unranked` já está excluído; o tiering é ranking, não validação).

## Workstream A — Split de validação nível-SITE (colunas existentes, sem schema)

`DATA_COVERAGE_SQL`: para **industry, gmb, whatsapp**, em vez de 1 count, expor 2 por bucket: `<ind>_usavel` e
`<ind>_possivel` (o "existe" = usável+possível). Ex.:
- `industry_usavel = count FILTER (industry_confidence >= T)`, `industry_possivel = count FILTER (industry IS NOT NULL AND confidence < T)`.
- `gmb_usavel = count FILTER (gmb_name IS NOT NULL)`, `gmb_possivel = count FILTER ((gmb OR gmb_signal IS NOT NULL) AND gmb_name IS NULL)`.
- `whatsapp_usavel = count FILTER (whatsapp_number IS NOT NULL)`, `whatsapp_possivel = count FILTER (social_whatsapp AND whatsapp_number IS NULL)`.

## Workstream B — Indicadores nível-CONTACTO

- **email**: reutilizar o que já existe (`CONTACT_VERIFY_SQL` → verde/roxo); clarificar rótulo usável/possível.
- **decision_maker**: nova query contact-level (DMs) → usável (`role_category='decision_maker' AND email_status='valid'`)
  vs possível (DM sem email válido) / total de DMs. Denominador contact-level (não o `total` site).

## Workstream C — UI (reutiliza o `covBar2` do verify)

Cada linha DIVISÍVEL passa a barra a 2 tons: **verde=usável + roxo=possível**, `(+N)` para o possível, sobre o
"existe" (usável+possível). Os binários ficam barra simples. Legenda: "usável = validado/confirmado · possível =
existe mas não 100% validado". Reutilizar `covBar2` (index.html:1922) + o padrão da secção verify.

## Workstream C — Colunas de proveniência p/ phone/city/address (schema NOVO) → split

Decisão do user: adicionar proveniência para dividir estes 3.
- **Campos novos** (`sites`: `business_city_source`, `business_address_source`; `contacts`: `phone_source`) via
  `ensureField` (string) + `pgwrite` allow-list (+ SITE_COLS/CONTACT_COLS).
- **Handlers escrevem a proveniência:**
  - city/address: `handleLocality` (`worker/handlers.mjs`) → `'heuristic'`; o handler `gmb` (`worker/worker.mjs`,
    quando escreve `business_city`/address autoritativos) → `'gmb'`.
  - phone: `extract-contacts.js`/`handleContacts` → `'tel_href'` (número num `tel:` link = forte) vs `'text'`
    (extraído do texto = fraco). (Ver `lib/phone.js` para onde os números são captados.)
- **Split:** usável = `*_source IN ('gmb','tel_href')`; possível = `'heuristic'/'text'` (ou source NULL nos
  já-existentes). Backfill dos existentes → `'heuristic'`/`'text'` conforme o melhor palpite (ou NULL→possível).
- phone é contact-level → precisa de rollup `sites.has_phone_valid` OU medir contact-level (à la email/DM).

## Workstream D — 2ª cor de QUALIDADE (ssl/spf/dmarc/cms) — eixo SEPARADO

Decisão do user: adicionar cor de qualidade (bom/mau), distinta do eixo usável/possível.
- **ssl:** bom = `ssl_grade <> 'F'` (A-D); mau = `'F'` (sem HTTPS/expirado). Sobre "tem ssl_grade".
- **spf / dmarc:** bom = `= 'ok'`; mau = `IN ('missing','invalid')` (fraco = `'weak'` → decidir na execução: bom ou mau).
- **cms_version:** bom = `cms_outdated=false`; mau = `cms_outdated=true`.
- UI: 2ª cor VERMELHA (mau) — variante de `covBar2` (verde/vermelho em vez de verde/roxo), rotulada "qualidade".

## Workstream E — UI (reutiliza/estende `covBar2`)

- Linhas de VALIDAÇÃO (industry/gmb/whatsapp/email/DM + city/address/phone após C): barra verde=usável +
  **roxo**=possível, `(+N)`, sobre o "existe".
- Linhas de QUALIDADE (ssl/spf/dmarc/cms): barra verde=bom + **vermelho**=mau.
- Binários: barra simples. Legenda distingue os 2 eixos (validação roxo · qualidade vermelho).

## Sequência
A (splits site s/ schema) + B (contacto) + D (qualidade, s/ schema) + E (UI) — sem migração, rápidos. **C**
(proveniência) tem schema+handlers+backfill → a seguir. Industry: **limiar ≥ 0.6** (decidido).

## Verificação
- `curl /api/data-coverage` por filtro (TODOS/>55/>75): cada indicador dividido mostra usável+possível (ou
  bom+mau) cujo total bate com o "existe"; comparar com `SELECT count(*) FILTER(...)` direto na DB.
- C: correr locality/gmb/contacts num site e confirmar que `*_source` fica preenchido; backfill valida os
  existentes; write-behind não rebenta (novos campos no SITE_COL_TYPE se forem ts — aqui são string, ok).
- UI: 3 tipos de barra (validação verde/roxo · qualidade verde/vermelho · binária simples); números por filtro batem.

## Decisões tomadas (2026-07-18)
1. Limiar de "usável" da industry = **≥ 0.6**.
2. phone/city/address = **adicionar colunas de proveniência** (Workstream C).
3. ssl/spf/dmarc/cms = **2ª cor de qualidade** (Workstream D).
