// lib/pgwrite.js
// Caminho de escrita DIRETA no Postgres (via PgBouncer) para o hot-path dos workers,
// contornando o Directus REST (auth + hooks + validação + 1 upsert por HTTP call). É a
// alavanca A2 do plano postgres-scaling. Ligado por DIRECT_PG_WRITE=true (+ PG_WRITE_*).
// Fail-closed: se desligado/sem config, pgEnabled()=false e os handlers usam o Directus.
// Só escreve dados de máquina (enriquecimento) — não precisa dos hooks/validação do Directus.
import pg from 'pg';
import { updateItem as _updateItem } from '@directus/sdk';
import { publishJob, SUBJECTS } from './jobs.js';

let pool = null;

export function pgEnabled() {
  return process.env.DIRECT_PG_WRITE === 'true' && !!(process.env.PG_WRITE_HOST || process.env.PG_WRITE_URL);
}

export function getPool() {
  if (pool) return pool;
  const base = process.env.PG_WRITE_URL
    ? { connectionString: process.env.PG_WRITE_URL }
    : {
        host: process.env.PG_WRITE_HOST || 'pgbouncer',
        port: parseInt(process.env.PG_WRITE_PORT || '5432', 10),
        user: process.env.PG_WRITE_USER,
        password: process.env.PG_WRITE_PASSWORD,
        database: process.env.PG_WRITE_DB,
      };
  // max baixo por-worker (PgBouncer multiplexa); transaction mode → sem prepared nomeados
  // (node-postgres não os usa por omissão). allowExitOnIdle p/ o worker sair limpo.
  // NB: sem statement_timeout na config (o pg envia-o como startup param e o PgBouncer
  // em transaction mode rejeita-o). Upserts de 1 linha são rápidos; não é crítico.
  pool = new pg.Pool({ ...base, max: parseInt(process.env.PG_WRITE_POOL || '6', 10), idleTimeoutMillis: 30000, allowExitOnIdle: true });
  return pool;
}

// Colunas json de `sites` (precisam de JSON.stringify + cast ::json)
const SITE_JSON = new Set(['hostnames', 'tech_detected', 'social', 'qualified_reasons', 'lead_score_breakdown']);
// Allow-list escrevível de `sites` (tudo menos id/created_at) — espelha o schema atual.
const SITE_COLS = new Set([
  'domain', 'hostnames', 'hosting_ip', 'ptr', 'asn', 'isp', 'ip_country', 'cdn', 'is_live', 'http_status', 'final_url',
  'redirects_www', 'language', 'tech_detected', 'qualified', 'discovered_via', 'checked_at', 'company', 'primary_platform',
  'ip_city', 'contacts_checked_at', 'has_email', 'has_phone', 'business_city', 'business_region', 'business_address', 'social',
  'social_facebook', 'social_instagram', 'social_linkedin', 'social_twitter',
  'social_youtube', 'social_tiktok', 'social_pinterest', 'social_whatsapp', 'whatsapp_number', 'gmb', 'gmb_checked_at', 'gmb_signal', 'gmb_place_id', 'gmb_name',
  'gmb_category', 'gmb_rating', 'gmb_reviews', 'gmb_phone', 'gmb_url', 'is_cpanel', 'cpanel_signal', 'load_ms', 'load_bucket',
  'traffic_rank', 'traffic_bucket', 'spf_status', 'dmarc_status', 'industry', 'industry_confidence', 'seo_score', 'mobile_score',
  'mobile_friendly', 'perf_mobile', 'perf_desktop', 'wp_vuln_count', 'security_findings', 'security_severity', 'audit_status', 'audit_error', 'cheap_checked_at',
  'audit_checked_at', 'has_decision_maker', 'qualified_reasons', 'lead_score', 'lead_score_breakdown', 'lead_score_at',
  'ssl_issuer', 'ssl_not_after', 'ssl_days_left', 'ssl_grade', 'whois_registrar', 'domain_created', 'domain_expiry',
  'domain_age_days', 'expiring_soon', 'whois_checked_at', 'dns_provider', 'cms_version', 'cms_outdated',
  'blocked_datacenter', 'blocked_at',
]);

// UPDATE sites SET ... WHERE id=$1 — 1 statement, só colunas do allow-list. Equivalente
// a client.request(updateItem('sites', id, patch)) mas sem o Directus no meio.
export async function pgUpdateSite(id, patch) {
  const cols = Object.keys(patch).filter((k) => SITE_COLS.has(k) && patch[k] !== undefined);
  if (!cols.length) return;
  const sets = []; const vals = [id];
  for (const c of cols) {
    let v = patch[c];
    if (SITE_JSON.has(c)) { v = v == null ? null : JSON.stringify(v); sets.push(`"${c}" = $${vals.length + 1}::json`); }
    else sets.push(`"${c}" = $${vals.length + 1}`);
    vals.push(v);
  }
  await getPool().query(`UPDATE sites SET ${sets.join(', ')} WHERE id = $1`, vals);
}

// companies — só os campos gerais que os handlers tocam (general_email/general_phone/phones).
const COMPANY_COLS = new Set(['general_email', 'general_phone', 'phones', 'name', 'website', 'source']);
const COMPANY_JSON = new Set(['phones']); // array de E.164 → JSON.stringify + ::json
export async function pgUpdateCompany(id, patch) {
  const cols = Object.keys(patch).filter((k) => COMPANY_COLS.has(k) && patch[k] !== undefined);
  if (!cols.length) return;
  const vals = [id];
  const sets = cols.map((c) => {
    let v = patch[c];
    if (COMPANY_JSON.has(c)) { v = v == null ? null : JSON.stringify(v); vals.push(v); return `"${c}" = $${vals.length}::json`; }
    vals.push(v); return `"${c}" = $${vals.length}`;
  });
  await getPool().query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $1`, vals);
}

// --- Contactos: dedup em 1 leitura + insert multi-linha (A4 — mata a amplificação
// do loop N leituras + N inserts do handleContacts). ---------------------------------
// Chaves de dedup dos contactos existentes da empresa (email OU name|role — espelha o
// filtro original). Devolve um Set p/ dedup em memória.
export async function pgCompanyContactKeys(companyId) {
  const { rows } = await getPool().query('SELECT email, name, role FROM contacts WHERE company = $1', [companyId]);
  const set = new Set();
  for (const c of rows) { if (c.email) set.add('e:' + c.email); set.add('nr:' + (c.name || '') + '|' + (c.role || '')); }
  return set;
}
export function contactKey(p) { return p.email ? 'e:' + p.email : 'nr:' + (p.name || '') + '|' + (p.role || ''); }

const CONTACT_COLS = ['name', 'role', 'role_category', 'email', 'phone', 'phone_country', 'social_profiles', 'source', 'source_detail', 'company', 'site', 'gdpr_basis'];
const CONTACT_JSON = new Set(['social_profiles']);
// INSERT multi-linha (1 statement p/ todos os contactos novos).
export async function pgInsertContacts(rows) {
  if (!rows.length) return;
  const vals = []; const tuples = []; let i = 1;
  for (const r of rows) {
    const ph = [];
    for (const c of CONTACT_COLS) {
      let v = r[c] === undefined ? null : r[c];
      if (CONTACT_JSON.has(c)) { v = v == null ? null : JSON.stringify(v); ph.push(`$${i}::json`); }
      else ph.push(`$${i}`);
      vals.push(v); i++;
    }
    tuples.push('(' + ph.join(', ') + ')');
  }
  const cols = CONTACT_COLS.map((c) => `"${c}"`).join(', ');
  await getPool().query(`INSERT INTO contacts (${cols}) VALUES ${tuples.join(', ')}`, vals);
}

// --- A3 write-behind: flush batched de sites (1 UPDATE p/ N patches heterogéneos) -----
export function writeBehindEnabled() { return process.env.WRITE_BEHIND === 'true'; }

// Tipo pg por coluna escalar (p/ o cast no jsonb-merge). json = SITE_JSON; resto = text.
const SITE_COL_TYPE = {
  asn: 'int', http_status: 'int', company: 'int', primary_platform: 'int', load_ms: 'int', traffic_rank: 'int',
  gmb_reviews: 'int', seo_score: 'int', mobile_score: 'int', perf_mobile: 'int', perf_desktop: 'int', wp_vuln_count: 'int', security_findings: 'int',
  ssl_days_left: 'int', domain_age_days: 'int', lead_score: 'int', gmb_rating: 'real', industry_confidence: 'real',
  is_live: 'bool', redirects_www: 'bool', qualified: 'bool', has_email: 'bool', has_phone: 'bool',
  social_facebook: 'bool', social_instagram: 'bool', social_linkedin: 'bool', social_twitter: 'bool', gmb: 'bool',
  is_cpanel: 'bool', mobile_friendly: 'bool', has_decision_maker: 'bool', expiring_soon: 'bool', cms_outdated: 'bool',
  checked_at: 'ts', contacts_checked_at: 'ts', cheap_checked_at: 'ts', audit_checked_at: 'ts', lead_score_at: 'ts',
  ssl_not_after: 'ts', domain_created: 'ts', domain_expiry: 'ts', whois_checked_at: 'ts',
};
function siteCast(col) {
  if (SITE_JSON.has(col)) return `(d.patch->'${col}')::json`;
  const t = SITE_COL_TYPE[col];
  if (t === 'int') return `(d.patch->>'${col}')::int`;
  if (t === 'real') return `(d.patch->>'${col}')::real`;
  if (t === 'bool') return `(d.patch->>'${col}')::boolean`;
  if (t === 'ts') return `(d.patch->>'${col}')::timestamptz`;
  return `(d.patch->>'${col}')`;
}
let FLUSH_SQL = null;
function flushSql() {
  if (FLUSH_SQL) return FLUSH_SQL;
  // Por coluna: aplica o valor do patch SE a chave existir (`?`), senão mantém o atual.
  // `?` distingue chave-ausente (manter) de valor-null (por a NULL) — semântica correta.
  const sets = [...SITE_COLS].map((c) => `"${c}" = CASE WHEN d.patch ? '${c}' THEN ${siteCast(c)} ELSE s."${c}" END`).join(', ');
  FLUSH_SQL = `UPDATE sites s SET ${sets} FROM (SELECT (e->>'id')::int AS id, e->'patch' AS patch FROM jsonb_array_elements($1::jsonb) e) d WHERE s.id = d.id`;
  return FLUSH_SQL;
}
// batch = [{id, patch}] — DEVE vir coalescido por id (1 entrada por site) senão o
// UPDATE...FROM escolhe uma linha d arbitrária por s.id. Filtra colunas fora do allow-list.
export async function pgFlushSites(batch) {
  if (!batch.length) return;
  const clean = batch.map(({ id, patch }) => {
    const p = {};
    for (const k of Object.keys(patch)) if (SITE_COLS.has(k) && patch[k] !== undefined) p[k] = patch[k];
    return { id, patch: p };
  }).filter((b) => Object.keys(b.patch).length);
  if (!clean.length) return;
  await getPool().query(flushSql(), [JSON.stringify(clean)]);
}

// --- A2+ : upserts diretos p/ o hot-path do enrich (contorna o Directus) ---------------
// upsertSite: INSERT ... ON CONFLICT (domain) DO UPDATE (todos os campos) RETURNING id.
// Substitui o read+create/update do upsertSite por 1 statement, sem o Directus no meio.
export async function pgUpsertSite(payload) {
  const cols = Object.keys(payload).filter((k) => SITE_COLS.has(k) && payload[k] !== undefined);
  if (!cols.includes('domain')) throw new Error('pgUpsertSite: payload sem domain');
  const vals = []; const ph = [];
  for (const c of cols) {
    let v = payload[c];
    if (SITE_JSON.has(c)) { v = v == null ? null : JSON.stringify(v); ph.push(`$${vals.length + 1}::json`); }
    else ph.push(`$${vals.length + 1}`);
    vals.push(v);
  }
  const set = cols.filter((c) => c !== 'domain').map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
  const sql = `INSERT INTO sites (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${ph.join(', ')}) ON CONFLICT (domain) DO UPDATE SET ${set} RETURNING id`;
  return (await getPool().query(sql, vals)).rows[0].id;
}

// upsertCompany: dedup por org_domain; ON CONFLICT preenche SÓ os campos vazios (COALESCE
// do existente) — mesma semântica "fill-empty" do upsertSite. RETURNING id.
const COMPANY_UPSERT_COLS = ['org_domain', 'name', 'website', 'general_email', 'general_phone', 'country', 'source'];
export async function pgUpsertCompany(payload) {
  const cols = COMPANY_UPSERT_COLS.filter((c) => payload[c] !== undefined);
  const vals = cols.map((c) => payload[c]);
  const ph = cols.map((_, i) => `$${i + 1}`);
  const set = cols.filter((c) => c !== 'org_domain' && c !== 'source')
    .map((c) => `"${c}" = COALESCE(companies."${c}", EXCLUDED."${c}")`).join(', ');
  const sql = `INSERT INTO companies (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${ph.join(', ')}) ON CONFLICT (org_domain) DO UPDATE SET ${set || '"org_domain" = companies."org_domain"'} RETURNING id`;
  return (await getPool().query(sql, vals)).rows[0].id;
}

// M2M sites_platforms — insere só as ligações em falta (1 read + 1 insert multi-linha).
export async function pgEnsurePlatforms(siteId, pids) {
  if (!pids || !pids.length) return;
  const pool = getPool();
  const { rows } = await pool.query('SELECT platform FROM sites_platforms WHERE site = $1', [siteId]);
  const have = new Set(rows.map((r) => r.platform));
  const missing = [...new Set(pids)].filter((p) => !have.has(p));
  if (!missing.length) return;
  const vals = []; const tuples = [];
  for (const p of missing) { tuples.push(`($${vals.length + 1}, $${vals.length + 2})`); vals.push(siteId, p); }
  await pool.query(`INSERT INTO sites_platforms (site, platform) VALUES ${tuples.join(', ')}`, vals);
}

export async function pgClose() { if (pool) { await pool.end(); pool = null; } }

// --- Drop-in para os handlers (zero alterações nos call-sites) ---------------
// Substitui o `updateItem` do @directus/sdk: p/ sites/companies com DIRECT_PG on,
// devolve um marcador que o client envolvido (wrapClientPg) intercepta e escreve
// direto no PG; para tudo o resto (ou DIRECT_PG off), devolve o comando Directus normal.
export function updateItemMaybePg(coll, id, patch) {
  if (pgEnabled() && (coll === 'sites' || coll === 'companies')) return { __pgwrite: { coll, id, patch } };
  return _updateItem(coll, id, patch);
}

// Envolve o client Directus: intercepta os marcadores __pgwrite (→ PG direto) e
// delega tudo o resto no client real. Object.create preserva os métodos do real.
export function wrapClientPg(real, js = null) {
  if (!pgEnabled()) return real;
  const wb = !!js && writeBehindEnabled(); // write-behind só se houver js (NATS) + flag
  const w = Object.create(real);
  w.request = (cmd) => {
    if (cmd && cmd.__pgwrite) {
      const { coll, id, patch } = cmd.__pgwrite;
      if (coll === 'companies') return pgUpdateCompany(id, patch); // baixo volume → sempre direto
      // sites: A3 write-behind (publica p/ o pool de writers, sem msgId — cada patch é
      // distinto) OU escrita direta (A2). O writer é idempotente (redelivery → re-UPDATE).
      if (wb) return publishJob(js, SUBJECTS.resultSite, { id, patch });
      return pgUpdateSite(id, patch);
    }
    return real.request(cmd);
  };
  return w;
}
