// Extração (heurística) de contactos de PESSOAS a partir do HTML de um site.
// Funções puras (sem rede) — o fetch fica em extract-contacts.js.
//
// Estratégia (v1, otimizada para PRECISÃO): descobrir páginas
// "equipa/quem-somos/contactos", e daí extrair pares (nome, cargo) ancorados
// em palavras-chave de liderança + emails que são claramente de pessoa ou de
// cargo (os departamentais/genéricos/placeholder são ignorados). Guarda sempre
// a proveniência (URL) de cada achado.

import { isJunkEmail } from './email-junk.js';

// --- Descoberta de páginas de contacto/equipa -------------------------------
const PAGE_KEYWORDS = /(equipa|quem[- ]?somos|sobre[- ]?n[oó]s|sobre|a[- ]?empresa|about|our[- ]?team|meet[- ]?the[- ]?team|team|contact|contacto|contactos|staff|dire[cç][aã]o|ger[eê]ncia|gest[aã]o|lideran[cç]a|pessoas|management|leadership)/i;
// Páginas onde faz sentido extrair (nome, cargo) — evita ancorar nomes em
// blocos de morada de páginas de contacto genéricas.
const TEAM_URL = /(equipa|team|quem[- ]?somos|sobre|about|staff|dire[cç]|lideran|gest[aã]o|pessoas|management|leadership)/i;

// Extrai URLs (mesmo host) de páginas candidatas, priorizadas.
export function findContactLinks(html, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const scored = new Map();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ');
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let url;
    try { url = new URL(href, base); } catch { continue; }
    if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    const hay = `${url.pathname} ${text}`;
    if (!PAGE_KEYWORDS.test(hay)) continue;
    const score = /(equipa|team|staff|dire[cç]|lideran|pessoas|management|leadership|quem[- ]?somos|sobre|about)/i.test(hay) ? 2 : 1;
    const clean = url.origin + url.pathname;
    scored.set(clean, Math.max(scored.get(clean) || 0, score));
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([u]) => u);
}

// --- Cargos (em texto) -> canónico -----------------------------------------
// Taxonomia ALARGADA (não só decisores). Ordem = mais específico primeiro.
const ROLE_PATTERNS = [
  [/chief executive|\bceo\b|diretor[ -]?geral|diretora[ -]?geral|director[ -]?geral|administrador[ -]?delegado/i, 'CEO'],
  [/co-?funda(dor|dora)|s[oó]cio[ -]?funda(dor|dora)|funda(dor|dora)|founder|co-?founder/i, 'Founder'],
  [/managing director|administrador[ -]?delegado|diretor[ -]?executivo/i, 'Managing Director'],
  [/propriet[aá]ri[oa]|\bowner\b|\bdono\b|\bdona\b/i, 'Owner'],
  [/\bs[oó]cio\b|\bpartner\b|associad[oa]/i, 'Partner'],
  [/presidente|\bpresident\b|chair(man|woman|person)?/i, 'President'],
  [/chief technology|\bcto\b|diretor[ -]?t[eé]cnico|respons[aá]vel[ -]?t[eé]cnico/i, 'CTO'],
  [/chief marketing|\bcmo\b|diretor[ -]?de[ -]?marketing|respons[aá]vel[ -]?de[ -]?marketing/i, 'CMO'],
  [/chief financial|\bcfo\b|diretor[ -]?financeiro/i, 'CFO'],
  [/chief operating|\bcoo\b|diretor[ -]?de[ -]?opera[cç][oõ]es/i, 'COO'],
  [/chief information|\bcio\b|chief technical/i, 'CIO'],
  [/\bdpo\b|data protection officer|encarregado[ -]?de[ -]?prote[cç][aã]o[ -]?de[ -]?dados/i, 'DPO'],
  [/vice[- ]?presidente|\bvp\b|vice[- ]?president/i, 'VP'],
  [/\bhead of\b|respons[aá]vel[ -]?(de|pela|por)|chefe[ -]?de/i, 'Head'],
  [/g[eé]rente|s[oó]cio[ -]?g[eé]rente|gestor[ -]?de|\bmanager\b/i, 'Manager'],
  [/diretor[ -]?comercial|diretor[ -]?de[ -]?vendas|sales (manager|director|rep|representative)|comercial\b|vendas\b/i, 'Sales'],
  [/marketing (manager|specialist|lead)?|community manager|social media/i, 'Marketing'],
  [/recursos humanos|\bhr\b|\brh\b|human resources|talent|recrutamento/i, 'HR'],
  [/apoio (ao|a) cliente|suporte|customer (support|success|service)|help[ -]?desk|atendimento/i, 'Support'],
  [/contabilis|accountant|contabilidade|financeir[oa]/i, 'Accountant'],
  [/advogad[oa]|jurista|legal counsel|jur[ií]dico/i, 'Legal'],
  [/consultor[ea]?|consultant|advisor/i, 'Consultant'],
  [/designer|\bux\b|\bui\b|criativ[oa]|art director/i, 'Designer'],
  [/(engenheir|developer|programad|full[- ]?stack|back[- ]?end|front[- ]?end|software|devops|técnic[oa])/i, 'Engineer'],
  [/administrativ[oa]|secret[aá]ri[oa]|rece[cç][aã]o|assistente/i, 'Administrative'],
  [/diretor[ea]?|director|\bdiretora\b/i, 'Director'],
  [/\blead\b|l[ií]der|coordenador[ea]?|coordinator|supervisor/i, 'Lead'],
];
export function canonicalRole(text) {
  for (const [re, role] of ROLE_PATTERNS) if (re.test(text)) return role;
  return null;
}

// Cargo canónico -> categoria (para filtrar sem enumerar todos os cargos).
const CATEGORY = {
  decision_maker: new Set(['CEO', 'Founder', 'Owner', 'Partner', 'President', 'Managing Director', 'CTO', 'CFO', 'COO', 'CMO', 'CIO']),
  dpo: new Set(['DPO']),
  manager: new Set(['VP', 'Head', 'Manager', 'Director', 'Lead']),
  staff: new Set(['Sales', 'Marketing', 'HR', 'Support', 'Accountant', 'Legal', 'Consultant', 'Designer', 'Engineer', 'Administrative']),
};
export function roleCategory(role) {
  if (!role) return 'unknown';
  if (role === 'general') return 'general'; // caixa da empresa (info@/geral@/marca@), não é pessoa
  for (const [cat, set] of Object.entries(CATEGORY)) if (set.has(role)) return cat;
  return 'staff';
}

// Cargo a partir do local-part de um email (ceo@, diretor.geral@, dpo@...).
const LOCAL_ROLE = [
  [/^(ceo|diretor[._-]?geral|dir[._-]?geral)/i, 'CEO'],
  [/^cto\b/i, 'CTO'], [/^cmo\b/i, 'CMO'], [/^cfo\b/i, 'CFO'], [/^coo\b/i, 'COO'], [/^cio\b/i, 'CIO'],
  [/^(dpo|rgpd|gdpr)/i, 'DPO'],
  [/^(fundador|founder)/i, 'Founder'],
  [/^(owner|dono|proprietario)/i, 'Owner'],
  [/^(presidente|president)/i, 'President'],
  [/^(vendas|sales|comercial)/i, 'Sales'],
  [/^(marketing|mkt)/i, 'Marketing'],
  [/^(rh|hr|recrutamento)/i, 'HR'],
  [/^(suporte|support|apoio|helpdesk|atendimento)/i, 'Support'],
  [/^(gerente|gestor|administrador|diretor|director|manager)/i, 'Manager'],
];
function localRole(local) {
  for (const [re, role] of LOCAL_ROLE) if (re.test(local)) return role;
  return null;
}

// --- Social por pessoa (LinkedIn /in/ cujo slug bate com o nome) -------------
const norm2 = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function personSocial(name, linkedinUrls) {
  if (!name) return null;
  const toks = norm2(name).split(/\s+/).filter((t) => t.length >= 3);
  if (!toks.length) return null;
  for (const url of linkedinUrls) {
    const slug = norm2(url.split(/\/in\/|\/pub\//)[1] || '');
    if (toks.filter((t) => slug.includes(t)).length >= Math.min(2, toks.length)) return { linkedin: url };
  }
  return null;
}
// Todos os URLs pessoais de LinkedIn na página.
function linkedinPersonUrls(html) {
  const out = new Set();
  // Só carateres de slug (o /in/<slug> é [a-z0-9-]). Parar em &/]/}/etc. evita
  // apanhar o JSON codificado (&quot;…) dos page-builders como parte do URL.
  const re = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[a-z0-9%._-]{2,80}/gi;
  let m;
  while ((m = re.exec(html || ''))) out.add(m[0].replace(/\/+$/, ''));
  return [...out];
}

// --- Nomes (PT) --------------------------------------------------------------
const NAME_RE = /\p{Lu}\p{Ll}+(?:\s+(?:de|da|do|dos|das|e)\s+|\s+)\p{Lu}\p{Ll}+(?:\s+(?:de|da|do|dos|das|e\s+)?\p{Lu}\p{Ll}+){0,2}/gu;
// Termos que denunciam que NÃO é um nome de pessoa (org, geografia, secções,
// serviços/tipos-de-negócio e elementos de UI/tema que passam como "N palavras
// Capitalizadas"). É a principal defesa de precisão da extração de pessoas.
const NOT_NAME = /(equipa|pol[ií]tica|privacidade|cookies|servi[cç]os?|produtos?|empresa|neg[oó]cio|contactos?|sobre|marketing|comercial|dire[cç][aã]o|gest[aã]o|solu[cç][oõ]es|qualidade|ambiente|reservad|direitos|termos|condi[cç][oõ]es|newsletter|portugal|lisboa|porto|braga|coimbra|aveiro|faro|rua|avenida|lda|unipessoal|regi[aã]o|regionai|regional|nacional|junta|associa[cç]|clube|grupo|agrupamento|federa[cç]|distrito|concelho|freguesia|munic[ií]|departamento|comiss[aã]o|escut|n[uú]cleo|secre?taria|assembleia|conselho|toggle|sliding|\bbar\b|\barea\b|\bmenu\b|conte[uú]do|\bmore\b|\bler mais\b|carrinho|checkout|\bcart\b|\blogin\b|pesquis|\bsearch\b|rodap[eé]|\bfooter\b|\bheader\b|sidebar|widget|\btopo\b|\bskip\b|voltar|\bblog\b|\bhome\b|\bloja\b|galeria|portf[oó]lio|\bfaq\b|hor[aá]rio|\bemail\b|telefone|whatsapp|copyright|todos os direitos|constru[cç]|\bcivil\b|design|criativ|consultor|assist[eê]nci|centro|cultural|desportiv|imobili[aá]ri|restaurante|\bcaf[eé]\b|\bhotel\b|cl[ií]nic|farm[aá]ci|oficina|\bstand\b|com[eé]rcio|ind[uú]stri|transporte|log[ií]stic|energia|sistemas|tecnologi|digital|st[uú]dio|atelier|gabinete|arquitetur|engenhari|forma[cç][aã]o|educa[cç][aã]o|sa[uú]de|est[eé]tica|beleza|turismo|viagens|imobili|advocacia|contabilidade|seguros|financ|manuten[cç]|repara[cç]|instala[cç]|projeto|obras|equipamento|material|m[aá]quina|ferramenta|acess[oó]ri|componente)/i;
const NOT_NAME2 = /(reclama|\bfale\b|con[n]?osco|or[cç]amento|gr[aá]tis|pedido|agendar|marca[cç]|\bnews\b|atualidade|not[ií]cia|evento|parceir|cliente|fornecedor)/i;
function looksLikeName(s) {
  if (!s) return false;
  const t = s.trim();
  const words = t.split(/\s+/).filter((w) => !/^(de|da|do|dos|das|e)$/i.test(w));
  if (words.length < 2 || words.length > 4) return false;
  if (/\s(e|&)\s/i.test(t)) return false;          // "X e Y" = organização
  if (NOT_NAME.test(s) || NOT_NAME2.test(s)) return false;
  if (canonicalRole(s)) return false;               // a frase É um cargo (ex.: "Warehouse Manager")
  return true;
}
function pickName(matches) {
  if (!matches) return null;
  for (const m of matches) if (looksLikeName(m)) return m.trim();
  return null;
}

// --- Emails ------------------------------------------------------------------
// Quantificadores LIMITADOS — sem eles, "x@" + longa cadeia pontuada num blob
// grande faz backtracking catastrófico e bloqueia o event loop (ver fingerprints.js).
const EMAIL_RE = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,24}/gi;
// Full-match p/ validar QUALQUER email capturado (não deixa passar lixo/over-long).
const EMAIL_VALID = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/i;
function extractEmails(html) {
  const out = new Set();
  // mailto: — captura SÓ o email válido (páginas de page-builder metem o href
  // dentro de JSON com &quot; codificado; um [^"'] corria até 600+ chars de lixo).
  for (const m of html.matchAll(/mailto:\s*([a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24})/gi)) out.add(m[1].toLowerCase());
  for (const m of html.matchAll(EMAIL_RE)) out.add(m[0].toLowerCase());
  // Validação estrita + filtro de lixo central (placeholders + support de providers).
  return [...out].filter((e) => EMAIL_VALID.test(e) && !isJunkEmail(e));
}
// 1.º token que denuncia caixa departamental (não pessoa).
const GENERIC_FIRST = /^(info|geral|general|contact|contactos?|cre|dep|dept|departamento|apoio|suporte|support|reservas|booking|noreply|newsletter|mail|email|webmaster|admin|rh|hr|marketing|comercial|vendas|sales|financeiro|loja|shop|encomendas|ola|hello|servico|servicos)$/i;
// Deriva "João Silva" de joao.silva@ (precisa de 2+ tokens alfabéticos, e não
// pode ser departamental nem conter termos de org/geografia).
function deriveName(local) {
  const parts = local.split(/[._-]+/).filter((p) => /^[a-zà-ÿ]{2,}$/i.test(p));
  if (parts.length < 2 || GENERIC_FIRST.test(parts[0])) return null;
  const name = parts.slice(0, 3).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
  return NOT_NAME.test(name) ? null : name;
}
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function sameNameish(a, b) {
  const ta = new Set(norm(a).split(/\s+/));
  return norm(b).split(/\s+/).every((t) => ta.has(t));
}

// --- Texto / telefone --------------------------------------------------------
export function htmlToText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/td|\/tr|\/section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*\n+/g, '\n');
}
const MAX_PEOPLE_PER_PAGE = 60; // trava anti-lixo em páginas grandes
// Honorífico SEGUIDO do nome — sinal FORTE de pessoa. Captura o NOME logo a seguir ao
// honorífico (Dr./Dra./Eng./Arq./Prof./Sr./Sra.), não qualquer texto capitalizado na janela
// (senão apanha um serviço/título vizinho, ex.: "Remodelação de Escritórios" junto a "Eng. João").
const HON_NAME = /\b(?:dr|dra|eng|arq|prof|sr|sra)\.?ª?\.?\s+(\p{Lu}\p{Ll}+(?:\s+(?:de|da|do|dos|das|e)\s+|\s+)\p{Lu}\p{Ll}+(?:\s+(?:de|da|do|dos|das|e\s+)?\p{Lu}\p{Ll}+){0,2})/iu;

// Devolve [{name, role, role_category, email, phone, phone_country, social_profiles, source_detail}].
// PRECISÃO-primeiro (melhor 0 do que lixo): uma pessoa só é emitida com sinal POSITIVO —
//   (1) nome+cargo em página de equipa ACOMPANHADO de honorífico (Dr./Eng./…), ou
//   (2) email cujo local-part dá um nome de pessoa (≥2 tokens) ou um cargo.
// Todos os outros emails não-junk (info@/geral@/marca@/torresnovas@) viram um contacto
// GERAL da empresa (role 'general', name = local-part) — NUNCA uma pessoa inventada.
export function extractPeople(html, sourceUrl, { defaultCountry = 'PT' } = {}) { // eslint-disable-line no-unused-vars
  const text = htmlToText(html);
  const segments = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const people = [];
  const seen = new Set();
  const liUrls = linkedinPersonUrls(html);
  const finish = (p) => { if (!p.role_category) p.role_category = roleCategory(p.role); p.social_profiles = personSocial(p.name, liUrls); return p; };

  // 1) Pares (nome, cargo) em páginas de equipa/sobre — SÓ com honorífico na janela.
  // Sem esse sinal, "N palavras Capitalizadas junto a um cargo" é lixo (menus, títulos
  // de secção, nomes de lugares). O antigo bloco "nome-só" (varria a página inteira)
  // foi REMOVIDO — era a principal fonte de contactos-lixo.
  if (TEAM_URL.test(sourceUrl || '')) {
    for (let i = 0; i < segments.length && people.length < MAX_PEOPLE_PER_PAGE; i++) {
      const role = canonicalRole(segments[i]);
      if (!role) continue;
      const window = [segments[i - 1], segments[i], segments[i + 1]].filter(Boolean).join(' • ');
      const hn = window.match(HON_NAME); // nome LOGO A SEGUIR ao honorífico
      if (!hn || !looksLikeName(hn[1])) continue;
      const name = hn[1].trim();
      const key = 'n:' + norm(name);
      if (seen.has(key)) continue;
      seen.add(key);
      people.push(finish({ name, role, email: null, phone: null, phone_country: null, source_detail: sourceUrl }));
    }
  }

  // 2) Emails — TODOS os não-junk viram contacto. local-part → nome de pessoa (deriveName)
  // ou cargo (localRole) → PESSOA; senão → contacto GERAL da empresa (role 'general').
  for (const email of extractEmails(html)) {
    const local = email.split('@')[0];
    const role = localRole(local);
    const derived = deriveName(local);
    const key = 'e:' + email;
    if (seen.has(key)) continue;
    seen.add(key);
    const match = derived && people.find((p) => p.name && !p.email && sameNameish(p.name, derived));
    if (match) { match.email = email; if (!match.role && role) { match.role = role; match.role_category = roleCategory(role); } continue; }
    if (derived) people.push(finish({ name: derived, role, email, phone: null, phone_country: null, source_detail: sourceUrl }));       // pessoa
    else if (role) people.push(finish({ name: local, role, email, phone: null, phone_country: null, source_detail: sourceUrl }));      // caixa de cargo (ceo@, comercial@)
    else people.push(finish({ name: local, role: 'general', role_category: 'general', email, phone: null, phone_country: null, source_detail: sourceUrl })); // geral da empresa
  }

  // NOTA: os telefones deixaram de ser colados a uma pessoa aqui (causava o "1.º contacto
  // fica com o telefone da empresa"). São capturados ao nível da empresa (extractPhones,
  // ver lib/fingerprints.js / worker) — TODOS os fixos+móveis, no país do site.
  return people;
}
