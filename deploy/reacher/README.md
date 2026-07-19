# Reacher — deploy do verificador SMTP (piloto do `verify`)

Desbloqueia o `verify` (hoje ~100/dia de APIs free contra 157k contactos por verificar). O Reacher faz
verificação SMTP **grátis e sem throttle** para domínios corporativos/PME; os grandes providers (Gmail/
Yahoo/Outlook) continuam pela API (o routing em `lib/verify-core.js` já faz isto). Contexto completo +
justificação de recursos: `.claude/plans/linear-weaving-quail.md` e `docs/outreach-ops/02-reacher.md`.

**Validado (2026-07-19):** a imagem `reacherhq/backend:v0.11.6` serve `/v1/check_email`; um probe real a
partir de um IP Hetzner (porto 25 aberto) distinguiu correto um endereço válido (`is_deliverable=true`) de
um inexistente (`is_reachable=invalid`) em `netmaster.pt`. O `lib/reacher.js` já usa `/v1` — sem alterações.

## Topologia (piloto)

```
worker verify (hel1-docker, FI) --HTTP--> Reacher (de-minio, DE, tailnet :8080)
                                              |
                                              +--SOCKS5--> Dante (de-minio 127.0.0.1:1080)
                                                              |
                                                              +--SMTP:25--> MX destino
                                                                 (egress 49.12.120.250, PTR p1.<D>)
```

O SMTP sai sempre do IP **DE 49.12.120.250** (limpo, porto 25 aberto), independentemente de onde corre o worker.

---

## Fase 0 — pré-requisitos (utilizador, fora do código)

1. **Registar** um domínio descartável barato `<D>` (não o netmaster.pt).
2. **DNS** no `<D>`: `p1.<D>.  A  49.12.120.250`.
3. **PTR/rDNS** no **Hetzner Robot**: `49.12.120.250 → p1.<D>`. Verificar (têm de bater):
   `dig +short p1.<D>` = `49.12.120.250` **e** `dig +short -x 49.12.120.250` = `p1.<D>.`
4. **Blocklist-clean** (re-confirmar): `for bl in zen.spamhaus.org b.barracudacentral.org bl.spamcop.net; do dig +short 250.120.12.49.$bl; done` → tudo vazio.

## Fase 1 — deploy (em de-minio)

1. **User `proxyuser`** no host (o Dante autentica por PAM):
   ```bash
   PASS=$(openssl rand -hex 16)
   useradd --no-create-home --shell /usr/sbin/nologin proxyuser
   echo "proxyuser:$PASS" | chpasswd
   echo "guarda a PASS → vai para config/verify-proxies.json"
   ```
2. **Env**: `cd deploy/reacher && cp .env.example .env` e preencher `REACHER_HELLO=p1.<D>`, `REACHER_FROM=verify@<D>`
   (o `TAILNET_IP=100.124.43.117` já está certo para de-minio).
3. **Arrancar**: `docker compose -f deploy/reacher/docker-compose.yml up -d` (puxa a imagem, arranca dante + reacher).
4. **`config/verify-proxies.json`** (na raiz do repo, gitignored) — 1 proxy:
   ```json
   [{ "id":"val1", "host":"127.0.0.1", "port":1080, "user":"proxyuser", "pass":"<PASS>",
      "ip":"49.12.120.250", "helo":"p1.<D>" }]
   ```
   Distribuir para o host que corre `verify` (hel1-docker — o mount `./config` já existe).
5. **REACHER_URL no worker**: `REACHER_URL=http://100.124.43.117:8080` + `REACHER_FROM_EMAIL=verify@<D>` no store
   da frota do host verify (`PUT /api/fleet/env/hel1-docker`); o pull-agent recria o worker.

## Fase 2 — validar + ligar

Smoke-tests:
```bash
# 1) túnel Dante (em de-minio) — espera banner 220
curl -x socks5://proxyuser:<PASS>@127.0.0.1:1080 -v telnet://gmail-smtp-in.l.google.com:25 --max-time 10
# 2) Reacher responde (via tailnet, de qualquer host da frota)
curl -s -XPOST http://100.124.43.117:8080/v1/check_email -H 'content-type: application/json' \
  -d '{"to_email":"test@gmail.com"}' | jq .is_reachable
# 3) fim-a-fim pelo verify-core (dry-run, não grava)
REACHER_URL=http://100.124.43.117:8080 REACHER_FROM_EMAIL=verify@<D> node verify-emails.js --limit=20 --dry-run
```
Ligar em produção (prioriza os melhores leads):
```bash
node enqueue-email-verification.js --min-score=45
```
Monitorizar ~2-3 rondas em `/api/queues` (consumer `verify`) e `/api/coverage` (`verify.verified` a subir);
sem pico de `unknown` (sintoma de IP sujo / porto 25 fechado).

## Fase 3 — escalar (depois de validado)

- **2º IP (FI)**: repetir em hel1-docker (`external eth0` → `65.108.120.25`, PTR `p2.<D>`), 2ª entrada em
  `verify-proxies.json`. O `lib/reacher.js` já faz round-robin + cooldowns por (IP, provider).
- **Gmail/Yahoo fiáveis**: proxies residenciais (pagos) ou o método `headless` (Chrome, já na imagem via
  ChromeDriver :9515). Avaliar custo vs deixar as APIs cobri-los.

## Reverter

`REACHER_URL` vazio no worker (+ recreate) → volta a só-APIs. `docker compose ... down` pára o Reacher/Dante.
Tudo aditivo, sem migração de dados.
