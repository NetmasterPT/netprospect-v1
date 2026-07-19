---
title: "Campanhas"
type: reference
tags: [comercial, data-model]
related: []
owner: comercial
status: stable
updated: 2026-07-17
visibility: internal
---

# Campanhas

Campanhas de email: constroem uma audiência a partir de filtros (de um segmento), geram a cópia (por
IA ou por template) e enviam por SMTP. Página **`#/campaigns`** (+ **`#/outreach`** para o funil/KPIs).

## Colecções

### `campaigns`
`name`, `status` (`draft`/`generating`/`ready`/`sending`/`sent`), `angle` (ângulo de IA),
`audience_filters` (json — filtros da audiência), `segment` (segmento de origem), `from_name`,
`from_email`, `reply_to`, `subject_hint`, `notes`, contadores (`total`/`generated`/`sent`/`opened`/
`clicked`), `created_at`, `sent_at`, `emails` (o2m).

### `emails`
Um por destinatário: `to_email`, `to_name`, `subject`, `body`, `status` (`pending`→`generating`→
`ready`→`sending`→`sent`→`opened`/`clicked`/`replied`/`failed`), `ai_generated`, `variables`, `token`
(tracking), `campaign`, `contact`, `site`, `send_account`, timestamps de `sent`/`opened`/`clicked`.

## Ciclo de vida

1. **Criar** (`POST /api/campaigns`): nome + ângulo + `audience_filters` (+ from/reply-to). Fica `draft`.
2. **Gerar** (`POST /api/campaigns/:id/generate`): constrói a audiência a partir de `audience_filters`
   (`contactAudienceParts` → contactos com email e não-"não contactar"), cria os `emails` (`pending`,
   dedup por email) e enfileira `jobs.campaign.generate` — o worker gera o assunto/corpo por **IA**
   (`generateEmail` em `lib/campaign-ai.js`) e marca `ready`.
3. **Enviar** (`POST /api/campaigns/:id/send`): enfileira `jobs.campaign.send` dos e-mails `ready`/`failed`.
   Modo SMTP ou dry-run consoante `SMTP_HOST`.
4. **Tracking**: pixel de abertura + redirect de clique por `token` marcam `opened_at`/`clicked_at`.

## A partir de uma subscrição

`POST /api/subscriptions/:id/campaign` — cria uma campanha a partir de um [pacote](subscricoes.md):

- **Audiência**: um `segmentId` (de entre os segmentos do pacote) → `audience_filters` = os `filters`
  desse segmento.
- **Conteúdo**:
  - **IA** (sem template): campanha `draft`; gera-se depois na página da campanha (ângulo).
  - **Template** (`templateId`, de entre os templates do pacote): constrói a audiência e **preenche já**
    os `emails` com o assunto/corpo do template, substituindo as `{{variáveis}}` por contacto
    (`subVars`/`subRender`), com `ai_generated:false` e `status:ready` (prontos a enviar).

O drawer "Criar campanha" (nos cards de subscrição) escolhe segmento + conteúdo (IA ou um template do
pacote) + remetente, e abre a campanha criada.

## API

- `GET /api/campaigns` (lista + contadores) · `GET /api/campaigns/:id` (campanha + e-mails).
- `POST /api/campaigns` · `POST /api/campaigns/:id/generate` · `POST /api/campaigns/:id/send` ·
  `DELETE /api/campaigns/:id`.
- Ângulos configuráveis em `config/campaign-angles.json` (página Configuração → Ângulos).
