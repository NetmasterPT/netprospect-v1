# DATA-BENCHMARK — ground truth de 2 sites (validação dos workers)

> Análise **manual e independente** (sem usar os workers), 2026-07-14, para servir de referência ao
> corrigir a pipeline. Cada campo tem: **valor na DB** vs **o que encontrei** vs **estado**.
> ✅ = DB correto · ❌ = DB errado · ⚠️ = DB incompleto/miss · ❓ = não validável (GMB).
> **NÃO apagar da DB ainda** — primeiro corrigir workers, validar contra este ficheiro, depois limpar.

---

## 1) galeriadoimobiliario.pt  (site id 36313 · mediação imobiliária, Torres Novas)

| Campo | DB | Encontrado (manual) | Estado |
|---|---|---|---|
| IP | 94.46.13.109 | 94.46.13.109 (dns.google) | ✅ |
| ASN/ISP | AS24768 Almouroltec | AS24768 ALMOUROLTEC (ipinfo) | ✅ |
| PTR | mail-01.improxy.com | mail-01.improxy.com | ✅ |
| DNS provider | improxy.com | NS dns1/dns2.improxy.com | ✅ |
| Local alojamento | PT | PT (Almouroltec, hosting nacional) | ✅ |
| SPF | missing | sem registo SPF | ✅ |
| DMARC | weak | `v=DMARC1; p=none; rua=…dmarc-report.com` (existe, política none) | ✅ |
| SSL | B · Let's Encrypt · exp 2026-08-26 (48d) | Let's Encrypt R12, exp Aug 26 2026 | ✅ |
| Velocidade | 792 ms · fast | 0.70 s (curl) | ✅ |
| CDN | (n/a) | **nenhum** (nginx+Plesk direto) | ✅ |
| Server | — | nginx · X-Powered-By PHP/7.3.33 · **PleskLin** | (Plesk, não cPanel — DB is_cpanel=false ✅) |
| Tech stack | WordPress, MySQL, PHP 7.3.33, Bootstrap, Nginx | idem | ✅ |
| Versão CMS | 5.5.18 (outdated) | WordPress 5.5.18 | ✅ |
| Indústria | imobiliario (0.85) | mediação imobiliária | ✅ |
| Cidade negócio | Torres Novas | Torres Novas | ✅ |
| País negócio | PT | PT | ✅ |
| Morada | `Galeria do Condominio Avenida dos Negréus, Lote 2, Loja D --> 2350-523 Torres Novas` | Avenida dos Negréus, Lote 2, Loja D, 2350-523 Torres Novas | ⚠️ (artefacto `-->` no meio) |
| **Emails** | (nenhum nos contactos) | **torresnovas@galeriadocondominio.pt** | ❌ MISS (`has_email=true` mas não guardado) |
| **Telefones fixos** | +351 249 109 955 (num contacto-lixo) | +351 249 109 955 | ⚠️ (certo, mas atado a lixo) |
| **Telemóveis** | — | **+351 918 304 805** | ❌ MISS |
| Redes sociais | Facebook ✅ · Instagram=false | Facebook `/GaleriadoImobiliario` + **Instagram** (link no site) | ⚠️ IG MISS |
| **Contactos (pessoas)** | 12 "contactos": `Quem Somos`→CIO/decision_maker, `Ilha de São Miguel`, `Vila Real`, `Torres Novas`, `Viana do Castelo`, `Administração de Condominios`, `Resolução Alternativa`… | **NENHUMA pessoa real** — são menus, localidades e títulos de página | ❌❌ LIXO |
| Nuclei | 0 findings | 0 findings (corri eu) | ✅ |
| WPScan | wp_vuln_count=0 | WP 5.5.18; **o site bloqueia o wpscan agora** (timeout) — 0 keyless é esperado (keyless não traz vulns) | ⚠️ (0 suspeito; keyless nunca dá vulns) |
| GMB | gmb=false | ❓ não validável (IP datacenter bloqueado; laptop sem SSH) | ❓ |

---

## 2) oculistadasavenidas.pt  (site id 58232 · oculista/Grupo Optivisão, Lisboa)

| Campo | DB | Encontrado (manual) | Estado |
|---|---|---|---|
| IP | 88.157.180.178 | 88.157.180.178 | ✅ |
| ASN/ISP | AS1897 NOS Comunicações | AS1897 NOS COMUNICACOES | ✅ |
| PTR | mail.visus.pt | mail.visus.pt | ✅ |
| DNS provider | domaincontrol.com | NS pdns11/12.domaincontrol.com (GoDaddy) | ✅ |
| MX | (n/a) | Outlook/Microsoft 365 | (não rastreado) |
| Local alojamento | PT | PT (NOS) | ✅ |
| SPF | ok | `v=spf1 …outlook… -all` (existe, forte) | ✅ |
| DMARC | missing | sem registo _dmarc | ✅ |
| SSL | B · Let's Encrypt · exp 2026-10-04 (86d) | Let's Encrypt YR2, exp Oct 4 2026 | ✅ |
| Velocidade | 1033 ms · medium | 1.8 s (com redirect www) | ✅ |
| CDN | (n/a) | **nenhum** (Apache direto) | ✅ |
| Server | — | Apache · X-Powered-By PHP/5.6.34 | ✅ (tech bate) |
| Tech stack | WordPress, MySQL, PHP 5.6.34, Bootstrap, Yoast, Apache, jQuery, prettyPhoto | idem | ✅ |
| Versão CMS | 4.8.6 (outdated) | **WordPress 4.8.6 (conf 100%, keyless)** | ✅ |
| Redirect www | true | redireciona p/ www.oculistadasavenidas.pt | ✅ |
| Indústria | retalho (0.65) | oculista/ótica = retalho | ✅ |
| Cidade negócio | Lisboa | Lisboa | ✅ |
| País negócio | PT | PT | ✅ |
| **Morada** | (null) | **1050-061 / 1000-081 Lisboa** (Grupo Optivisão) | ❌ MISS |
| **Emails** | (nenhum nos contactos) | **ocav@ocav.pt** | ❌ MISS |
| **Telefones fixos** | +351 217 999 060 (num contacto-lixo) | 217 999 060 + **217 959 043** | ⚠️ (2º fixo MISS) |
| Redes sociais | todas false | nenhuma na homepage | ✅ |
| **Contactos (pessoas)** | 6 "contactos": `Quem Somos`→CIO/decision_maker, `No Oculista`→Engineer/staff, `Flexi Open`, `Informações Legais`, `Em Espanha`, `Campo Pequeno` | **NENHUMA pessoa real** — menus/frases | ❌❌ LIXO |
| **Nuclei** | 0 findings | **2 findings: CVE-2021-24139 (CRÍTICO, SQLi 10Web Photo Gallery) + CVE-2023-5561 (médio)** | ❌ ERRADO (timeout do batch registou 0) |
| WPScan | wp_vuln_count=117 | WP 4.8.6 confirmado; 117 é plausível p/ WP de 2018 (scan com key). Não re-verifiquei: quota 25/dia esgotada | ⚠️ (plausível, não re-validado) |
| GMB | gmb=false | ❓ não validável | ❓ |

---

## 3) Bugs identificados → onde corrigir

1. **Extração de contactos (`extract-contacts.js` / `lib/contacts.js`)** — o pior. Apanha texto de menus, localidades e títulos de página (`Quem Somos`, `Ilha de São Miguel`, `Flexi Open`) como **pessoas**, e inventa cargos (CIO, decision_maker, Engineer). Praticamente 100% dos contactos são inválidos. Também marca `has_decision_maker=true` com base em lixo.
2. **Emails não guardados** — a pipeline deteta email (`has_email=true`) mas não o guarda como contacto/campo. Perde `torresnovas@galeriadocondominio.pt`, `ocav@ocav.pt`.
3. **Telefones/telemóveis parciais** — só apanha o 1.º fixo (atado ao contacto-lixo); perde telemóveis e 2.º fixo.
4. **Social (`lib/audit/social.js`)** — perde Instagram quando o link não é um perfil canónico (ex.: `/explore/locations/…`).
5. **Locality (`lib/audit/locality.js`)** — perde a morada quando não está num padrão óbvio (oculista: morada null apesar de estar no site).
6. **Nuclei** — o timeout do batch regista **0** em sites que TÊM findings reais (oculista tinha 1 CVE crítico). Já mitigado (tech-aware/timeout) mas há dados falsos na DB.
7. **WPScan (`lib/audit/wpscan.js`)** — dois bugs: (a) **aborta no redirect www** (falta `--ignore-main-redirect`); (b) o "keyless" **não é keyless** — o wpscan lê `WPSCAN_API_TOKEN` do env automaticamente, por isso o batch usava a key e batia no limite (causa dos ~25 853 reports `scan_aborted`). Fix: `WPSCAN_API_TOKEN=''` ao invocar keyless.
8. **Morada com artefacto** — o `-->` no meio da morada do galeriado (parsing do HTML).

> A rede/infra (IP, ASN, PTR, DNS, SPF, DMARC, SSL, tech, versão CMS, velocidade, cidade, indústria)
> está **toda correta** — o problema é o **on-site** (contactos, emails, telefones, social, morada) e o
> **nuclei/wpscan**.
