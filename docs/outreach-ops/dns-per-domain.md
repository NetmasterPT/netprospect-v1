---
title: "Runbook — DNS (OpenProvider) + PTR (Hetzner Robot) por domínio/IP de validação"
type: how-to
tags: [outreach, email]
related: []
owner: outreach
status: stable
updated: 2026-07-19
visibility: internal
---

# Runbook — DNS (OpenProvider) + PTR (Hetzner Robot) por domínio/IP de validação

Para cada **IP de validação** (de onde o Reacher faz o `RCPT` probing) escolhe-se um **domínio descartável**
e um subdomínio `p{N}.<domínio>`, e configura-se:

1. **Forward DNS** no **OpenProvider** (a zona do domínio).
2. **Reverse DNS (PTR)** no **Hetzner Robot** (o IP).

O que os MX destino verificam — e porque isto importa:
- **FCrDNS** (Forward-Confirmed reverse DNS): o PTR do IP resolve para um nome, e esse nome resolve de volta
  para o mesmo IP. **É o requisito nº1** — sem isto muitos MX (Gmail/Outlook) respondem `unknown`/recusam.
- **HELO alinhado**: o Reacher apresenta `EHLO p{N}.<domínio>` — tem de ser exatamente o PTR do IP.
- **Domínio do `MAIL FROM`** (`verify@<domínio>`) deve *parecer* legítimo (resolver + idealmente SPF) para
  os MX que fazem verificação do remetente.

> ⚠️ **Validação ≠ envio.** Estes domínios são só para probing (nunca enviam email real). Os domínios de
> **envio** (cold outreach, Fase 2) são **outros** e precisam de SPF+DKIM+DMARC completos — ver `03-sending-fleet.md`.
> **Nunca reutilizar** um domínio de validação para envio (o probing gasta reputação).

---

## Os nossos IPs (piloto + escala)

| IP público | Região | Host (egress) | Nome sugerido | Fase |
|---|---|---|---|---|
| `49.12.120.250` | DE (de1) | de-minio → NAT de1-pve | `p1.<D>` | **Piloto (agora)** |
| `65.108.120.25` | FI (hel1) | hel1-docker → hel1-pve | `p2.<D>` (ou `p1.<D2>`) | Fase 3 (escala) |

> Nota: `49.12.120.250` é o IP **principal** do nó de1-pve (partilhado pelas VMs DE via NAT). Definir-lhe o
> PTR muda o reverse DNS do host — inócuo (o nó não envia email). Para **isolar** o IP de validação do host,
> pode-se **encomendar um IP adicional** no Hetzner (~€1/mês) e encaminhá-lo para a VM; para o piloto usa-se o
> IP principal (custo zero). Se tiveres **vários domínios**, atribui **um domínio por IP** (ex. `p1.<D1>` no DE,
> `p1.<D2>` no FI) — diversifica os nomes HELO; ou usa `p1/p2` do mesmo domínio. Tanto faz para o funcionamento.

---

## Parte 1 — OpenProvider (forward DNS da zona `<D>`)

No painel OpenProvider → **DNS** → a zona do domínio `<D>` → adicionar:

| Tipo | Nome (host) | Valor | TTL | Necessário? | Porquê |
|---|---|---|---|---|---|
| **A** | `p1` | `<IP>` | 3600 | ✅ **obrigatório** | o nome HELO/PTR resolve para o IP (metade do FCrDNS) |
| **A** | `@` (o `<D>`) | `<IP>` | 3600 | 🟡 recomendado | o domínio do `MAIL FROM` (`verify@<D>`) resolve → parece configurado |
| **TXT** | `@` | `v=spf1 ip4:<IP> ~all` | 3600 | 🟡 recomendado | SPF autoriza o IP → passa a verificação de alguns MX ao `MAIL FROM` |
| **MX** | `@` | `10 p1.<D>` | 3600 | ⚪ opcional | dá um MX ao domínio (para MX que fazem *sender callout*); baixo valor marginal |
| **TXT** | `_dmarc` | `v=DMARC1; p=none` | 3600 | ⚪ opcional | evita que o domínio pareça totalmente por-configurar |

**Exemplo preenchido** (domínio `np-mailcheck.pt`, IP DE):
```
p1.np-mailcheck.pt.      A     49.12.120.250
np-mailcheck.pt.         A     49.12.120.250
np-mailcheck.pt.         TXT   "v=spf1 ip4:49.12.120.250 ~all"
np-mailcheck.pt.         MX    10 p1.np-mailcheck.pt.      (opcional)
_dmarc.np-mailcheck.pt.  TXT   "v=DMARC1; p=none"          (opcional)
```

> Se o domínio estiver **registado no OpenProvider mas com nameservers noutro lado**, os registos têm de ir
> ao provedor de DNS ativo. Confirmar: `dig +short NS <D>` mostra os nameservers em uso.

---

## Parte 2 — Hetzner Robot (reverse DNS / PTR)

Os nós são **dedicated servers** → o PTR define-se no **Robot** (não na Cloud Console):

1. **Robot** → **Servers** → o servidor (de1-pve para `49.12.120.250`; hel1-pve para `65.108.120.25`).
2. Separador **IPs** → a linha do IP → **Editar DNS reverso** (ícone/campo "Reverse DNS").
3. Pôr exatamente o nome do `p{N}.<D>`:
   ```
   49.12.120.250  →  p1.<D>
   ```
4. Guardar. A propagação do PTR do Hetzner é rápida (minutos), mas pode levar até ~1h.

> Se usares um **IP adicional** (encomendado à parte), aparece na mesma lista de IPs do servidor — mesmo passo.

---

## Parte 3 — Verificação (FCrDNS tem de bater)

Depois de propagar, correr (de qualquer host):
```bash
D=<D>; IP=<IP>
dig +short p1.$D            # tem de dar: <IP>
dig +short -x $IP           # tem de dar: p1.<D>.   (com o ponto final)
# extras (se configurados):
dig +short $D               # -> <IP>
dig +short TXT $D           # -> "v=spf1 ip4:<IP> ~all"
```
**Critério:** `dig +short p1.$D` **==** `$IP` **e** `dig +short -x $IP` **==** `p1.$D.` → FCrDNS OK ✅.
Enquanto não baterem, o Reacher devolve muito `unknown` (o MX desconfia do HELO/PTR).

Teste funcional rápido (depois do FCrDNS OK), a partir do host de egress:
```bash
printf 'EHLO p1.%s\r\nMAIL FROM:<verify@%s>\r\nRCPT TO:<postmaster@gmail.com>\r\nQUIT\r\n' "$D" "$D" \
  | nc -w10 gmail-smtp-in.l.google.com 25          # 220/250 = handshake aceite
```

---

## Tabela de atribuição — preencher por IP (o teu registo)

| IP | Região | Domínio + sub (HELO/PTR) | A no OpenProvider | PTR no Robot | FCrDNS ✅ |
|---|---|---|---|---|---|
| `49.12.120.250` | DE | `p1.___________` | ☐ | ☐ | ☐ |
| `65.108.120.25` | FI | `___._________` | ☐ | ☐ | ☐ |

Depois de FCrDNS ✅ no IP DE, diz-me o domínio/subdomínio que usaste — eu ligo o piloto do Reacher
(`config/verify-proxies.json` com `helo=p1.<D>`, `REACHER_URL`, deploy em de-minio; ver
[`../../deploy/reacher/README.md`](../../deploy/reacher/README.md)).
