---
title: Subscrições
type: reference
tags: [comercial, data-model]
related: []
owner: comercial
status: stable
updated: 2026-07-17
visibility: internal
---

# Subscrições

Produtos/pacotes que a Netmaster oferece (alojamento, manutenção, SSL, segurança, SEO técnico,
melhorias desktop/mobile, …). Página **`#/subscriptions`** (menu Comercial).

## Colecção `subscriptions`

| Campo | Tipo | Notas |
|---|---|---|
| `name` | string | nome do pacote (obrigatório) |
| `frequency` | string | `one_off` · `monthly` · `quarterly` · `semiannual` · `annual` |
| `category` | string | alojamento/manutenção/ssl/segurança/seo/desktop/mobile/outro (datalist) |
| `features` | json | array de strings — pontos/funcionalidades (um por linha no editor) |
| `price_ex_vat` | float | preço **sem** IVA (€) |
| `price_inc_vat` | float | preço **com** IVA (€) — IVA a **23%** |
| `icp_ids` | json | ids de [ICPs](icps.md) |
| `template_ids` | json | ids de [templates](templates.md) |
| `segment_ids` | json | ids de [segmentos](segmentos.md) |
| `client_ids` | json | ids de empresas-cliente ([empresas](empresas.md)) |
| `campaign_ids` | json | ids de [campanhas](campanhas.md) |
| `active`, `notes`, `sort`, `date_created` | — | estado + metadados |
| `icps`, `email_templates` | json | **legado** — modelo inline antigo (texto/objetos), antes de ICPs e templates virarem colecções. Novos pacotes usam `icp_ids`/`template_ids`. |

## Preço e IVA

O editor tem os dois campos ligados (23%): ao escrever o preço **sem IVA** calcula o **com IVA**
(`×1.23`), e vice-versa (`÷1.23`). O servidor (`subClean` em `dashboard/server.mjs`) recalcula o outro
lado ao guardar, priorizando o `price_ex_vat` quando ambos vêm.

## Página

- Lista de cards (nome, frequência, categoria, preço s/ e c/ IVA, primeiros pontos, contagens de
  relações) + **"+ Novo pacote"**.
- Editor: nome/frequência/categoria, preço, pontos (textarea), e **Relações** por multi-seleção —
  Segmentos, **ICPs** e **Templates** (que "bebem" das colecções respetivas, via `SUB.refs`),
  Clientes, Campanhas.
- **"Criar campanha"** (nos pacotes com segmentos) → abre um drawer. Ver o fluxo em
  [campanhas.md](campanhas.md#a-partir-de-uma-subscrição).

## API (`dashboard/server.mjs`)

- `GET /api/subscriptions` → `{ subscriptions, refs: { segments, campaigns, clients, icps, templates } }`.
- `POST /api/subscriptions` · `PUT /api/subscriptions/:id` · `DELETE /api/subscriptions/:id`.
- `POST /api/subscriptions/:id/campaign` — cria uma campanha a partir do pacote (segmento → audiência;
  `templateId` opcional → preenche os e-mails). Ver [campanhas.md](campanhas.md).
