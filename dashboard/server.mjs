// NetProspect Dashboard — servidor (Node + Express).
// Serve a SPA e uma API que consulta o Directus do lado do servidor (o token
// nunca vai para o browser). Pensado para correr atrás do Authentik/npmPlus.
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DIRECTUS_URL = (process.env.DIRECTUS_URL || 'http://localhost:8056').replace(/\/$/, '');
const TOKEN = process.env.DIRECTUS_TOKEN || '';
const NATS_URL = process.env.NATS_URL || 'nats://nats:4222';
const POSTHOG_PUBLIC_KEY = process.env.POSTHOG_PUBLIC_KEY || '';
const POSTHOG_PUBLIC_HOST = (process.env.POSTHOG_PUBLIC_HOST || '').replace(/\/$/, '');
// --- Cache (Redis, fail-soft) — REDIS_URL vazio = desligado (tudo live, sem cache).
const REDIS_URL = process.env.REDIS_URL || '';
const CACHE_TTL = Math.max(5, parseInt(process.env.CACHE_TTL || '60', 10)); // segundos

// Cliente NATS preguiçoso partilhado (liga na 1.ª auditoria/consulta de fila; não
// falha o arranque se o NATS estiver em baixo). Uma só ligação → js + jsm + headers.
let _nc = null;
async function natsConn() {
  if (_nc) return _nc;
  const { connect } = await import('nats');
  _nc = await connect({ servers: NATS_URL, name: 'dashboard', maxReconnectAttempts: -1, reconnectTimeWait: 2000 });
  return _nc;
}
async function natsJs() {
  const nc = await natsConn();
  const { headers } = await import('nats');
  return { js: nc.jetstream(), headers };
}
async function natsManager() { return (await natsConn()).jetstreamManager(); }

// --- ClickHouse (Fase E) — cliente de LEITURA para timeline + gatilhos. Vazio =
// desligado (endpoints devolvem []). Inline (o build do dashboard não inclui lib/).
const CH_URL = (process.env.CLICKHOUSE_URL || '').replace(/\/$/, '');
const CH_DB = process.env.CLICKHOUSE_DB || 'netprospect';
const CH_USER = process.env.CLICKHOUSE_USER || 'netprospect';
const CH_PASS = process.env.CLICKHOUSE_PASSWORD || '';
const chEnabled = () => !!CH_URL;
const sqlStr = (s) => `'${String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
async function chQuery(query) {
  if (!CH_URL) return [];
  try {
    const r = await fetch(`${CH_URL}/?database=${encodeURIComponent(CH_DB)}`, {
      method: 'POST',
      headers: { 'X-ClickHouse-User': CH_USER, 'X-ClickHouse-Key': CH_PASS, 'Content-Type': 'text/plain' },
      body: `${query} FORMAT JSON`,
    });
    if (!r.ok) return [];
    return (await r.json()).data || [];
  } catch { return []; }
}
async function chTimeline(siteId) {
  if (!CH_URL || !siteId) return [];
  return chQuery(`SELECT metric, value_num, value_str, toUnixTimestamp(ts) AS ts FROM ${CH_DB}.observations WHERE site_id = ${Number(siteId)} ORDER BY ts`);
}
async function chTriggers({ limit = 100, severity, event, domain, sinceDays } = {}) {
  if (!CH_URL) return [];
  const w = [];
  if (severity) w.push(`severity IN (${String(severity).split(',').filter(Boolean).map(sqlStr).join(',')})`);
  if (event) w.push(`event = ${sqlStr(event)}`);
  if (domain) w.push(`domain = ${sqlStr(domain)}`);
  if (sinceDays) w.push(`ts >= now() - INTERVAL ${Number(sinceDays) || 30} DAY`);
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  return chQuery(`SELECT site_id, domain, event, old_value, new_value, severity, toUnixTimestamp(ts) AS ts FROM ${CH_DB}.change_events ${where} ORDER BY ts DESC LIMIT ${Math.min(500, Number(limit) || 100)}`);
}

async function d(pathAndQuery) {
  const res = await fetch(`${DIRECTUS_URL}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Directus ${res.status} em ${pathAndQuery}`);
  return (await res.json()).data;
}
const count = async (collection, filter = '') => {
  const r = await d(`/items/${collection}?aggregate[count]=id${filter}`);
  return Number(r?.[0]?.count?.id || 0);
};
// Heurística DETERMINISTA: um contacto `general` que PARECE pessoa (para o agente/humano
// decidir incluir numa audiência, sem auto-promover). Sinal: local-part de 1 só token, não
// genérico (info/geral/…), só letras, ≠ marca/domínio. Ex.: sverre@, mirja@ → parece pessoa.
const GENERIC_MAILBOX = new Set(['info', 'geral', 'general', 'contact', 'contacto', 'contactos', 'apoio', 'suporte', 'support', 'reservas', 'booking', 'noreply', 'newsletter', 'mail', 'email', 'webmaster', 'admin', 'rh', 'hr', 'marketing', 'comercial', 'vendas', 'sales', 'financeiro', 'loja', 'shop', 'encomendas', 'ola', 'hello', 'servico', 'servicos', 'office', 'post', 'team', 'equipa', 'dpo', 'rgpd', 'gdpr', 'privacy', 'legal', 'faturacao', 'billing', 'accounts', 'contabilidade', 'kontakt', 'kontor', 'firmapost']);
function maybePersonGeneral(name, orgDomain) {
  const n = String(name || '').toLowerCase().trim();
  if (!n || /\s/.test(n) || n.length < 3 || n.length > 18) return false;
  if (!/^[a-zà-ÿ]+$/i.test(n) || GENERIC_MAILBOX.has(n)) return false;
  const root = String(orgDomain || '').toLowerCase().split('.')[0];
  if (root && (n === root || root.includes(n) || n.includes(root))) return false; // = marca/domínio
  return true;
}
async function dwrite(method, p, body) {
  const res = await fetch(`${DIRECTUS_URL}${p}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Directus ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : (await res.json()).data;
}

// Cliente Redis preguiçoso + FAIL-SOFT: se REDIS_URL vazio ou o Redis em baixo, as
// queries correm live (sem cache). Acelera as agregações pesadas (/api/stats ~18 queries,
// contagens de segmentos) que hoje batem o Directus a cada request.
let _redis = null, _redisUp = false;
async function redisClient() {
  if (!REDIS_URL) return null;
  if (_redis) return _redisUp ? _redis : null;
  try {
    const { createClient } = await import('redis');
    _redis = createClient({ url: REDIS_URL });
    _redis.on('error', () => { _redisUp = false; });
    _redis.on('ready', () => { _redisUp = true; });
    await _redis.connect();
    _redisUp = true;
  } catch { _redis = null; _redisUp = false; return null; }
  return _redis;
}
// Devolve do cache ou calcula com fn() e guarda (TTL em s). Nunca falha por causa do cache.
async function cached(key, fn, ttl = CACHE_TTL) {
  const r = await redisClient();
  if (r && _redisUp) { try { const hit = await r.get(key); if (hit != null) return JSON.parse(hit); } catch { /* miss */ } }
  const val = await fn();
  if (r && _redisUp) { try { await r.set(key, JSON.stringify(val), { EX: ttl }); } catch { /* ignora */ } }
  return val;
}
// --- Postgres (np-db) — SÓ para a página Cobertura (agregações pesadas sobre 1,5M sites que o
// Directus/aggregate não faz bem). Lazy + fail-soft: sem PG_HOST, /api/coverage devolve desligado. ---
const PG_HOST = process.env.PG_HOST || '';
let _pg = null;
async function pgPool() {
  if (!PG_HOST) return null;
  if (_pg) return _pg;
  try {
    const { default: pg } = await import('pg');
    _pg = new pg.Pool({
      host: PG_HOST, port: +(process.env.PG_PORT || 5432),
      database: process.env.POSTGRES_DB || 'netprospect',
      user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD,
      max: 2, idleTimeoutMillis: 30000, statement_timeout: 120000,
    });
    _pg.on('error', () => {});
  } catch { _pg = null; }
  return _pg;
}

// Invalida chaves por prefixo (poucas chaves de cache → KEYS é barato). Ex.: após escrever segmento.
async function cacheDrop(prefix) {
  const r = await redisClient(); if (!r || !_redisUp) return;
  try { const keys = await r.keys(`${prefix}*`); if (keys.length) await r.del(keys); } catch { /* ignora */ }
}
// Predicados de auditoria/prospeção sobre a coleção `sites`. `pfx` prefixa o campo
// para aplicar os mesmos filtros a partir de outra coleção via relação m2o
// (ex.: em `contacts` usa-se pfx='site' -> filter[site][is_cpanel][_eq]=true).
function buildSiteFilters(f = {}, pfx = '') {
  const enc = encodeURIComponent;
  const on = (v) => v === 'true' || v === '1';
  // Constrói CRITÉRIOS: cada facet = 1 critério = lista de [field,op,val] ANDadas internamente
  // (quase todos têm 1 condição; o "SPF e DMARC ambos" tem 2). Depois combina por E (flat) ou OU.
  const crit = [];
  const F = (field, op, val) => crit.push([[field, op, val]]);
  // has_email/has_phone: na diretório é a flag do site; na página de contactos é tratado à parte.
  if (pfx === '') {
    if (on(f.has_email)) F('has_email', '_eq', 'true');
    if (on(f.has_phone)) F('has_phone', '_eq', 'true');
  }
  if (on(f.dm)) F('has_decision_maker', '_eq', 'true'); // tem contacto decisor
  if (f.lead_min) F('lead_score', '_gte', String(parseInt(f.lead_min, 10) || 0));
  if (f.lead_max) F('lead_score', '_lt', String(parseInt(f.lead_max, 10) || 0)); // combina c/ lead_min = intervalo
  if (f.city) F('business_city', '_icontains', f.city);
  if (f.industry) F('industry', '_eq', f.industry);
  if (f.traffic) F('traffic_bucket', '_in', f.traffic);
  if (on(f.cpanel)) F('is_cpanel', '_eq', 'true');
  if (on(f.notcpanel)) F('is_cpanel', '_neq', 'true'); // alojamento sem cPanel
  if (on(f.fb)) F('social_facebook', '_eq', 'true');
  if (on(f.ig)) F('social_instagram', '_eq', 'true');
  if (on(f.li)) F('social_linkedin', '_eq', 'true');
  if (on(f.tw)) F('social_twitter', '_eq', 'true');
  if (on(f.gmb)) F('gmb', '_eq', 'true');
  if (on(f.wa)) F('social_whatsapp', '_eq', 'true');
  if (on(f.pin)) F('social_pinterest', '_eq', 'true');
  if (on(f.yt)) F('social_youtube', '_eq', 'true');
  if (on(f.tk)) F('social_tiktok', '_eq', 'true');
  if (f.load) F('load_bucket', '_in', f.load);
  if (f.spf) F('spf_status', '_in', f.spf);       // UI envia missing,weak,invalid p/ "problemas"
  if (f.dmarc) F('dmarc_status', '_in', f.dmarc);
  if (f.authboth === 'both') crit.push([['spf_status', '_in', 'missing,weak,invalid'], ['dmarc_status', '_in', 'missing,weak,invalid']]); // 1 critério, 2 condições ANDadas
  if (f.seo_max) F('seo_score', '_lte', String(parseInt(f.seo_max, 10) || 0));
  if (f.mobile === 'bad') F('mobile_friendly', '_eq', 'false');
  if (f.desktop === 'bad') F('perf_desktop', '_lt', '50'); // proxy: sem coluna desktop_friendly, usa perf desktop <50
  if (on(f.security)) F('security_findings', '_gt', '0');
  if (f.sev) F('security_severity', '_in', f.sev);
  if (on(f.wpvuln)) F('wp_vuln_count', '_gt', '0');
  // Fase D — SSL / domínio / CMS (gatilhos de venda: renovação, hosting, manutenção).
  if (on(f.ssl_expiring)) F('ssl_days_left', '_between', '0,30');   // certificado a expirar ≤30d
  if (on(f.ssl_expired)) F('ssl_days_left', '_lt', '0');           // certificado JÁ expirado (dias < 0)
  // SSL "pago": emissor é uma CA comercial, i.e. NÃO está na lista das gratuitas dominantes
  // (Let's Encrypt 1.1M, Google Trust Services 131k, ZeroSSL, Amazon ACM, Certainly). Proxy de
  // sinal de venda (empresa que investiu). Nota: Sectigo (87k) inclui muito cPanel AutoSSL grátis —
  // fica marcado como "pago" (não há como distinguir só pelo emissor); afinável se o utilizador quiser.
  if (on(f.ssl_paid)) F('ssl_issuer', '_nin', "Let's Encrypt,Google Trust Services,ZeroSSL GmbH,Amazon,Certainly");
  if (on(f.domain_expiring)) F('expiring_soon', '_eq', 'true');    // domínio a expirar ≤90d (flag)
  // Renovação de domínio graduada: expira entre agora e agora+N dias (usa $NOW dinâmico do Directus).
  if (f.domain_renew) { const n = parseInt(f.domain_renew, 10); if ([30, 60, 90, 180].includes(n)) crit.push([['domain_expiry', '_gte', '$NOW'], ['domain_expiry', '_lte', `$NOW(+${n} days)`]]); }
  if (on(f.cms_outdated)) F('cms_outdated', '_eq', 'true');        // CMS desatualizado
  if (f.dns) F('dns_provider', '_icontains', f.dns);
  // MODO OU (só no diretório): base AND (crit1 OU crit2 …). Aninhado em _and[0][_or] para NÃO colidir
  // com o _or da pesquisa `q` (que também é top-level). Critério multi-condição → _and interno.
  if (pfx === '' && f.match === 'any' && crit.length > 1) {
    const parts = [];
    crit.forEach((c, i) => {
      const b = `filter[_and][0][_or][${i}]`;
      if (c.length === 1) { const [fl, op, val] = c[0]; parts.push(`${b}[${fl}][${op}]=${enc(val)}`); }
      else c.forEach(([fl, op, val], j) => parts.push(`${b}[_and][${j}][${fl}][${op}]=${enc(val)}`));
    });
    return parts;
  }
  // MODO E (default + relação/contactos): tudo ANDed (flat).
  const p = [];
  for (const c of crit) for (const [fl, op, val] of c) p.push(pfx ? `filter[${pfx}][${fl}][${op}]=${enc(val)}` : `filter[${fl}][${op}]=${enc(val)}`);
  return p;
}

// Filtro completo de sites (partilhado por /api/directory e contagem de segmentos).
function siteFilterParts(f = {}) {
  const parts = [];
  if (f.q) { const s = encodeURIComponent(f.q); parts.push(`filter[_or][0][domain][_icontains]=${s}`, `filter[_or][1][company][name][_icontains]=${s}`); }
  if (f.qualified === 'true') parts.push('filter[qualified][_eq]=true');
  else if (f.qualified === 'false') parts.push('filter[qualified][_eq]=false&filter[is_live][_eq]=true');
  if (f.live === 'true') parts.push('filter[is_live][_eq]=true');
  if (f.platform) parts.push(`filter[primary_platform][slug][_eq]=${encodeURIComponent(f.platform)}`);
  if (f.country) parts.push(`filter[ip_country][_eq]=${encodeURIComponent(f.country)}`);
  if (f.isp) parts.push(`filter[isp][_eq]=${encodeURIComponent(f.isp)}`);
  // Clientes (companies.is_client). (Audiência/"em campanha" foi revertida — a alias o2m
  // sites.emails era puxada p/ SELECT * dos scripts standalone e partia as queries; ver Follow-Ups.)
  if (f.client === 'true') parts.push('filter[company][is_client][_eq]=true');
  else if (f.client === 'false') parts.push('filter[company][is_client][_neq]=true');
  parts.push(...buildSiteFilters(f, ''));
  return parts.join('&');
}

const posthogEnabled = () => !!(POSTHOG_PUBLIC_KEY && POSTHOG_PUBLIC_HOST);
const posthogDistinctId = (req, fallback = 'dashboard-server') => req.get('X-POSTHOG-DISTINCT-ID') || fallback;
const posthogSessionId = (req) => req.get('X-POSTHOG-SESSION-ID') || undefined;
async function captureServerEvent(req, event, distinctId, properties = {}) {
  if (!posthogEnabled()) return;
  const sessionId = posthogSessionId(req);
  const payload = {
    api_key: POSTHOG_PUBLIC_KEY,
    event,
    distinct_id: String(distinctId || 'dashboard-server'),
    properties: {
      ...properties,
      source: 'dashboard-server',
      $current_url: req.originalUrl,
      ...(sessionId ? { $session_id: sessionId } : {}),
    },
  };
  try {
    await fetch(`${POSTHOG_PUBLIC_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch { /* fail-soft */ }
}

const app = express();
app.use(express.json());
app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));
app.get('/api/posthog-config', (req, res) => {
  res.json({
    enabled: posthogEnabled(),
    key: POSTHOG_PUBLIC_KEY || null,
    host: POSTHOG_PUBLIC_HOST || null,
  });
});
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // import CSV até 25 MB

// --- Overview / KPIs + breakdowns -------------------------------------------
app.get('/api/stats', async (req, res) => {
  try {
    const payload = await cached('stats:overview', async () => {
    const [sites, live, qualified, companies, contacts, verifiedEmails, plats] = await Promise.all([
      count('sites'),
      count('sites', '&filter[is_live][_eq]=true'),
      count('sites', '&filter[qualified][_eq]=true'),
      count('companies'),
      count('contacts'),
      count('contacts', '&filter[email_verified][_eq]=true'),
      d('/items/platforms?fields=id,name,slug&limit=-1'),
    ]);
    const nameById = Object.fromEntries(plats.map((p) => [p.id, p.name]));
    const slugById = Object.fromEntries(plats.map((p) => [p.id, p.slug]));

    // Nota: o Directus dá erro SQL ao ordenar por `count` num groupBy — por isso
    // pedimos os grupos sem ordenação e ordenamos/cortamos aqui.
    const byPlatform = (await d('/items/sites?groupBy[]=primary_platform&aggregate[count]=id&filter[primary_platform][_nnull]=true'))
      .map((r) => ({ name: nameById[r.primary_platform] || 'Outro', slug: slugById[r.primary_platform] || 'custom', count: Number(r.count.id) }))
      .filter((r) => r.count > 0).sort((a, b) => b.count - a.count);

    // byCountry/byCity/byIsp: agregados EXATOS via PG direto. O groupBy do Directus sobre 1,5M sites
    // devolve grupos CAPADOS e NÃO-ordenados → o "top N" (ISPs/países) saía errado/desatualizado. Filtra
    // a is_live (prospetos reais, não sites mortos). Fallback ao Directus se não houver PG_HOST.
    let byCountry, byCity, byIsp;
    const _pgStats = await pgPool();
    if (_pgStats) {
      const topN = (col, n) => _pgStats.query(`SELECT ${col} AS name, count(*)::int AS count FROM sites WHERE ${col} IS NOT NULL AND is_live GROUP BY ${col} ORDER BY count DESC LIMIT ${n}`).then((r) => r.rows);
      [byCountry, byCity, byIsp] = await Promise.all([topN('ip_country', 10), topN('ip_city', 10), topN('isp', 12)]);
    } else {
      byCountry = (await d('/items/sites?groupBy[]=ip_country&aggregate[count]=id&filter[ip_country][_nnull]=true'))
        .map((r) => ({ name: r.ip_country, count: Number(r.count.id) })).sort((a, b) => b.count - a.count).slice(0, 10);
      byCity = (await d('/items/sites?groupBy[]=ip_city&aggregate[count]=id&filter[ip_city][_nnull]=true'))
        .map((r) => ({ name: r.ip_city, count: Number(r.count.id) })).sort((a, b) => b.count - a.count).slice(0, 10);
      byIsp = (await d('/items/sites?groupBy[]=isp&aggregate[count]=id&filter[isp][_nnull]=true'))
        .map((r) => ({ name: r.isp, count: Number(r.count.id) })).sort((a, b) => b.count - a.count).slice(0, 12);
    }

    // Cidade do NEGÓCIO (business_city, do site/GMB) — distinta de ip_city (alojamento).
    const byBusinessCity = (await d('/items/sites?groupBy[]=business_city&aggregate[count]=id&filter[business_city][_nnull]=true'))
      .map((r) => ({ name: r.business_city, count: Number(r.count.id) })).sort((a, b) => b.count - a.count).slice(0, 10);

    // Sinais de prospeção (contagens rápidas para o overview).
    const [withEmail, withPhone, cpanel, gmb, spfProblems, dmarcProblems] = await Promise.all([
      count('sites', '&filter[has_email][_eq]=true'),
      count('sites', '&filter[has_phone][_eq]=true'),
      count('sites', '&filter[is_cpanel][_eq]=true'),
      count('sites', '&filter[gmb][_eq]=true'),
      count('sites', '&filter[spf_status][_in]=missing,invalid,weak'),
      count('sites', '&filter[dmarc_status][_in]=missing,invalid,weak'),
    ]);

    return {
      totals: { sites, live, qualified, unqualified: live - qualified, dead: sites - live, companies, contacts, verifiedEmails },
      audit: { withEmail, withPhone, cpanel, gmb, spfProblems, dmarcProblems },
      byPlatform, byCountry, byCity, byBusinessCity, byIsp,
    };
    });
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Business Directory (sites) ---------------------------------------------
app.get('/api/directory', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;
    const parts = siteFilterParts(req.query);
    const filter = parts ? '&' + parts : '';
    const fields = 'fields=id,domain,is_live,qualified,http_status,hosting_ip,ip_country,ip_city,isp,cdn,language,primary_platform.name,primary_platform.slug,company.org_domain,company.name,company.general_email'
      + ',has_email,has_phone,has_decision_maker,lead_score,is_cpanel,gmb,social_facebook,social_instagram,social_linkedin,social_twitter,load_bucket,spf_status,dmarc_status,business_city'
      + ',industry,traffic_bucket,seo_score,mobile_friendly,security_findings,security_severity,wp_vuln_count,audit_status'
      + ',ssl_days_left,ssl_grade,expiring_soon,cms_outdated,cms_version';
    // Ordenação: por omissão os melhores leads primeiro. ?sort=<col>&dir=asc|desc ordena por coluna
    // (whitelist). dir explícito ganha; senão lead_score default desc, restantes asc. Desempate por domain.
    const SORTABLE = { domain: 'domain', lead_score: 'lead_score', seo: 'seo_score', country: 'ip_country', platform: 'primary_platform.slug', city: 'business_city', traffic: 'traffic_bucket', ssl: 'ssl_days_left', isp: 'isp', company: 'company.name', qualified: 'qualified' };
    const sf = SORTABLE[req.query.sort];
    const dir = req.query.dir === 'desc' ? '-' : req.query.dir === 'asc' ? '' : (req.query.sort === 'lead_score' ? '-' : '');
    const sort = sf ? `sort[]=${dir}${sf}&sort[]=domain` : 'sort[]=-lead_score&sort[]=domain';
    const url = `/items/sites?${fields}${filter}&${sort}&limit=${limit}&offset=${offset}&meta=filter_count`;
    const res2 = await fetch(`${DIRECTUS_URL}${url}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await res2.json();
    const rows = json.data || [];
    // Contagem de contactos (e se tem e-mail verificado) por site, para a página atual.
    const ids = rows.map((r) => r.id).filter(Boolean);
    if (ids.length) {
      const inList = ids.join(',');
      const [byAll, byVer] = await Promise.all([
        d(`/items/contacts?groupBy[]=site&aggregate[count]=id&filter[site][_in]=${inList}`),
        d(`/items/contacts?groupBy[]=site&aggregate[count]=id&filter[site][_in]=${inList}&filter[email_verified][_eq]=true`),
      ]);
      const cAll = Object.fromEntries(byAll.map((x) => [x.site, Number(x.count.id)]));
      const cVer = Object.fromEntries(byVer.map((x) => [x.site, Number(x.count.id)]));
      for (const r of rows) { r.contacts_count = cAll[r.id] || 0; r.has_verified_email = (cVer[r.id] || 0) > 0; }
    }
    res.json({ rows, total: json.meta?.filter_count ?? rows.length, page, limit });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Site detail (hostnames + tech + contacts) ------------------------------
app.get('/api/site', async (req, res) => {
  try {
    const domain = (req.query.domain || '').trim();
    if (!domain) return res.status(400).json({ error: 'domain em falta' });
    const rows = await d(`/items/sites?filter[domain][_eq]=${encodeURIComponent(domain)}&fields=*,primary_platform.name,company.id,company.name,company.org_domain,company.general_email,company.general_phone,company.is_client&limit=1`);
    const site = rows[0];
    if (!site) return res.status(404).json({ error: 'não encontrado' });
    const companyId = site.company?.id ?? site.company;
    const contacts = companyId
      ? await d(`/items/contacts?filter[company][_eq]=${companyId}&fields=id,name,role,role_category,email,phone,source,source_detail,email_status,email_verified,gdpr_basis,do_not_contact,reviewed&limit=50`)
      : [];
    // Relatórios de auditoria (Lighthouse/Nuclei/WPScan/GMB) — vazio na Fase 1.
    let reports = [];
    try {
      reports = await d(`/items/site_reports?filter[site][_eq]=${site.id}&fields=id,kind,score,summary,created_at&sort=-created_at&limit=20`);
    } catch { /* coleção ainda sem dados */ }
    const orgDomain = site.company?.org_domain;
    for (const c of contacts) c.maybe_person = c.role === 'general' && maybePersonGeneral(c.name, orgDomain);
    res.json({ site, contacts, reports, metricsEnabled: chEnabled(), directusPublicUrl: process.env.DIRECTUS_PUBLIC_URL || '' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Analytics (Fase E): timeline por site + feed de gatilhos (ClickHouse) ----
// Timeline de um site (por domínio): observações agrupadas por métrica.
app.get('/api/timeline', async (req, res) => {
  try {
    if (!chEnabled()) return res.json({ enabled: false, series: {} });
    const domain = (req.query.domain || '').trim();
    if (!domain) return res.status(400).json({ error: 'domain em falta' });
    const rows = await d(`/items/sites?filter[domain][_eq]=${encodeURIComponent(domain)}&fields=id&limit=1`);
    if (!rows[0]) return res.status(404).json({ error: 'não encontrado' });
    const obs = await chTimeline(rows[0].id);
    // Agrupa por métrica → [{ts, v}] (numérico usa value_num, senão value_str).
    const series = {};
    for (const o of obs) {
      (series[o.metric] ||= []).push({ ts: Number(o.ts), v: o.value_num == null ? o.value_str : Number(o.value_num) });
    }
    res.json({ enabled: true, series });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Feed de gatilhos (change events) recentes; filtros severity/event/domain/since.
app.get('/api/triggers', async (req, res) => {
  try {
    if (!chEnabled()) return res.json({ enabled: false, triggers: [] });
    const triggers = await chTriggers({
      limit: req.query.limit, severity: req.query.severity, event: req.query.event,
      domain: (req.query.domain || '').trim() || undefined, sinceDays: req.query.since,
    });
    res.json({ enabled: true, triggers });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Contacts directory ------------------------------------------------------
app.get('/api/contacts', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;
    const parts = [];
    const q = (req.query.q || '').trim();
    if (q) {
      const s = encodeURIComponent(q);
      parts.push(`filter[_or][0][name][_icontains]=${s}`);
      parts.push(`filter[_or][1][email][_icontains]=${s}`);
      parts.push(`filter[_or][2][company][name][_icontains]=${s}`);
    }
    // Cargos: multi-seleção (roles=CEO,CTO,...) e/ou categorias (rolecat=decision_maker,...).
    if (req.query.roles) parts.push(`filter[role][_in]=${encodeURIComponent(req.query.roles)}`);
    else if (req.query.role) parts.push(`filter[role][_eq]=${encodeURIComponent(req.query.role)}`); // retrocompat
    if (req.query.rolecat) parts.push(`filter[role_category][_in]=${encodeURIComponent(req.query.rolecat)}`);
    if (req.query.verif) parts.push(`filter[email_status][_eq]=${encodeURIComponent(req.query.verif)}`);
    if (req.query.dm === 'true') parts.push('filter[role_category][_eq]=decision_maker');
    // "tem email/telefone" = o próprio contacto (não a flag do site)
    if (req.query.has_email === 'true' || req.query.has_email === '1') parts.push('filter[email][_nnull]=true');
    if (req.query.has_phone === 'true' || req.query.has_phone === '1') parts.push('filter[phone][_nnull]=true');
    // Filtros de auditoria do site associado (via relação m2o)
    parts.push(...buildSiteFilters(req.query, 'site'));
    const filter = parts.length ? '&' + parts.join('&') : '';
    const fields = 'fields=name,role,role_category,email,phone,phone_country,social_profiles,source,source_detail,gdpr_basis,email_status,email_verified,company.name,company.org_domain,site.domain,site.primary_platform.slug,site.business_city,site.is_cpanel,site.gmb,site.lead_score';
    const C_SORTABLE = { name: 'name', role: 'role', email: 'email', phone: 'phone', company: 'company.name', source: 'source' };
    const csf = C_SORTABLE[req.query.sort]; const csdir = req.query.dir === 'desc' ? '-' : '';
    const csort = csf ? `sort[]=${csdir}${csf}&sort[]=name` : 'sort[]=name';
    const url = `/items/contacts?${fields}${filter}&${csort}&limit=${limit}&offset=${offset}&meta=filter_count`;
    const res2 = await fetch(`${DIRECTUS_URL}${url}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await res2.json();
    for (const c of (json.data || [])) c.maybe_person = c.role === 'general' && maybePersonGeneral(c.name, c.company?.org_domain);
    res.json({ rows: json.data, total: json.meta?.filter_count ?? json.data.length, page, limit });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Edição manual de um contacto — reclassificar general↔pessoa (name/role/role_category)
// e/ou marcar "não contactar" (do_not_contact). Qualquer edição marca `reviewed`.
const ROLE_CATS = ['decision_maker', 'manager', 'dpo', 'staff', 'general', 'unknown'];
app.patch('/api/contacts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    const patch = {};
    if (typeof b.name === 'string') patch.name = b.name.slice(0, 255);
    if (typeof b.role === 'string') patch.role = b.role.slice(0, 255);
    if (typeof b.role_category === 'string' && ROLE_CATS.includes(b.role_category)) patch.role_category = b.role_category;
    if (typeof b.do_not_contact === 'boolean') patch.do_not_contact = b.do_not_contact;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nada a atualizar' });
    patch.reviewed = true; // um humano tocou neste contacto → revisto (não re-tocar automaticamente)
    patch.reviewed_at = new Date().toISOString();
    const updated = await dwrite('PATCH', `/items/contacts/${encodeURIComponent(id)}`, patch);
    res.json({ ok: true, contact: updated });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Edição manual da ÁREA DE ATIVIDADE de um site — correção pontual quando o classificador erra.
// Grava industry_confidence=1 (sentinela "revisto por humano"): o handler `industry` do worker
// não sobrescreve sites com conf ≥ 1, por isso a correção fica protegida de re-classificações.
const INDUSTRY_TAX = ['restauracao', 'retalho', 'saude', 'construcao', 'imobiliario', 'turismo', 'juridico', 'contabilidade', 'automovel', 'beleza', 'educacao', 'ti', 'marketing', 'industria', 'agricultura', 'transportes', 'desporto', 'moda', 'casa', 'financeiro', 'associacao', 'outros'];
app.patch('/api/sites/:id/industry', async (req, res) => {
  try {
    const id = req.params.id;
    const industry = String((req.body || {}).industry || '');
    if (!INDUSTRY_TAX.includes(industry)) return res.status(400).json({ error: 'categoria inválida' });
    const updated = await dwrite('PATCH', `/items/sites/${encodeURIComponent(id)}`, { industry, industry_confidence: 1 });
    res.json({ ok: true, site: updated });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Segments (saved views) CRUD -------------------------------------------
app.get('/api/segments', async (req, res) => {
  try {
    const segments = await cached('segments:list', async () => {
      const segs = await d('/items/segments?sort[]=-id&limit=-1&fields=id,name,description,accent,filters,shared,owner');
      await Promise.all(segs.map(async (s) => {
        try { s.count = await count('sites', s.filters ? '&' + siteFilterParts(s.filters) : ''); } catch { s.count = null; }
      }));
      return segs;
    });
    res.json({ segments });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/segments', async (req, res) => {
  try {
    const { name, description, accent, filters, shared, owner } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name obrigatório' });
    const s = await dwrite('POST', '/items/segments', { name, description: description || null, accent: accent || 'var(--np-brand)', filters: filters || {}, shared: !!shared, owner: owner || 'Rui Almeida' });
    await cacheDrop('segments:');
    res.json({ segment: s });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.put('/api/segments/:id', async (req, res) => {
  try { const segment = await dwrite('PATCH', `/items/segments/${encodeURIComponent(req.params.id)}`, req.body || {}); await cacheDrop('segments:'); res.json({ segment }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.delete('/api/segments/:id', async (req, res) => {
  try { await dwrite('DELETE', `/items/segments/${encodeURIComponent(req.params.id)}`); await cacheDrop('segments:'); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Campanhas (Fase F) ------------------------------------------------------
const newToken = () => crypto.randomBytes(16).toString('hex');
async function natsPublish(subject, obj, msgId) {
  const { js, headers } = await natsJs();
  const h = headers();
  if (msgId) h.set('Nats-Msg-Id', msgId);
  await js.publish(subject, new TextEncoder().encode(JSON.stringify(obj)), { headers: h });
}
// Audiência de contactos (com email) a partir de um objeto de filtros de segmento,
// via a relação `site`. É a mesma linguagem de filtros do diretório/segmentos.
function contactAudienceParts(f = {}) {
  const p = ['filter[email][_nnull]=true', 'filter[do_not_contact][_neq]=true']; // campanhas: com email e NÃO marcados "não contactar"
  if (f.qualified === 'true') p.push('filter[site][qualified][_eq]=true');
  else if (f.qualified === 'false') p.push('filter[site][qualified][_eq]=false');
  if (f.live === 'true') p.push('filter[site][is_live][_eq]=true');
  if (f.platform) p.push(`filter[site][primary_platform][slug][_eq]=${encodeURIComponent(f.platform)}`);
  if (f.country) p.push(`filter[site][ip_country][_eq]=${encodeURIComponent(f.country)}`);
  if (f.roles) p.push(`filter[role][_in]=${encodeURIComponent(f.roles)}`);
  if (f.rolecat) p.push(`filter[role_category][_in]=${encodeURIComponent(f.rolecat)}`);
  p.push(...buildSiteFilters(f, 'site'));
  return p.join('&');
}
async function campaignCounts(id) {
  const rows = await d(`/items/emails?aggregate[count]=id&groupBy=status&filter[campaign][_eq]=${encodeURIComponent(id)}`);
  const c = { pending: 0, generating: 0, ready: 0, sending: 0, sent: 0, failed: 0, opened: 0, clicked: 0, replied: 0 };
  let total = 0;
  for (const r of rows) { const n = Number(r.count?.id || 0); c[r.status] = n; total += n; }
  // "sent" agrega tudo o que já saiu (sent/opened/clicked/replied) para a taxa.
  c.delivered = c.sent + c.opened + c.clicked + c.replied;
  return { ...c, total };
}

app.get('/api/campaigns', async (req, res) => {
  try {
    const rows = await d('/items/campaigns?sort[]=-id&limit=-1&fields=id,name,status,angle,from_name,from_email,total,created_at,sent_at');
    await Promise.all(rows.map(async (c) => { try { c.counts = await campaignCounts(c.id); } catch { c.counts = null; } }));
    res.json({ campaigns: rows, mailer: { mode: process.env.SMTP_HOST ? 'smtp' : 'dry' } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/campaigns', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'nome em falta' });
    const row = {
      name: String(b.name).slice(0, 255), angle: b.angle || 'general', status: 'draft',
      audience_filters: b.filters || {}, segment: b.segmentId || null,
      from_name: (b.from_name || '').slice(0, 255), from_email: (b.from_email || '').slice(0, 255),
      reply_to: (b.reply_to || '').slice(0, 255), subject_hint: (b.subject_hint || '').slice(0, 255),
      total: 0, generated: 0, sent: 0, opened: 0, clicked: 0,
    };
    const created = await dwrite('POST', '/items/campaigns', row);
    void captureServerEvent(req, 'campaign_created', posthogDistinctId(req, `campaign:${created.id}`), {
      campaign_id: created.id,
      angle: row.angle,
      has_segment: !!row.segment,
    });
    res.json({ ok: true, campaign: created });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    const rows = await d(`/items/campaigns?filter[id][_eq]=${id}&limit=1&fields=*`);
    const campaign = rows[0];
    if (!campaign) return res.status(404).json({ error: 'não encontrada' });
    const emails = await d(`/items/emails?filter[campaign][_eq]=${id}&sort[]=id&limit=200&fields=id,to_email,to_name,subject,body,status,ai_generated,error,sent_at,opened_at,clicked_at,site.domain`);
    campaign.counts = await campaignCounts(req.params.id);
    res.json({ campaign, emails, mailerMode: process.env.SMTP_HOST ? 'smtp' : 'dry' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Constrói a audiência + cria os e-mails (pending) + enfileira geração de cópia.
app.post('/api/campaigns/:id/generate', async (req, res) => {
  try {
    const id = req.params.id;
    const rows = await d(`/items/campaigns?filter[id][_eq]=${encodeURIComponent(id)}&limit=1&fields=id,angle,audience_filters`);
    const campaign = rows[0];
    if (!campaign) return res.status(404).json({ error: 'não encontrada' });
    // Já tem e-mails? re-gera a cópia dos existentes (não recria audiência).
    const existing = await d(`/items/emails?filter[campaign][_eq]=${encodeURIComponent(id)}&fields=id&limit=-1`);
    let ids = existing.map((e) => e.id);
    if (!ids.length) {
      const cap = Math.min(5000, parseInt(req.body?.limit, 10) || 2000);
      const parts = contactAudienceParts(campaign.audience_filters || {});
      const contacts = await d(`/items/contacts?${parts}&fields=id,name,email,site.id,site.domain&limit=${cap}`);
      const seen = new Set();
      const toCreate = [];
      for (const c of contacts) {
        const em = (c.email || '').toLowerCase();
        if (!em || seen.has(em)) continue; // dedup por email
        seen.add(em);
        toCreate.push({ campaign: id, contact: c.id, site: c.site?.id || null, to_email: em, to_name: (c.name || '').slice(0, 255), status: 'pending', token: newToken() });
      }
      // cria em lotes de 100 e recolhe os ids
      for (let i = 0; i < toCreate.length; i += 100) {
        const chunk = toCreate.slice(i, i + 100);
        const made = await dwrite('POST', '/items/emails', chunk);
        ids.push(...(Array.isArray(made) ? made.map((m) => m.id) : []));
      }
    }
    await dwrite('PATCH', `/items/campaigns/${encodeURIComponent(id)}`, { status: 'generating', total: ids.length });
    for (const emailId of ids) await natsPublish('jobs.campaign.generate', { emailId }, `campgen:${emailId}`);
    void captureServerEvent(req, 'campaign_generation_queued', posthogDistinctId(req, `campaign:${id}`), {
      campaign_id: id,
      queued_count: ids.length,
      reused_existing_emails: existing.length > 0,
    });
    res.json({ ok: true, queued: ids.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Enfileira envio dos e-mails prontos.
app.post('/api/campaigns/:id/send', async (req, res) => {
  try {
    const id = req.params.id;
    const ready = await d(`/items/emails?filter[campaign][_eq]=${encodeURIComponent(id)}&filter[status][_in]=ready,failed&fields=id&limit=-1`);
    for (const e of ready) await natsPublish('jobs.campaign.send', { emailId: e.id }, `campsend:${e.id}`);
    await dwrite('PATCH', `/items/campaigns/${encodeURIComponent(id)}`, { status: ready.length ? 'sending' : 'sent', sent_at: new Date().toISOString() });
    void captureServerEvent(req, 'campaign_send_queued', posthogDistinctId(req, `campaign:${id}`), {
      campaign_id: id,
      queued_count: ready.length,
    });
    res.json({ ok: true, queued: ready.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.delete('/api/campaigns/:id', async (req, res) => {
  try { await dwrite('DELETE', `/items/campaigns/${encodeURIComponent(req.params.id)}`); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Tracking de e-mail (open pixel + click redirect) ------------------------
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'); // 1x1 gif
async function findEmailByToken(token) {
  if (!token) return null;
  const rows = await d(`/items/emails?filter[token][_eq]=${encodeURIComponent(token)}&limit=1&fields=id,status,to_email,site.domain,contact.id,campaign.id,campaign.angle`);
  return rows[0] || null;
}
// Marca um email como opt-out: contacto do_not_contact + linha dnc + email unsubscribed.
async function doUnsubscribe(token) {
  const em = await findEmailByToken(token);
  if (!em) return false;
  const email = (em.to_email || '').toLowerCase();
  const contactId = em.contact?.id ?? em.contact;
  if (contactId) await dwrite('PATCH', `/items/contacts/${contactId}`, { do_not_contact: true }).catch(() => {});
  if (email) {
    const ex = await d(`/items/dnc?filter[email][_eq]=${encodeURIComponent(email)}&fields=id&limit=1`).catch(() => []);
    if (!ex.length) await dwrite('POST', '/items/dnc', { email, reason: 'unsubscribe', source: `campaign:${em.campaign?.id || ''}` }).catch(() => {});
  }
  await dwrite('PATCH', `/items/emails/${em.id}`, { status: 'unsubscribed' }).catch(() => {});
  return true;
}
app.get('/t/o/:token', async (req, res) => {
  try {
    const em = await findEmailByToken(req.params.token);
    if (em && !['opened', 'clicked', 'replied'].includes(em.status)) {
      await dwrite('PATCH', `/items/emails/${em.id}`, { status: 'opened', opened_at: new Date().toISOString() }).catch(() => {});
    }
  } catch { /* nunca falha o pixel */ }
  res.set('Content-Type', 'image/gif'); res.set('Cache-Control', 'no-store'); res.send(PIXEL);
});
app.get('/t/c/:token', async (req, res) => {
  const url = req.query.u || '/';
  try {
    const em = await findEmailByToken(req.params.token);
    if (em) await dwrite('PATCH', `/items/emails/${em.id}`, { status: 'clicked', clicked_at: new Date().toISOString() }).catch(() => {});
  } catch { /* segue o redirect na mesma */ }
  const safe = /^https?:\/\//i.test(url) ? url : '/';
  res.redirect(302, safe);
});
// Opt-out: POST = one-click (List-Unsubscribe-Post do Gmail/Yahoo); GET = clique no link.
app.post('/t/u/:token', async (req, res) => {
  try { await doUnsubscribe(req.params.token); } catch { /* nunca falha */ }
  res.set('Content-Type', 'text/plain').send('OK');
});
app.get('/t/u/:token', async (req, res) => {
  let ok = false; try { ok = await doUnsubscribe(req.params.token); } catch { /* ignore */ }
  res.set('Content-Type', 'text/html').send(`<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#202124"><h2>${ok ? 'Removido' : 'Pedido registado'}</h2><p>Não voltará a receber os nossos contactos. Obrigado.</p></body>`);
});

// --- Auditoria pesada on-demand (publica em jobs.audit.ondemand) -------------
// ?only=wpscan (ou lista) corre só esses passos (ex.: botão WPScan). O worker lê job.only.
app.post('/api/audit/:domain', async (req, res) => {
  const domain = (req.params.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'domain em falta' });
  const only = (req.query.only || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Uma só ferramenta → subject FINO dedicado (Fase B); senão → coarse ondemand.
  const FINE = { wpscan: 'jobs.wpscan', nuclei: 'jobs.nuclei', lighthouse: 'jobs.lighthouse.mobile', gmb: 'jobs.gmb', industry: 'jobs.industry', ssl: 'jobs.ssl', whois: 'jobs.whois', dnsprovider: 'jobs.dnsprovider' };
  const subject = (only.length === 1 && FINE[only[0]]) ? FINE[only[0]] : 'jobs.audit.ondemand';
  try {
    const { js, headers } = await natsJs();
    const h = headers();
    h.set('Nats-Msg-Id', `audit:${domain}:${only.join('-') || 'all'}`);
    await js.publish(subject, new TextEncoder().encode(JSON.stringify({ domain, only: only.length ? only : undefined })), { headers: h });
    try {
      const rows = await d(`/items/sites?filter[domain][_eq]=${encodeURIComponent(domain)}&fields=id&limit=1`);
      if (rows[0]) await dwrite('PATCH', `/items/sites/${rows[0].id}`, { audit_status: 'queued' });
    } catch { /* ignora */ }
    void captureServerEvent(req, 'audit_requested', posthogDistinctId(req, `site:${domain}`), {
      domain,
      scope: 'single_site',
      requested_steps: only.join(',') || 'all',
    });
    res.json({ ok: true, queued: domain, only });
  } catch (e) {
    res.status(502).json({ error: `fila indisponível: ${e.message}` });
  }
});

// "Auditar tudo" numa audiência/segmento: enfileira audit p/ os sites que batem o filtro.
app.post('/api/audit/segment', async (req, res) => {
  const f = req.body?.filters || {};
  const only = Array.isArray(req.body?.only) ? req.body.only : [];
  const cap = Math.min(5000, parseInt(req.body?.limit, 10) || 2000);
  try {
    const parts = siteFilterParts(f);
    const url = `/items/sites?fields=domain&limit=${cap}&${parts}`;
    const rows = await d(url);
    const { js, headers } = await natsJs();
    let n = 0;
    for (const r of rows) {
      if (!r.domain) continue;
      const h = headers();
      h.set('Nats-Msg-Id', `audit:${r.domain}:${only.join('-') || 'all'}`);
      await js.publish('jobs.audit.qualified', new TextEncoder().encode(JSON.stringify({ domain: r.domain, only: only.length ? only : undefined })), { headers: h });
      n++;
    }
    void captureServerEvent(req, 'audit_requested', posthogDistinctId(req, 'segment-audit'), {
      scope: 'segment',
      enqueued_count: n,
      requested_steps: only.join(',') || 'all',
      capped: rows.length >= cap,
    });
    res.json({ ok: true, enqueued: n, capped: rows.length >= cap });
  } catch (e) {
    res.status(502).json({ error: `fila indisponível: ${e.message}` });
  }
});

// --- Workers / fila (observabilidade NATS JetStream) — B2 --------------------
// Espelho compacto de lib/jobs.js CONSUMERS (durable -> role); o dashboard não
// importa lib/. Manter em sincronia se se acrescentarem consumers.
const CONSUMER_ROLES = {
  enrich: 'base', contacts: 'base', verify: 'verify', discover: 'base', dns: 'base', geoip: 'base',
  fetch: 'base', fingerprint: 'base', social: 'base', locality: 'base', emailauth: 'base', traffic: 'base',
  score: 'base', subdomains: 'base', ssl: 'base', whois: 'base', dnsprovider: 'base',
  campaign_generate: 'base', campaign_send: 'base',
  audit_ondemand: 'browser', audit_qualified: 'browser', audit_rest: 'browser',
  industry: 'ai', lighthouse_desktop: 'browser', lighthouse_mobile: 'browser', gmb: 'browser',
  nuclei: 'security', wpscan: 'security',
};
// /api/queues — estado da stream + profundidade por consumer (a antiga /api/workers).
app.get('/api/queues', async (req, res) => {
  try {
    const jsm = await natsManager();
    const stream = await jsm.streams.info('NP_JOBS');
    const consumers = [];
    for await (const ci of jsm.consumers.list('NP_JOBS')) {
      const name = ci.name;
      consumers.push({
        name, role: CONSUMER_ROLES[name] || '?', subject: ci.config?.filter_subject || '',
        pending: ci.num_pending || 0, ackPending: ci.num_ack_pending || 0, redelivered: ci.num_redelivered || 0, waiting: ci.num_waiting || 0, delivered: ci.delivered?.consumer_seq || 0, acked: ci.ack_floor?.consumer_seq || 0,
      });
    }
    // Rate (jobs/h) por consumer: delta do delivered vs snapshot no Redis (janela >=20s).
      try {
        const rr = await redisClient();
        if (rr && _redisUp) {
          const now = Date.now();
          const prev = JSON.parse((await rr.get('np:qstats:prev').catch(() => null)) || 'null');
          if (prev && prev.ts && now - prev.ts > 3000) {
            const dt = (now - prev.ts) / 1000;
            for (const c of consumers) { const pv = prev.byName?.[c.name]; if (pv != null) { c.rate = Math.max(0, Math.round((c.delivered - pv) / dt * 3600)); c.eta = c.rate > 0 ? +(c.pending / c.rate).toFixed(1) : null; } }
          }
          if (!prev || now - prev.ts >= 20000) { const byName = {}; for (const c of consumers) byName[c.name] = c.delivered; await rr.set('np:qstats:prev', JSON.stringify({ ts: now, byName }), { EX: 300 }).catch(() => {}); }
        }
      } catch { /* rate opcional */ }
      consumers.sort((a, b) => (b.pending + b.ackPending) - (a.pending + a.ackPending) || a.name.localeCompare(b.name));
    const byRole = {};
    for (const c of consumers) {
      const r = (byRole[c.role] ||= { role: c.role, consumers: 0, pending: 0, ackPending: 0, redelivered: 0, waiting: 0 });
      r.consumers++; r.pending += c.pending; r.ackPending += c.ackPending; r.redelivered += c.redelivered; r.waiting += c.waiting;
    }
    res.json({
      stream: { messages: stream.state?.messages || 0, bytes: stream.state?.bytes || 0, consumerCount: stream.state?.consumer_count ?? consumers.length, firstSeq: stream.state?.first_seq || 0, lastSeq: stream.state?.last_seq || 0 },
      consumers, byRole: Object.values(byRole).sort((a, b) => (b.pending + b.ackPending) - (a.pending + a.ackPending)),
    });
  } catch (e) { res.status(502).json({ error: `NATS indisponível: ${e.message}` }); }
});
// Amostra de jobs numa fila (peek read-only via getMessage por seq — o workqueue NÃO deixa
// abrir um 2.º consumer no mesmo subject; varremos as seqs mais recentes e filtramos).
app.get('/api/queues/:consumer/jobs', async (req, res) => {
  try {
    const jsm = await natsManager();
    let subj; try { subj = (await jsm.consumers.info('NP_JOBS', req.params.consumer)).config?.filter_subject; } catch { return res.status(404).json({ error: 'consumer desconhecido' }); }
    const st = (await jsm.streams.info('NP_JOBS')).state;
    const dec = new TextDecoder(); const jobs = []; const SCAN = 500; let scanned = 0;
    for (let seq = st.last_seq; seq >= st.first_seq && scanned < SCAN && jobs.length < 80; seq--, scanned++) {
      let m; try { m = await jsm.streams.getMessage('NP_JOBS', { seq }); } catch { continue; } // acked → removido
      if (m.subject !== subj) continue;
      let p = {}; try { p = JSON.parse(dec.decode(m.data)); } catch { /* */ }
      jobs.push({ seq, label: p.domain || p.emailId || p.ip || '(payload)', time: m.time });
    }
    res.json({ consumer: req.params.consumer, subject: subj, jobs, scanned, sampled: jobs.length >= 80 });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Apagar jobs por seq (bulk). Prioritizar NÃO é suportado num workqueue FIFO (ver README Follow-ups).
app.post('/api/queues/jobs/delete', async (req, res) => {
  try {
    const seqs = Array.isArray(req.body?.seqs) ? req.body.seqs.map(Number).filter(Boolean) : [];
    const jsm = await natsManager(); let deleted = 0;
    for (const seq of seqs.slice(0, 1000)) { try { await jsm.streams.deleteMessage('NP_JOBS', seq); deleted++; } catch { /* já saiu */ } }
    res.json({ ok: true, deleted });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Purga TODOS os pendentes de um consumer (o subject inteiro).
app.post('/api/queues/:consumer/purge', async (req, res) => {
  try {
    const jsm = await natsManager();
    let subj; try { subj = (await jsm.consumers.info('NP_JOBS', req.params.consumer)).config?.filter_subject; } catch { return res.status(404).json({ error: 'consumer desconhecido' }); }
    const r = await jsm.streams.purge('NP_JOBS', { filter: subj });
    res.json({ ok: true, purged: r.purged });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Workers A CORRER (telemetria via Redis) — B2 revisão -------------------
async function workerCounts(r, id) {
  const h = Math.floor(Date.now() / 3600000);
  const dk = [], fk = [];
  for (let i = 0; i < 24; i++) { dk.push(`np:wk:${id}:done:${h - i}`); fk.push(`np:wk:${id}:fail:${h - i}`); }
  const [dv, fv] = await Promise.all([r.mGet(dk), r.mGet(fk)]);
  const d = dv.map((x) => +x || 0), f = fv.map((x) => +x || 0);
  return { done1h: d[0], fail1h: f[0], done24h: d.reduce((a, b) => a + b, 0), fail24h: f.reduce((a, b) => a + b, 0) };
}
app.get('/api/workers', async (req, res) => {
  try {
    const r = await redisClient();
    if (!r || !_redisUp) return res.json({ workers: [], telemetry: false });
    const ids = await r.zRangeByScore('np:wk:index', Date.now() - 90000, '+inf').catch(() => []); // heartbeat <90s
    const workers = [];
    for (const id of ids) {
      const h = await r.hGetAll(`np:wk:${id}`).catch(() => ({}));
      if (!h.id) continue;
      const durs = (await r.lRange(`np:wk:${id}:dur`, 0, -1).catch(() => [])).map(Number).filter(Number.isFinite);
      const pj = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
      workers.push({ id, role: h.role || '?', host: h.host || '', consumers: (h.consumers || '').split(',').filter(Boolean),
        started: +h.started || null, beat: +h.beat || null, cur: h.cur || null, curStarted: +h.cur_started || null,
        load: h.load != null && h.load !== 'null' ? +h.load : null, cores: +h.cores || null,
        version: h.version || null, replicas: +h.replicas || null, conc: pj(h.conc), maxacks: pj(h.maxacks),
        avgMs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null, ...(await workerCounts(r, id)) });
    }
    workers.sort((a, b) => (b.beat || 0) - (a.beat || 0));
    res.json({ workers, telemetry: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/workers/:id', async (req, res) => {
  try {
    const r = await redisClient();
    if (!r || !_redisUp) return res.status(404).json({ error: 'sem telemetria (Redis desligado)' });
    const h = await r.hGetAll(`np:wk:${req.params.id}`);
    if (!h.id) return res.status(404).json({ error: 'worker não encontrado ou expirado' });
    const logs = await r.lRange(`np:wk:${req.params.id}:log`, 0, 120).catch(() => []);
    const durs = (await r.lRange(`np:wk:${req.params.id}:dur`, 0, -1).catch(() => [])).map(Number).filter(Number.isFinite);
    res.json({ id: h.id, role: h.role || '?', host: h.host || '', pid: h.pid || '', consumers: (h.consumers || '').split(',').filter(Boolean),
      started: +h.started || null, beat: +h.beat || null, cur: h.cur || null, curStarted: +h.cur_started || null,
      avgMs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null, ...(await workerCounts(r, req.params.id)), logs });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Config / Sistema (B5) — estado dos serviços + resumos de config (SEM segredos) --
function readCfg(f) { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config', f), 'utf8')); } catch { return null; } }
app.get('/api/config', async (req, res) => {
  try {
    const status = {};
    status.directus = { up: true, url: DIRECTUS_URL };
    const r = await redisClient().catch(() => null);
    status.redis = { up: !!(r && _redisUp), url: REDIS_URL || '(desligado)' };
    try { const jsm = await natsManager(); const s = await jsm.streams.info('NP_JOBS'); status.nats = { up: true, messages: s.state?.messages || 0, consumers: s.state?.consumer_count || 0 }; } catch (e) { status.nats = { up: false, error: e.message }; }
    status.clickhouse = { enabled: chEnabled(), up: chEnabled() ? ((await chQuery('SELECT 1 AS x')).length > 0) : false };
    status.ollama = { enabled: !!OLLAMA_URL, url: OLLAMA_URL || '(desligado)' };
    // Resumos de config — só contagens/estado, NUNCA os valores secretos.
    const vp = readCfg('verify-providers.json');
    const providers = Array.isArray(vp) ? vp.filter((p) => p && p.provider).map((p) => ({ provider: p.provider, keys: Array.isArray(p.apiKeys) ? p.apiKeys.length : (p.apiKey ? 1 : 0), dailyLimit: p.dailyLimit || null })) : [];
    const proxies = readCfg('verify-proxies.json'); const angles = readCfg('campaign-angles.json');
    // sending_accounts é uma COLEÇÃO (metadados, sem passwords — essas ficam no ficheiro gitignored).
    let sending = [];
    try { sending = await d('/items/sending_accounts?fields=id,label,from_email,warmup_stage,daily_cap,sent_today,active&limit=50').catch(() => []); } catch { /* coleção pode não existir */ }
    res.json({
      status,
      config: {
        providers, providerFileExists: !!vp,
        proxyCount: Array.isArray(proxies) ? proxies.length : 0, proxyFileExists: !!proxies,
        angles: angles?.angles ? Object.keys(angles.angles) : [], sender_org: angles?.sender_org || null,
        sending, mailer: process.env.SMTP_HOST ? 'smtp' : 'dry-run',
      },
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- ISPs descobertos (B3) — agrega sites.isp (paginado, com % qualificados) --
app.get('/api/isps', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const all = await cached('isps:all', async () => {
      const [tot, qual] = await Promise.all([
        d('/items/sites?groupBy[]=isp&aggregate[count]=id&filter[isp][_nnull]=true&limit=-1'),
        d('/items/sites?groupBy[]=isp&aggregate[count]=id&filter[isp][_nnull]=true&filter[qualified][_eq]=true&limit=-1'),
      ]);
      const qMap = Object.fromEntries(qual.map((r) => [r.isp, Number(r.count.id)]));
      return tot.map((r) => ({ isp: r.isp, sites: Number(r.count.id), qualified: qMap[r.isp] || 0 }))
        .filter((r) => r.sites > 0).sort((a, b) => b.sites - a.sites);
    }, 300); // ISPs mudam devagar → TTL 5 min
    const off = (page - 1) * limit;
    // sort por coluna (?sort=isp|sites|qualified|pct &dir=asc|desc). Default = sites desc (já ordenado).
    const sc = req.query.sort, dir = req.query.dir === 'asc' ? 1 : -1;
    const val = (r) => sc === 'isp' ? String(r.isp).toLowerCase() : sc === 'qualified' ? r.qualified : sc === 'pct' ? (r.sites ? r.qualified / r.sites : 0) : r.sites;
    const sorted = sc ? [...all].sort((a, b) => { const x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; }) : all;
    res.json({ rows: sorted.slice(off, off + limit), total: all.length, page, limit, totalSites: all.reduce((a, r) => a + r.sites, 0) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Clientes (B3) — empresas convertidas (companies.is_client) --------------
app.get('/api/clients', async (req, res) => {
  try {
    const rows = await d('/items/companies?filter[is_client][_eq]=true&fields=id,name,org_domain,website,general_email,general_phone,country,client_since,client_mrr,client_notes&sort[]=-client_since&limit=500');
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      const inList = ids.join(',');
      const [bySite, byContact] = await Promise.all([
        d(`/items/sites?groupBy[]=company&aggregate[count]=id&filter[company][_in]=${inList}`),
        d(`/items/contacts?groupBy[]=company&aggregate[count]=id&filter[company][_in]=${inList}`),
      ]);
      const sc = Object.fromEntries(bySite.map((x) => [x.company, Number(x.count.id)]));
      const cc = Object.fromEntries(byContact.map((x) => [x.company, Number(x.count.id)]));
      for (const r of rows) { r.sites_count = sc[r.id] || 0; r.contacts_count = cc[r.id] || 0; }
    }
    res.json({ clients: rows, totalMrr: rows.reduce((a, r) => a + (Number(r.client_mrr) || 0), 0) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Marcar/atualizar/desmarcar uma empresa como cliente (do drawer do site ou da página).
app.post('/api/clients/:companyId', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.is_client !== undefined) {
      patch.is_client = !!b.is_client;
      if (patch.is_client) patch.client_since = b.client_since || new Date().toISOString();
      else { patch.client_since = null; patch.client_mrr = null; }
    }
    if (b.client_mrr !== undefined) patch.client_mrr = b.client_mrr === '' || b.client_mrr == null ? null : Number(b.client_mrr);
    if (b.client_notes !== undefined) patch.client_notes = b.client_notes || null;
    const company = await dwrite('PATCH', `/items/companies/${encodeURIComponent(req.params.companyId)}`, patch);
    void captureServerEvent(req, 'client_status_updated', posthogDistinctId(req, `company:${req.params.companyId}`), {
      company_id: req.params.companyId,
      is_client: patch.is_client,
      has_mrr: patch.client_mrr != null,
      has_notes: !!patch.client_notes,
    });
    res.json({ ok: true, company });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Live search de empresas por nome/domínio OU por nome de contacto (p/ marcar cliente).
app.get('/api/companies/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const s = encodeURIComponent(q);
    const [byCo, byCt] = await Promise.all([
      d(`/items/companies?filter[_or][0][name][_icontains]=${s}&filter[_or][1][org_domain][_icontains]=${s}&fields=id,name,org_domain,is_client&limit=8`),
      d(`/items/contacts?filter[name][_icontains]=${s}&fields=name,company.id,company.name,company.org_domain,company.is_client&limit=8`),
    ]);
    const map = new Map();
    for (const c of byCo) map.set(c.id, { id: c.id, name: c.name, org_domain: c.org_domain, is_client: c.is_client });
    for (const ct of byCt) { const co = ct.company; if (co && co.id && !map.has(co.id)) map.set(co.id, { id: co.id, name: co.name, org_domain: co.org_domain, is_client: co.is_client, via: ct.name }); }
    res.json({ results: [...map.values()].slice(0, 10) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Importação CSV (B3) — upload → mapeamento de colunas → upsert -----------
// Campos importáveis por tipo de destino (usados pelo mapeamento de colunas no UI).
const IMPORT_FIELD_SETS = {
  contacts: ['name', 'email', 'phone', 'role', 'company_name', 'domain'],
  companies: ['name', 'domain', 'website', 'general_email', 'general_phone', 'country'],
  clients: ['name', 'domain', 'client_mrr', 'client_notes', 'general_email', 'general_phone'],
  sites: ['domain', 'company_name'],
  campaigns: ['name', 'angle', 'from_name', 'from_email', 'subject_hint'],
  segments: ['name', 'description'],
};
const IMPORT_COLL = { companies: 'companies', clients: 'companies', sites: 'sites', campaigns: 'campaigns', segments: 'segments' };
function parseCsvBuffer(buf) {
  return parseCsvSync(buf.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
}
// 1) Preview: devolve cabeçalhos + amostra para o UI mapear as colunas.
app.post('/api/import/preview', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ficheiro em falta' });
    const records = parseCsvBuffer(req.file.buffer);
    const headers = records.length ? Object.keys(records[0]) : [];
    res.json({ headers, sample: records.slice(0, 5), rowCount: records.length });
  } catch (e) { res.status(400).json({ error: 'CSV inválido: ' + e.message }); }
});
// 2) Import: recebe o MESMO ficheiro + o mapeamento; faz upsert (dedup) em companies+contacts.
const derivDomain = (raw, email) => {
  let dom = (raw || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0].trim();
  if (!dom && email && email.includes('@')) dom = email.split('@')[1];
  return dom || null;
};
// Constrói o registo p/ os destinos simples (companies/clients/sites/campaigns/segments).
function buildImportRecord(target, get, row) {
  const domain = derivDomain(get(row, 'domain'), get(row, 'email'));
  const nz = (o) => { const r = {}; for (const [k, v] of Object.entries(o)) if (v != null && v !== '') r[k] = v; return r; };
  if (target === 'companies' || target === 'clients') {
    const nm = get(row, 'name');
    const org = domain || (nm ? nm.toLowerCase().replace(/\s+/g, '-').slice(0, 255) : '');
    if (!org) return null;
    const rec = nz({ org_domain: org.slice(0, 255), name: (nm || org).slice(0, 255), website: domain || '', general_email: get(row, 'general_email'), general_phone: get(row, 'general_phone'), country: get(row, 'country'), source: 'csv_import' });
    if (target === 'clients') { rec.is_client = true; rec.client_since = new Date().toISOString(); const m = get(row, 'client_mrr'); if (m) rec.client_mrr = Number(m) || null; const n = get(row, 'client_notes'); if (n) rec.client_notes = n; }
    return { dedup: 'org_domain', rec };
  }
  if (target === 'sites') { if (!domain) return null; return { dedup: 'domain', rec: { domain, discovered_via: 'csv_import' } }; }
  if (target === 'campaigns') { const name = get(row, 'name'); if (!name) return null; return { dedup: 'name', rec: nz({ name: name.slice(0, 255), angle: get(row, 'angle') || 'general', from_name: get(row, 'from_name'), from_email: get(row, 'from_email'), subject_hint: get(row, 'subject_hint'), status: 'draft', audience_filters: {} }) }; }
  if (target === 'segments') { const name = get(row, 'name'); if (!name) return null; return { dedup: 'name', rec: nz({ name: name.slice(0, 255), description: get(row, 'description'), filters: {}, accent: 'var(--np-brand)' }) }; }
  return null;
}
app.post('/api/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ficheiro em falta' });
    const target = req.body.target && IMPORT_FIELD_SETS[req.body.target] ? req.body.target : 'contacts';
    const mapping = JSON.parse(req.body.mapping || '{}');
    const dryRun = req.body.dryRun === 'true' || req.body.dryRun === true;
    let records = parseCsvBuffer(req.file.buffer);
    const MAX = 20000; const capped = records.length > MAX; if (capped) records = records.slice(0, MAX);
    const get = (row, f) => { const col = mapping[f]; return col && row[col] != null ? String(row[col]).trim() : ''; };
    const stat = { target, total: records.length, created: 0, updated: 0, skipped: 0, errors: 0, companies_created: 0, capped };

    if (target === 'contacts') {
      const companyCache = new Map();
      for (const row of records) {
        try {
          const email = get(row, 'email').toLowerCase(), name = get(row, 'name'), phone = get(row, 'phone'), role = get(row, 'role');
          const domain = derivDomain(get(row, 'domain'), email);
          const org = domain || (get(row, 'company_name') ? get(row, 'company_name').toLowerCase().replace(/\s+/g, '-').slice(0, 255) : null);
          if ((!email && !name) || !org) { stat.skipped++; continue; }
          let companyId = companyCache.get(org);
          if (companyId === undefined) {
            const found = await d(`/items/companies?filter[org_domain][_eq]=${encodeURIComponent(org)}&fields=id&limit=1`);
            if (found.length) companyId = found[0].id;
            else { stat.companies_created++; companyId = dryRun ? -1 : (await dwrite('POST', '/items/companies', { org_domain: org.slice(0, 255), name: (get(row, 'company_name') || org).slice(0, 255), website: domain || null, source: 'csv_import' })).id; }
            companyCache.set(org, companyId);
          }
          let existing = [];
          if (companyId > 0) { const f = email ? `filter[email][_eq]=${encodeURIComponent(email)}` : `filter[name][_eq]=${encodeURIComponent(name)}`; existing = await d(`/items/contacts?filter[company][_eq]=${companyId}&${f}&fields=id,email,phone,name,role&limit=1`); }
          if (existing.length) {
            const ex = existing[0], patch = {};
            if (name && !ex.name) patch.name = name.slice(0, 255); if (phone && !ex.phone) patch.phone = phone.slice(0, 60); if (role && !ex.role) patch.role = role.slice(0, 120); if (email && !ex.email) patch.email = email;
            if (Object.keys(patch).length && !dryRun) await dwrite('PATCH', `/items/contacts/${ex.id}`, patch);
            stat.updated++;
          } else { if (!dryRun && companyId > 0) await dwrite('POST', '/items/contacts', { name: name.slice(0, 255) || null, email: email || null, phone: phone.slice(0, 60) || null, role: role.slice(0, 120) || null, company: companyId, source: 'csv_import', gdpr_basis: 'legitimate_interest' }); stat.created++; }
        } catch { stat.errors++; }
      }
    } else {
      const coll = IMPORT_COLL[target]; const seen = new Set();
      for (const row of records) {
        try {
          const built = buildImportRecord(target, get, row);
          if (!built) { stat.skipped++; continue; }
          const dv = built.rec[built.dedup];
          if (!dv || seen.has(dv)) { stat.skipped++; continue; }
          seen.add(dv);
          const found = await d(`/items/${coll}?filter[${built.dedup}][_eq]=${encodeURIComponent(dv)}&fields=id&limit=1`);
          if (found.length) { if (!dryRun) await dwrite('PATCH', `/items/${coll}/${found[0].id}`, built.rec); stat.updated++; }
          else { if (!dryRun) await dwrite('POST', `/items/${coll}`, built.rec); stat.created++; }
        } catch { stat.errors++; }
      }
    }
    if (!dryRun) await cacheDrop('stats:');
    void captureServerEvent(req, 'csv_import_submitted', posthogDistinctId(req, `import:${target}`), {
      target,
      dry_run: dryRun,
      total_rows: stat.total,
      created_count: stat.created,
      updated_count: stat.updated,
      skipped_count: stat.skipped,
      error_count: stat.errors,
    });
    res.json({ ...stat, dryRun });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Agentes IA (B4) — Ollama on-prem via /api/agents/* ---------------------
const OLLAMA_URL = (process.env.OLLAMA_URL || '').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';
// AI observability (PostHog): 1 evento `$ai_generation` por chamada LLM — modelo, latência, tokens
// REAIS do Ollama (prompt_eval_count/eval_count), sucesso/erro. Fail-soft; atribuído por agente (label).
function captureAi({ label, model, latencyMs, ok, promptTokens, outputTokens, inputText, outputText, httpStatus, error }) {
  if (!posthogEnabled()) return;
  const props = {
    $ai_provider: 'ollama', $ai_model: model, $ai_span_name: label, agent: label, source: 'dashboard-server',
    $ai_latency: latencyMs != null ? +(latencyMs / 1000).toFixed(3) : undefined, $ai_is_error: !ok,
  };
  if (promptTokens != null) props.$ai_input_tokens = promptTokens;
  if (outputTokens != null) props.$ai_output_tokens = outputTokens;
  if (httpStatus) props.$ai_http_status = httpStatus;
  if (error) props.$ai_error = String(error).slice(0, 200);
  if (inputText) props.$ai_input = String(inputText).slice(0, 2000);
  if (outputText) props.$ai_output_choices = [String(outputText).slice(0, 2000)];
  fetch(`${POSTHOG_PUBLIC_HOST}/capture/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: POSTHOG_PUBLIC_KEY, event: '$ai_generation', distinct_id: `ai:${label || 'ollama'}`, properties: props }),
  }).catch(() => { /* fail-soft */ });
}
async function ollamaJson(prompt, format, { timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 60000, options = {}, label = 'ollama' } = {}) {
  if (!OLLAMA_URL) return { ok: false, error: 'Ollama desligado. Corre `docker compose --profile audit up -d ollama ollama-init` (e define OLLAMA_URL no .env).' };
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const body = { model: OLLAMA_MODEL, prompt, stream: false, keep_alive: '30m', options };
    if (format) body.format = format;
    const r = await fetch(`${OLLAMA_URL}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) { captureAi({ label, model: OLLAMA_MODEL, latencyMs: Date.now() - started, ok: false, httpStatus: r.status }); return { ok: false, error: `Ollama HTTP ${r.status}` }; }
    const j = await r.json();
    const text = String(j.response ?? '');
    let json = null; if (format) { try { json = JSON.parse(text); } catch { /* não-JSON */ } }
    captureAi({ label, model: OLLAMA_MODEL, latencyMs: Date.now() - started, ok: true, promptTokens: j.prompt_eval_count, outputTokens: j.eval_count, inputText: prompt, outputText: text });
    return { ok: true, text, json };
  } catch (e) { captureAi({ label, model: OLLAMA_MODEL, latencyMs: Date.now() - started, ok: false, error: e.name }); return { ok: false, error: e.name === 'AbortError' ? 'Ollama timeout (CPU ocupado com enrich/extract?)' : e.message }; }
  finally { clearTimeout(to); }
}
const AGENT_TAXONOMY = ['restauracao', 'retalho', 'saude', 'construcao', 'imobiliario', 'turismo', 'juridico', 'contabilidade', 'automovel', 'beleza', 'educacao', 'ti', 'marketing', 'industria', 'agricultura', 'transportes', 'desporto', 'moda', 'casa', 'financeiro', 'associacao', 'outros'];
const AGENT_FILTER_KEYS = ['q', 'qualified', 'live', 'platform', 'country', 'isp', 'has_email', 'has_phone', 'dm', 'lead_min', 'city', 'industry', 'traffic', 'cpanel', 'fb', 'ig', 'li', 'tw', 'gmb', 'load', 'spf', 'dmarc', 'seo_max', 'mobile', 'security', 'sev', 'wpvuln', 'ssl_expiring', 'domain_expiring', 'cms_outdated', 'dns'];
const FILTER_DOC = `Campos de filtro válidos (usa SÓ estes) e valores:
- qualified:"true" (só alvos WordPress/WooCommerce/PrestaShop/Wix) | "false"
- live:"true" · platform:"wordpress"|"woocommerce"|"prestashop"|"wix"|"shopify"|"joomla"|"drupal"
- country:"PT"|"NL"|"SE"|"FI"|"NO" (país de alojamento) · lead_min:número 0-100 · city:texto
- industry:${AGENT_TAXONOMY.join('|')}
- has_email:"true" · has_phone:"true" · dm:"true"(tem decisor) · gmb:"true"(tem Google Business) · cpanel:"true"
- fb/ig/li/tw:"true"(redes sociais) · traffic:"top10k"|"top100k"|"top1m"|"unranked"(junta c/ vírgula)
- load:"fast"|"medium"|"slow"|"very_slow"(velocidade; junta c/ vírgula)
- spf:"missing,weak,invalid" · dmarc:"missing,weak,invalid"(problemas de autenticação de email)
- seo_max:número(SEO abaixo de) · security:"true"(problemas segurança) · wpvuln:"true"
- ssl_expiring:"true"(certificado ≤30d) · domain_expiring:"true"(domínio ≤90d) · cms_outdated:"true"`;

// Audience Creator: linguagem natural → objeto de filtros (com pré-visualização da contagem).
// Sub-agente Audience Creator (reutilizado pela página + pelo orquestrador).
async function agentAudience(q) {
  const prompt = `És o "Audience Creator" do NetProspect (prospeção B2B para a Netmaster, agência web portuguesa: manutenção de sites + alojamento gerido).
Converte o pedido do utilizador num objeto de FILTROS usando SÓ os campos abaixo. Não inventes campos nem valores.
Responde APENAS em JSON: { "name":"<nome curto do segmento>", "explanation":"<1 frase a descrever o público>", "filters": { ...só campos válidos... } }
${FILTER_DOC}

Pedido do utilizador: "${q}"`;
  const format = { type: 'object', properties: { name: { type: 'string' }, explanation: { type: 'string' }, filters: { type: 'object' } }, required: ['name', 'filters'] };
  const r = await ollamaJson(prompt, format, { options: { temperature: 0.2 }, label: 'audience' });
  if (!r.ok) return { error: r.error };
  if (!r.json) return { error: 'A IA devolveu uma resposta inválida.' };
  const filters = {};
  for (const [k, v] of Object.entries(r.json.filters || {})) if (AGENT_FILTER_KEYS.includes(k) && v != null && v !== '' && v !== false) filters[k] = String(v);
  let n = null; try { n = await count('sites', Object.keys(filters).length ? '&' + siteFilterParts(filters) : ''); } catch { /* filtro inválido */ }
  return { name: r.json.name || 'Novo público', explanation: r.json.explanation || '', filters, count: n };
}
// Sub-agente Planner.
async function agentPlan(extra) {
  const [sites, qualified, contacts, spf, cpanel, gmb, withEmail] = await Promise.all([
    count('sites'), count('sites', '&filter[qualified][_eq]=true'), count('contacts'),
    count('sites', '&filter[spf_status][_in]=missing,invalid,weak'), count('sites', '&filter[is_cpanel][_eq]=true'),
    count('sites', '&filter[gmb][_eq]=true'), count('sites', '&filter[has_email][_eq]=true'),
  ]);
  const summary = `Base: ${sites} sites, ${qualified} qualificados (WordPress/WooCommerce/PrestaShop/Wix), ${contacts} contactos. `
    + `Sinais de dor: ${spf} com SPF/DMARC fraco, ${cpanel} em cPanel, ${gmb} SEM Google Business confirmado, ${withEmail} com email de contacto. TLDs: .pt .nl .se .fi .no.`;
  const prompt = `És o "Planner" de vendas do NetProspect (Netmaster — agência web PT: manutenção + alojamento gerido).
A partir dos dados da base, sugere 3-4 campanhas de outreach CONCRETAS e acionáveis. Para cada uma: público-alvo (linguagem simples), ângulo de venda, e porquê (que sinal/dor justifica).
Responde só em JSON: { "ideas":[ { "title":"", "audience":"", "angle":"", "why":"" } ] }
${summary}
${extra ? 'Foco pedido: ' + extra : ''}`;
  const format = { type: 'object', properties: { ideas: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, audience: { type: 'string' }, angle: { type: 'string' }, why: { type: 'string' } }, required: ['title', 'audience', 'angle'] } } }, required: ['ideas'] };
  const r = await ollamaJson(prompt, format, { timeoutMs: 90000, options: { temperature: 0.5 }, label: 'planner' });
  if (!r.ok) return { error: r.error };
  return { ideas: (r.json?.ideas || []).slice(0, 6), summary };
}
app.post('/api/agents/audience', async (req, res) => {
  try { const q = (req.body?.prompt || '').trim(); if (!q) return res.status(400).json({ error: 'descreve o público que queres' }); const out = await agentAudience(q); if (out.error) return res.status(502).json(out); res.json(out); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/agents/plan', async (req, res) => {
  try { const out = await agentPlan((req.body?.prompt || '').trim()); if (out.error) return res.status(502).json(out); res.json(out); } catch (e) { res.status(502).json({ error: e.message }); }
});
// Sub-agente Campaign Creator: brief → copy de email (assuntos + corpo c/ variáveis).
const CAMPAIGN_VARS = ['{{name}}', '{{domain}}', '{{seo_score}}', '{{mobile_score}}', '{{security_findings}}', '{{ssl_grade}}', '{{ssl_days_left}}', '{{gmb_name}}', '{{gmb_rating}}', '{{industry}}', '{{report_url}}'];
async function agentCampaign({ angle, audience, message } = {}) {
  const prompt = `És o "Campaign Creator" do NetProspect (Netmaster — agência web PT: manutenção de sites + alojamento gerido).
Escreve UM email de outreach frio para prospetos B2B. Regras: PT de Portugal, tom humano e direto (não corporativo), CURTO (máx ~90 palavras), UM call-to-action (marcar chamada ou ver relatório). Personaliza com as variáveis disponíveis (serão substituídas por dados reais de cada site):
${CAMPAIGN_VARS.join(' ')}
Usa {{report_url}} para o link do relatório e {{name}}/{{domain}} para personalizar. Não prometas o que não sabes nem inventes números.
Ângulo de venda: ${angle || 'geral'}. ${audience ? 'Público: ' + audience + '.' : ''} ${message ? 'Instruções extra: ' + message : ''}
Responde só em JSON: { "subjects":["<2-3 assuntos curtos, menos de 60 chars>"], "preview_text":"<pré-visualização 1 linha>", "body":"<corpo do email com as variáveis>", "variables":["<variáveis efetivamente usadas>"] }`;
  const format = { type: 'object', properties: { subjects: { type: 'array', items: { type: 'string' } }, preview_text: { type: 'string' }, body: { type: 'string' }, variables: { type: 'array', items: { type: 'string' } } }, required: ['subjects', 'body'] };
  const r = await ollamaJson(prompt, format, { timeoutMs: 90000, options: { temperature: 0.6 }, label: 'campaign' });
  if (!r.ok) return { error: r.error };
  if (!r.json) return { error: 'A IA devolveu uma resposta inválida.' };
  return { subjects: (r.json.subjects || []).slice(0, 3), preview_text: r.json.preview_text || '', body: r.json.body || '', variables: (r.json.variables || []).slice(0, 12), angle: angle || 'geral' };
}
app.post('/api/agents/campaign-copy', async (req, res) => {
  try { const out = await agentCampaign(req.body || {}); if (out.error) return res.status(502).json(out); res.json(out); } catch (e) { res.status(502).json({ error: e.message }); }
});
// Orquestrador — chat que classifica a intenção e delega no sub-agente certo.
app.post('/api/agents/chat', async (req, res) => {
  try {
    const msg = (req.body?.message || '').trim();
    if (!msg) return res.status(400).json({ error: 'mensagem em falta' });
    const routeFmt = { type: 'object', properties: { intent: { type: 'string', enum: ['audience', 'plan', 'campaign', 'general'] }, reply: { type: 'string' } }, required: ['intent'] };
    const routePrompt = `És o Orquestrador de IA do NetProspect (prospeção B2B, agência web Netmaster). Classifica a mensagem do utilizador:
- "audience": quer construir/definir um público-alvo ou segmento (por filtros).
- "plan": quer sugestões de campanhas / estratégia a partir dos dados.
  - "campaign": quer ESCREVER/criar o texto (copy) de um email de campanha.
- "general": pergunta geral → responde tu próprio no campo "reply" (PT de Portugal, curto e útil).
Mensagem: "${msg}"
Responde só em JSON {intent, reply}.`;
    const r = await ollamaJson(routePrompt, routeFmt, { options: { temperature: 0.2 }, label: 'orchestrator' });
    if (!r.ok) return res.status(502).json({ error: r.error });
    const intent = r.json?.intent || 'general';
    if (intent === 'audience') { const a = await agentAudience(msg); if (a.error) return res.status(502).json(a); return res.json({ kind: 'audience', intent, ...a }); }
    if (intent === 'plan') { const p = await agentPlan(msg); if (p.error) return res.status(502).json(p); return res.json({ kind: 'plan', intent, ...p }); }
    return res.json({ kind: 'text', intent: 'general', reply: r.json?.reply || 'Posso criar públicos-alvo, sugerir campanhas ou escrever o copy dos emails — o que precisas?' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Exportação CSV (mesmos filtros da diretório/contactos) ------------------
function toCsv(rows, cols) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = cols.map((c) => c.h).join(',');
  const body = rows.map((r) => cols.map((c) => esc(c.get(r))).join(',')).join('\n');
  return head + '\n' + body + '\n';
}
app.get('/api/directory.csv', async (req, res) => {
  try {
    const parts = siteFilterParts(req.query);
    const cap = Math.min(100000, parseInt(req.query.limit, 10) || 50000);
    const fields = 'fields=domain,is_live,qualified,lead_score,primary_platform.slug,ip_country,business_city,has_email,has_phone,has_decision_maker,spf_status,dmarc_status,load_bucket,traffic_bucket,industry,company.name,company.general_email,company.general_phone';
    const rows = await d(`/items/sites?${fields}&sort[]=-lead_score&limit=${cap}${parts ? '&' + parts : ''}`);
    const cols = [
      { h: 'domain', get: (r) => r.domain }, { h: 'company', get: (r) => r.company?.name },
      { h: 'platform', get: (r) => r.primary_platform?.slug }, { h: 'lead_score', get: (r) => r.lead_score },
      { h: 'qualified', get: (r) => r.qualified }, { h: 'country', get: (r) => r.ip_country },
      { h: 'business_city', get: (r) => r.business_city }, { h: 'industry', get: (r) => r.industry },
      { h: 'has_email', get: (r) => r.has_email }, { h: 'has_phone', get: (r) => r.has_phone },
      { h: 'has_decision_maker', get: (r) => r.has_decision_maker }, { h: 'spf', get: (r) => r.spf_status },
      { h: 'dmarc', get: (r) => r.dmarc_status }, { h: 'load', get: (r) => r.load_bucket },
      { h: 'general_email', get: (r) => r.company?.general_email }, { h: 'general_phone', get: (r) => r.company?.general_phone },
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="netprospect-diretorio.csv"');
    res.send(toCsv(rows, cols));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/contacts.csv', async (req, res) => {
  try {
    const parts = [];
    const q = (req.query.q || '').trim();
    if (q) { const s = encodeURIComponent(q); parts.push(`filter[_or][0][name][_icontains]=${s}`, `filter[_or][1][email][_icontains]=${s}`, `filter[_or][2][company][name][_icontains]=${s}`); }
    if (req.query.roles) parts.push(`filter[role][_in]=${encodeURIComponent(req.query.roles)}`);
    if (req.query.rolecat) parts.push(`filter[role_category][_in]=${encodeURIComponent(req.query.rolecat)}`);
    if (req.query.verif) parts.push(`filter[email_status][_eq]=${encodeURIComponent(req.query.verif)}`);
    if (req.query.has_email === 'true') parts.push('filter[email][_nnull]=true');
    if (req.query.has_phone === 'true') parts.push('filter[phone][_nnull]=true');
    parts.push(...buildSiteFilters(req.query, 'site'));
    const cap = Math.min(100000, parseInt(req.query.limit, 10) || 50000);
    const fields = 'fields=name,role,role_category,email,phone,phone_country,email_status,source,company.name,company.org_domain,site.domain';
    const rows = await d(`/items/contacts?${fields}&sort[]=name&limit=${cap}${parts.length ? '&' + parts.join('&') : ''}`);
    const cols = [
      { h: 'name', get: (r) => r.name }, { h: 'role', get: (r) => r.role }, { h: 'role_category', get: (r) => r.role_category },
      { h: 'email', get: (r) => r.email }, { h: 'email_status', get: (r) => r.email_status },
      { h: 'phone', get: (r) => r.phone }, { h: 'phone_country', get: (r) => r.phone_country },
      { h: 'company', get: (r) => r.company?.name }, { h: 'domain', get: (r) => r.site?.domain }, { h: 'source', get: (r) => r.source },
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="netprospect-contactos.csv"');
    res.send(toCsv(rows, cols));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- Cobertura de jobs por bucket de lead_score (np-db direto; cache 30min) ---
// TEM de ficar ANTES do catch-all `app.get('*')`, senão a SPA engole /api/coverage.
const COVERAGE_SQL = `
-- unv = sites com contactos AINDA por processar (email_status NULL). Inclui os deixados a meio
-- quando a quota do verify esgotou (esses ficam email=NULL,status=NULL — antes escapavam à métrica
-- porque exigia email IS NOT NULL → o site contava como "verificado" sem o job ter terminado).
WITH unv AS (SELECT DISTINCT site FROM contacts WHERE email_status IS NULL)
SELECT
  CASE WHEN lead_score>70 THEN 'gt70' WHEN lead_score>60 THEN 'b60' WHEN lead_score>50 THEN 'b50'
       WHEN lead_score>40 THEN 'b40' ELSE 'lt40' END AS bucket,
  count(*)::int AS total,
  -- Cada métrica = O JOB CORREU para o site (não "tem resultado"). Marcador por job:
  count(*) FILTER (WHERE s.checked_at IS NOT NULL)::int AS enrich,
  count(*) FILTER (WHERE s.http_status IS NOT NULL)::int AS fetch,
  count(*) FILTER (WHERE s.checked_at IS NOT NULL)::int AS dns,
  count(*) FILTER (WHERE s.checked_at IS NOT NULL)::int AS geoip,
  count(*) FILTER (WHERE s.tech_detected IS NOT NULL)::int AS fingerprint,
  count(*) FILTER (WHERE s.social IS NOT NULL)::int AS social,
  count(*) FILTER (WHERE s.tech_detected IS NOT NULL)::int AS locality,
  count(*) FILTER (WHERE s.spf_status IS NOT NULL)::int AS emailauth,
  count(*) FILTER (WHERE s.traffic_bucket IS NOT NULL)::int AS traffic,
  count(*) FILTER (WHERE s.tech_detected IS NOT NULL)::int AS subdomains,
  count(*) FILTER (WHERE s.ssl_grade IS NOT NULL)::int AS ssl,
  count(*) FILTER (WHERE s.dns_provider IS NOT NULL)::int AS dnsprovider,
  count(*) FILTER (WHERE s.whois_checked_at IS NOT NULL)::int AS whois,
  count(*) FILTER (WHERE s.contacts_checked_at IS NOT NULL)::int AS contacts,
  count(*) FILTER (WHERE s.contacts_checked_at IS NOT NULL AND s.id NOT IN (SELECT site FROM unv))::int AS verify,
  count(*) FILTER (WHERE s.lead_score_at IS NOT NULL)::int AS score,
  count(*) FILTER (WHERE s.cheap_checked_at IS NOT NULL)::int AS audit,
  count(*) FILTER (WHERE s.industry IS NOT NULL)::int AS industry,
  count(*) FILTER (WHERE s.mobile_score IS NOT NULL)::int AS lighthouse_mobile,
  count(*) FILTER (WHERE s.perf_desktop IS NOT NULL)::int AS lighthouse_desktop,
  count(*) FILTER (WHERE s.security_findings IS NOT NULL)::int AS nuclei,
  count(*) FILTER (WHERE s.wp_vuln_count IS NOT NULL)::int AS wpscan,
  count(*) FILTER (WHERE s.gmb_checked_at IS NOT NULL)::int AS gmb
FROM sites s GROUP BY bucket`;
app.get('/api/coverage', async (req, res) => {
  try {
    const data = await cached('np:coverage:v1', async () => {
      const p = await pgPool();
      if (!p) return { ok: false, error: 'PG desligado (falta PG_HOST/creds)' };
      const [sites, ver] = await Promise.all([
        p.query(COVERAGE_SQL),
        p.query("SELECT count(*) FILTER (WHERE email_status IS NOT NULL)::int verified, count(*) FILTER (WHERE email IS NOT NULL)::int with_email FROM contacts"),
      ]);
      return { ok: true, buckets: sites.rows, verify: ver.rows[0], ts: Date.now() };
    }, 120);
    res.json(data);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Cobertura de DADOS por bucket de lead_score (≠ jobs: aqui mede-se se o CAMPO TEM VALOR, não se
//     o job correu). Ajuda a ver que dados temos sobre as leads — um job pode ter corrido e não achar
//     nada (o dado simplesmente não existe). np-db direto; cache 2min. Antes do catch-all. ---
const DATA_COVERAGE_SQL = `
SELECT
  CASE WHEN lead_score>70 THEN 'gt70' WHEN lead_score>60 THEN 'b60' WHEN lead_score>50 THEN 'b50'
       WHEN lead_score>40 THEN 'b40' ELSE 'lt40' END AS bucket,
  count(*)::int AS total,
  count(*) FILTER (WHERE has_email)::int AS email,
  count(*) FILTER (WHERE has_phone)::int AS phone,
  count(*) FILTER (WHERE has_decision_maker)::int AS decision_maker,
  count(*) FILTER (WHERE social IS NOT NULL AND social::text NOT IN ('null','{}','[]'))::int AS social,
  count(*) FILTER (WHERE whatsapp_number IS NOT NULL OR social_whatsapp IS TRUE)::int AS whatsapp,
  count(*) FILTER (WHERE business_city IS NOT NULL)::int AS city,
  count(*) FILTER (WHERE business_address IS NOT NULL)::int AS address,
  count(*) FILTER (WHERE gmb_name IS NOT NULL)::int AS gmb,
  count(*) FILTER (WHERE industry IS NOT NULL)::int AS industry,
  count(*) FILTER (WHERE ip_country IS NOT NULL)::int AS geoip,
  count(*) FILTER (WHERE ssl_grade IS NOT NULL)::int AS ssl,
  count(*) FILTER (WHERE tech_detected IS NOT NULL)::int AS tech,
  count(*) FILTER (WHERE cms_version IS NOT NULL)::int AS cms_version,
  count(*) FILTER (WHERE dns_provider IS NOT NULL)::int AS dns_provider,
  count(*) FILTER (WHERE spf_status IS NOT NULL)::int AS spf,
  count(*) FILTER (WHERE dmarc_status IS NOT NULL)::int AS dmarc,
  count(*) FILTER (WHERE traffic_bucket IS NOT NULL AND traffic_bucket <> 'unranked')::int AS traffic,
  count(*) FILTER (WHERE mobile_score IS NOT NULL)::int AS lighthouse_mobile,
  count(*) FILTER (WHERE perf_desktop IS NOT NULL)::int AS lighthouse_desktop,
  count(*) FILTER (WHERE seo_score IS NOT NULL)::int AS seo,
  count(*) FILTER (WHERE security_findings IS NOT NULL AND security_findings::text NOT IN ('null','[]','{}'))::int AS security,
  count(*) FILTER (WHERE wp_vuln_count IS NOT NULL)::int AS wpscan,
  count(*) FILTER (WHERE domain_expiry IS NOT NULL)::int AS whois
FROM sites GROUP BY bucket`;
app.get('/api/data-coverage', async (req, res) => {
  try {
    const data = await cached('np:datacoverage:v1', async () => {
      const p = await pgPool();
      if (!p) return { ok: false, error: 'PG desligado (falta PG_HOST/creds)' };
      const [sites, ver] = await Promise.all([
        p.query(DATA_COVERAGE_SQL),
        p.query("SELECT count(*) FILTER (WHERE email_status IS NOT NULL)::int verified, count(*) FILTER (WHERE email IS NOT NULL)::int with_email FROM contacts"),
      ]);
      return { ok: true, buckets: sites.rows, verify: ver.rows[0], ts: Date.now() };
    }, 120);
    res.json(data);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Logs agregados da frota (merge dos np:wk:<id>:log de todos os workers vivos). Antes do catch-all.
app.get('/api/logs', async (req, res) => {
  try {
    const r = await redisClient();
    if (!r || !_redisUp) return res.json({ logs: [], telemetry: false });
    const ids = await r.zRangeByScore('np:wk:index', Date.now() - 90000, '+inf').catch(() => []);
    const all = [];
    for (const id of ids) {
      const h = await r.hGetAll(`np:wk:${id}`).catch(() => ({}));
      const lines = await r.lRange(`np:wk:${id}:log`, 0, 40).catch(() => []);
      for (const ln of lines) all.push({ host: h.host || id, role: h.role || '?', wid: id, line: String(ln) });
    }
    all.sort((a, b) => b.line.slice(0, 8).localeCompare(a.line.slice(0, 8)));
    res.json({ logs: all.slice(0, 400), telemetry: true, workers: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Outreach: funil de campanhas + emails recentes (antes do catch-all) ---
app.get('/api/outreach', async (req, res) => {
  try {
    const camps = await d('/items/campaigns?fields=id,name,status,angle,total,generated,sent,opened,clicked,created_at&sort=-created_at&limit=200').catch(() => []);
    const f = { total: 0, generated: 0, sent: 0, opened: 0, clicked: 0 };
    const byAngle = {}, byStatus = {};
    for (const c of camps) { for (const k of Object.keys(f)) f[k] += (c[k] || 0); byAngle[c.angle || '—'] = (byAngle[c.angle || '—'] || 0) + 1; byStatus[c.status || '—'] = (byStatus[c.status || '—'] || 0) + 1; }
    let recent = [];
    try { recent = await d('/items/emails?fields=id,to_email,subject,status,created_at,sent_at,opened_at,clicked_at,bounce_type,campaign.name&sort=-created_at&limit=60'); } catch { /* vazio */ }
    res.json({ ok: true, campaigns: camps, funnel: f, byAngle, byStatus, recent });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// --- Relatório PÚBLICO (link nos emails: /r/<token>). Serve HTML standalone; marca opened_at. ---
// NOTA: para ser público, o Authentik/NPMPlus tem de EXCLUIR /r/* da autenticação.
const escH = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renderReport(em, full) {
  const s = em.site || {};
  const seo = s.seo_score != null ? Math.round(s.seo_score) : null;
  const mob = s.mobile_score != null ? Math.round(s.mobile_score) : null;
  const pm = s.perf_mobile != null ? Math.round(s.perf_mobile) : null;
  const pd = s.perf_desktop != null ? Math.round(s.perf_desktop) : null;
  const sev = s.security_severity || (s.security_findings ? 'medium' : null);
  const techName = (t) => t == null ? '' : (typeof t === 'string' ? t : (t.name || t.slug || t.technology || ''));
  const techArr = Array.isArray(s.tech_detected) ? s.tech_detected : (s.tech_detected && typeof s.tech_detected === 'object' ? Object.keys(s.tech_detected) : []);
  const tech = techArr.map(techName).filter(Boolean);
  const token = em.token || em.id;
  const sender = em.campaign?.from_email || 'ola@netmaster.pt';
  const scoreCol = (v) => v == null ? '#9aa0aa' : (v >= 90 ? '#16a34a' : v >= 50 ? '#f59e0b' : '#ef4444');
  const sevCol = { critical: '#ef4444', high: '#ef4444', medium: '#f59e0b', low: '#22c55e' }[sev] || '#22c55e';
  const card = (t, v, note, col) => `<div style="flex:1;min-width:150px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">${t}</div><div style="font-size:26px;font-weight:800;margin:4px 0;color:${col || 'var(--text)'}">${v}</div><div style="font-size:12px;color:var(--muted)">${note || ''}</div></div>`;
  const recs = [];
  if (seo != null && seo < 90) recs.push('Melhorar o SEO técnico (metadados, estrutura, velocidade) — impacta a visibilidade no Google.');
  if (mob != null && mob < 90) recs.push('Melhorar a experiência mobile — a maioria do tráfego é telemóvel.');
  if (sev && sev !== 'low') recs.push('Corrigir os problemas de segurança detetados antes que sejam explorados.');
  if (s.ssl_days_left != null && s.ssl_days_left < 30) recs.push('Renovar o certificado SSL (expira em breve).');
  if (s.cms_outdated) recs.push('Atualizar o CMS/WordPress e plugins — versões antigas são o principal vetor de ataque.');
  if (s.wp_vuln_count) recs.push(`Rever ${s.wp_vuln_count} potenciais vulnerabilidades de WordPress.`);
  if (!s.gmb_name) recs.push('Criar/otimizar o perfil Google Business — presença local grátis que traz clientes.');
  const fullSections = full ? `
    <div class="sec"><b>Análise detalhada</b>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px">
        ${card('SEO', seo != null ? seo + '/100' : '—', 'categoria SEO (Lighthouse)', scoreCol(seo))}
        ${card('Mobile-friendly', mob != null ? mob + '/100' : '—', 'viewport · fontes · tap', scoreCol(mob))}
        ${card('Performance mobile', pm != null ? pm + '/100' : '—', 'Lighthouse mobile', scoreCol(pm))}
        ${card('Performance desktop', pd != null ? pd + '/100' : '—', 'Lighthouse desktop', scoreCol(pd))}
      </div></div>
    ${tech.length ? `<div class="sec"><b>Stack tecnológica (${tech.length})</b><div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${tech.map((t) => `<span style="background:var(--chip);border-radius:20px;padding:4px 10px;font-size:12px">${escH(t)}</span>`).join('')}</div></div>` : ''}
    ${recs.length ? `<div class="sec"><b>Recomendações da Netmaster</b><ul style="margin:10px 0 0;padding-left:20px;line-height:1.8">${recs.map((r) => `<li>${escH(r)}</li>`).join('')}</ul></div>` : ''}
  ` : `
    ${recs.length ? `<div class="sec"><b>O que encontrámos para melhorar</b><ul style="margin:10px 0 0;padding-left:20px;line-height:1.7">${recs.slice(0, 3).map((r) => `<li>${escH(r)}</li>`).join('')}${recs.length > 3 ? `<li class="muted">…e mais ${recs.length - 3} no relatório completo.</li>` : ''}</ul></div>` : ''}`;
  return `<!doctype html><html lang="pt" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${full ? 'Relatório completo' : 'Análise'} — ${escH(s.domain)}</title>
<style>
:root,:root[data-theme="dark"]{--bg:#0e1014;--card:#191c22;--text:#e9ebef;--muted:#9aa0aa;--border:#282d36;--chip:#232830;--cta:#141821}
:root[data-theme="light"]{--bg:#f9fafb;--card:#ffffff;--text:#111827;--muted:#6b7280;--border:#e5e7eb;--chip:#f3f4f6;--cta:#111827}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;transition:background .2s,color .2s}
.wrap{max-width:820px;margin:0 auto;padding:32px 20px}h1{font-size:26px;margin:0 0 4px}.muted{color:var(--muted)}
.sec{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;margin:16px 0}
.cta{background:var(--cta);color:#fff;border:1px solid var(--border);border-radius:14px;padding:24px;text-align:center;margin-top:20px}
.btn{display:inline-block;background:#e11d48;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700;margin:6px}
ul{color:var(--text)}
.themebtn{position:fixed;top:14px;right:14px;background:var(--card);border:1px solid var(--border);color:var(--text);width:38px;height:38px;border-radius:10px;cursor:pointer;font-size:16px;line-height:1;z-index:9}
</style></head>
<body>
<button class="themebtn" onclick="(function(){var r=document.documentElement,n=r.getAttribute('data-theme')==='dark'?'light':'dark';r.setAttribute('data-theme',n);try{localStorage.setItem('np-r-theme',n)}catch(e){}document.querySelector('.themebtn').textContent=n==='dark'?'☀️':'🌙'})()" title="Tema claro/escuro">☀️</button>
<script>(function(){try{var t=localStorage.getItem('np-r-theme');if(t){document.documentElement.setAttribute('data-theme',t);var b=document.querySelector('.themebtn');if(b)b.textContent=t==='dark'?'☀️':'🌙';}}catch(e){}})();</script>
<div class="wrap">
  <div class="muted" style="font-size:12px">Netmaster · Análise técnica do seu site</div>
  <h1>${escH(s.domain)}</h1>
  <p class="muted">Olá${em.contact?.name ? ' ' + escH(em.contact.name) : ''}, fizemos uma análise automática ao seu site. ${full ? 'Aqui está o relatório completo.' : 'Aqui está o resumo.'}</p>
  <div style="display:flex;gap:12px;flex-wrap:wrap">
    ${card('SEO', seo != null ? seo + '/100' : '—', seo != null ? (seo >= 90 ? 'excelente' : seo >= 50 ? 'a melhorar' : 'crítico') : 'não medido', scoreCol(seo))}
    ${card('Mobile', mob != null ? mob + '/100' : '—', mob != null ? (mob >= 90 ? 'ótimo' : 'a melhorar') : 'não medido', scoreCol(mob))}
    ${card('Segurança', s.security_findings != null ? s.security_findings + ' achados' : '—', sev || 'sem dados', sevCol)}
    ${card('SSL', s.ssl_grade || '—', s.ssl_days_left != null ? s.ssl_days_left + ' dias' : '', s.ssl_grade && /^A/.test(s.ssl_grade) ? '#22c55e' : '#f59e0b')}
    ${s.gmb_name ? card('Google Business', s.gmb_rating ? s.gmb_rating + '★' : '✓', (s.gmb_reviews || 0) + ' reviews') : ''}
  </div>
  ${s.wp_vuln_count || s.cms_outdated ? `<div class="sec"><b>⚠️ WordPress</b><p class="muted" style="margin:6px 0 0">${s.cms_outdated ? 'CMS desatualizado. ' : ''}${s.wp_vuln_count ? s.wp_vuln_count + ' potenciais vulnerabilidades detetadas.' : ''} Recomendamos uma revisão de segurança.</p></div>` : ''}
  ${fullSections}
  <div class="cta"><div style="font-size:20px;font-weight:800">${full ? 'Quer que tratemos disto por si?' : 'Quer o relatório completo + plano de melhoria?'}</div>
    <p style="color:#cbd0d8;margin:8px 0 14px">Marque uma chamada gratuita de 15 min com a Netmaster.</p>
    <a class="btn" href="mailto:${escH(sender)}?subject=${encodeURIComponent('Chamada sobre ' + (s.domain || 'o meu site'))}">Marcar chamada</a>${full ? '' : `<a class="btn" style="background:#374151" href="/r/${escH(token)}?full=1">Ver relatório completo</a>`}</div>
  <p class="muted" style="font-size:11px;text-align:center;margin-top:24px">Netmaster · análise gerada automaticamente · responder ao email remove-o da lista.</p>
</div></body></html>`;
}

app.get('/r/:token', async (req, res) => {
  try {
    const rows = await d(`/items/emails?filter[token][_eq]=${encodeURIComponent(req.params.token)}&fields=id,token,opened_at,site.domain,site.seo_score,site.mobile_score,site.perf_mobile,site.perf_desktop,site.security_findings,site.security_severity,site.ssl_grade,site.ssl_days_left,site.tech_detected,site.gmb_name,site.gmb_rating,site.gmb_reviews,site.industry,site.cms_outdated,site.wp_vuln_count,contact.name,campaign.angle,campaign.from_email&limit=1`).catch(() => []);
    const em = rows[0];
    if (!em || !em.site) return res.status(404).type('html').send('<h1 style="font-family:sans-serif;text-align:center;margin-top:60px">Relatório não encontrado</h1>');
    if (!em.opened_at) fetch(`${DIRECTUS_URL}/items/emails/${em.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ opened_at: new Date().toISOString() }) }).catch(() => {});
    void captureServerEvent(req, 'report_viewed', posthogDistinctId(req, `report:${req.params.token}`), {
      report_mode: req.query.full === '1' ? 'full' : 'summary',
      domain: em.site.domain,
      campaign_angle: em.campaign?.angle || null,
    });
    res.type('html').send(renderReport(em, req.query.full === '1'));
  } catch (e) {
    res.status(500).type('html').send('<h1>Erro a gerar o relatório</h1>');
  }
});

// Report individual (para o report-viewer human-readable). Antes do catch-all.
app.get('/api/report/:id', async (req, res) => {
  try {
    const rows = await d(`/items/site_reports?filter[id][_eq]=${encodeURIComponent(req.params.id)}&fields=id,kind,score,summary,report,site.domain,site.id&limit=1`).catch(() => []);
    const r = rows[0];
    if (!r) return res.status(404).json({ ok: false, error: 'report não encontrado' });
    res.json({ ok: true, report: r });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`NetProspect dashboard em http://localhost:${PORT} (Directus: ${DIRECTUS_URL})`));
