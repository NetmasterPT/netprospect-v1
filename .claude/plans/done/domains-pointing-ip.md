# Descobrir domínios apontando para um IP

**Created:** 7/7/2026 10:19:58  
**Updated:** 7/7/2026 10:33:02  
**Exported:** 7/7/2026 14:57:27  
**Link:** [https://claude.ai/chat/00829406-9fb5-45d4-8519-b7aa5e303c05](https://claude.ai/chat/00829406-9fb5-45d4-8519-b7aa5e303c05)  

## User:

> 7/7/2026 10:20:16

Existe forma de se descobrir todos os dominios que têm o DNS a apontar para um IP?

## Assistant:

> 7/7/2026 10:20:47

> Mapeou métodos técnicos para descobrir domínios associados a IPs.
>
> - The user is asking in Portuguese about discovering all domains pointing to a specific IP address—essentially a reverse DNS or reverse IP lookup question. This is a legitimate technical inquiry, especially given their sysadmin background, and comes up regularly for server migrations, security audits, and understanding shared hosting environments. Let me think through the technical approaches available for this.
>   
>   DNS doesn't inherently support reverse lookups in that way—you can't query "show me all domains on this IP"—but there are several practical methods. PTR records only give you one primary reverse DNS entry, not comprehensive results. The more useful approaches involve third-party services that maintain domain-to-IP databases built from web crawling and DNS zone file analysis, like ViewDNS, SecurityTrails, Shodan, Censys, and others. Passive DNS databases from services like SecurityTrails, RiskIQ, VirusTotal, and Farsight DNSDB track historical DNS resolutions and are particularly valuable. Certificate Transparency logs can also reveal domains since SSL certificates often list multiple domains via Subject Alternative Names, and searching crt.sh can uncover certificates associated with that IP address.
>   
>   For his specific situation as a Portuguese MSP managing WHM/cPanel servers on Hetzner infrastructure, if this is his own server he can directly query the system using WHM API calls or check the local domain configuration files to list all hosted domains. If it's someone else's IP, the OSINT approach using Bing's `ip:` operator combined with passive DNS and certificate transparency searches would be most effective, though no single method will give a completely comprehensive picture since DNS fundamentally doesn't support reverse enumeration beyond PTR records. I don't need to search for this—it's established technical knowledge about reverse DNS and passive DNS tools that hasn't fundamentally changed. I'll structure the answer in Portuguese with practical methods and tools, keeping it concise and technical for someone with WHM access.
> - **Done**

Sim, mas com limitações — o DNS em si não tem uma query "reverse" que devolva todos os domínios A-record apontados a um IP. As opções práticas são:

**Se o servidor é teu (WHM/cPanel, Proxmox, etc.)**
- É o método mais fiável: `whmapi1 listaccts` no WHM lista todas as contas/domínios no servidor.
- Ou olhar directamente para `/var/cpanel/users/`, `/etc/userdomains` ou o vhost config do Apache/Nginx (`/etc/apache2/sites-enabled` ou equivalente lsapi/EA4 configs).

**Se não é teu (IP de terceiros)**
- **PTR record (reverse DNS)** — `dig -x IP` ou `nslookup IP`. Só dá o hostname principal configurado no PTR, não todos os domínios que apontam para lá.
- **Bases de dados de Passive DNS / Reverse IP** — recolhem histórico de resoluções DNS vistas na internet:
  - [SecurityTrails](https://securitytrails.com) (tem free tier, é dos mais completos)
  - [ViewDNS.info](https://viewdns.info) → "Reverse IP Lookup"
  - [RapidDNS.io](https://rapiddns.io)
  - [HackerTarget](https://hackertarget.com) → reverse IP lookup tool
- **Shodan / Censys** — pesquisando pelo IP mostram hostnames e certificados SSL associados.
- **Certificate Transparency** — [crt.sh](https://crt.sh) não pesquisa por IP directamente, mas se souberes um domínio no servidor podes ver outros SANs no mesmo certificado (útil em hosting partilhado com certs multi-domínio).
- **Bing** — suporta o operador `ip:IP_AQUI` na pesquisa, mostrando páginas indexadas nesse IP (Google não tem equivalente).

Nenhum destes é garantidamente completo — dependem do que cada serviço já rastreou. Para uma lista 100% exacta e actual, só o próprio servidor (WHM, vhosts) tem a resposta definitiva.

## User:

> 7/7/2026 10:23:47

Ok e há alguma forma de descobrir que outros dominios usam o mesmo IP que um domínio específico?

## Assistant:

> 7/7/2026 10:24:00

> Reconheceu reverse IP lookup e mapeou solução técnica direta.
>
> - The user is essentially asking the same thing in different words—finding other domains on the same IP as a given domain. It's a reverse IP lookup, just starting from a domain instead of an IP address. The approach is straightforward: resolve the domain to its IP first, then perform the reverse lookup. Given the user's technical background with sysadmin experience, I can keep the technical depth as is without oversimplifying.
> - **Done**

Sim — o processo é exactamente o mesmo que descrevi, só acrescenta um passo inicial: primeiro resolves o domínio para o IP, depois fazes reverse IP lookup nesse IP.

**Passo 1 — obter o IP do domínio**
```
dig +short dominio.com
```
ou `nslookup dominio.com`

**Passo 2 — reverse IP lookup nesse IP**
Mesmas ferramentas de antes:
- [ViewDNS.info](https://viewdns.info) → Reverse IP Lookup (aceita directamente um domínio, resolve o IP por ti)
- [RapidDNS.io](https://rapiddns.io) → também aceita domínio ou IP
- [SecurityTrails](https://securitytrails.com) — histórico mais completo (free tier tem limite de queries)
- Bing: `ip:X.X.X.X`

**Um aviso importante para este caso específico:** se o domínio estiver atrás de Cloudflare, um CDN, ou hosting com IP partilhado tipo anycast, o IP que resolves não é o "servidor real" — é um proxy/edge node partilhado por milhares de sites completamente não relacionados. Nesse caso o reverse IP lookup vai devolver uma lista enorme e inútil. Vale a pena confirmar primeiro se o IP é mesmo dedicado ao servidor de origem (por exemplo, vendo se há um AS/ASP conhecido de CDN no whois do IP, ou usando `dig` para ver se há Cloudflare nos nameservers).

Se for um servidor cPanel/WHM teu (como os teus hel1/de1), o mais fiável continua a ser aceder directamente e correr `whmapi1 listaccts` ou verificar `/etc/userdomains`, em vez de depender destas bases de dados externas.

## User:

> 7/7/2026 10:25:27

Como ter a certeza que não está por detrás de uma CDN como o cloudflare?

## Assistant:

> 7/7/2026 10:25:50

> Compilou métodos práticos para detectar presença de CDN.
>
> - O usuário está perguntando como verificar se um domínio está atrás de um CDN como Cloudflare. Vou responder com métodos práticos — verificar nameservers, ranges de IP, headers HTTP — e como o usuário prefere Node.js, Batch ou PowerShell, vou priorizar exemplos nessas linguagens em vez de Python ou PHP. I'll structure this as a practical checklist with concrete commands for Windows/PowerShell, mentioning the key indicators: checking nameservers for Cloudflare's NS pattern, running WHOIS on the resolved IP to look for CLOUDFLARENET, examining HTTP response headers for CF-RAY and Cloudflare server identifiers, verifying the IP against Cloudflare's published ranges, and checking if the SSL certificate is issued by Cloudflare.
> - **Done**

**Como confirmar se um domínio está atrás de Cloudflare (ou outro CDN):**

- **Nameservers** — se estiver na Cloudflare, os NS são sempre custom deles, tipo `xxxx.ns.cloudflare.com`:
  ```
  dig NS dominio.com
  ```
  (PowerShell: `Resolve-DnsName -Name dominio.com -Type NS`)

- **Headers HTTP** — a Cloudflare quase sempre devolve um header `cf-ray` e `Server: cloudflare`:
  ```
  curl.exe -I https://dominio.com
  ```

- **WHOIS do IP** — o campo OrgName/descr aparece como "CLOUDFLARENET" ou "Cloudflare, Inc.":
  ```
  whois <IP>
  ```
  (Windows não tem `whois` nativo — usa [whois.domaintools.com](https://whois.domaintools.com) ou instala via `winget install whois`)

- **Confirmar contra os ranges oficiais** — a Cloudflare publica a lista completa de IPs deles em [cloudflare.com/ips](https://www.cloudflare.com/ips/). Se o IP resolvido cair dentro de um desses blocos, é praticamente certeza que é edge da Cloudflare.

- **Certificado SSL** — se o cert for emitido por "Cloudflare Inc ECC CA-3" ou similar, confirma o proxy:
  ```
  openssl s_client -connect dominio.com:443 -servername dominio.com 2>/dev/null | openssl x509 -noout -issuer
  ```

Se qualquer um destes bater certo, sabes que o IP resolvido é edge partilhado — nesse caso o reverse IP lookup não te vai dizer nada útil sobre o servidor de origem real. Para outros CDNs (Sucuri, Fastly, Akamai, AWS CloudFront) o princípio é o mesmo: NS distintos, header de servidor característico, e ranges de IP publicados que dá para verificar.

## User:

> 7/7/2026 10:26:33

Ok e há forma de descobrir todos os dominios registados numa extensão (como o .pt)?

## Assistant:

> 7/7/2026 10:27:27

> Distinguiu registos públicos de ccTLDs e mapeou alternativas práticas.
>
> - The user wants to know how to discover all domains registered under a specific TLD like .pt. This is about accessing zone files and registry data—many TLD registries provide zone file access to approved researchers and security professionals through ICANN's programs, though the specific availability depends on the registry's policies.
>   
>   For .pt specifically, I should verify DNS.PT's current policies on zone file access and what data they publish. Since registry policies can change and my knowledge has a cutoff, I need to search for current information about .pt TLD enumeration methods and what's actually available right now.
> - DNS.PT zona .pt lista completa domínios acesso zone file
> - I'm not finding much on DNS.PT zone file policies through general searches, so I need to try more targeted queries about accessing .pt domain data or whether the registry participates in CZDS for country-code TLDs.
> - "dns.pt" zone file access "czds" OR "ficheiro de zona" pedido acesso
> - CZDS only covers gTLDs like .com and .org, so .pt as a ccTLD wouldn't be included there. I need to check whether the Portuguese registry (DNS.PT) offers direct zone file access or any bulk domain listing, since I'm not certain about their specific policies on this.
> - dns.pt relatório estatístico número domínios registados .pt download lista
> - I've confirmed that .pt is a ccTLD managed by DNS.PT outside of ICANN's CZDS system, which only covers gTLDs, and there's no public zone file access available. So I'll structure my answer to distinguish between gTLDs like .com and .org where CZDS provides official zone file access through ICANN, versus country-code domains like .pt that operate under different registries.
>   
>   For practical alternatives, certificate transparency logs like crt.sh offer a way to enumerate domains that have obtained TLS certificates under a TLD, which captures most active sites since HTTPS adoption is widespread. Commercial providers like WhoisXML API and DomainTools compile and sell domain lists per TLD through their own data collection methods. Given the context that this might relate to a prospecting pipeline for the Portuguese market, these approaches would be more relevant than trying to source official zone files that simply don't exist publicly for .pt. I'm thinking through the technical answer in Portuguese for a mobile-friendly format—leading with the key point that .pt is a country-code TLD without public ICANN zone file access, then covering practical alternatives like Certificate Transparency logs for finding registered domains, commercial data providers that may have .pt zone data through registry agreements, and broader web crawl datasets, keeping it concise and actionable.
> - **Done**

Depende do tipo de extensão — a resposta é diferente para gTLDs (.com, .org, etc.) e para ccTLDs como o .pt.

**Para gTLDs (.com, .net, .org, novos gTLDs)**
Existe um mecanismo oficial: o [CZDS da ICANN](https://czds.icann.org) permite pedir acesso ao ficheiro de zona completo diretamente aos registries participantes. É gratuito, mas precisa de aprovação caso a caso (tipicamente para investigação de segurança, propriedade intelectual, etc.) e o registry pode recusar o pedido.

**Para o .pt especificamente**
O .pt é um ccTLD gerido pela Associação DNS.PT e **não está no CZDS** — isso é exclusivo de gTLDs. A DNS.PT não disponibiliza o ficheiro de zona completo ao público; o que publicam são apenas estatísticas agregadas (contagens de registos, evolução mensal, etc.) em [pt.pt/statistics](https://www.pt.pt/en/statistics/), sem lista de nomes.

**Alternativas práticas para aproximar uma lista de domínios .pt:**
- **Certificate Transparency (crt.sh)** — pesquisar por `%.pt` nos logs de CT devolve uma fatia enorme de domínios que já emitiram certificados SSL (hoje em dia isso cobre a maioria dos sites ativos). É a via gratuita mais completa.
- **Datasets comerciais de zonas** — empresas como WhoisXML API ou DomainTools vendem "TLD zone/domain lists" que incluem ccTLDs como o .pt, obtidos através de acordos próprios ou agregação de múltiplas fontes.
- **Common Crawl** — dataset público de crawling da web; não é exaustivo mas apanha muitos domínios .pt indexados organicamente.
- **Brute-force com wordlists** — testar nomes prováveis contra DNS é o método menos eficiente e nunca dá cobertura total.

Nenhuma destas alternativas dá uma lista 100% completa e oficial — só o próprio registry (DNS.PT) tem isso, e não o disponibiliza publicamente.

---

**Sources:**

- [Zonas DNS no servidor DNS do Windows Server | Microsoft Learn](https://learn.microsoft.com/pt-br/windows-server/networking/dns/zone-types)
- [Exibir registros de recursos DNS para uma zona DNS | Microsoft Learn](https://learn.microsoft.com/pt-pt/windows-server/networking/technologies/ipam/view-dns-resource-records-for-a-dns-zone)
- [Alterar ou configurar registos de DNS (zona de DNS) « Domínios.pt](https://kb.dominios.pt/article/alterar-ou-configurar-registos-de-dns/)
- [Gestão de Zonas DNS via myPTisp - Knowledge Base PTisp](https://kb.ptisp.com/gestao-zonas-dns-via-myptisp/)
- [.PT - Domínios de Portugal](https://www.pt.pt/en/)
- [Visão Geral das Zonas e Registos DNS | Microsoft Learn](https://learn.microsoft.com/pt-pt/azure/dns/dns-zones-records)
- [Área de Cliente – As suas Funcionalidades « Domínios.pt](https://kb.dominios.pt/article/area-de-cliente-as-suas-funcionalidades/)
- [O que é o DNS? | Domínios - GoDaddy Ajuda PT](https://pt.godaddy.com/help/o-que-e-o-dns-665)
- [Configurar/Administrar domínios « Categories « Domínios.pt](https://kb.dominios.pt/article-category/configuracao-de-dominios/)
- [Gestão de DNS e NameServers – Blog Dominios.pt](https://blog.dominios.pt/category/dns)
- [Serviço de Dados de Zona Centralizado (CZDS)](https://www.icann.org/en/contracted-parties/registry-operators/services/centralized-zone-data-service-pt)
- [Sign In | Centralized Zone Data Service](https://czds.icann.org/)
- [Formatando um Arquivo de Zona de DNS](https://docs.oracle.com/pt-br/iaas/Content/DNS/Reference/formattingzonefile.htm)
- [O que é uma zona de DNS?](https://www.cloudflare.com/learning/dns/glossary/dns-zone/)
- [As opções de transferência de zona DNS são redefinidas inesperadamente - Windows Server | Microsoft Learn](https://learn.microsoft.com/pt-br/troubleshoot/windows-server/networking/dns-zone-transfer-options-reset)
- [Best Practices for DNS Zone File Management: A Comprehensive Guide - DNS Expert](https://dnscompetition.in/articles/best-practices-for-dns-zone-file-management-a-comprehensive-guide/)
- [Zonas DNS integradas ao Active Directory | Microsoft Learn](https://learn.microsoft.com/pt-br/windows-server/identity/ad-ds/plan/active-directory-integrated-dns-zones)
- [Statistics - .PT](https://www.pt.pt/en/statistics/)
- [RELA TÓRIO DNS .PT](https://www.pt.pt/fotos/editor2/relatorios/relatorio_icann58.pdf)
- [Ferramenta de pesquisa de DNS | verifique registros DNS de um domínio - Ferramentas do Site24x7](https://www.site24x7.com/pt/tools/pesquisa-dns.html)
- [Regras de registo de nomes de domínios .PT - Knowledge Base PTisp](https://kb.ptisp.com/regras-de-registo-de-nomes-de-dominios-pt/)
- [Relatório DNS.PT PDF Download grátis](https://docplayer.com.br/865677-Relatorio-dns-pt-2011.html)
- [Registo de Domínio em .pt - INPI - Justiça.gov.pt](https://inpi.justica.gov.pt/Registo-de-Dominio-em-pt)
- [Portugal na Web: O que precisa saber para registar um domínio .PT](https://www.pcguia.pt/2019/11/portugal-na-web-o-que-precisa-saber-para-registar-um-dominio-pt/)
- [O que precisa para registar um domínio .PT - onesoft PT](https://onesoft.pt/o-que-precisa-para-registar-um-dominio-pt/)
- [Domínios ".PT" chegam a um milhão. Já há um site nacional para cada 11 portugueses](https://observador.pt/2018/03/13/dominios-pt-chegam-a-um-milhao-ja-ha-um-site-nacional-para-cada-11-portugueses/)

## User:

> 7/7/2026 10:30:26

Ok, explica em detalhe o método que descreveste do Certificate Transparency e como posso utilizar esse método

## Assistant:

> 7/7/2026 10:33:02

> Arquitetou solução Node.js para enumerar domínios via Certificate Transparency.
>
> - The user is looking for a detailed guide on using Certificate Transparency logs to enumerate domains under the .pt TLD, and I should frame the implementation around his tech stack—likely a Node.js script since that's his primary language, with a PowerShell alternative for his Windows environment. He seems to have started mentioning something specific but got cut off.
>   
>   Now I'm diving into how Certificate Transparency actually works—it's an RFC 6962 system where CAs log every SSL/TLS certificate they issue into public, append-only logs, which makes it perfect for domain enumeration since nearly every domain has an SSL cert these days. The main practical approach is querying crt.sh, which indexes these CT logs and exposes them through a web UI, JSON API, and even a public PostgreSQL database. A wildcard search like `%.pt` pulls back all certificates with SANs ending in .pt, including subdomains, and returns useful metadata like issuer, common name, and the full SAN list—though since one cert can cover multiple domains, I'll need to handle deduplication.
>   
>   The challenge is scale: a query for `.pt` could return over a million domains with historical certificates, so the HTTP API would likely time out. The better approach is connecting directly to crt.sh's PostgreSQL instance at crt.sh:5432 to run SQL queries against their certwatch database, which is much more efficient for bulk operations. I could write a Node.js script using the `pg` library to connect and query the certificate_and_identities table directly, filtering for `.pt` domains. The crt.sh database is publicly accessible on a PostgreSQL instance with standard connection details that are documented on their site, though I should verify these haven't changed since they're specific technical facts that could shift over time.
> - crt.sh postgresql direct database access certwatch guest query example
> - The public Postgres instance at crt.sh is still actively maintained and well-documented across multiple sources, so that's a reliable data source. The certificate_and_identities view contains the key fields I need, and the NAME_TYPE OID '2.5.4.3' specifically identifies common names in the certificate data.
>   
>   For DNS names specifically, I should use the crt.sh web UI's "Show SQL" feature (by appending `&showSQL=Y` to a query URL) to see the exact working query syntax rather than guessing at the NAME_TYPE value, since the format might vary. This also reveals the pagination limits—crt.sh caps results at around 15,000 records per page, so for large domains like .pt with millions of certificate identity rows, I'll need to implement cursor-based or offset-based pagination to retrieve the full dataset without hitting query limits.
>   
>   Since he's working in Node.js with his existing pipeline (Playwright, PostgreSQL, n8n), I should write a Node.js script using the `pg` package to connect directly to crt.sh's Postgres instance, paginate through results efficiently using cursor-based approaches (ID > last_id ordering), and stream the results into a file or his prospecting database.
>   
>   I'll structure the response to explain Certificate Transparency fundamentals—why every HTTPS certificate issued for a .pt domain gets logged publicly in append-only logs since 2013 (mandatory for browsers since ~2018)—and then show how querying these logs lets us enumerate all registered .pt domains and subdomains by searching for certificates with SANs ending in .pt.
>   
>   Key limitations to flag: only domains with issued SSL certificates appear (no HTTPS = no entry), results include massive numbers of subdomains requiring deduplication, wildcard certificates need special handling, expired/revoked certs are included, and the same domain can appear many times across certificate renewals.
>   
>   For the practical approach, I'll skip the simple web interface (`crt.sh/?q=%.pt&output=json`) since it'll timeout on .pt's volume, and jump straight to direct PostgreSQL access via `psql -h crt.sh -p 5432 -U guest certwatch` with a Node.js implementation that handles pagination and bulk export efficiently.
>   
>   Writing Node.js script... At this scale, I need to handle pagination with cursors to avoid timeouts and memory issues. I should also filter for non-expired certificates by joining with the certificate table and checking the expiry date, since that gives a much more useful prospecting list than historical dead certs. The exact schema has evolved over time—sometimes they expose a combined view, sometimes separate tables—so the safest approach is to use crt.sh's web UI with the `showSQL=Y` parameter to get today's working query, then adapt it into the script rather than guessing at column names.
>   
>   I should also warn about resource constraints: crt.sh is shared community infrastructure, and aggressive scraping with many parallel connections risks getting blocked. For a dataset this large—potentially tens of millions of rows across .pt domains—hammering the live database directly might not be welcome. I could suggest limiting scope to active certs or currently resolving domains, or point toward alternative bulk sources like Rapid7's Open Data project, which publishes pre-compiled DNS and CT-based hostname datasets that are less taxing than live queries.
>   
>   But the user specifically asked for a detailed explanation of the CT method itself, so I should focus on that: what CT is, why it works for enumeration, the practical methods (web UI, JSON API, direct Postgres access), and a working Node.js script that fits his stack. I'll include the caveat about scale and politeness with shared infrastructure, and suggest he might want to scope down or approach this incrementally rather than trying to extract the entire ccTLD at once.
>   
>   I'll write this in Portuguese (European) matching his language and tone, and since the Node.js script will be substantial, I'll create it as an artifact so he can save and reuse it directly in his pipeline. Writing the Node.js script... I should mention that running this against the full .pt domain on crt.sh's free service could take a very long time and consume significant resources, so it's worth considering running it overnight and potentially filtering to non-expired certificates only if he's just looking for active domains. For smaller-scale testing, the JSON API endpoint works well with shorter substrings, though it'll time out on the full TLD. I'll create this as a downloadable JavaScript file so he can save and execute it directly. I'm settling on the standard `dNSName` pattern I've seen across multiple crt.sh enumeration examples, and I'll include a caveat to verify it with `showSQL=Y` since schema details can shift. Now I'll structure the full response: starting with what Certificate Transparency is and why it works for subdomain discovery, then covering the limitations, quick web-based approaches for small exploration, and finally the robust Postgres direct-access method with the Node.js script as the main artifact.
> - **Done**

O Certificate Transparency (CT) é um mecanismo criado pela Google em 2013 e hoje obrigatório em todos os browsers principais: desde ~2018, nenhuma CA pública pode emitir um certificado SSL/TLS sem o submeter a um ou mais **logs públicos, append-only**. Isto significa que **qualquer certificado alguma vez emitido para um domínio fica publicamente pesquisável para sempre**, mesmo que o dono do site nunca tenha pedido isso.

**Porque é que isto serve para enumerar domínios de um TLD**
Como quase todos os sites hoje usam HTTPS (Let's Encrypt tornou isto gratuito e automático), pesquisar "todos os certificados cujo SAN termina em `.pt`" nos logs de CT dá-te uma aproximação muito boa da lista real de domínios ativos sob esse TLD — sem depender do registry.

**Limitações a ter em conta**
- Só apanha domínios que **já tiveram certificado SSL** — sites sem HTTPS (raro, mas existe: domínios parqueados, usados só para email/DNS) não aparecem.
- Devolve **imensos subdomínios**, não só domínios apex (`www.`, `mail.`, `dev.`, etc.).
- Certificados wildcard aparecem como `*.exemplo.pt` — tens de limpar o `*.`.
- Inclui certificados **expirados/revogados** — um domínio pode aparecer dezenas de vezes ao longo dos anos por renovações.

---

## Método 1 — Interface web / JSON (bom para explorar, não para bulk)

```
https://crt.sh/?q=%.pt&output=json
```

Funciona bem para domínios individuais ou substrings pequenas. Para o `.pt` inteiro, esta via via HTTP simples vai dar timeout — há demasiados registos.

## Método 2 — Acesso direto ao PostgreSQL do crt.sh (o que realmente funciona para bulk)

O crt.sh disponibiliza acesso público, só-leitura, à base de dados que alimenta o site:

```bash
psql -h crt.sh -p 5432 -U guest certwatch
```

**Dica importante:** o esquema de tabelas evolui ao longo do tempo, por isso a forma mais fiável de obteres a query exata e atual é acrescentar `&showSQL=Y` a qualquer pesquisa no site, por exemplo:

```
https://crt.sh/?q=%.pt&showSQL=Y
```

Isso mostra-te, no fundo da página, o SQL exato que o crt.sh gerou — copia esse padrão em vez de confiares cegamente numa query decorada (a minha abaixo é um ponto de partida típico, mas confirma sempre contra o `showSQL=Y`).

Vou preparar-te um script Node.js (já que é a tua stack principal) que faz a extração paginada por ID — mais eficiente que `OFFSET` em bases tão grandes — normaliza os nomes e grava para ficheiro.

> Created file, presented file
>
> - Script Node.js para extrair domínios .pt via acesso direto ao PostgreSQL do crt.sh (Certificate Transparency)
> - Presenting file(s)...
> - **Done**

**Como usar:**
```bash
npm install pg
node crtsh-enum.js pt --active-only
```

**Notas práticas:**
- `--active-only` filtra para certificados ainda válidos — reduz drasticamente o volume e dá-te uma lista mais próxima de "domínios vivos hoje", o que provavelmente te interessa mais do que histórico completo.
- A paginação é feita por `CERTIFICATE_ID > lastId` em vez de `OFFSET`, que é muito mais eficiente em tabelas deste tamanho.
- Corre isto em background (`nohup node crtsh-enum.js pt --active-only &` ou via `pm2`) — para um TLD com a dimensão do `.pt` pode demorar horas.
- Depois de teres o `dominios_pt.txt`, o passo lógico seguinte (e provavelmente o que te interessa para a tua pipeline de prospecção) é cruzar essa lista com resolução DNS ativa + Wappalyzer para filtrar só os que estão realmente online e identificar a stack tecnológica — que já tens montado no NetProspect.

> File: [/mnt/user-data/outputs/crtsh-enum.js](https://claude.ai/api/organizations/1c2124cf-3877-4c17-8cb4-8cfe198190c0/conversations/00829406-9fb5-45d4-8519-b7aa5e303c05/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fcrtsh-enum.js)

---

**Sources:**

- [Enhancement: Connect with PostgreSQL · Issue #8 · PaulSec/crt.sh](https://github.com/PaulSec/crt.sh/issues/8)
- [New feature: Direct access to the crt.sh DB](https://groups.google.com/g/crtsh/c/sUmV0mBz8bQ/m/K-6Vymd_AAAJ)
- [Re: New feature: Direct access to the crt.sh DB](https://groups.google.com/g/crtsh/c/oEDOzwr2Fuc)
- [crt.sh actually has their postgres database open to the public! You can connect ... | Hacker News](https://news.ycombinator.com/item?id=22440551)
- [GitHub - c3l3si4n/quickcert: A better way of querying certificate transparency logs · GitHub](https://github.com/c3l3si4n/quickcert)
- [PostgreSQL Support for Certificate Transparency Logs Now Available | Hacker News](https://news.ycombinator.com/item?id=42625372)
- [In this vein I was surprised to learn that crt.sh (certificate transparency log)... | Hacker News](https://news.ycombinator.com/item?id=38774466)
- [explainshell.com - psql -A -F , -f querycrt -h http://crt.sh -p 5432 -U guest certwatch 2>/dev/null | tr ', ' '\n' | grep twitch | anew](https://explainshell.com/explain?cmd=psql+-A+-F+%2C+-f+querycrt+-h+http%3A%2F%2Fcrt.sh+-p+5432+-U+guest+certwatch+2%3E%2Fdev%2Fnull+%7C+tr+%27%2C+%27+%27\n%27+%7C+grep+twitch+%7C+anew)
- [Crt.sh Unsupported use of '%' | Medium](https://medium.com/@CustosClarus/crt-sh-into-the-wild-43b55f4c5495)
- [`crt.sh` PostgreSQL interface subdomain query · GitHub](https://gist.github.com/maxrodrigo/dec5c1d676e2cfbfcf1935414ed4c7a8)
