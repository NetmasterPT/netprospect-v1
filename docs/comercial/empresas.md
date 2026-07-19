---
title: Empresas
type: reference
tags: [comercial, data-model]
related: []
owner: comercial
status: stable
updated: 2026-07-17
visibility: internal
---

# Empresas

As empresas por trás dos sites/prospetos. Não há uma página "Empresas" dedicada — vêem-se pelo
**drawer do site** (a partir do directório/contactos) e as que são clientes têm a página
**`#/clients`**.

## Colecção `companies`

| Campo | Notas |
|---|---|
| `name`, `website`, `org_domain` | identidade (o `org_domain` liga aos sites/contactos) |
| `general_email`, `general_phone`, `phones` | contactos gerais da empresa |
| `address`, `country` | morada/país |
| `source`, `notes`, `created_at` | proveniência + metadados |
| `is_client` | **é cliente** (converte a empresa em cliente) |
| `client_since`, `client_mrr`, `client_notes` | dados de cliente (desde quando, MRR, notas) |
| `sites` (o2m), `contacts` (o2m) | sites e contactos da empresa |

## Vistas

- **Drawer do site** (`openSite`, via `GET /api/site?domain=`): alojamento, tech stack, auditoria
  (SEO/mobile/segurança/SSL/GMB/…), **contactos** da empresa, e ações — marcar/desmarcar **cliente**
  e **"+ a template"** (secção Contactos).
- **Clientes** (`#/clients`, `GET /api/clients`): empresas com `is_client=true` — o funil de conversão.

## Marcar cliente

`POST /api/clients/:companyId` `{ is_client }` — alterna o estado de cliente (usado pelo botão no
drawer do site).

## Contactos de uma empresa → Template

No drawer do site, a secção **Contactos** tem **"+ a template"** (quando há contactos com email):
abre um seletor de [template](templates.md) e adiciona os contactos com email da empresa ao
`contact_ids` desse template — `POST /api/email-templates/:id/contacts { add:[ids] }`.

## Ligações

- **Contactos** e **sites** pertencem a uma empresa (o2m via `org_domain`).
- **Subscrições / ICPs / Templates** ligam-se a empresas-cliente por `client_ids` (os `refs.clients`
  dos endpoints trazem só as empresas com `is_client=true`).
