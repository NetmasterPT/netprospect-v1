# deploy/mailserver — VM de envio (cold outreach Fase 2) · TURNKEY

Deploy de uma **VM de envio** com `docker-mailserver` (DMS): autentica a submissão SMTP do drip, assina
**DKIM**, entrega do **IP limpo** da VM, e recebe **bounces + respostas** (lidos por `imap-poller.js`).

> ⚠️ **Isolamento (regra de ouro):** IPs/domínios de ENVIO ≠ de VALIDAÇÃO ≠ de PRODUÇÃO. Enviar/sondar
> tainta reputação — um domínio cold queimado nunca deve poder afetar `netmaster.pt`. Usa **2–3 domínios
> secundários baratos** (~€10/ano) espalhados por **2–4 IPs limpos**. O código já está pronto (o
> `campaign-drip.js` faz round-robin multi-conta + warm-up); **só falta esta infra + o warm-up (semanas).**

## Estado (o que está pronto vs o que precisas de fazer)

| Peça | Estado |
|---|---|
| Motor de envio + pool multi-conta + tracking + List-Unsubscribe | ✅ `lib/mailer.js`, `campaign-drip.js` |
| Warm-up com rampa `[5,10,15,25,35,50]` + caps por conta | ✅ `campaign-drip.js`, `docs/outreach-ops/04-warmup.md` |
| Leitura de bounces/respostas (IMAP) | ✅ `imap-poller.js` |
| **Artefacto de deploy do DMS** | ✅ **este diretório** (compose + setup.sh) |
| **IPs limpos + domínios secundários + DNS/PTR** | ⛔ **TU** (provisionar) |
| **Warm-up (calendário)** | ⛔ **TU** (semanas; não opcional) |

`SMTP_HOST` fica vazio → o envio corre em **dry-run** (gera + marca `sent`, mas **não envia**) até
`config/sending-accounts.json` existir. **Nada aqui envia sozinho.**

## Passos (por VM/IP)

0. **Porta 25 + IP limpo** — `docs/outreach-ops/00-port25-and-ips.md` (testar egress :25, PTR, Spamhaus-clean).
1. **Domínio secundário** — comprar 1; um mailbox por domínio; espalhar domínios pelos IPs.
2. **Provisionar a VM** — Docker + este diretório; `cp .env.example .env` e preencher `MAIL_HOSTNAME`
   (= PTR do IP = `mail.<domínio>`), `POSTMASTER_ADDRESS`, `SSL_TYPE`.
3. **Deploy + mailbox + DKIM + DNS** — `./setup.sh goncalo@<domínio>`: sobe o DMS, cria a mailbox, gera o
   DKIM e **imprime os registos DNS** (A/MX/SPF/DMARC/DKIM) + o **PTR** a pedir. Cria-os no DNS do domínio
   (OpenProvider) e o PTR no painel do IP (Hetzner Robot). Ver também `docs/outreach-ops/dns-per-domain.md`.
4. **Verificar auth** — 1 teste p/ seed Gmail → *Mostrar original*: **SPF/DKIM/DMARC = pass**; e
   `https://mail-tester.com` → **≥9/10** (corrige rDNS/headers antes de volume).
5. **Registar no app** — mete a mailbox em `config/sending-accounts.json` (gitignored;
   `config/sending-accounts.example.json` tem o formato: `host`=`mail.<domínio>`, `port` 587/465,
   `user`/`pass`, `from_email`, `warmup_max`). O estado (sent_today/stage) fica no Directus `sending_accounts`.
6. **Warm-up** — `docs/outreach-ops/04-warmup.md`; o `campaign-drip.js` sobe o volume pela rampa. **Semanas.**
7. **Ligar o envio real** — com ≥1 conta em `sending-accounts.json`, o `campaign-drip.js` deixa o dry-run e
   envia pelas contas (respeitando caps/warm-up). (O caminho worker `handleCampaignSend` continua a usar o
   transporte único `SMTP_*` — deliberado: os segredos das contas são **host-only**, não vão para a frota.)

## Operar

```bash
docker compose up -d                                   # subir
docker compose logs -f mailserver                      # logs
docker exec mailserver setup email list                # mailboxes
docker exec mailserver setup email add u@dominio '<pw>' # + mailbox
node campaign-drip.js --dry-run                         # simular o drip (sem contas → conta virtual)
node campaign-drip.js                                   # enviar real (precisa de sending-accounts.json)
```

## Custo / escala
2–3 domínios (~€10/ano cada) + 2–4 IPs (Hetzner/Scaleway baratos, ou os já-limpos que tens). Se, após um
warm-up justo, a colocação em inbox continuar má → escalar pela escada (`05-esp-ladder.md` / `06-aws-ses-mautic.md`).
