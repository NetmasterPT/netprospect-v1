---
title: "Segmentos"
type: reference
tags: [comercial, data-model]
related: []
owner: comercial
status: stable
updated: 2026-07-17
visibility: internal
---

# Segmentos

Vistas guardadas de filtros do directório de negócios. Um segmento **é uma audiência**: o seu objeto
de `filters` é a mesma linguagem de filtros do directório e é o que campanhas e subscrições usam para
construir a lista de contactos. Página **`#/segments`**.

## Colecção `segments`

| Campo | Tipo | Notas |
|---|---|---|
| `name` | string | nome do segmento |
| `description` | text | descrição |
| `accent` | string | cor de destaque na UI |
| `filters` | json | objeto de filtros do directório (país, plataforma, lead score, SSL, social, …) |
| `shared` | boolean | partilhado |
| `owner` | string | dono |

## Filtros (`filters`)

O mesmo vocabulário do directório de negócios, construído por `buildSiteFilters`/`siteFilterParts`
(`dashboard/server.mjs`). Inclui, entre outros: `qualified`, `live`, `platform`, `country`, `isp`,
`has_email`/`has_phone`, `dm` (tem decisor), `lead_min`/`lead_max` (ranges de 5 em 5), `city`,
`industry`, `traffic`, `cpanel`/`notcpanel`, redes sociais (`fb/ig/li/tw/wa/pin/yt/tk`), `spf`/`dmarc`,
`ssl_expiring`/`ssl_expired`/`ssl_paid`/`ssl_ov`/`ssl_wildcard`, `domain_renew` (30/60/90/180d),
`cms_outdated`, etc. Combinam-se em **E** (default) ou **OU** (modo `match=any`).

## Página

CRUD simples: criar (a partir dos filtros atuais do directório), listar (com contagem de sites que
batem os filtros) e apagar.

## API

- `GET /api/segments` (lista + contagem por segmento) · `POST /api/segments` · `PUT /api/segments/:id`
  · `DELETE /api/segments/:id`.

## Uso a jusante

- **Campanhas**: `audience_filters` de uma campanha = os `filters` do segmento escolhido → contactos
  via `contactAudienceParts`.
- **Subscrições, ICPs, Templates**: ligam-se a segmentos por `segment_ids` (ver ficheiros respetivos).
