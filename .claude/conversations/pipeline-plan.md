# Netmaster — Pipeline de Prospeção e Enriquecimento (Self-Hosted)
## Estratégia + Plano de Implementação — para Claude Opus / Claude Code

**Contexto:** Gonçalo Pedro / Netmaster — objetivo de negócio de 30.000€ de faturação adicional em contratos de manutenção + alojamento (receita recorrente e previsível), com prospeção em Portugal, Holanda, Suécia, Finlândia e Noruega.

**Natureza deste documento:** especificação técnica + plano de implementação faseado, para ser executado por um agente de coding (Claude Opus via Claude Code) com checkpoints de revisão humana entre fases. Não é uma proposta de produto — é um plano de engenharia direto.

---

## 1. Contexto e Restrições

### 1.1 Porque é que isto é self-hosted e não usa Apollo/Hunter/etc.
Testámos ao vivo a API da Apollo.io com a conta atual: tanto a pesquisa de empresas (`mixed_companies/search`) como o enriquecimento de pessoas (`people/match`) devolveram `API_INACCESSIBLE` — bloqueados ao nível do plano, independentemente do saldo de créditos disponível. Confirma isto se decidires reавaliar Apollo no futuro, mas para já a via SaaS está fechada sem upgrade pago, o que contraria o requisito de custo zero.

### 1.2 Restrições inegociáveis
- **Custo zero de licenciamento/SaaS.** Apenas custo de computação, na infraestrutura já existente (Proxmox hel1/de1, Docker Compose).
- **Sem scraping direto de LinkedIn.** Viola os Termos de Serviço da plataforma e há histórico de ações legais da Microsoft/LinkedIn contra scrapers (ex: casos hiQ, e outros mais recentes). Não é compatível com o objetivo de "reduzir risco".
- **RGPD aplicável** em PT, NL, SE, FI (UE) e NO (EEE, aplica RGPD via acordo EEE) — ver secção 4.2.
- **Preferir fontes com licença aberta explícita** (dados governamentais, OpenStreetMap) a scraping de plataformas comerciais com ToS restritivos (Google Maps, LinkedIn).

### 1.3 Non-goals (fora de âmbito nesta fase)
- Não construir um CRM completo — apenas armazenamento simples (Postgres) para deduplicação e estado.
- Não fazer verificação SMTP em volume alto sem validação manual prévia (risco de reputação de IP/domínio).
- Não cobrir mercados fora dos 5 indicados.
- Não automatizar o envio de outreach nesta fase — o pipeline entrega contactos qualificados e verificados a um workflow n8n; o disparo em si é uma decisão separada.

---

## 2. Arquitetura de Alto Nível

```
1. Discovery (por país)          →  fontes oficiais abertas + fallback OSM/Maps
2. Resolução de Website           →  quando o registo não devolve site
3. Deteção de Tecnologia          →  Wappalyzer: WordPress/WooCommerce/PrestaShop/Wix
4. Extração de Contactos          →  papéis do registo + página "equipa" + padrão de email
5. Armazenamento + Dedup          →  PostgreSQL
6. n8n — handoff para outreach    →  SMTP próprio / relay Brevo já configurado
```

Cada etapa é um serviço Node.js separado, correndo em containers Docker Compose independentes, comunicando via fila simples (tabela de estado no Postgres é suficiente nesta escala — não introduzir Kafka/RabbitMQ, é over-engineering para o volume em causa).

### 2.1 Stack tecnológico
- **Linguagem:** Node.js (LTS) — alinhado com o stack atual (FeathersJS/React)
- **Automação de browser:** Playwright — só onde não há API aberta (Portugal, fallback Holanda)
- **Deteção de tecnologia:** pacote `wappalyzer` via npm. **Nota:** o projeto Wappalyzer original tornou-se código fechado; existem forks open-source mantidos pela comunidade (ex: `wapiti-scanner/wappalyzer` no GitHub). Confirma no momento da implementação qual fork está mais ativo/atualizado, isto muda com alguma frequência.
- **Resolução de morada/website sem risco de ToS:** Overpass API (OpenStreetMap) — dados sob licença ODbL, explicitamente reutilizáveis, ao contrário do Google Maps cujo ToS proíbe scraping. Preferir sempre que a cobertura for suficiente.
- **Base de dados:** PostgreSQL (container Docker)
- **Orquestração:** n8n (já em uso)
- **Deployment:** Docker Compose em hel1 ou de1, conforme carga

---

## 3. Fontes de Dados por País — Deep Dive

### Tabela-resumo

| País | Fonte principal | Acesso | Custo | Website incluído? | Gestor/CEO nomeado? |
|---|---|---|---|---|---|
| 🇳🇴 Noruega | Brønnøysundregistrene (Enhetsregisteret) | API JSON aberta, sem chave | Grátis | Fill-rate baixo | **Sim** — `daglig leder`, `styreleder` |
| 🇸🇪 Suécia | Bolagsverket "Värdefulla datamängder" | API REST, chave grátis por registo | Grátis | Não confirmado na API | Não na API; sim via scraping da pesquisa pública |
| 🇫🇮 Finlândia | PRH/YTJ Open Data | API JSON aberta, sem chave | Grátis | Sim, quando registado | Não |
| 🇳🇱 Holanda | OpenKvK.nl (mirror aberto) | Scraping de mirror aberto | Grátis | Incerto — validar | Não |
| 🇵🇹 Portugal | Sem registo aberto em bulk; OSM/Maps + Justiça (um-a-um) | Scraping/consulta pontual | Grátis (computação) | Obtido via OSM/Maps | Não em bulk; um-a-um via Portal da Justiça |

### 3.1 🇳🇴 Noruega — Brønnøysundregistrene

O registo central de entidades da Noruega (Enhetsregisteret), publicado como dados abertos sob a licença NLOD.

- **Endpoint base:** `https://data.brreg.no/enhetsregisteret/api/enheter`
- **Autenticação:** nenhuma — sem chave, sem login, sem registo prévio.
- **Filtros úteis:** `navn` (nome), `naeringskode` (código NACE — ex. 47.911 comércio retalhista online), `kommunenummer` (concelho), intervalos de nº de empregados.
- **Dados devolvidos:** nome, número de organização (9 dígitos), morada, código NACE, data de fundação, nº de empregados, email/telefone/site **quando a empresa os registou** (fill-rate baixo, tipicamente dígitos simples de percentagem).
- **Ponto forte decisivo:** o endpoint `/api/enheter/{orgnr}/roller` devolve os **papéis nomeados** — `daglig leder` (gerente/CEO) e `styreleder` (presidente do conselho), com nome próprio. Isto é enriquecimento de pessoa-decisora de graça, direto do registo oficial — sem scraping adicional.
- **Limites:** sem limite de taxa documentado publicamente; usa com bom senso (pausa entre pedidos). Números de identificação pessoal nunca são expostos, só nome e cargo.
- **Licença:** NLOD — uso comercial permitido, atribuição recomendada.

### 3.2 🇸🇪 Suécia — Bolagsverket "Värdefulla datamängder"

API gratuita lançada em fevereiro de 2025 pelo Bolagsverket + Estatística da Suécia (SCB), na sequência de uma diretiva da Comissão Europeia sobre "conjuntos de dados de alto valor" (high-value datasets).

- **Acesso:** requer registo simples (email + telemóvel) via formulário "Kundanmälan" em bolagsverket.se — chaves de teste e produção enviadas por email/SMS, sem contrato nem custo.
- **Dados incluídos:** nome, número de organização, morada, códigos SNI (equivalente sueco ao CAE/NACE), forma jurídica, contas/relatórios anuais entregues digitalmente.
- **Limite de taxa:** 60 pedidos/minuto (documentado para a API relacionada de documentos; confirmar se se aplica igualmente ao endpoint de organizações).
- **Atalho sem registo para prototipar:** ficheiro bulk `bolagsverket_bulkfil.zip`, atualizado semanalmente, sem qualquer registo — bom para um primeiro import em massa antes de decidir se compensa pedir as chaves de API.
- **Gestores/conselho:** **não incluído na API gratuita.** Os `styrelseledamöter` (membros do conselho) aparecem na página pública de pesquisa (`bolagsverket.se/sok/foretag`), mas só via HTML — precisa de scraping leve sobre essa página, não é dado estruturado da API.

### 3.3 🇫🇮 Finlândia — PRH/YTJ Open Data

- **Endpoint base:** `https://avoindata.prh.fi/opendata-ytj-api/v3/companies`
- **Autenticação:** nenhuma.
- **Filtros:** `name`, `location` (concelho), `businessId`, `companyForm` (OY, KY, AY, etc.), `mainBusinessLine` (código TOL/NACE).
- **Dados devolvidos:** ID de negócio (Y-tunnus), nome atual e histórico, forma jurídica, código de atividade, morada, **website (quando registado)**, data de registo.
- **Não incluído:** email, telefone, nomes de gestores/administradores.
- **Limite de taxa:** ~300 pedidos/minuto partilhado por todos os utilizadores (número observado, não documentado oficialmente com esta cifra exata — confirma em produção e implementa backoff exponencial por segurança).
- **Licença:** Creative Commons Attribution 4.0 — atribuição obrigatória à fonte ("PRH/YTJ"), uso comercial permitido.
- **Atualização:** diária.

### 3.4 🇳🇱 Holanda — a mais difícil das cinco

A API oficial da KVK (developers.kvk.nl) tem 4 endpoints (Zoeken, Basisprofiel, Vestigingsprofiel, Naamgeving), mas com duas barreiras sérias:
1. **Acesso requer entidade legal registada na Holanda.** A Netmaster, sendo portuguesa sem presença local, não consegue subscrever diretamente, mesmo pagando.
2. O tier de dados abertos da KVK (sem essa barreira) **remove todos os dados de identificação pessoal** — nome da empresa vazio, sem diretores, só aceita pesquisa por número de KVK já conhecido, não por nome.

**Alternativa prática recomendada:** `OpenKvK.nl` — mirror de dados abertos do Handelsregister, sem registo, com mais de 5 milhões de estabelecimentos ativos.

**Nota de risco a validar na Fase 3 do plano:** por ser um mirror de terceiros (não oficial), a cobertura de campos (sobretudo website) pode ser inferior ao esperado. Há uma tarefa explícita de validação antes de investir mais tempo nesta via.

**Gestores/diretores:** não disponível de forma aberta e gratuita para a Holanda. Fica para a camada de scraping do site da própria empresa (secção 4).

### 3.5 🇵🇹 Portugal — sem equivalente Nordic-style

- Não existe API bulk aberta equivalente ao Brreg/PRH. O RNPC/SICAE permite consulta de CAE um-a-um, não pesquisa em massa por critério (dimensão, atividade, zona).
- O portal de publicações de atos societários do Ministério da Justiça tem atos de registo comercial pesquisáveis (incluindo nomeação de gerentes/administradores), mas também é consulta pontual — confirma a URL atual no momento da implementação, já que estes portais mudam de endereço com alguma frequência.
- **Recomendação prática:** manter a abordagem já definida — descoberta via OSM/Overpass (preferencial) ou Google Maps (fallback, maior risco de ToS) por categoria de negócio + zona. Usar o SICAE apenas para validação pontual de uma empresa já identificada, não como fonte de descoberta em massa.

---

## 4. Enriquecimento de Contactos de Pessoas — Estratégia Cross-Cutting

### 4.1 Hierarquia de fontes (da melhor para a pior, em esforço/qualidade)

1. **Papéis nomeados no registo oficial** — só Noruega, de graça (secção 3.1). Usar sempre que disponível.
2. **Página "equipa"/"sobre nós" do site da empresa** — universal, funciona nos 5 países. Precisa de um dicionário de palavras-chave por idioma:
   - PT: "quem somos", "equipa", "sobre nós"; cargos: "fundador", "sócio-gerente", "diretor"
   - NL: "over ons", "team"; cargos: "oprichter", "directeur", "eigenaar"
   - SE: "om oss"; cargos: "VD", "grundare" · NO: "om oss"; cargos: "daglig leder", "grunnlegger"
   - FI: "tietoa meistä", "meistä"; cargos: "toimitusjohtaja", "perustaja"
3. **Inferência de padrão de email + verificação SMTP.** Com nome + domínio: gerar candidatos (nome.apelido@domínio, ninicial.apelido@domínio, nome@domínio) e verificar com handshake SMTP `RCPT TO` (sem enviar mensagem real). **Importante:** correr a partir de um IP/domínio dedicado e descartável — nunca da infraestrutura de email de produção — porque domínios "catch-all" invalidam a verificação, e fazer isto em volume pode manchar a reputação de quem envia. Rate-limit agressivo por domínio de destino.
4. **Evitar LinkedIn direto.** Não fazer scraping da própria plataforma. Se quiseres um sinal adicional mais seguro, usa pesquisa web normal (`site:linkedin.com/in "Nome da Empresa" CEO`) e lê só os snippets já indexados publicamente — não abrir/scrapar a página do LinkedIn em si.

### 4.2 Nota RGPD (aplica-se a PT, NL, SE, FI, NO)

Usar nome + email profissional para outreach B2B é geralmente justificável sob "interesse legítimo", mas isso não é um cheque em branco:
- Incluir sempre hiperligação de política de privacidade e opção de opt-out clara no primeiro contacto.
- Registar a base legal e a origem de cada contacto (rastreabilidade) — ver campo `email_source` no esquema abaixo.
- Manter a possibilidade de apagar um contacto por pedido (direito ao apagamento).

---

## 5. Esquema de Base de Dados (proposta inicial)

```sql
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country CHAR(2) NOT NULL,
  source VARCHAR(50) NOT NULL,        -- 'brreg', 'prh_ytj', 'bolagsverket', 'openkvk', 'osm'
  source_id VARCHAR(100),             -- nº organização / business ID / OSM id
  name TEXT NOT NULL,
  website TEXT,
  address TEXT,
  industry_code VARCHAR(20),
  employee_range VARCHAR(20),
  tech_detected JSONB,                -- resultado do Wappalyzer
  qualified BOOLEAN DEFAULT false,    -- corre WP/WooCommerce/PrestaShop/Wix?
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(country, source, source_id)
);

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  name TEXT,
  role TEXT,                          -- 'CEO', 'CTO', 'CMO', 'DPO', etc.
  email TEXT,
  email_source VARCHAR(30),           -- 'registry_role', 'team_page', 'pattern_smtp'
  email_verified BOOLEAN DEFAULT false,
  gdpr_basis VARCHAR(30) DEFAULT 'legitimate_interest',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 6. Plano de Implementação Faseado

### Fase 0 — Scaffold (≈½ dia)
- [ ] Repositório Node.js, monorepo simples: `/services/discovery`, `/services/techdetect`, `/services/contacts`, `/shared`
- [ ] `docker-compose.yml` com Postgres + rede interna
- [ ] `.env.example` com placeholders (nenhuma chave paga necessária, exceto o registo gratuito do Bolagsverket na Fase 2)

### Fase 1 — Noruega + Finlândia (as mais abertas, sem registo prévio) (≈1-2 dias)
- [ ] `discovery/no.js`: cliente para `data.brreg.no`, filtro por NACE de e-commerce/retalho + concelho, paginação
- [ ] `discovery/no-roles.js`: chamada ao endpoint `/roller` — só para empresas já qualificadas pela deteção de tecnologia (poupa pedidos)
- [ ] `discovery/fi.js`: cliente para `avoindata.prh.fi`, com backoff exponencial
- [ ] Testes: correr contra 50 empresas reais de cada país, validar taxa de sucesso de parsing

### Fase 2 — Suécia (≈2 dias, inclui registo)
- [ ] Preencher o formulário "Kundanmälan" no Bolagsverket para chaves de teste/produção (ação humana, não automatizável)
- [ ] `discovery/se.js`: cliente para a API "Värdefulla datamängder"
- [ ] Fallback: parser do `bolagsverket_bulkfil.zip` para import em massa sem esperar pelas chaves
- [ ] Scraper leve (Playwright) sobre `bolagsverket.se/sok/foretag` **só** para empresas já qualificadas, a extrair `styrelseledamöter`

### Fase 3 — Holanda (≈2-3 dias, a mais incerta — checkpoint de decisão)
- [ ] Validar `OpenKvK.nl`: 20 pedidos de teste, documentar campos reais devolvidos
- [ ] **Critério de decisão:** se o fill-rate de website for demasiado baixo, passar este país para a abordagem OSM/Maps da Fase 4 em vez de insistir no registo
- [ ] `discovery/nl.js` de acordo com o resultado da validação

### Fase 4 — Portugal + fallback genérico OSM/Maps (≈1-2 dias)
- [ ] `discovery/osm.js`: Overpass API (OpenStreetMap) por categoria de negócio + zona — via preferencial, sem risco de ToS
- [ ] `discovery/gmaps.js`: fallback com Playwright sobre Google Maps, só se a cobertura OSM for insuficiente numa zona específica (maior risco de ToS, usar com moderação)
- [ ] Este módulo serve de fallback para qualquer país onde o registo oficial falhe

### Fase 5 — Resolução de Website (transversal) (≈1 dia)
- [ ] `website-resolver.js`: para empresas sem `website` no registo, tenta OSM/Overpass primeiro, com fallback opcional de pesquisa web leve

### Fase 6 — Deteção de Tecnologia (≈1 dia)
- [ ] Integrar `wappalyzer` (ou fork ativo — ver nota 2.1) como serviço local
- [ ] Filtrar por: WordPress + WooCommerce, PrestaShop, Wix
- [ ] Marcar `qualified = true`

### Fase 7 — Extração de Contactos de Pessoas (≈2-3 dias)
- [ ] Scraper de página "equipa/sobre nós" com dicionário multi-idioma (secção 4.1)
- [ ] Módulo de inferência de padrão de email + verificação SMTP isolada — **decidir antes com o Gonçalo qual VPS/domínio descartável usar**, nunca a infraestrutura de produção
- [ ] Priorizar cargos: CEO/Fundador, CTO, CMO, DPO

### Fase 8 — Integração n8n (≈1 dia)
- [ ] Workflow n8n a ler `contacts` (só `qualified = true` e `email_verified = true`) e alimentar a sequência de outreach via SMTP próprio / relay Brevo
- [ ] Template de email com link de opt-out (requisito RGPD, secção 4.2)

**Estimativa total:** 12-16 dias de trabalho de agente de coding, revisto por fase — não correr tudo sem checkpoints intermédios.

---

## 7. Riscos e Perguntas em Aberto

- **Holanda** é o país com maior incerteza — a Fase 3 tem um checkpoint de decisão explícito.
- **Reputação de email:** a verificação SMTP em volume, mesmo isolada, pode gerar sinais negativos se um destinatário notar tentativas de RCPT TO. Começar com lotes pequenos (<50/dia) e monitorizar.
- **Taxas de sucesso reais** (fill-rate de website, sucesso da deteção de tecnologia) só se confirmam em produção — os números mencionados nas fontes são qualitativos, não uma percentagem garantida.
- **URLs de portais governamentais mudam com o tempo** — confirmar cada endpoint no arranque de cada fase, não assumir que o que está neste documento continua válido indefinidamente.

---

## 8. Prompt de Arranque Sugerido para o Claude Code

```
Vou construir um pipeline de descoberta e enriquecimento de leads B2B, self-hosted,
para a Netmaster (Node.js + Docker Compose + Postgres + n8n).

Lê o documento netmaster-pipeline-prospecao-plano.md anexo — é a especificação
completa e o plano faseado. Começa pela Fase 0 (scaffold) e Fase 1 (Noruega +
Finlândia), e para no fim de cada fase para eu rever antes de avançares.

Stack: Node.js LTS, Playwright, wappalyzer (ou fork ativo), PostgreSQL em Docker.
Não uses nenhuma API paga. Confirma comigo antes de qualquer ação que precise de
registo externo (ex: Fase 2, chaves do Bolagsverket).
```