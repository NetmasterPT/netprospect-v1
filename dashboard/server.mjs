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
  if (on(f.ssl_ov)) F('ssl_validation', '_eq', 'OV');   // OV/EV = validação de EMPRESA (pago) — distingue Sectigo pago do cPanel DV grátis
  if (on(f.ssl_wildcard)) F('ssl_wildcard', '_eq', 'true'); // certificado wildcard (*.dominio)
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
app.use(express.json({ limit: '4mb' })); // 4mb: as métricas de host trazem stats + tail de logs por container
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

// --- Subscrições (produtos Netmaster: pacotes + preço IVA + ICPs + segmentos/clientes/campanhas/templates) ---
const SUB_FREQ = ['one_off', 'monthly', 'quarterly', 'semiannual', 'annual'];
const SUB_FIELDS = 'id,name,frequency,category,features,price_ex_vat,price_inc_vat,icps,segment_ids,client_ids,campaign_ids,email_templates,active,notes,sort,date_created';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function subClean(b) {
  const o = {};
  if (typeof b.name === 'string') o.name = b.name.slice(0, 255);
  if (SUB_FREQ.includes(b.frequency)) o.frequency = b.frequency;
  if (typeof b.category === 'string') o.category = b.category.slice(0, 120);
  for (const k of ['features', 'icps', 'segment_ids', 'client_ids', 'campaign_ids', 'email_templates', 'icp_ids', 'template_ids']) if (Array.isArray(b[k])) o[k] = b[k];
  if (typeof b.active === 'boolean') o.active = b.active;
  if (typeof b.notes === 'string') o.notes = b.notes;
  if (b.sort != null) o.sort = parseInt(b.sort, 10) || null;
  // IVA 23%: entra o preço s/IVA (ou c/IVA) e calcula-se o outro.
  if (b.price_ex_vat != null && b.price_ex_vat !== '') { o.price_ex_vat = round2(b.price_ex_vat); o.price_inc_vat = round2(o.price_ex_vat * 1.23); }
  else if (b.price_inc_vat != null && b.price_inc_vat !== '') { o.price_inc_vat = round2(b.price_inc_vat); o.price_ex_vat = round2(o.price_inc_vat / 1.23); }
  return o;
}
const CLIENTS_REF_URL = '/items/companies?filter[is_client][_eq]=true&limit=-1&fields=id,name,org_domain';
app.get('/api/subscriptions', async (req, res) => {
  try {
    const [subscriptions, segments, campaigns, clients, icps, templates] = await Promise.all([
      d(`/items/subscriptions?sort[]=sort&sort[]=-id&limit=-1&fields=${SUB_FIELDS},icp_ids,template_ids`),
      d('/items/segments?limit=-1&fields=id,name,accent').catch(() => []),
      d('/items/campaigns?limit=-1&fields=id,name,angle,status').catch(() => []),
      d(CLIENTS_REF_URL).catch(() => []),
      d('/items/icps?limit=-1&fields=id,name,description').catch(() => []),
      d('/items/email_templates?limit=-1&fields=id,name,subject').catch(() => []),
    ]);
    res.json({ subscriptions, refs: { segments, campaigns, clients, icps, templates } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/subscriptions', async (req, res) => {
  try {
    const b = subClean(req.body || {});
    if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
    const subscription = await dwrite('POST', '/items/subscriptions', b);
    res.json({ subscription });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.put('/api/subscriptions/:id', async (req, res) => {
  try { const subscription = await dwrite('PATCH', `/items/subscriptions/${encodeURIComponent(req.params.id)}`, subClean(req.body || {})); res.json({ subscription }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.delete('/api/subscriptions/:id', async (req, res) => {
  try { await dwrite('DELETE', `/items/subscriptions/${encodeURIComponent(req.params.id)}`); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
// Variáveis p/ os templates ({{name}}, {{company}}, …). Espelha lib/campaign-ai.js (a imagem do
// dashboard não tem lib/); cobre os campos comuns dos templates escritos à mão.
const PLATFORM_WORD_S = { wordpress: 'WordPress', woocommerce: 'WooCommerce', prestashop: 'PrestaShop', wix: 'Wix', shopify: 'Shopify', joomla: 'Joomla', drupal: 'Drupal' };
function subVars(c, s) {
  const co = s?.company?.name || s?.domain || 'a vossa empresa';
  const fn = (c?.name || '').trim().split(/\s+/)[0] || '';
  const slug = s?.primary_platform?.slug || '';
  return {
    name: c?.name || '', first_name: fn, greeting: fn ? `Olá ${fn}` : 'Olá', company: co, domain: s?.domain || '',
    city: s?.business_city || '', industry: s?.industry || '', seo_score: s?.seo_score ?? '', ssl_days_left: s?.ssl_days_left ?? '',
    cms_version: s?.cms_version || '', platform: slug, platform_word: PLATFORM_WORD_S[slug] || slug || '', dns_provider: s?.dns_provider || '',
  };
}
const subRender = (tpl, vars) => String(tpl || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => { const v = vars[k.toLowerCase()]; return v == null ? '' : String(v); });
// Cria uma campanha a partir de um pacote: usa os filtros de um segmento do pacote como audiência.
// { segmentId, templateIndex?, name?, from_name?, from_email?, reply_to?, angle? }. Com template →
// preenche os e-mails com o template (variáveis substituídas, status=ready). Sem → draft p/ gerar por IA.
app.post('/api/subscriptions/:id/campaign', async (req, res) => {
  try {
    const b = req.body || {};
    const subs = await d(`/items/subscriptions?filter[id][_eq]=${encodeURIComponent(req.params.id)}&limit=1&fields=${SUB_FIELDS}`);
    const sub = subs[0]; if (!sub) return res.status(404).json({ error: 'pacote não encontrado' });
    if (!b.segmentId) return res.status(400).json({ error: 'segmentId obrigatório' });
    const segRows = await d(`/items/segments?filter[id][_eq]=${encodeURIComponent(b.segmentId)}&limit=1&fields=id,name,filters`);
    const seg = segRows[0]; if (!seg) return res.status(404).json({ error: 'segmento não encontrado' });
    // Template: da colecção (templateId) ou, retro-compat, do array inline (templateIndex).
    let tpl = null;
    if (b.templateId) tpl = (await d(`/items/email_templates?filter[id][_eq]=${encodeURIComponent(b.templateId)}&limit=1&fields=id,name,subject,body`))[0] || null;
    else if (b.templateIndex != null && Array.isArray(sub.email_templates)) tpl = sub.email_templates[b.templateIndex];
    const campRow = {
      name: String(b.name || `${sub.name} — ${seg.name}`).slice(0, 255), angle: b.angle || 'general', status: 'draft',
      audience_filters: seg.filters || {}, segment: seg.id, from_name: (b.from_name || '').slice(0, 255),
      from_email: (b.from_email || '').slice(0, 255), reply_to: (b.reply_to || '').slice(0, 255),
      subject_hint: (tpl?.subject || '').slice(0, 255), total: 0, generated: 0, sent: 0, opened: 0, clicked: 0,
    };
    const camp = await dwrite('POST', '/items/campaigns', campRow);
    let filled = 0;
    if (tpl) {
      const parts = contactAudienceParts(seg.filters || {});
      const contacts = await d(`/items/contacts?${parts}&fields=id,name,email,site.id,site.domain,site.business_city,site.industry,site.seo_score,site.ssl_days_left,site.cms_version,site.dns_provider,site.primary_platform.slug,site.company.name&limit=5000`);
      const seen = new Set(); const toCreate = [];
      for (const c of contacts) {
        const em = (c.email || '').toLowerCase(); if (!em || seen.has(em)) continue; seen.add(em);
        const vars = subVars(c, c.site || {});
        toCreate.push({ campaign: camp.id, contact: c.id, site: c.site?.id || null, to_email: em, to_name: (c.name || '').slice(0, 255), subject: subRender(tpl.subject, vars).slice(0, 255), body: subRender(tpl.body, vars), ai_generated: false, status: 'ready', token: newToken() });
      }
      for (let i = 0; i < toCreate.length; i += 100) await dwrite('POST', '/items/emails', toCreate.slice(i, i + 100));
      filled = toCreate.length;
      await dwrite('PATCH', `/items/campaigns/${camp.id}`, { status: filled ? 'ready' : 'draft', total: filled, generated: filled });
    }
    res.json({ ok: true, campaignId: camp.id, mode: tpl ? 'template' : 'ai', filled });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- ICPs (públicos-alvo) + Email Templates: CRUD genérico (relações por arrays de ids) ----------
function idArrayCrud(basePath, collection, fields, allow, refsSpec) {
  const clean = (b) => {
    const o = {};
    for (const [k, kind] of Object.entries(allow)) {
      if (kind === 'str' && typeof b[k] === 'string') o[k] = b[k].slice(0, 500);
      else if (kind === 'text' && typeof b[k] === 'string') o[k] = b[k];
      else if (kind === 'arr' && Array.isArray(b[k])) o[k] = b[k];
      else if (kind === 'bool' && typeof b[k] === 'boolean') o[k] = b[k];
      else if (kind === 'int' && b[k] != null) o[k] = parseInt(b[k], 10) || null;
    }
    return o;
  };
  app.get(basePath, async (req, res) => {
    try {
      const items = await d(`/items/${collection}?sort[]=sort&sort[]=-id&limit=-1&fields=${fields}`);
      const refs = {};
      await Promise.all(Object.entries(refsSpec).map(async ([k, url]) => { refs[k] = await d(url).catch(() => []); }));
      res.json({ items, refs });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post(basePath, async (req, res) => {
    try { const b = clean(req.body || {}); if (!b.name) return res.status(400).json({ error: 'name obrigatório' }); res.json({ item: await dwrite('POST', `/items/${collection}`, b) }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.put(`${basePath}/:id`, async (req, res) => {
    try { res.json({ item: await dwrite('PATCH', `/items/${collection}/${encodeURIComponent(req.params.id)}`, clean(req.body || {})) }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.delete(`${basePath}/:id`, async (req, res) => {
    try { await dwrite('DELETE', `/items/${collection}/${encodeURIComponent(req.params.id)}`); res.json({ ok: true }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
}
const REF_SEGMENTS = '/items/segments?limit=-1&fields=id,name';
const REF_CAMPAIGNS = '/items/campaigns?limit=-1&fields=id,name,angle';
idArrayCrud('/api/icps', 'icps',
  'id,name,description,tags,category,language,template_ids,client_ids,campaign_ids,segment_ids,active,notes,sort,date_created',
  { name: 'str', description: 'text', category: 'str', language: 'str', tags: 'arr', template_ids: 'arr', client_ids: 'arr', campaign_ids: 'arr', segment_ids: 'arr', active: 'bool', notes: 'text', sort: 'int' },
  { segments: REF_SEGMENTS, campaigns: REF_CAMPAIGNS, clients: CLIENTS_REF_URL, templates: '/items/email_templates?limit=-1&fields=id,name,subject' });
idArrayCrud('/api/email-templates', 'email_templates',
  'id,name,subject,body,variables,tags,category,business_type,language,icp_ids,segment_ids,client_ids,campaign_ids,contact_ids,active,notes,sort,date_created',
  { name: 'str', subject: 'str', body: 'text', category: 'str', business_type: 'str', language: 'str', variables: 'arr', tags: 'arr', icp_ids: 'arr', segment_ids: 'arr', client_ids: 'arr', campaign_ids: 'arr', contact_ids: 'arr', active: 'bool', notes: 'text', sort: 'int' },
  { segments: REF_SEGMENTS, campaigns: REF_CAMPAIGNS, clients: CLIENTS_REF_URL, icps: '/items/icps?limit=-1&fields=id,name,description' });

// Pesquisa de contactos (popup do template): por nome/email/empresa. Só com email.
app.get('/api/contacts-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 40);
    let filter = 'filter[email][_nnull]=true';
    if (q) { const s = encodeURIComponent(q); filter += `&filter[_and][0][_or][0][name][_icontains]=${s}&filter[_and][0][_or][1][email][_icontains]=${s}&filter[_and][0][_or][2][company][name][_icontains]=${s}`; }
    const contacts = await d(`/items/contacts?${filter}&fields=id,name,email,role,role_category,company.name,site.domain&sort=name&limit=${limit}`);
    res.json({ contacts });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Resolve ids de contactos → detalhes (para mostrar os contactos já associados a um template).
app.get('/api/contacts-by-ids', async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean);
    if (!ids.length) return res.json({ contacts: [] });
    const contacts = await d(`/items/contacts?filter[id][_in]=${ids.join(',')}&fields=id,name,email,role,company.name,site.domain&limit=${ids.length}`);
    res.json({ contacts });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Adicionar/remover contactos de um template (popup + vista de empresa). {add:[ids], remove:[ids]}
app.post('/api/email-templates/:id/contacts', async (req, res) => {
  try {
    const id = req.params.id;
    const rows = await d(`/items/email_templates?filter[id][_eq]=${encodeURIComponent(id)}&fields=contact_ids&limit=1`);
    if (!rows[0]) return res.status(404).json({ error: 'template não encontrado' });
    const cur = new Set((rows[0].contact_ids || []).map(Number));
    (req.body?.add || []).map(Number).forEach((x) => cur.add(x));
    (req.body?.remove || []).map(Number).forEach((x) => cur.delete(x));
    const item = await dwrite('PATCH', `/items/email_templates/${encodeURIComponent(id)}`, { contact_ids: [...cur] });
    res.json({ ok: true, count: cur.size, item });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Templates disponíveis (para a vista de empresa: "adicionar contactos a um template").
app.get('/api/email-templates-list', async (req, res) => {
  try { res.json({ templates: await d('/items/email_templates?limit=-1&fields=id,name&sort=name') }); }
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
    const rows = await d('/items/campaigns?sort[]=-id&limit=-1&fields=id,name,status,angle,phase,from_name,from_email,total,created_at,sent_at');
    await Promise.all(rows.map(async (c) => { try { c.counts = await campaignCounts(c.id); } catch { c.counts = null; } }));
    res.json({ campaigns: rows, mailer: { mode: process.env.SMTP_HOST ? 'smtp' : 'dry' } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/campaigns', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'nome em falta' });
    const row = {
      name: String(b.name).slice(0, 255), angle: b.angle || 'general', phase: ['cold', 'semi_warm', 'warm'].includes(b.phase) ? b.phase : 'cold', status: 'draft',
      audience_filters: b.filters || {}, segment: b.segmentId || null,
      from_name: (b.from_name || '').slice(0, 255), from_email: (b.from_email || '').slice(0, 255),
      reply_to: (b.reply_to || '').slice(0, 255), subject_hint: (b.subject_hint || '').slice(0, 255),
      notes: (b.notes || '').slice(0, 8000), total: 0, generated: 0, sent: 0, opened: 0, clicked: 0,
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
// PATCH — mudar a fase (escada de temperatura) de uma campanha. Aceita só campos seguros.
app.patch('/api/campaigns/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.phase !== undefined) { if (!['cold', 'semi_warm', 'warm'].includes(b.phase)) return res.status(400).json({ error: 'fase inválida' }); patch.phase = b.phase; }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nada a atualizar' });
    const updated = await dwrite('PATCH', `/items/campaigns/${encodeURIComponent(req.params.id)}`, patch);
    res.json({ ok: true, campaign: updated });
  } catch (e) { res.status(502).json({ error: e.message }); }
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
  const FINE = { wpscan: 'jobs.wpscan', nuclei: 'jobs.nuclei', lighthouse: 'jobs.lighthouse.mobile', gmb: 'jobs.gmb', industry: 'jobs.industry', ssl: 'jobs.ssl', ssllabs: 'jobs.ssllabs', whois: 'jobs.whois', dnsprovider: 'jobs.dnsprovider' };
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

// --- Verify: enqueue diário (chamado por cron no np-server) -------------------
// Enfileira jobs.verify (1 por domínio) pelos MELHORES leads primeiro (lead_score desc), até percorrer
// ~maxEmails contactos por-verificar. Re-enfileira automaticamente os PENDENTES do dia anterior (são os
// contactos que continuam email_status NULL; idempotente por msgId=verify:<dom>). A quota REAL é imposta
// pela frota (contador+lock por-chave no Redis, lib/verify-providers.js) — isto só ALIMENTA a fila.
app.post('/api/verify/enqueue', async (req, res) => {
  if (FLEET_PULL_TOKEN) {
    const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.token || '';
    if (tok !== FLEET_PULL_TOKEN) return res.status(401).json({ error: 'não autorizado' });
  }
  const maxEmails = Math.max(1, Math.min(5000, parseInt(req.query.maxEmails ?? req.body?.maxEmails, 10) || 100));
  try {
    const p = await pgPool();
    if (!p) return res.status(503).json({ ok: false, error: 'PG desligado (falta PG_HOST/creds)' });
    // Re-verificação inteligente (reacher-coordinated-plan): seleciona por verificar OU com TTL expirado
    // (reverify_after<now — os permanentes têm NULL → excluídos); exclui domínios que bloqueiam o probing; e
    // DESPRIORITIZA os mega-domínios B2C (>20 contactos elegíveis: jouwweb/ISPs) para as empresas reais irem 1º.
    const rows = (await p.query(
      `SELECT co.org_domain AS domain
         FROM contacts ct JOIN companies co ON co.id = ct.company JOIN sites s ON s.id = ct.site
        WHERE (ct.email_status IS NULL OR ct.reverify_after < now())
          AND co.org_domain IS NOT NULL AND s.qualified AND s.is_live
          AND coalesce(co.blocks_probing, false) = false
        GROUP BY co.org_domain
        ORDER BY (count(*) > 20) ASC, max(s.lead_score) DESC NULLS LAST
        LIMIT $1`, [maxEmails])).rows;
    const seen = new Set(); let jobs = 0;
    for (const r of rows) { const dom = r.domain; if (!dom || seen.has(dom)) continue; seen.add(dom); await natsPublish('jobs.verify', { domain: dom }, `verify:${dom}`); jobs++; }
    await recordCron('verify-enqueue-cron', { status: 'ok', summary: `enfileirados ${jobs} domínios (maxEmails ${maxEmails})` });
    res.json({ ok: true, scanned: rows.length, domains: jobs, maxEmails });
  } catch (e) { await recordCron('verify-enqueue-cron', { status: 'erro', summary: e.message }); res.status(500).json({ ok: false, error: e.message }); }
});

// --- Crons: registo de execuções + observabilidade (Frota › Crons) -----------
// Os crons do np-server são contentores busybox que fazem `curl` a endpoints daqui; ao servir o endpoint
// gravamos um heartbeat em Redis (np:cron:<name>) → última execução + resultado. Os timers systemd dos
// hosts-worker (pull/metrics) vêm da telemetria do agente (kind=timer em np:host:<h>:containers).
async function recordCron(name, { host = 'np-server', status = 'ok', summary = '', durationMs = null } = {}) {
  try {
    const rr = await redisClient(); if (!rr || !_redisUp) return;
    const ts = new Date().toISOString();
    const rec = { name, host, status, summary: String(summary).slice(0, 500), durationMs: durationMs == null ? '' : String(durationMs), ts };
    await rr.hSet(`np:cron:${name}`, rec);
    await rr.expire(`np:cron:${name}`, 40 * 24 * 3600);
    await rr.lPush(`np:cron:${name}:runs`, JSON.stringify({ ts, status, summary: rec.summary, durationMs: rec.durationMs }));
    await rr.lTrim(`np:cron:${name}:runs`, 0, 29);
    await rr.expire(`np:cron:${name}:runs`, 40 * 24 * 3600);
  } catch { /* fail-soft: o heartbeat é um bónus, não bloqueia o cron */ }
}

// Registo ESTÁTICO dos crons conhecidos (schedule/descrição não vêm da telemetria dos contentores Docker).
const CRON_REGISTRY = [
  { name: 'verify-enqueue-cron', host: 'np-server', kind: 'docker', schedule: '06:00 UTC · diário', endpoint: '/api/verify/enqueue', desc: 'Enfileira o verify de email pelos melhores leads (após o reset da quota free à meia-noite UTC).' },
  { name: 'moloni-sync-cron', host: 'np-server', kind: 'docker', schedule: '05:00 UTC · diário', endpoint: '/api/moloni/sync', desc: 'Sincroniza a Contabilidade (Moloni → Directus): empresas/produtos/documentos.' },
  { name: 'gmb-enqueue-cron', host: 'np-server', kind: 'docker', schedule: 'de 3/3h', endpoint: '/api/gmb/enqueue', desc: 'Top-up da fila GMB pelos melhores leads — só repõe se a fila estiver baixa (evita a expiração de 48h do stream).' },
];

// Timers de manutenção do SO (ruído) — a página Crons foca nas tarefas NetProspect + monitorização.
const OS_TIMER_NOISE = /^(apt-daily|apt-daily-upgrade|dpkg-db-backup|e2scrub_all|xfs_scrub_all|fstrim|man-db|logrotate|systemd-tmpfiles-clean|pve-daily-update|zpool-textfile|systemd-tmpfiles|update-notifier|motd-news|plocate|mlocate|snapd|ua-timer|ubuntu-advantage|phpsessionclean)\b/i;

// Enumera os hosts da frota (agente ativo <15min) + os seus containers/timers (np:host:<h>:containers).
async function fleetHosts(rr) {
  const out = {};
  if (!rr || !_redisUp) return out;
  const names = await rr.zRangeByScore('np:host:index', Date.now() - 900000, '+inf').catch(() => []);
  for (const hn of names) {
    let containers = null; try { const cs = await rr.get(`np:host:${hn}:containers`); containers = cs ? JSON.parse(cs) : null; } catch { containers = null; }
    out[hn] = { containers };
  }
  return out;
}

// Top-up da fila GMB: enfileira os melhores leads que precisam de GMB, MAS só se a fila estiver baixa (o stream
// NP_JOBS expira jobs a 48h → despejar 100k desperdiça; mantém-se só o que drena). Idempotente por msgId
// gmb:<domain> (dedup 24h). Chamado pelo gmb-enqueue-cron; protegido por FLEET_PULL_TOKEN se definido.
app.post('/api/gmb/enqueue', async (req, res) => {
  if (FLEET_PULL_TOKEN) { const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.token || ''; if (tok !== FLEET_PULL_TOKEN) return res.status(401).json({ error: 'não autorizado' }); }
  const t0 = Date.now();
  const limit = Math.max(1, Math.min(60000, parseInt(req.query.limit ?? req.body?.limit, 10) || 30000));
  const ms = parseInt(req.query.minScore ?? req.body?.minScore, 10); const MIN = Number.isFinite(ms) ? ms : 30;
  const maxPending = Math.max(0, parseInt(req.query.maxPending ?? req.body?.maxPending, 10) || 15000);
  try {
    const p = await pgPool(); if (!p) return res.status(503).json({ ok: false, error: 'PG desligado (falta PG_HOST/creds)' });
    // guarda de top-up: se a fila já tem trabalho que chegue, NÃO repõe (evita expiração a 48h).
    let pending = 0; try { const jsm = await natsManager(); pending = (await jsm.consumers.info('NP_JOBS', 'gmb')).num_pending || 0; } catch { /* fila indisponível → segue e tenta enfileirar */ }
    if (pending >= maxPending) { await recordCron('gmb-enqueue-cron', { status: 'skip', summary: `fila alta (${pending} ≥ ${maxPending}) — sem top-up`, durationMs: Date.now() - t0 }); return res.json({ ok: true, skipped: true, pending }); }
    const rows = (await p.query(`SELECT id, domain FROM sites WHERE qualified AND is_live AND gmb_checked_at IS NULL AND lead_score >= $1 ORDER BY lead_score DESC, id LIMIT $2`, [MIN, limit])).rows;
    let n = 0; for (const r of rows) { if (!r.domain) continue; await natsPublish('jobs.gmb', { siteId: r.id, domain: r.domain }, `gmb:${r.domain}`); n++; }
    await recordCron('gmb-enqueue-cron', { status: 'ok', summary: `enfileirados ${n} (fila estava ${pending}, min-score ${MIN})`, durationMs: Date.now() - t0 });
    res.json({ ok: true, enqueued: n, pending_before: pending, minScore: MIN });
  } catch (e) { await recordCron('gmb-enqueue-cron', { status: 'erro', summary: e.message, durationMs: Date.now() - t0 }); res.status(500).json({ ok: false, error: e.message }); }
});

// Agrega os crons de TODA a frota: registo estático (schedule/desc) + heartbeats (np:cron:*) + unidades
// kind=timer / *-cron da telemetria do agente. Agrupado por host para a página Frota › Crons.
app.get('/api/crons', async (req, res) => {
  try {
    const rr = await redisClient();
    const crons = [];
    for (const c of CRON_REGISTRY) {
      let last = null, runs = [];
      if (rr && _redisUp) { try { const h = await rr.hGetAll(`np:cron:${c.name}`); if (h && Object.keys(h).length) last = h; runs = (await rr.lRange(`np:cron:${c.name}:runs`, 0, 29)).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean); } catch { /* */ } }
      crons.push({ ...c, source: 'registry', last, runs });
    }
    try {
      const hosts = await fleetHosts(rr);
      for (const [host, H] of Object.entries(hosts)) {
        for (const u of (H.containers || [])) {
          const isTimer = u.kind === 'timer';
          const isDockerCron = (!u.kind || u.kind === 'container') && /(-cron\b|cron-|\bcron\b)/i.test(u.name || '');
          if (!isTimer && !isDockerCron) continue;
          // Filtra os timers de MANUTENÇÃO do SO (ruído: não são tarefas nossas) — mantém NetProspect + monitorização.
          if (isTimer && OS_TIMER_NOISE.test(u.name || '')) continue;
          const up = /up|active|running|waiting/i.test(u.state || u.status || '');
          const unit = { host, name: u.name, state: u.state || '', status: u.status || '', up, logb64: u.logb64 || '' };
          // Funde com o cron do registo: o agente reporta o contentor prefixado pelo compose
          // (server-verify-enqueue-cron-1) → casa por substring com o nome do registo (verify-enqueue-cron).
          const reg = crons.find((x) => x.source === 'registry' && (x.name === u.name || String(u.name || '').includes(x.name)));
          if (reg) { reg.unit = unit; continue; }
          crons.push({ name: u.name, host, kind: isTimer ? 'timer' : 'docker', schedule: isTimer ? (u.status || '') : '', desc: isTimer ? (u.image || '') : (u.status || ''), source: 'agent', last: null, runs: [], unit });
        }
      }
    } catch { /* telemetria indisponível → mostra só o registo estático */ }
    res.json({ ok: true, crons });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Workers / fila (observabilidade NATS JetStream) — B2 --------------------
// Espelho compacto de lib/jobs.js CONSUMERS (durable -> role); o dashboard não
// importa lib/. Manter em sincronia se se acrescentarem consumers.
const CONSUMER_ROLES = {
  enrich: 'base', contacts: 'base', verify: 'verify', discover: 'base', dns: 'base', geoip: 'base',
  fetch: 'base', fingerprint: 'base', social: 'base', locality: 'base', emailauth: 'base', traffic: 'base',
  score: 'base', subdomains: 'base', ssl: 'base', whois: 'base', dnsprovider: 'base',
  campaign_generate: 'ai', campaign_send: 'base',
  audit_ondemand: 'browser', audit_qualified: 'browser', audit_rest: 'browser',
  industry: 'base', lighthouse_desktop: 'browser', lighthouse_mobile: 'browser', gmb: 'residential',
  nuclei: 'security', wpscan: 'security', ssllabs: 'base', fetch_residential: 'residential',
};
// Calcula, por tipo de job (consumer), a DURAÇÃO MÉDIA e a CAPACIDADE (usada/total/disponível) em
// 3 janelas (1h/24h/30d). Fonte: contadores por-tipo no Redis (np:job:<c>:done:<h> horário 26h,
// :dday:<d> diário 32d, :dur durações). slots = paralelização efetiva da frota = min(Σ conc dos
// workers vivos, maxAckPending). total = slots × (período / duração-média); disponível = total − usada.
async function addQueueCapacity(rr, consumers) {
  // 1) slots por consumer = soma da concorrência reportada pelos workers vivos (heartbeat <90s).
  const conc = {};
  try {
    const ids = await rr.zRangeByScore('np:wk:index', Date.now() - 90000, '+inf').catch(() => []);
    for (const id of ids) {
      const h = await rr.hGetAll(`np:wk:${id}`).catch(() => ({}));
      let cj = {}; try { cj = JSON.parse(h.conc || '{}'); } catch { /* */ }
      for (const k in cj) conc[k] = (conc[k] || 0) + (+cj[k] || 0);
    }
  } catch { /* */ }
  const now = Date.now();
  const curH = Math.floor(now / 3600000), curD = Math.floor(now / 86400000);
  const frac = (now % 3600000) / 3600000; // fração decorrida da hora atual (p/ trailing-60min)
  // 2) chaves a ler em lote: 25 horas (curH..curH-24) + 30 dias por consumer.
  const keys = [];
  for (const c of consumers) {
    for (let i = 0; i <= 24; i++) keys.push(`np:job:${c.name}:done:${curH - i}`);
    for (let i = 0; i < 30; i++) keys.push(`np:job:${c.name}:dday:${curD - i}`);
  }
  let vals = [];
  try { vals = keys.length ? await rr.mGet(keys) : []; } catch { vals = []; }
  const map = {}; keys.forEach((k, i) => { map[k] = +vals[i] || 0; });
  for (const c of consumers) {
    // duração média (rolling) das últimas N conclusões deste tipo
    let durs = []; try { durs = (await rr.lRange(`np:job:${c.name}:dur`, 0, 199)).map(Number).filter((x) => x >= 0); } catch { /* */ }
    const avgMs = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
    c.avgMs = avgMs;
    // usada por janela (concluídos)
    const usedH = map[`np:job:${c.name}:done:${curH}`] + map[`np:job:${c.name}:done:${curH - 1}`] * (1 - frac); // trailing 60min
    let used24 = 0; for (let i = 0; i < 24; i++) used24 += map[`np:job:${c.name}:done:${curH - i}`];
    let used30 = 0; for (let i = 0; i < 30; i++) used30 += map[`np:job:${c.name}:dday:${curD - i}`];
    // slots efetivos: Σ conc da frota, limitado pelo teto maxAckPending (quando existir)
    const cap = c.maxAckPending || 0;
    const slots = cap > 0 ? Math.min(conc[c.name] || 0, cap) : (conc[c.name] || 0);
    c.slots = slots;
    // total teórico por janela = slots × (segundos da janela / duração-média-segundos)
    const perH = avgMs > 0 ? slots * 3600000 / avgMs : null;
    const mk = (used, total) => ({ used: Math.round(used), total: total != null ? Math.round(total) : null, avail: total != null ? Math.max(0, Math.round(total - used)) : null });
    c.cap1h = mk(usedH, perH);
    c.cap24h = mk(used24, perH != null ? perH * 24 : null);
    c.cap30d = mk(used30, perH != null ? perH * 720 : null);
  }
}
// Capacidade (usada/total/livre em 1h/24h/30d) POR HOST (FLEET_HOST) — análogo a addQueueCapacity mas
// somando TODOS os tipos de job do host (contadores np:host:<host>:done/dday/dur, escritos no taskEnd).
// slots = Σ conc de todos os workers vivos do host (paralelismo total da VM); avgMs = duração média
// blended (mistura de tipos) → total = slots × janela/avgMs. Junta ainda o snapshot de telemetria do
// agente de pull (np:host:<host>:metrics, HASH com TTL → ausência = "sem dados"). Muta `hosts` in-place.
async function hostCapacity(rr, hosts) {
  const names = Object.keys(hosts);
  if (!names.length) return;
  const now = Date.now();
  const curH = Math.floor(now / 3600000), curD = Math.floor(now / 86400000);
  const frac = (now % 3600000) / 3600000;
  const keys = [];
  for (const hn of names) {
    for (let i = 0; i <= 24; i++) keys.push(`np:host:${hn}:done:${curH - i}`);
    for (let i = 0; i < 30; i++) keys.push(`np:host:${hn}:dday:${curD - i}`);
  }
  let vals = []; try { vals = keys.length ? await rr.mGet(keys) : []; } catch { vals = []; }
  const map = {}; keys.forEach((k, i) => { map[k] = +vals[i] || 0; });
  for (const hn of names) {
    const H = hosts[hn];
    let durs = []; try { durs = (await rr.lRange(`np:host:${hn}:dur`, 0, 199)).map(Number).filter((x) => x >= 0); } catch { /* */ }
    const avgMs = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
    H.avgMs = avgMs;
    const usedH = map[`np:host:${hn}:done:${curH}`] + map[`np:host:${hn}:done:${curH - 1}`] * (1 - frac); // trailing 60min
    let used24 = 0; for (let i = 0; i < 24; i++) used24 += map[`np:host:${hn}:done:${curH - i}`];
    let used30 = 0; for (let i = 0; i < 30; i++) used30 += map[`np:host:${hn}:dday:${curD - i}`];
    const slots = H.slots || 0;
    const perH = avgMs > 0 ? slots * 3600000 / avgMs : null;
    const mk = (used, total) => ({ used: Math.round(used), total: total != null ? Math.round(total) : null, avail: total != null ? Math.max(0, Math.round(total - used)) : null });
    H.cap1h = mk(usedH, perH);
    H.cap24h = mk(used24, perH != null ? perH * 24 : null);
    H.cap30d = mk(used30, perH != null ? perH * 720 : null);
    try { const m = await rr.hGetAll(`np:host:${hn}:metrics`); H.metrics = (m && Object.keys(m).length) ? m : null; } catch { H.metrics = null; }
    try { const cs = await rr.get(`np:host:${hn}:containers`); H.containers = cs ? JSON.parse(cs) : null; } catch { H.containers = null; }
    try { const lm = await rr.get(`np:host:${hn}:latmatrix`); H.latmatrix = lm ? JSON.parse(lm) : null; } catch { H.latmatrix = null; }
    // Hosts de infra (sem workers) não têm load/cores dos heartbeats → tira-os das métricas.
    if (H.metrics) { if (H.cores == null && H.metrics.cores) H.cores = +H.metrics.cores; if (H.load == null && H.metrics.load) H.load = +H.metrics.load; }
  }
}
// /api/queues — estado da stream + profundidade por consumer (a antiga /api/workers).
app.get('/api/queues', async (req, res) => {
  try {
    const jsm = await natsManager();
    const stream = await jsm.streams.info('NP_JOBS', { subjects_filter: '>' });
    const subjMsgs = stream.state?.subjects || {}; // { 'jobs.x': nMsgs } — p/ contar órfãos
    const consumers = [];
    for await (const ci of jsm.consumers.list('NP_JOBS')) {
      const name = ci.name;
      const subject = ci.config?.filter_subject || '';
      const pending = ci.num_pending || 0, ackPending = ci.num_ack_pending || 0;
      // Órfãos = mensagens no stream para este subject que NÃO estão pendentes nem in-flight
      // (esgotaram maxDeliver → presas no workqueue até MaxAge). Invisíveis nas colunas normais.
      const orphans = Math.max(0, (subjMsgs[subject] || 0) - pending - ackPending);
      consumers.push({
        name, role: CONSUMER_ROLES[name] || '?', subject, maxAckPending: ci.config?.max_ack_pending || 0,
        pending, ackPending, orphans, redelivered: ci.num_redelivered || 0, waiting: ci.num_waiting || 0, delivered: ci.delivered?.consumer_seq || 0, acked: ci.ack_floor?.consumer_seq || 0,
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
          // --- Capacidade por tipo de job (duração média + usada/total/disponível em 1h/24h/30d) ---
          await addQueueCapacity(rr, consumers);
        }
      } catch { /* rate/capacidade opcionais */ }
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
// Limpar / relançar ÓRFÃOS de uma fila (mensagens presas que esgotaram maxDeliver).
// body { mode: 'clean' | 'requeue' }. SÓ é seguro quando a fila NÃO tem pendentes legítimos
// (pending==0) — o purge do NATS é por subject inteiro, logo com pendentes perderíamos trabalho.
// requeue: lê os payloads órfãos (via next_by_subj), purga, e re-publica (sem msgId → aceite).
app.post('/api/queues/:consumer/orphans', async (req, res) => {
  try {
    const mode = (req.body?.mode === 'requeue') ? 'requeue' : 'clean';
    const jsm = await natsManager();
    let ci; try { ci = await jsm.consumers.info('NP_JOBS', req.params.consumer); } catch { return res.status(404).json({ error: 'consumer desconhecido' }); }
    const subj = ci.config?.filter_subject;
    const pending = ci.num_pending || 0, inflight = ci.num_ack_pending || 0;
    const st0 = (await jsm.streams.info('NP_JOBS', { subjects_filter: '>' })).state;
    const orphans = Math.max(0, ((st0.subjects || {})[subj] || 0) - pending - inflight);
    if (orphans <= 0) return res.json({ ok: true, orphans: 0, purged: 0, requeued: 0, message: 'sem órfãos' });
    // Guarda: não purgar por subject enquanto houver pendentes legítimos (ex.: backfill fetch).
    if (pending > 0) return res.status(409).json({ error: `fila tem ${pending} pendentes legítimos — a purga por subject não é seletiva. Espera a fila esvaziar (ou o MaxAge de 48h expira os órfãos sozinho).`, orphans, pending });
    // Lê os payloads (todos os do subject = órfãos, já que pending==0).
    let payloads = [];
    if (mode === 'requeue') {
      let seq = st0.first_seq;
      for (;;) {
        let m; try { m = await jsm.streams.getMessage('NP_JOBS', { seq, next_by_subj: subj }); } catch { break; }
        if (!m) break;
        payloads.push(m.data); seq = m.seq + 1;
      }
    }
    const pr = await jsm.streams.purge('NP_JOBS', { filter: subj });
    let requeued = 0;
    if (mode === 'requeue' && payloads.length) {
      const { js } = await natsJs();
      for (const data of payloads) { await js.publish(subj, data); requeued++; }
    }
    res.json({ ok: true, mode, orphans, purged: pr.purged, requeued });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Workers A CORRER (telemetria via Redis) — B2 revisão -------------------
async function workerCounts(r, id) {
  const now = Date.now();
  const h = Math.floor(now / 3600000);
  const frac = (now % 3600000) / 3600000; // fração da hora epoch atual já decorrida
  const dk = [], fk = [];
  for (let i = 0; i < 24; i++) { dk.push(`np:wk:${id}:done:${h - i}`); fk.push(`np:wk:${id}:fail:${h - i}`); }
  const [dv, fv] = await Promise.all([r.mGet(dk), r.mGet(fk)]);
  const d = dv.map((x) => +x || 0), f = fv.map((x) => +x || 0);
  // done1h = 60min TRAILING (hora atual + cauda da anterior), NÃO só o bucket epoch parcial: com d[0]
  // sozinho, no início de cada hora epoch subcontava (ex.: 84 vs ~1500 reais) → o autoscaler via hosts
  // "parados" que estão a full. Mesma fórmula do cap por-host (usedH).
  const trail = (arr) => Math.round(arr[0] + arr[1] * (1 - frac));
  return { done1h: trail(d), fail1h: trail(f), done24h: d.reduce((a, b) => a + b, 0), fail24h: f.reduce((a, b) => a + b, 0) };
}
app.get('/api/workers', async (req, res) => {
  try {
    const r = await redisClient();
    if (!r || !_redisUp) return res.json({ workers: [], telemetry: false });
    const ids = await r.zRangeByScore('np:wk:index', Date.now() - 90000, '+inf').catch(() => []); // heartbeat <90s
    const workers = [];
    const hosts = {}; // agregação por FLEET_HOST (VM) → capacidade + métricas de host
    const pj = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
    for (const id of ids) {
      const h = await r.hGetAll(`np:wk:${id}`).catch(() => ({}));
      if (!h.id) continue;
      const durs = (await r.lRange(`np:wk:${id}:dur`, 0, -1).catch(() => [])).map(Number).filter(Number.isFinite);
      const logs3 = await r.lRange(`np:wk:${id}:log`, 0, 2).catch(() => []); // últimas 3 (mais recente à cabeça)
      const conc = pj(h.conc);
      const w = { id, role: h.role || '?', host: h.host || '', consumers: (h.consumers || '').split(',').filter(Boolean),
        started: +h.started || null, beat: +h.beat || null, cur: h.cur || null, curStarted: +h.cur_started || null,
        load: h.load != null && h.load !== 'null' ? +h.load : null, cores: +h.cores || null,
        version: h.version || null, replicas: +h.replicas || null, conc, maxacks: pj(h.maxacks), logs3,
        avgMs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null, ...(await workerCounts(r, id)) };
      workers.push(w);
      const hn = w.host;
      if (hn) {
        if (!hosts[hn]) hosts[hn] = { host: hn, slots: 0, workers: [], cores: null, load: null };
        let s = 0; if (conc) for (const k in conc) s += (+conc[k] || 0);
        hosts[hn].slots += s;
        hosts[hn].workers.push(id);
        if (w.cores) hosts[hn].cores = w.cores;
        if (w.load != null) hosts[hn].load = w.load;
      }
    }
    // Hosts que reportam MÉTRICAS mas não têm workers (infra: np-server/np-db/de-minio/de-analytics).
    try {
      const mh = await r.zRangeByScore('np:host:index', Date.now() - 900000, '+inf').catch(() => []); // ativos <15min
      for (const hn of mh) if (!hosts[hn]) hosts[hn] = { host: hn, slots: 0, workers: [], cores: null, load: null, infra: true };
    } catch { /* */ }
    await hostCapacity(r, hosts); // preenche cap1h/24h/30d + métricas + containers por host
    workers.sort((a, b) => (b.beat || 0) - (a.beat || 0));
    res.json({ workers, hosts, telemetry: true });
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
    let conc = null; try { conc = h.conc ? JSON.parse(h.conc) : null; } catch { /* */ }
    // Stats do container deste worker (docker stats/logs, reportados pelo agente do host). O id do worker
    // (HOSTNAME) = id do container do docker ps → cruza-se por id.
    let container = null;
    try {
      const cs = h.host ? JSON.parse((await r.get(`np:host:${h.host}:containers`)) || '[]') : [];
      container = cs.find((c) => c.id && (c.id === req.params.id || req.params.id.startsWith(c.id) || c.id.startsWith(req.params.id))) || null;
    } catch { /* */ }
    res.json({ id: h.id, role: h.role || '?', host: h.host || '', pid: h.pid || '', consumers: (h.consumers || '').split(',').filter(Boolean),
      started: +h.started || null, beat: +h.beat || null, cur: h.cur || null, curStarted: +h.cur_started || null, conc, container,
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
    // Estado REAL do verify na frota: os ficheiros verify-*.json vivem nos hosts dos workers (ex.: hel1-docker),
    // não aqui no np-server → em vez do ficheiro local (que aparece "ausente"), deriva de sinais que o
    // control-plane conhece: nº de workers 'verify' vivos + total de emails já verificados (aceites).
    const verifyFleet = { workers: 0, verifiedTotal: null };
    try {
      if (r && _redisUp) { const ids = await r.zRangeByScore('np:wk:index', Date.now() - 90000, '+inf').catch(() => []);
        for (const id of ids) { const hh = await r.hGetAll(`np:wk:${id}`).catch(() => ({})); const rls = String(hh.role || '').split(',').map((x) => x.trim()); if (rls.includes('verify') || rls.includes('all')) verifyFleet.workers++; } }
    } catch { /* */ }
    verifyFleet.verifiedTotal = await count('contacts', '&filter[email_verified][_eq]=true').catch(() => null);
    res.json({
      status,
      config: {
        providers, providerFileExists: !!vp, verifyFleet,
        proxyCount: Array.isArray(proxies) ? proxies.length : 0, proxyFileExists: !!proxies,
        angles: angles?.angles ? Object.keys(angles.angles) : [], sender_org: angles?.sender_org || null,
        sending, mailer: process.env.SMTP_HOST ? 'smtp' : 'dry-run',
        // Estado das integrações (Fase F) — só flags de env, NUNCA os valores secretos.
        integrations: (() => { const has = (k) => !!process.env[k]; const mp = (process.env.MOLONI_MODE || '').toLowerCase() === 'live' ? 'MOLONI_' : 'SANDBOX_MOLONI_'; return {
          moloni: { enabled: has(mp + 'CLIENT_ID') && has(mp + 'COMPANY_ID'), mode: process.env.MOLONI_MODE || 'sandbox' },
          openprovider: { enabled: has('OPENPROVIDER_USERNAME') && (has('OPENPROVIDER_PASSWORD') || has('OPENPROVIDER_PASSWORD_HASH')) },
          documenso: { enabled: has('DOCUMENSO_API_BASE') && has('DOCUMENSO_API_TOKEN') && has('DOCUMENSO_WEBHOOK_SECRET') },
          notion: { enabled: has('NOTION_ACCESS_TOKEN') && has('NOTION_DATABASE_ID') },
          google: { enabled: has('GOOGLE_SA_CLIENT_EMAIL') && has('GOOGLE_SA_PRIVATE_KEY') },
          stripe: { enabled: has('STRIPE_TEST_SECRET_KEY') || has('STRIPE_LIVE_SECRET_KEY') },
          paypal: { enabled: has('PAYPAL_SANDBOX_CLIENT_ID') || has('PAYPAL_LIVE_CLIENT_ID') },
          eupago: { enabled: has('EUPAGO_API_KEY') },
          coingate: { enabled: has('COINGATE_SANDBOX_API_TOKEN') || has('COINGATE_LIVE_API_TOKEN') },
          wise: { enabled: has('WISE_SANDBOX_API_TOKEN') || has('WISE_LIVE_API_TOKEN') },
          bank_transfer: { enabled: has('BANK_TRANSFER_IBAN') },
        }; })(),
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
  return { subjects: (r.json.subjects || []).slice(0, 3), preview_text: r.json.preview_text || '', body: r.json.body || '', variables: (r.json.variables || []).slice(0, 12), angle: angle || 'general', audience: audience || '' };
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
    if (intent === 'campaign') { const c = await agentCampaign({ message: msg }); if (c.error) return res.status(502).json(c); return res.json({ kind: 'campaign', intent, ...c }); }
    return res.json({ kind: 'text', intent: 'general', reply: r.json?.reply || 'Posso criar públicos-alvo, sugerir campanhas ou escrever o copy dos emails — o que precisas?' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Estado do Ollama on-prem (chip de saúde nas páginas AI). Verifica reachability + se o modelo existe/está quente.
app.get('/api/agents/health', async (req, res) => {
  if (!OLLAMA_URL) return res.json({ ok: false, state: 'off', reason: 'OLLAMA_URL não definido', model: OLLAMA_MODEL });
  const base = OLLAMA_MODEL.split(':')[0];
  const grab = async (path) => { const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 4000); try { const r = await fetch(`${OLLAMA_URL}${path}`, { signal: ctrl.signal }); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(to); } };
  const tags = await grab('/api/tags');
  if (!tags) return res.json({ ok: false, state: 'off', reason: 'sem resposta (Ollama em baixo?)', model: OLLAMA_MODEL });
  const models = (tags.models || []).map((m) => m.name || m.model).filter(Boolean);
  const available = models.some((m) => m === OLLAMA_MODEL || m.startsWith(base));
  const ps = await grab('/api/ps');
  const warm = !!(ps?.models || []).some((m) => (m.name || m.model || '').startsWith(base));
  res.json({ ok: true, state: available ? 'online' : 'no-model', model: OLLAMA_MODEL, available, warm, models });
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
-- NB: o verify NÃO é medido aqui. Ao nível-site enganava (sites sem emails contavam trivialmente como
-- verificados, ex. 1805). É medido ao nível-CONTACTO em CONTACT_VERIFY_SQL (partilhado c/ a Cobertura de
-- Dados) → campo verifyBuckets; a página Jobs mostra os contactos CLASSIFICADOS / contactos com email.
SELECT
  CASE WHEN lead_score>75 THEN 'b75' WHEN lead_score>70 THEN 'b70' WHEN lead_score>65 THEN 'b65'
       WHEN lead_score>60 THEN 'b60' WHEN lead_score>55 THEN 'b55' WHEN lead_score>50 THEN 'b50'
       WHEN lead_score>45 THEN 'b45' WHEN lead_score>40 THEN 'b40' WHEN lead_score>35 THEN 'b35'
       WHEN lead_score>30 THEN 'b30' WHEN lead_score>25 THEN 'b25' WHEN lead_score>20 THEN 'b20'
       ELSE 'lt20' END AS bucket,
  count(*)::int AS total,
  -- wp_total: sites WordPress/WooCommerce por bucket → denominador do wpscan (não-WP não pode ter wpscan).
  count(*) FILTER (WHERE s.primary_platform IN (SELECT id FROM platforms WHERE slug IN ('wordpress','woocommerce')))::int AS wp_total,
  -- loc_total: sites que PODEM ter localidade (têm GMB OU morada extraída) → denominador do locality. Sites
  -- SEM fonte nenhuma (nem GMB nem morada no HTML) não podem ter cidade → N/A, saem da % de jobs (como o wpscan
  -- exclui não-WP). O "sem morada" é conhecido pós-locality: business_address preenchido ⟺ havia morada.
  count(*) FILTER (WHERE s.gmb = true OR s.business_address IS NOT NULL)::int AS loc_total,
  -- COBERTURA DE JOBS = "o job CORREU" (≠ "tem dado útil", que é a página Cobertura de Dados).
  -- MARCADOR PRÓPRIO POR JOB (fim dos partilhados): timestamp dedicado OU a coluna que o handler grava
  -- SEMPRE que corre (mesmo em vazio: tech_detected=[] · traffic_bucket='unranked' · ssl_grade='F' · etc.).
  -- Nota: dns é resolvido INLINE pelo fetch (não é job separado) -> marcador = hosting_ip (todo o site vivo
  -- tem IP). geoip/dnsprovider têm coluna-de-saída não-condicional (ip_country/dns_provider) -> usam-na
  -- (revela quem NÃO correu). locality/industry gravam a saída só quando ACHAM (condicional) -> têm
  -- timestamp dedicado (locality_checked_at/industry_checked_at). NÃO usar aqui colunas que ficam NULL
  -- quando o job corre mas não acha nada (isso é "dado", vai para a Cobertura de Dados).
  count(*) FILTER (WHERE s.checked_at IS NOT NULL)::int AS enrich,
  count(*) FILTER (WHERE s.http_status IS NOT NULL)::int AS fetch,
  count(*) FILTER (WHERE s.hosting_ip IS NOT NULL)::int AS dns,
  count(*) FILTER (WHERE s.ip_country IS NOT NULL OR s.asn IS NOT NULL)::int AS geoip,
  count(*) FILTER (WHERE s.tech_detected IS NOT NULL)::int AS fingerprint,
  count(*) FILTER (WHERE s.social IS NOT NULL)::int AS social,
  count(*) FILTER (WHERE s.locality_checked_at IS NOT NULL AND (s.gmb = true OR s.business_address IS NOT NULL))::int AS locality,
  count(*) FILTER (WHERE s.spf_status IS NOT NULL)::int AS emailauth,
  count(*) FILTER (WHERE s.traffic_bucket IS NOT NULL)::int AS traffic,
  count(*) FILTER (WHERE s.hostnames IS NOT NULL)::int AS subdomains,
  count(*) FILTER (WHERE s.ssl_grade IS NOT NULL)::int AS ssl,
  count(*) FILTER (WHERE s.dns_provider IS NOT NULL)::int AS dnsprovider,
  count(*) FILTER (WHERE s.whois_checked_at IS NOT NULL)::int AS whois,
  count(*) FILTER (WHERE s.contacts_checked_at IS NOT NULL)::int AS contacts,
  count(*) FILTER (WHERE s.lead_score_at IS NOT NULL)::int AS score,
  count(*) FILTER (WHERE s.audit_checked_at IS NOT NULL)::int AS audit,
  count(*) FILTER (WHERE s.industry_checked_at IS NOT NULL)::int AS industry,
  count(*) FILTER (WHERE s.lighthouse_mobile_checked_at IS NOT NULL)::int AS lighthouse_mobile,
  count(*) FILTER (WHERE s.lighthouse_desktop_checked_at IS NOT NULL)::int AS lighthouse_desktop,
  count(*) FILTER (WHERE s.security_findings IS NOT NULL)::int AS nuclei,
  count(*) FILTER (WHERE s.wp_vuln_count IS NOT NULL)::int AS wpscan,
  count(*) FILTER (WHERE s.gmb_checked_at IS NOT NULL)::int AS gmb
-- Denominador = leads QUALIFICADOS e VIVOS. Sites mortos (is_live=false) ou desqualificados não podem
-- completar os jobs (tal como os não-WP não podem ter wpscan → wp_total), logo não contam para a % de
-- cobertura. is_live é refrescado pelo fetch; um site que volte a responder reentra automaticamente.
FROM sites s WHERE s.qualified AND s.is_live GROUP BY bucket`;
app.get('/api/coverage', async (req, res) => {
  try {
    const data = await cached('np:coverage:v1', async () => {
      const p = await pgPool();
      if (!p) return { ok: false, error: 'PG desligado (falta PG_HOST/creds)' };
      const [sites, ver, vb] = await Promise.all([
        p.query(COVERAGE_SQL),
        p.query("SELECT count(*) FILTER (WHERE email_status IS NOT NULL)::int verified, count(*) FILTER (WHERE email_verified)::int accepted, count(*) FILTER (WHERE email IS NOT NULL)::int with_email FROM contacts"),
        p.query(CONTACT_VERIFY_SQL),
      ]);
      return { ok: true, buckets: sites.rows, verify: ver.rows[0], verifyBuckets: vb.rows, ts: Date.now() };
    }, 120);
    res.json(data);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Cobertura de DADOS por bucket de lead_score (≠ jobs: aqui mede-se se o CAMPO TEM VALOR, não se
//     o job correu). Ajuda a ver que dados temos sobre as leads — um job pode ter corrido e não achar
//     nada (o dado simplesmente não existe). np-db direto; cache 2min. Antes do catch-all. ---
const DATA_COVERAGE_SQL = `
SELECT
  CASE WHEN lead_score>75 THEN 'b75' WHEN lead_score>70 THEN 'b70' WHEN lead_score>65 THEN 'b65'
       WHEN lead_score>60 THEN 'b60' WHEN lead_score>55 THEN 'b55' WHEN lead_score>50 THEN 'b50'
       WHEN lead_score>45 THEN 'b45' WHEN lead_score>40 THEN 'b40' WHEN lead_score>35 THEN 'b35'
       WHEN lead_score>30 THEN 'b30' WHEN lead_score>25 THEN 'b25' WHEN lead_score>20 THEN 'b20'
       ELSE 'lt20' END AS bucket,
  count(*)::int AS total,
  count(*) FILTER (WHERE primary_platform IN (SELECT id FROM platforms WHERE slug IN ('wordpress','woocommerce')))::int AS wp_total,
  -- loc_total: sites com FONTE de localidade (GMB ou morada) = denominador honesto da cidade. Sem fonte = N/A
  -- (não podem ter cidade), não contam como "cidade em falta". Ver Cobertura de Jobs (mesmo loc_total).
  count(*) FILTER (WHERE gmb = true OR business_address IS NOT NULL)::int AS loc_total,
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
  count(*) FILTER (WHERE tech_detected IS NOT NULL AND tech_detected::text NOT IN ('[]','{}','null'))::int AS tech,
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
-- Mesmo denominador da cobertura de jobs: só leads qualificados e vivos (ver COVERAGE_SQL).
FROM sites WHERE qualified AND is_live GROUP BY bucket`;
// Verify ao NÍVEL DO CONTACTO por bucket de score, PARTILHADO pelas 2 páginas de cobertura → reconciliam:
// Jobs usa v_classified ("verify correu" = email_status não-NULL); Dados usa v_valid (verde) + v_catchall
// (roxo, prováveis). Denominador comum = v_withemail (contactos COM email). v_classified ⊇ v_valid+v_catchall
// (o resto são inválido/role/sem-MX — classificações grátis, fora da quota ~100/dia das sondas pagas).
const CONTACT_VERIFY_SQL = `
SELECT
  CASE WHEN s.lead_score>75 THEN 'b75' WHEN s.lead_score>70 THEN 'b70' WHEN s.lead_score>65 THEN 'b65'
       WHEN s.lead_score>60 THEN 'b60' WHEN s.lead_score>55 THEN 'b55' WHEN s.lead_score>50 THEN 'b50'
       WHEN s.lead_score>45 THEN 'b45' WHEN s.lead_score>40 THEN 'b40' WHEN s.lead_score>35 THEN 'b35'
       WHEN s.lead_score>30 THEN 'b30' WHEN s.lead_score>25 THEN 'b25' WHEN s.lead_score>20 THEN 'b20'
       ELSE 'lt20' END AS bucket,
  count(*) FILTER (WHERE c.email_status IS NOT NULL)::int AS v_classified,
  count(*) FILTER (WHERE c.email_status='valid')::int AS v_valid,
  count(*) FILTER (WHERE c.email_status='catch_all')::int AS v_catchall,
  count(*) FILTER (WHERE c.email IS NOT NULL)::int AS v_withemail
FROM contacts c JOIN sites s ON s.id = c.site
WHERE s.qualified AND s.is_live GROUP BY bucket`;
app.get('/api/data-coverage', async (req, res) => {
  try {
    const data = await cached('np:datacoverage:v1', async () => {
      const p = await pgPool();
      if (!p) return { ok: false, error: 'PG desligado (falta PG_HOST/creds)' };
      const [sites, ver, vb] = await Promise.all([
        p.query(DATA_COVERAGE_SQL),
        p.query("SELECT count(*) FILTER (WHERE email_status IS NOT NULL)::int verified, count(*) FILTER (WHERE email_verified)::int accepted, count(*) FILTER (WHERE email IS NOT NULL)::int with_email FROM contacts"),
        p.query(CONTACT_VERIFY_SQL),
      ]);
      return { ok: true, buckets: sites.rows, verify: ver.rows[0], verifyBuckets: vb.rows, ts: Date.now() };
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
    const camps = await d('/items/campaigns?fields=id,name,status,angle,phase,total,generated,sent,opened,clicked,created_at&sort=-created_at&limit=200').catch(() => []);
    const f = { total: 0, generated: 0, sent: 0, opened: 0, clicked: 0 };
    const byAngle = {}, byStatus = {}, byPhase = { cold: 0, semi_warm: 0, warm: 0 };
    for (const c of camps) { for (const k of Object.keys(f)) f[k] += (c[k] || 0); byAngle[c.angle || '—'] = (byAngle[c.angle || '—'] || 0) + 1; byStatus[c.status || '—'] = (byStatus[c.status || '—'] || 0) + 1; const ph = ['cold', 'semi_warm', 'warm'].includes(c.phase) ? c.phase : 'cold'; byPhase[ph]++; }
    let recent = [];
    try { recent = await d('/items/emails?fields=id,to_email,subject,status,created_at,sent_at,opened_at,clicked_at,bounce_type,campaign.name&sort=-created_at&limit=60'); } catch { /* vazio */ }
    res.json({ ok: true, campaigns: camps, funnel: f, byAngle, byStatus, byPhase, recent });
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
// ──────────────────────────────────────────────────────────────────────────
// FLEET ENV STORE + PULL — controlo de env vars por host + auto-deploy por PULL.
// Modelo (sem SSH/ACL): o np-server guarda o .env de cada host; cada host corre um
// agente que puxa o .env + faz git pull e recria SÓ se algo mudou. Ver deploy/agent/ +
// docs/runbook-laptop-autodeploy.md. Store em /app/fleet-env (volume rw) — ficheiros
// <host>.env (segredos → gitignored). Editor no dashboard (tailnet-gated); os agentes
// usam /api/fleet/pull/:host com FLEET_PULL_TOKEN (podem vir de qualquer nó da tailnet).
const FLEET_ENV_DIR = path.join(__dirname, 'fleet-env');
const FLEET_PULL_TOKEN = process.env.FLEET_PULL_TOKEN || '';
const HOST_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i; // valida :host → nome de ficheiro seguro
const envPath = (host) => path.join(FLEET_ENV_DIR, `${host}.env`);
const readFleetEnv = (host) => { try { return fs.readFileSync(envPath(host), 'utf8'); } catch { return ''; } };
const hashEnv = (s) => crypto.createHash('sha256').update(s || '', 'utf8').digest('hex').slice(0, 16);
function ensureFleetDir() { try { fs.mkdirSync(FLEET_ENV_DIR, { recursive: true }); } catch { /* já existe */ } }

// Editor (browser, tailnet-gated como o resto do dashboard): lê/grava o .env de um host.
app.get('/api/fleet/env/:host', (req, res) => {
  const host = req.params.host;
  if (!HOST_RE.test(host)) return res.status(400).json({ error: 'host inválido' });
  const env = readFleetEnv(host);
  res.json({ host, env, hash: hashEnv(env), exists: !!env });
});
app.put('/api/fleet/env/:host', (req, res) => {
  const host = req.params.host;
  if (!HOST_RE.test(host)) return res.status(400).json({ error: 'host inválido' });
  const env = String((req.body || {}).env ?? '');
  if (env.length > 65536) return res.status(413).json({ error: '.env demasiado grande' });
  try { ensureFleetDir(); fs.writeFileSync(envPath(host), env, { mode: 0o600 }); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, host, hash: hashEnv(env) });
});
// Lista os hosts com .env guardado (para a Servers page saber quais têm store).
app.get('/api/fleet/env', (req, res) => {
  ensureFleetDir();
  let hosts = [];
  try { hosts = fs.readdirSync(FLEET_ENV_DIR).filter((f) => f.endsWith('.env')).map((f) => f.replace(/\.env$/, '')); } catch { /* vazio */ }
  res.json({ hosts, token_set: !!FLEET_PULL_TOKEN });
});
// PULL (agente máquina-a-máquina): devolve o .env + hash. Protegido por FLEET_PULL_TOKEN
// (os agentes correm em qualquer nó da tailnet). Sem token configurado → tailnet-gated.
app.get('/api/fleet/pull/:host', (req, res) => {
  const host = req.params.host;
  if (!HOST_RE.test(host)) return res.status(400).json({ error: 'host inválido' });
  if (FLEET_PULL_TOKEN) {
    const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.token || '';
    if (tok !== FLEET_PULL_TOKEN) return res.status(401).json({ error: 'não autorizado' });
  }
  const env = readFleetEnv(host);
  // Por defeito raw (text/plain) → os agentes comparam ficheiros com `cmp`, sem parser JSON.
  res.set('X-Env-Hash', hashEnv(env));
  res.type('text/plain').send(env);
});
// PUSH de telemetria de host (agente de pull, ~5 min): grava um snapshot no Redis (HASH, TTL 15min →
// hosts silenciosos aparecem "sem dados" na página Servidores). Mesmo token que o pull do .env.
// Só campos conhecidos (whitelist) e limitados em tamanho → não guardamos lixo arbitrário.
const METRIC_FIELDS = ['cpu', 'load', 'cores', 'mem_used', 'mem_total', 'swap_used', 'swap_total', 'disk_used', 'disk_total',
  'io_read', 'io_write', 'net_rx', 'net_tx', 'lat_directus', 'lat_pg', 'lat_minio', 'uptime', 'ts', 'addr', 'tailnet'];
app.post('/api/fleet/metrics/:host', async (req, res) => {
  const host = req.params.host;
  if (!HOST_RE.test(host)) return res.status(400).json({ error: 'host inválido' });
  if (FLEET_PULL_TOKEN) {
    const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.token || '';
    if (tok !== FLEET_PULL_TOKEN) return res.status(401).json({ error: 'não autorizado' });
  }
  const body = req.body || {};
  const h = {};
  for (const k of METRIC_FIELDS) if (body[k] != null && body[k] !== '') h[k] = String(body[k]).slice(0, 32);
  h.reported = String(Date.now()); // relógio do servidor → idade do snapshot sem depender do clock do host
  try {
    const r = await redisClient();
    if (!r || !_redisUp) return res.status(503).json({ error: 'sem Redis' });
    await r.del(`np:host:${host}:metrics`); // limpa campos obsoletos antes de re-escrever
    await r.hSet(`np:host:${host}:metrics`, h);
    await r.expire(`np:host:${host}:metrics`, 900); // 15 min
    await r.zAdd('np:host:index', { score: Date.now(), value: host }); // registo → hosts SEM workers (infra) aparecem na frota
    // Matriz de latência entre nós (o host mediu ping a cada outro nó) — guarda o mapa {host: ms}.
    if (body.latmatrix && typeof body.latmatrix === 'object' && !Array.isArray(body.latmatrix)) {
      const lm = {}; for (const k of Object.keys(body.latmatrix).slice(0, 100)) { const v = +body.latmatrix[k]; if (isFinite(v)) lm[String(k).slice(0, 64)] = v; }
      await r.set(`np:host:${host}:latmatrix`, JSON.stringify(lm), { EX: 900 });
    }
    // Containers Docker do host (docker ps) → mostrados na página VMs como "workers" da VM.
    if (Array.isArray(body.containers)) {
      const S = (v, n) => String(v == null ? '' : v).slice(0, n);
      const cs = body.containers.slice(0, 500).map((c) => ({ kind: S(c && c.kind, 12) || 'container', id: S(c && c.id, 96), name: S(c && c.name, 72), state: S(c && c.state, 16), status: S(c && c.status, 80), image: S(c && c.image, 90), ports: S(c && c.ports, 160), cpu: S(c && c.cpu, 12), mem: S(c && c.mem, 40), net: S(c && c.net, 40), blk: S(c && c.blk, 40), memb: S(c && c.memb, 24), memtotal: S(c && c.memtotal, 24), diskb: S(c && c.diskb, 24), disktotal: S(c && c.disktotal, 24), netin: S(c && c.netin, 24), netout: S(c && c.netout, 24), up: S(c && c.up, 16), vmid: S(c && c.vmid, 12), storage: S(c && c.storage, 40), cpuSec: S(c && c.cpuSec, 16), logb64: S(c && c.logb64, 8000) })).filter((c) => c.name);
      await r.set(`np:host:${host}:containers`, JSON.stringify(cs), { EX: 900 });
    }
  } catch (e) { return res.status(502).json({ error: e.message }); }
  res.json({ ok: true, host, fields: Object.keys(h).length });
});
// Lista de nós da frota (host + IP reportado) → cada agente pinga estes para a matriz de latência.
app.get('/api/fleet/targets', async (req, res) => {
  try {
    const r = await redisClient();
    if (!r || !_redisUp) return res.json([]);
    const hs = await r.zRangeByScore('np:host:index', Date.now() - 900000, '+inf').catch(() => []);
    const out = [];
    for (const h of hs) { const m = await r.hGetAll(`np:host:${h}:metrics`).catch(() => ({})); if (m && m.addr) out.push({ host: h, addr: m.addr }); }
    res.json(out);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Bridge Alertmanager → ntfy: recebe os webhooks do Alertmanager e publica notificações formatadas
// no ntfy (o Alertmanager só faz webhook JSON; aqui damos-lhe título/prioridade/tags legíveis). O
// receiver do Alertmanager (CT 203) aponta para este endpoint. Ver docs/observability.md.
const NTFY_URL = (process.env.NTFY_URL || 'http://100.118.244.35').replace(/\/$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'netprospect-alerts';
app.post('/api/alertmanager-webhook', async (req, res) => {
  const alerts = Array.isArray(req.body?.alerts) ? req.body.alerts : [];
  let sent = 0;
  for (const a of alerts) {
    const firing = a.status === 'firing';
    const sev = a.labels?.severity || 'info';
    const name = a.labels?.alertname || 'alerta';
    const host = a.labels?.host ? ' @ ' + a.labels.host : '';
    const summary = a.annotations?.summary || a.annotations?.description || name;
    const prio = !firing ? '2' : sev === 'critical' ? '5' : sev === 'warning' ? '4' : '3';
    const tag = !firing ? 'white_check_mark' : sev === 'critical' ? 'rotating_light' : 'warning';
    const title = (firing ? '[FIRING] ' : '[RESOLVED] ') + name + host; // ASCII (header ntfy)
    try {
      await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: 'POST', headers: { 'X-Title': title.slice(0, 250), 'X-Priority': prio, 'X-Tags': tag }, body: `${firing ? 'FIRING' : 'RESOLVED'} · ${sev}\n${summary}` });
      sent++;
    } catch { /* fail-soft */ }
  }
  res.json({ ok: true, received: alerts.length, sent });
});
// --- Alertmanager PULL: o monitor de saúde consulta AQUI os alertas ATIVOS (fonte de verdade =
// Prometheus→Alertmanager) em vez de fazer os curls exaustivos a /api/queues|workers|logs à mão. ---
const ALERTMANAGER_URL = (process.env.ALERTMANAGER_URL || 'http://100.96.102.84:9093').replace(/\/$/, '');
app.get('/api/alerts', async (req, res) => {
  try {
    const r = await fetch(`${ALERTMANAGER_URL}/api/v2/alerts?active=true&silenced=false&inhibited=false`);
    if (!r.ok) return res.status(502).json({ ok: false, error: `Alertmanager HTTP ${r.status}` });
    const raw = await r.json();
    const alerts = (Array.isArray(raw) ? raw : []).filter((a) => (a.status?.state || 'active') === 'active').map((a) => ({
      name: a.labels?.alertname, severity: a.labels?.severity, service: a.labels?.service,
      host: a.labels?.host, consumer: a.labels?.consumer, instance: a.labels?.instance,
      summary: a.annotations?.summary || a.annotations?.description || '', startsAt: a.startsAt,
    }));
    res.json({ ok: true, count: alerts.length, alerts, source: ALERTMANAGER_URL, ts: Date.now() });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
// --- Prometheus /metrics — expõe a telemetria da frota p/ o Prometheus da stack de observabilidade.
// Fonte: Redis (rápido, sem NATS). Host (CPU/RAM/disco/rede/IO/latências) + unidades (docker/lxc/vm/
// serviço/storage) + throughput por host + workers vivos. Ver docs/observability.md.
const DC_OF = (h) => /^hel1|^np-(server|db)/.test(h || '') ? 'HEL1' : /^de|^np-wk-de/.test(h || '') ? 'DE1' : /laptop/.test(h || '') ? 'Laptop' : /oracle/.test(h || '') ? 'Oracle' : 'Outro';
app.get('/metrics', async (req, res) => {
  res.type('text/plain; version=0.0.4');
  const out = [];
  const seen = new Set();
  const M = (name, help, type) => { if (!seen.has(name)) { out.push(`# HELP ${name} ${help}`); out.push(`# TYPE ${name} ${type}`); seen.add(name); } };
  const esc = (v) => String(v).replace(/[\\"\n]/g, '_');
  const g = (name, labels, val) => { if (val == null || val === '' || !isFinite(+val)) return; const l = Object.entries(labels).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}="${esc(v)}"`).join(','); out.push(`${name}{${l}} ${+val}`); };
  try {
    const r = await redisClient();
    if (!r || !_redisUp) return res.send('# NetProspect: Redis offline\n');
    const now = Date.now(); const curH = Math.floor(now / 3600000);
    // Hosts = quem reporta métricas (infra) ∪ quem tem workers vivos.
    const mh = await r.zRangeByScore('np:host:index', now - 900000, '+inf').catch(() => []);
    const wkIds = await r.zRangeByScore('np:wk:index', now - 90000, '+inf').catch(() => []);
    const wkHosts = {};
    for (const id of wkIds) { const h = await r.hGetAll(`np:wk:${id}`).catch(() => ({})); if (h.host) wkHosts[h.host] = (wkHosts[h.host] || 0) + 1; }
    const hosts = [...new Set([...mh, ...Object.keys(wkHosts)])];
    M('np_up', 'Dashboard/telemetria online', 'gauge'); out.push('np_up 1');
    M('np_workers_up', 'Workers vivos (heartbeat <90s)', 'gauge'); out.push(`np_workers_up ${wkIds.length}`);
    M('np_host_cpu_percent', 'CPU do host (%)', 'gauge');
    M('np_host_mem_used_bytes', 'RAM usada do host', 'gauge');
    M('np_host_mem_total_bytes', 'RAM total do host', 'gauge');
    M('np_host_swap_used_bytes', 'SWAP usada do host', 'gauge');
    M('np_host_swap_total_bytes', 'SWAP total do host', 'gauge');
    M('np_host_disk_used_bytes', 'Disco / usado', 'gauge');
    M('np_host_disk_total_bytes', 'Disco / total', 'gauge');
    M('np_host_load1', 'Load average 1m', 'gauge');
    M('np_host_cores', 'Núcleos (vCPU)', 'gauge');
    M('np_host_net_rx_mbps', 'Rede recebida (MB/s)', 'gauge');
    M('np_host_net_tx_mbps', 'Rede enviada (MB/s)', 'gauge');
    M('np_host_io_read_mbps', 'Disco leitura (MB/s)', 'gauge');
    M('np_host_io_write_mbps', 'Disco escrita (MB/s)', 'gauge');
    M('np_host_latency_ms', 'Latência a um serviço (ms)', 'gauge');
    M('np_host_uptime_seconds', 'Uptime do host (s)', 'gauge');
    M('np_host_metrics_age_seconds', 'Idade do último snapshot de métricas (s)', 'gauge');
    M('np_host_workers', 'Workers NP vivos neste host', 'gauge');
    M('np_host_jobs_done_1h', 'Jobs concluídos na última hora (host)', 'gauge');
    M('np_host_units', 'Unidades a correr no host, por tipo', 'gauge');
    for (const host of hosts) {
      const dc = DC_OF(host);
      const m = await r.hGetAll(`np:host:${host}:metrics`).catch(() => ({}));
      if (m && Object.keys(m).length) {
        g('np_host_cpu_percent', { host, dc }, m.cpu);
        if (m.mem_used) g('np_host_mem_used_bytes', { host, dc }, +m.mem_used * 1048576);
        if (m.mem_total) g('np_host_mem_total_bytes', { host, dc }, +m.mem_total * 1048576);
        if (m.swap_used) g('np_host_swap_used_bytes', { host, dc }, +m.swap_used * 1048576);
        if (m.swap_total) g('np_host_swap_total_bytes', { host, dc }, +m.swap_total * 1048576);
        if (m.disk_used) g('np_host_disk_used_bytes', { host, dc }, +m.disk_used * 1073741824);
        if (m.disk_total) g('np_host_disk_total_bytes', { host, dc }, +m.disk_total * 1073741824);
        g('np_host_load1', { host, dc }, m.load);
        g('np_host_cores', { host, dc }, m.cores);
        g('np_host_net_rx_mbps', { host, dc }, m.net_rx); g('np_host_net_tx_mbps', { host, dc }, m.net_tx);
        g('np_host_io_read_mbps', { host, dc }, m.io_read); g('np_host_io_write_mbps', { host, dc }, m.io_write);
        g('np_host_latency_ms', { host, dc, target: 'directus' }, m.lat_directus);
        g('np_host_latency_ms', { host, dc, target: 'postgres' }, m.lat_pg);
        g('np_host_latency_ms', { host, dc, target: 'minio' }, m.lat_minio);
        g('np_host_uptime_seconds', { host, dc }, m.uptime);
        if (m.reported) g('np_host_metrics_age_seconds', { host, dc }, Math.round((now - +m.reported) / 1000));
      }
      g('np_host_workers', { host, dc }, wkHosts[host] || 0);
      const doneH = await r.get(`np:host:${host}:done:${curH}`).catch(() => null);
      if (doneH != null) g('np_host_jobs_done_1h', { host, dc }, +doneH || 0);
      try {
        const cs = JSON.parse((await r.get(`np:host:${host}:containers`)) || '[]');
        const byKind = {}; for (const c of cs) { const k = c.kind || 'container'; byKind[k] = (byKind[k] || 0) + 1; }
        for (const k in byKind) g('np_host_units', { host, dc, kind: k }, byKind[k]);
      } catch { /* */ }
    }
    // Filas / consumers (NATS) — base para as regras Alertmanager de filas. Reusa a lógica do /api/queues
    // (consumers.info + addQueueCapacity) via self-fetch; corre a cada scrape (~30s).
    M('np_queue_pending', 'Mensagens pendentes na fila', 'gauge');
    M('np_queue_ack_pending', 'Mensagens em voo (inflight)', 'gauge');
    M('np_queue_orphans', 'Mensagens órfãs (esgotaram maxDeliver)', 'gauge');
    M('np_queue_redelivered', 'Mensagens re-entregues', 'gauge');
    M('np_queue_max_ack', 'Teto maxAckPending do consumer', 'gauge');
    M('np_queue_waiting', 'Pull-requests à espera (capacidade ociosa)', 'gauge');
    M('np_queue_slots', 'Slots efetivos (Σ conc dos workers, capado por maxAckPending)', 'gauge');
    M('np_consumer_avg_ms', 'Duração média por job (ms)', 'gauge');
    M('np_consumer_jobs_done_1h', 'Jobs concluídos na última hora (consumer)', 'gauge');
    try {
      const q = await fetch(`http://127.0.0.1:${PORT}/api/queues`).then((x) => x.json()).catch(() => null);
      for (const c of (q && q.consumers) || []) {
        const lab = { consumer: c.name, role: c.role };
        g('np_queue_pending', lab, c.pending);
        g('np_queue_ack_pending', lab, c.ackPending);
        g('np_queue_orphans', lab, c.orphans);
        g('np_queue_redelivered', lab, c.redelivered);
        g('np_queue_max_ack', lab, c.maxAckPending);
        g('np_queue_waiting', lab, c.waiting);
        g('np_queue_slots', lab, c.slots);
        g('np_consumer_avg_ms', lab, c.avgMs);
        if (c.cap1h && c.cap1h.used != null) g('np_consumer_jobs_done_1h', lab, c.cap1h.used);
      }
    } catch { /* fila indisponível — segue sem as séries de fila */ }
  } catch (e) { out.push(`# erro: ${String(e.message).replace(/\n/g, ' ')}`); }
  res.send(out.join('\n') + '\n');
});

// --- Autoscaler (FASE 1: RECOMENDADOR read-only) — lê filas + hosts + .env e SUGERE ajustes de
//     capacidade para escoar os backlogs, dentro de guarda-costas. NÃO aplica nada (revisão humana no
//     editor de .env). Distingue "PRESO no teto maxAckPending" (lever = subir teto) de "teto com folga
//     mas poucos a puxar" (lever = add-role / subir conc). Antes do catch-all. ---
const AUTOSCALE_CAPPED = {
  gmb: 'rate-limit do Google sobre 1 IP residencial — escala com +IPs, não com conc (ver GMB_MAX_ACK)',
  verify: 'quota da API de verificação (~100/dia)',
};
const CONC_ENV = {
  enrich: 'ENRICH_CONCURRENCY', contacts: 'CONTACTS_CONCURRENCY', fingerprint: 'FINGERPRINT_CONC',
  score: 'SCORE_CONC', verify: 'VERIFY_CONCURRENCY', nuclei: 'NUCLEI_JOB_CONC', wpscan: 'WPSCAN_CONC',
  industry: 'INDUSTRY_CONC', gmb: 'GMB_CONC', lighthouse_mobile: 'LIGHTHOUSE_CONC', lighthouse_desktop: 'LIGHTHOUSE_CONC',
  ssl: 'DOMAIN_HEALTH_CONC', whois: 'DOMAIN_HEALTH_CONC', dnsprovider: 'DOMAIN_HEALTH_CONC',
};
function autoscaleRoleAssignable(role, host, env) {
  if (role === 'residential') return /laptop/i.test(host);      // só há IP residencial na laptop
  if (role === 'ai') return /^OLLAMA_URL=\S/m.test(env || '');    // ai precisa de Ollama
  if (role === 'verify') return false;                            // quota — não escala por host
  return true;                                                    // base/browser/security
}
function autoscaleRecommend({ consumers, workers, envByHost }) {
  const roleByConsumer = {}; for (const c of consumers) roleByConsumer[c.name] = c.role;
  const H = {};
  for (const w of workers) {
    const h = w.host || w.id;
    (H[h] ||= { host: h, cores: 0, load: 0, roles: new Set(), done1h: 0, conc: {}, replicas: 0 });
    H[h].cores = Math.max(H[h].cores, w.cores || 0);
    H[h].load = Math.max(H[h].load, w.load || 0);
    H[h].done1h += w.done1h || 0;
    H[h].replicas = Math.max(H[h].replicas, w.replicas || 1);
    (w.consumers || []).forEach((c) => { const r = roleByConsumer[c]; if (r && r !== '?') H[h].roles.add(r); });
    if (w.conc) for (const k in w.conc) H[h].conc[k] = Math.max(H[h].conc[k] || 0, +w.conc[k] || 0);
  }
  for (const h in H) { H[h].busyPct = H[h].cores ? Math.min(100, Math.round(100 * H[h].load / H[h].cores)) : 0; H[h].headroom = Math.max(0, Math.round(H[h].cores - H[h].load)); }
  const bottlenecks = consumers.filter((c) => (c.pending || 0) > 200).map((c) => {
    const used = c.cap1h && typeof c.cap1h.used === 'number' ? c.cap1h.used : 0;
    const drainPerH = used || (c.avgMs > 0 && c.slots > 0 ? Math.round(c.slots * 3600000 / c.avgMs) : 0);
    const etaH = drainPerH > 0 ? +(c.pending / drainPerH).toFixed(1) : null;
    const maxAck = c.maxAckPending || 0, inflight = c.ackPending || 0;
    return { job: c.name, role: c.role, pending: c.pending, inflight, maxAck, pegged: maxAck > 0 && inflight >= Math.max(1, Math.floor(maxAck * 0.85)), avgMs: c.avgMs || null, slots: c.slots || 0, drainPerH, etaH, capped: !!AUTOSCALE_CAPPED[c.name], capReason: AUTOSCALE_CAPPED[c.name] || null };
  }).sort((a, b) => ((b.etaH ?? 1e9) - (a.etaH ?? 1e9)));
  const hostList = Object.values(H).sort((a, b) => a.host.localeCompare(b.host));
  for (const h of hostList) h.suggestions = [];
  const fleetSuggestions = [];
  for (const b of bottlenecks) {
    if (b.capped) continue;
    const runners = hostList.filter((h) => h.cores > 0 && h.roles.has(b.role));
    if (b.pegged) {
      const headroomHosts = runners.filter((h) => h.busyPct < 70);
      if (headroomHosts.length) {
        fleetSuggestions.push({ type: 'raise-maxack', job: b.job, from: b.maxAck, to: b.maxAck * 2, reason: `${b.job}: PRESO no teto fleet-wide maxAckPending=${b.maxAck} (inflight ${b.inflight}); hosts '${b.role}' com folga (${headroomHosts.map((h) => h.host + ' ' + h.busyPct + '%').join(', ')}) → subir o teto${b.role === 'browser' ? ' (Chromium/CPU-pesado: gradual)' : ''}. Requer tornar maxAckPending override-ável (tipo GMB_MAX_ACK) ou editar jobs.js.` });
      } else {
        const idle = hostList.filter((h) => h.cores > 0 && !h.roles.has(b.role) && h.busyPct < 55 && autoscaleRoleAssignable(b.role, h.host, envByHost[h.host])).sort((a, b2) => b2.headroom - a.headroom)[0];
        if (idle) idle.suggestions.push({ type: 'add-role', role: b.role, env: 'WORKER_ROLES', action: `+${b.role}`, reason: `${b.job}: backlog ${b.pending}; runners de '${b.role}' saturados → dar '${b.role}' a ${idle.host} (folga ${idle.busyPct}%)` });
      }
      continue;
    }
    const runnersBusy = runners.length > 0 && runners.every((h) => h.busyPct >= 75);
    if (runners.length === 0 || runnersBusy) {
      const idle = hostList.filter((h) => h.cores > 0 && !h.roles.has(b.role) && h.busyPct < 55 && autoscaleRoleAssignable(b.role, h.host, envByHost[h.host])).sort((a, b2) => b2.headroom - a.headroom)[0];
      if (idle && !idle.suggestions.some((s) => s.type === 'add-role' && s.role === b.role))
        idle.suggestions.push({ type: 'add-role', role: b.role, env: 'WORKER_ROLES', action: `+${b.role}`, reason: `${b.job}: backlog ${b.pending}${b.etaH ? ` (ETA ${b.etaH}h)` : ''}, teto com folga (inflight ${b.inflight}/${b.maxAck}); ${idle.host} livre (${idle.busyPct}%) pode puxar` });
    }
    const cenv = CONC_ENV[b.job];
    if (cenv) for (const h of runners) if (h.busyPct < 65) {
      const cur = h.conc[b.job] || 1, to = Math.max(cur + 1, Math.min(cur * 2, cur + h.headroom));
      if (to > cur && !h.suggestions.some((s) => s.type === 'raise-conc' && s.env === cenv && s.job === b.job))
        h.suggestions.push({ type: 'raise-conc', job: b.job, env: cenv, from: cur, to, reason: `${b.job}: backlog ${b.pending}, teto com folga; ${h.host} a ${h.busyPct}% → ${cenv} ${cur}→${to}` });
    }
  }
  return { bottlenecks, fleetSuggestions, hosts: hostList.map((h) => ({ host: h.host, cores: h.cores, load: +h.load.toFixed(2), busyPct: h.busyPct, headroom: h.headroom, roles: [...h.roles].sort(), done1h: h.done1h, replicas: h.replicas, suggestions: h.suggestions })), capped: Object.entries(AUTOSCALE_CAPPED).map(([job, reason]) => ({ job, reason })) };
}
app.get('/api/autoscale', async (req, res) => {
  try {
    const data = await cached('np:autoscale:v1', async () => {
      const b = `http://127.0.0.1:${PORT}`;
      const [q, w] = await Promise.all([
        fetch(`${b}/api/queues`).then((r) => r.json()).catch(() => ({ consumers: [] })),
        fetch(`${b}/api/workers`).then((r) => r.json()).catch(() => ({ workers: [] })),
      ]);
      let names = [];
      try { names = fs.readdirSync(FLEET_ENV_DIR).filter((f) => f.endsWith('.env')).map((f) => f.replace(/\.env$/, '')); } catch { /* */ }
      const envByHost = {}; for (const h of names) envByHost[h] = readFleetEnv(h);
      return { ok: true, ...autoscaleRecommend({ consumers: q.consumers || [], workers: w.workers || [], envByHost }), ts: Date.now() };
    }, 60);
    res.json(data);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Moloni — sync de leitura (A3). On-demand a partir do dashboard.
// Import DINÂMICO da lib/: o container do dashboard só serve isto se montar ../lib
// (como os workers). Falha graciosa (502) enquanto não estiver montada — não parte o arranque.
app.post('/api/moloni/sync', async (req, res) => {
  try {
    const entity = String(req.query.entity || 'all');
    let mod;
    try { mod = await import('./lib/moloni-sync.js'); }        // container: /app/lib
    catch { mod = await import('../lib/moloni-sync.js'); }     // host: repo/lib
    const result = entity === 'all' ? await mod.syncAll() : await mod.syncEntity(entity);
    await recordCron('moloni-sync-cron', { status: 'ok', summary: `sync ${entity}: ${(() => { try { return JSON.stringify(result).slice(0, 200); } catch { return 'ok'; } })()}` });
    res.json({ ok: true, result });
  } catch (e) { await recordCron('moloni-sync-cron', { status: 'erro', summary: e.message }); res.status(502).json({ ok: false, error: e.message }); }
});

// ── Moloni — leitura (A4): as páginas Contabilidade lêem o Directus sincronizado. ──
app.get('/api/moloni/documents', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;
    const parts = [];
    if (req.query.type) parts.push(`filter[document_type][_eq]=${encodeURIComponent(req.query.type)}`);
    const q = (req.query.q || '').trim();
    if (q) { const s = encodeURIComponent(q); parts.push(`filter[_or][0][number][_icontains]=${s}`); parts.push(`filter[_or][1][customer_name][_icontains]=${s}`); }
    const filter = parts.length ? '&' + parts.join('&') : '';
    const fields = 'fields=id,moloni_id,document_type,number,customer_name,date,net,vat,total,status,pdf_cached,related,company.name';
    const url = `/items/moloni_documents?${fields}${filter}&sort[]=-date&limit=${limit}&offset=${offset}&meta=filter_count`;
    const r = await fetch(`${DIRECTUS_URL}${url}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await r.json();
    res.json({ rows: json.data || [], total: json.meta?.filter_count ?? (json.data || []).length, page, limit });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/moloni/products', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;
    const q = (req.query.q || '').trim();
    let filter = '';
    if (q) { const s = encodeURIComponent(q); filter = `&filter[_or][0][name][_icontains]=${s}&filter[_or][1][reference][_icontains]=${s}`; }
    const url = `/items/products?fields=id,moloni_id,name,reference,kind,price,tax_id${filter}&sort[]=name&limit=${limit}&offset=${offset}&meta=filter_count`;
    const r = await fetch(`${DIRECTUS_URL}${url}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await r.json();
    res.json({ rows: json.data || [], total: json.meta?.filter_count ?? (json.data || []).length, page, limit });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/moloni/avencas', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;
    const url = `/items/moloni_avencas?fields=id,moloni_id,name,customer_moloni_id,amount,period,next_date,active,company.name&sort[]=name&limit=${limit}&offset=${offset}&meta=filter_count`;
    const r = await fetch(`${DIRECTUS_URL}${url}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await r.json();
    res.json({ rows: json.data || [], total: json.meta?.filter_count ?? (json.data || []).length, page, limit });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// PDF de um documento fechado (status=1) — via Moloni (getPDFLink → landing → bytes).
app.get('/api/moloni/documents/:id/pdf', async (req, res) => {
  try {
    const docId = parseInt(req.params.id, 10);
    if (!docId) return res.status(400).json({ error: 'id inválido' });
    let mod; try { mod = await import('./lib/moloni.js'); } catch { mod = await import('../lib/moloni.js'); }
    const buf = await mod.fetchPdfBuffer(docId);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="moloni-${docId}.pdf"`);
    res.send(buf);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Moloni — escrita (B): criar cliente/produto/documento (todos os tipos). ──
const importMoloniWrite = async () => { try { return await import('./lib/moloni-write.js'); } catch { return import('../lib/moloni-write.js'); } };
app.post('/api/moloni/customers', async (req, res) => {
  try { const m = await importMoloniWrite(); res.json({ ok: true, result: await m.createCustomer(req.body || {}) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.post('/api/moloni/products', async (req, res) => {
  try { const m = await importMoloniWrite(); res.json({ ok: true, result: await m.createProduct(req.body || {}) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.post('/api/moloni/documents', async (req, res) => {
  try { const m = await importMoloniWrite(); const type = req.query.type || (req.body && req.body.type);
    res.json({ ok: true, result: await m.createDocument(type, req.body || {}) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.post('/api/moloni/documents/:id/finalize', async (req, res) => {
  try { const m = await importMoloniWrite(); const type = req.query.type || (req.body && req.body.type);
    res.json({ ok: true, result: await m.finalizeDocument(type, parseInt(req.params.id, 10)) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
// Nota de Crédito ligada a um documento original (associated_documents + related_id). Rascunho por defeito.
app.post('/api/moloni/credit-note', async (req, res) => {
  try {
    const m = await importMoloniWrite(); const b = req.body || {};
    const orig = b.original_document_id || req.query.original;
    if (!orig) return res.status(400).json({ ok: false, error: 'original_document_id obrigatório' });
    res.json({ ok: true, result: await m.createNotaCredito(orig, b) });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ── Agendamentos (G): GCal âncora + Meet → Notion ligado → Directus. ──
const CAL_USER = process.env.AGENDAMENTOS_CALENDAR || 'geral@netmaster.pt';
const CAL_TZ = process.env.AGENDAMENTOS_TZ || 'Europe/Lisbon';
const importGcal = async () => { try { return await import('./lib/google-calendar.js'); } catch { return import('../lib/google-calendar.js'); } };
const importNotion = async () => { try { return await import('./lib/notion.js'); } catch { return import('../lib/notion.js'); } };
app.get('/api/agendamentos', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 100);
    const offset = (page - 1) * limit;
    const url = `/items/agendamentos?fields=id,title,contact_name,contact_email,start,end,status,meet_link,gcal_event_id,notion_url,notes,company.name&sort[]=-start&limit=${limit}&offset=${offset}&meta=filter_count`;
    const r = await fetch(`${DIRECTUS_URL}${url}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await r.json();
    res.json({ rows: json.data || [], total: json.meta?.filter_count ?? (json.data || []).length, page, limit });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Cria um agendamento: GCal (âncora + Meet) → Notion (best-effort) → Directus. Partilhado pelo
// endpoint interno (POST /api/agendamentos) e pela página pública de marcação (POST /api/book/:token).
async function createAgendamento(b) {
  const startIso = b.start;
  const endIso = b.end || new Date(new Date(b.start).getTime() + (Number(b.duration_min) || 30) * 60000).toISOString();
  const title = b.title || `Reunião — ${b.contact_name || b.contact_email}`;
  const [gcal, notion] = await Promise.all([importGcal(), importNotion()]);
  let ev = null; let notionRes = null; const warnings = [];
  if (gcal.isCalendarConfigured()) {
    ev = await gcal.createEvent({ userEmail: CAL_USER, summary: title, description: b.notes || '', startIso, endIso, timezone: CAL_TZ, attendees: [{ email: b.contact_email, displayName: b.contact_name || undefined }] }).catch((e) => { warnings.push('gcal: ' + e.message); return null; });
  } else warnings.push('google desligado / sem domain-wide delegation');
  if (notion.notionEnabled()) {
    notionRes = await notion.createAgendamentoPage({ title, email: b.contact_email, company: b.company_name, startIso, meetLink: ev && ev.meetLink, calendarLink: ev && ev.htmlLink, notes: b.notes }).catch((e) => { warnings.push('notion: ' + e.message); return null; });
  }
  if (ev && notionRes && notionRes.url) await gcal.appendEventDescription({ userEmail: CAL_USER, eventId: ev.id, appendText: `Notion: ${notionRes.url}` }).catch(() => {});
  const row = await dwrite('POST', '/items/agendamentos', {
    title, contact_name: b.contact_name || null, contact_email: b.contact_email,
    start: startIso, end: endIso, status: 'agendado',
    meet_link: (ev && ev.meetLink) || null, gcal_event_id: (ev && ev.id) || null,
    notion_page_id: (notionRes && notionRes.pageId) || null, notion_url: (notionRes && notionRes.url) || null,
    notes: b.notes || null, ...(b.company_id ? { company: b.company_id } : {}),
  });
  return { row, meetLink: (ev && ev.meetLink) || null, warnings };
}
app.post('/api/agendamentos', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.start || !b.contact_email) return res.status(400).json({ ok: false, error: 'start e contact_email obrigatórios' });
    const r = await createAgendamento(b);
    res.json({ ok: true, result: r.row, meetLink: r.meetLink, warnings: r.warnings });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.post('/api/agendamentos/:id/cancel', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ag = await d(`/items/agendamentos/${id}?fields=id,gcal_event_id`).catch(() => null);
    const gcal = await importGcal();
    if (ag && ag.gcal_event_id && gcal.isCalendarConfigured()) await gcal.deleteCalendarEvent({ userEmail: CAL_USER, eventId: ag.gcal_event_id }).catch(() => {});
    await dwrite('PATCH', `/items/agendamentos/${id}`, { status: 'cancelado' });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// --- Página pública de marcação (Book Call) — token-gated (só quem recebeu outreach) -----------
// ⚠️ /book/* e /api/book/* TÊM de ser excluídos do Authentik no NPMplus (como /r/* e /t/*).
const _tzParts = (tz, date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  .formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
const _tzOffMin = (tz, date) => { const p = _tzParts(tz, date); return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime()) / 60000; };
const _localIso = (tz, y, mo, d, h, mi) => { const g = Date.UTC(y, mo - 1, d, h, mi); return new Date(g - _tzOffMin(tz, new Date(g)) * 60000).toISOString(); }; // ISO UTC p/ a hora-parede local (trata DST)
async function bookingSlots({ userEmail, tz, days = 7 }) {
  const now = Date.now();
  let busy = [];
  try { const gcal = await importGcal(); if (gcal.isCalendarConfigured()) busy = await gcal.getBusyIntervals({ userEmail, timeMin: new Date(now).toISOString(), timeMax: new Date(now + (days + 3) * 864e5).toISOString(), timezone: tz }); } catch { /* freebusy off → oferece todos */ }
  const bR = busy.map((b) => [Date.parse(b.start), Date.parse(b.end)]);
  const clash = (s, e) => bR.some(([bs, be]) => s < be && e > bs);
  const out = [];
  for (let dd = 0; dd <= days + 2 && out.length < 21; dd++) {
    const p = _tzParts(tz, new Date(now + dd * 864e5));
    if (p.weekday === 'Sat' || p.weekday === 'Sun') continue;             // dias úteis
    for (let h = 10; h < 17 && out.length < 21; h++) {                    // 10h–17h
      if (h === 13) continue;                                            // almoço
      for (const mi of [0, 30]) {
        const iso = _localIso(tz, +p.year, +p.month, +p.day, h, mi); const s = Date.parse(iso);
        if (s < now + 36e5) continue;                                    // >= 1h de antecedência
        if (!clash(s, s + 18e5)) out.push(iso);
      }
    }
  }
  return out;
}
const _bLookup = async (t) => (await d(`/items/emails?filter[token][_eq]=${encodeURIComponent(t)}&fields=id,token,to_email,to_name,company.id,company.name,site.domain,campaign.from_name&limit=1`).catch(() => []))[0] || null;
const _bEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const _bFmt = (iso, tz) => new Intl.DateTimeFormat('pt-PT', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
function bookHtml(o) {
  const shell = (inner) => `<!doctype html><html lang=pt><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><title>Marcar chamada — Netmaster</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#202124;margin:0;padding:24px;line-height:1.5}.card{max-width:560px;margin:24px auto;background:#fff;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:28px}h1{font-size:20px;margin:0 0 6px}p.sub{color:#5f6368;margin:0 0 20px;font-size:14px}.slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}.slot{padding:10px;border:1px solid #dadce0;border-radius:8px;background:#fff;cursor:pointer;font-size:13px;text-transform:capitalize}.slot:hover{border-color:#2563eb;background:#eff4ff}.slot[disabled]{opacity:.4;cursor:default}.box{border-radius:8px;padding:16px;margin-top:16px}.ok{background:#e6f4ea;border:1px solid #34a853}.err{background:#fce8e6;border:1px solid #d93025}.empty{color:#5f6368;font-size:14px}a{color:#1a73e8}</style><body><div class=card>${inner}</div></body></html>`;
  if (o.notFound) return shell('<h1>Link inválido</h1><p class=sub>Este link de marcação não é válido ou expirou.</p>');
  if (o.error) return shell('<h1>Erro</h1><p class=sub>Não foi possível carregar a marcação. Tenta mais tarde.</p>');
  const btns = (o.slots || []).map((iso) => `<button class=slot data-start="${_bEsc(iso)}">${_bEsc(_bFmt(iso, o.tz))}</button>`).join('');
  const hi = o.name ? `Olá ${_bEsc(String(o.name).split(' ')[0])}, ` : '';
  const tokJs = JSON.stringify(o.token || '').replace(/</g, '\\u003c');
  return shell(`<h1>${hi}vamos falar 30 minutos?</h1><p class=sub>Escolhe um horário (${_bEsc(o.tz)}). Recebes um convite com link Google Meet.</p><div class=slots id=slots>${btns || '<span class=empty>Sem horários nos próximos dias — responde ao email e combinamos.</span>'}</div><div id=result></div><script>const TOK=${tokJs},R=document.getElementById('result'),S=document.getElementById('slots');S.addEventListener('click',async e=>{const b=e.target.closest('.slot');if(!b||b.disabled)return;[...S.querySelectorAll('.slot')].forEach(x=>x.disabled=true);b.textContent='A marcar…';try{const r=await fetch('/api/book/'+encodeURIComponent(TOK),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({start:b.dataset.start})}),j=await r.json();if(j.ok){S.style.display='none';R.innerHTML='<div class="box ok"><b>Chamada marcada!</b><br>Recebes um convite por email'+(j.meetLink?' com o link <a href=\\''+j.meetLink+'\\'>Google Meet</a>':'')+'.</div>';}else{R.innerHTML='<div class="box err"><b>Não deu.</b> '+(j.error||'')+'</div>';[...S.querySelectorAll('.slot')].forEach(x=>x.disabled=false);}}catch(_){R.innerHTML='<div class="box err">Erro de rede — tenta outra vez.</div>';[...S.querySelectorAll('.slot')].forEach(x=>x.disabled=false);}});</script>`);
}
app.get('/book/:token', async (req, res) => {
  try {
    const em = await _bLookup(req.params.token);
    if (!em) return res.status(404).type('html').send(bookHtml({ notFound: true }));
    const slots = await bookingSlots({ userEmail: CAL_USER, tz: CAL_TZ });
    res.type('html').send(bookHtml({ token: req.params.token, name: em.to_name, slots, tz: CAL_TZ }));
  } catch { res.status(500).type('html').send(bookHtml({ error: true })); }
});
app.post('/api/book/:token', async (req, res) => {
  try {
    const em = await _bLookup(req.params.token);
    if (!em || !em.to_email) return res.status(404).json({ ok: false, error: 'link inválido' });
    const start = String(req.body?.start || '');
    const slots = await bookingSlots({ userEmail: CAL_USER, tz: CAL_TZ }); // valida contra os slots livres ATUAIS (anti-abuso)
    if (!slots.includes(start)) return res.status(400).json({ ok: false, error: 'esse horário já não está disponível — recarrega a página' });
    const r = await createAgendamento({ start, contact_email: em.to_email, contact_name: em.to_name || undefined, company_id: em.company?.id, company_name: em.company?.name, title: `Chamada — ${em.company?.name || em.site?.domain || em.to_email}`, notes: `Marcada pelo próprio via /book${em.site?.domain ? ` (${em.site.domain})` : ''}.` });
    void captureServerEvent(req, 'call_booked', posthogDistinctId(req, `book:${req.params.token}`), { domain: em.site?.domain || null });
    res.json({ ok: true, meetLink: r.meetLink, start });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => { ensureFleetDir(); console.log(`NetProspect dashboard em http://localhost:${PORT} (Directus: ${DIRECTUS_URL})`); });
