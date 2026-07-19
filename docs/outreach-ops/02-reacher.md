# 02 — Reacher (the validation engine)

[Reacher](https://github.com/reacherhq/check-if-email-exists) is the Rust engine that does the 5-step
check (syntax → MX → SMTP `RCPT` → catch-all/role/disposable heuristics). We self-host it and call it
over HTTP from the worker, passing **our clean SOCKS5 proxy + PTR-aligned HELO per request**, so the
SMTP handshake egresses from a validation IP — never this box.

> **Deploy concreto (piloto) → [`deploy/reacher/`](../../deploy/reacher/)** — compose (dante + reacher) +
> `danted.conf` + README passo-a-passo, para o `de-minio` (DE, egress `49.12.120.250`).
>
> **Validado (2026-07-19):** a imagem OSS **`reacherhq/backend:v0.11.6`** (AGPL) serve **`/v1/check_email`**
> (e `/v0`) — o `lib/reacher.js` já usa `/v1`, sem alterações. Um probe real a partir de um IP Hetzner
> (porto 25 aberto) deu `is_deliverable=true` num endereço válido e `is_reachable=invalid` num inexistente
> em `netmaster.pt`. A imagem inclui ChromeDriver (:9515) para o método `headless` (Yahoo/Hotmail) → mais RAM.
> **Licença:** AGPL, uso interno (não é serviço a terceiros) é conforme sem publicação; **não** usar a imagem
> `commercial-license-trial` (proíbe produção). **Env v0.11 usa prefixo `RCH__` (duplo underscore).**

> **License check (do once):** confirm the current Reacher backend license permits your self-hosted,
> internal, commercial use. If it doesn't, we keep `lib/email-verify.js`'s own `smtpProbe` as the
> fallback engine (the code path is designed so `lib/reacher.js` is swappable). Don't skip this.

## Deploy Reacher on the Hetzner worker (one instance, many proxies)

Add to the netprospect stack (or a standalone compose on the worker box). Bind it to localhost only —
the worker reaches it in-process/over the internal network; it must not be public.

```yaml
  reacher:
    image: reacherhq/backend:latest
    restart: unless-stopped
    environment:
      RCH_HTTP_HOST: 0.0.0.0
      RUST_LOG: info
      # Per-request proxy + hello_name are sent in the JSON body (see below), so no global
      # proxy is set here. Set a sane default HELO/FROM as a fallback:
      RCH_HELLO_NAME: p1.<disposable-domain>
      RCH_FROM_EMAIL: verify@<disposable-domain>
      RCH_SMTP_TIMEOUT: "15"
    ports:
      - "127.0.0.1:8080:8080"      # localhost only
```

```bash
docker compose up -d reacher
curl -s -XPOST http://127.0.0.1:8080/v1/check_email \
  -H 'content-type: application/json' \
  -d '{"to_email":"test@gmail.com"}' | jq .is_reachable
```

> Reacher's env/API surface evolves — verify env var names (`RCH_*`) and whether a
> `RCH_HEADER_SECRET` / bearer token is required against the **current** Reacher docs for the image
> tag you pull, and pin the tag.

## The request shape our worker sends (per e-mail)

`lib/reacher.js` POSTs to `/v1/check_email` with a round-robin proxy from `config/verify-proxies.json`
and that proxy's PTR as the HELO:

```json
{
  "to_email": "person@corp.pt",
  "from_email": "verify@<disposable-domain>",
  "hello_name": "p2.<disposable-domain>",
  "proxy": { "host": "p2.<disposable-domain>", "port": 1080,
             "username": "proxyuser", "password": "<PASS>" },
  "smtp_timeout": 15
}
```

## Response → our `contacts.email_status`

Reacher returns `is_reachable` ∈ `safe | risky | invalid | unknown` plus `smtp.is_catch_all`,
`misc.is_role_account`, `misc.is_disposable`, `syntax.is_valid_syntax`, `mx.accepts_mail`.
`lib/reacher.js` maps them:

| Reacher | → `email_status` |
|---|---|
| `is_reachable=safe` | `valid` |
| `is_reachable=invalid` | `invalid` |
| `smtp.is_catch_all=true` | `catch_all` |
| `misc.is_role_account=true` | `role` |
| `misc.is_disposable=true` | `disposable` |
| `mx.accepts_mail=false` | `no_mx` |
| `is_reachable=risky/unknown` | `unknown` → **fall back to the API pool for Gmail/M365/Yahoo** |

## Scaling alternative (no proxies)

Instead of one Reacher + N Dante proxies, you can run **Reacher directly on each validation VM**
(no SOCKS5 layer) and round-robin across the VM endpoints. Simpler per-IP alignment, heavier per VM.
Fine for a few IPs; the proxy model scales to many IPs behind one Reacher. Start with whichever is
less ops for you — the app only needs either a proxy list or a Reacher-endpoint list.
