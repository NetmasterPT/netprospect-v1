// npmplus-routes.mjs — versiona os proxy hosts do NPMplus (Camada B: routing) entre a fonte-de-verdade e o git.
// Dois métodos (env NPMPLUS_ROUTES_METHOD), ambos produzem/consomem o MESMO routes.json (shape idêntico):
//   • sqlite (default, seguro) — escreve/lê a DB SQLite direto (node:sqlite nativo, sem deps). Corre num
//                                container node com a DB montada; ver npmplus-routes.sh.
//   • api                     — usa a REST API do NPMplus (login local → cookie JWT → /api/nginx/proxy-hosts).
//                                A API valida `nginx -t` + faz reload sozinha (não precisa de restart).
//
//   node npmplus-routes.mjs export            → imprime routes.json (stdout) da fonte
//   node npmplus-routes.mjs apply <routes>    → upsert por domínio (imprime CHANGED se mexeu; NUNCA apaga)
//
// Env (sqlite): NPMPLUS_DB (default /db/database.sqlite).
// Env (api):    NPMPLUS_API_URL (default https://127.0.0.1:443), NPMPLUS_API_HOST (default npm.netmaster.pt),
//               NPMPLUS_API_EMAIL, NPMPLUS_API_PASSWORD (user LOCAL do NPM com roles=[admin] + user_permission).
// Identidade de um host = domain_names (array ordenado) — casa git↔fonte independentemente do método.
import { readFileSync } from 'node:fs';

// Colunas DECLARATIVAS (o que versionamos). Excluídas: id, created_on, modified_on, owner_user_id, is_deleted.
const COLS = [
  'domain_names', 'forward_scheme', 'forward_host', 'forward_port', 'enabled',
  'ssl_forced', 'caching_enabled', 'block_exploits', 'allow_websocket_upgrade', 'http2_support',
  'hsts_enabled', 'hsts_subdomains', 'trust_forwarded_proto', 'access_list_id', 'certificate_id',
  'advanced_config', 'locations', 'meta',
  'npmplus_proxy_request_buffering', 'npmplus_proxy_response_buffering', 'npmplus_noindex',
  'npmplus_x_frame_options', 'npmplus_auth_request', 'npmplus_http3_support',
  'npmplus_crowdsec_appsec', 'npmplus_upstream_compression', 'npmplus_fancyindex',
];
// Colunas guardadas como JSON (string na DB SQLite; array/objeto na API — normalizamos SEMPRE para string).
const JSON_COLS = new Set(['domain_names', 'locations', 'meta']);
// Colunas boolean 0/1 (int na DB; boolean na API). No routes.json ficam sempre 0/1.
const BOOL_COLS = new Set([
  'enabled', 'ssl_forced', 'caching_enabled', 'block_exploits', 'allow_websocket_upgrade',
  'http2_support', 'hsts_enabled', 'hsts_subdomains', 'trust_forwarded_proto',
  'npmplus_proxy_request_buffering', 'npmplus_proxy_response_buffering', 'npmplus_noindex',
  'npmplus_http3_support', 'npmplus_crowdsec_appsec', 'npmplus_upstream_compression', 'npmplus_fancyindex',
]);

// Chave estável de identidade (domínios ordenados) p/ casar git↔fonte. Aceita string (DB/routes.json) ou array (API).
const domainKey = (dn) =>
  JSON.stringify([...(typeof dn === 'string' ? JSON.parse(dn || '[]') : (dn || []))].sort());
// Duas linhas declarativas são iguais? (comparação tolerante a int/'string', igual em ambos os métodos)
const rowsEqual = (a, b) => COLS.every((c) => String(a[c] ?? '') === String(b[c] ?? ''));

// Emite o routes.json (ordenado por domínio p/ diffs estáveis) — IDÊNTICO nos dois métodos.
function emitRows(rows) {
  rows.sort((a, b) => domainKey(a.domain_names).localeCompare(domainKey(b.domain_names)));
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

// ─────────────────────────────── método SQLite (default) ───────────────────────────────
const DB = process.env.NPMPLUS_DB || '/db/database.sqlite';
async function openDb() {
  // Import lazy: só o método sqlite precisa de node:sqlite (exige --experimental-sqlite). O método api
  // corre com `node` puro, sem a flag e sem o warning experimental.
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(DB);
}

async function exportRoutesSqlite() {
  const db = await openDb();
  const rows = db.prepare(`SELECT ${COLS.join(',')} FROM proxy_host WHERE is_deleted=0`).all();
  db.close();
  emitRows(rows);
}

async function applyRoutesSqlite(routesPath) {
  const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
  const db = await openDb();
  const existing = db.prepare('SELECT id, domain_names FROM proxy_host WHERE is_deleted=0').all();
  const byKey = new Map(existing.map((r) => [domainKey(r.domain_names), r.id]));
  let changed = 0;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const setSql = COLS.map((c) => `${c}=?`).join(',');
  const upd = db.prepare(`UPDATE proxy_host SET ${setSql}, modified_on=? WHERE id=?`);
  const insCols = [...COLS, 'created_on', 'modified_on', 'owner_user_id', 'is_deleted'];
  const ins = db.prepare(`INSERT INTO proxy_host (${insCols.join(',')}) VALUES (${insCols.map(() => '?').join(',')})`);
  for (const r of routes) {
    const vals = COLS.map((c) => (r[c] === undefined || r[c] === null ? null : r[c]));
    const id = byKey.get(domainKey(r.domain_names));
    if (id) {
      // só escreve se algo mudou (idempotente) — compara a linha atual
      const cur = db.prepare(`SELECT ${COLS.join(',')} FROM proxy_host WHERE id=?`).get(id);
      if (rowsEqual(cur, r)) continue;
      upd.run(...vals, now, id); changed++;
      process.stderr.write(`~ atualizado: ${r.domain_names}\n`);
    } else {
      ins.run(...vals, now, now, 1, 0); changed++;
      process.stderr.write(`+ criado: ${r.domain_names}\n`);
    }
  }
  db.close();
  // NB: NÃO apagamos hosts que existam na DB mas não no git (segurança: a UI pode ter extras legítimos).
  process.stdout.write(changed ? `CHANGED ${changed}\n` : 'NOCHANGE\n');
}

// ──────────────────────────────────── método API ────────────────────────────────────
// Nota: usamos node:https (não o fetch global) porque precisamos de um https.Agent com
// rejectUnauthorized:false (TLS mismatch em 127.0.0.1) — o fetch/undici não aceita um agente node:https.
const API_URL = process.env.NPMPLUS_API_URL || 'https://127.0.0.1:443';
const API_HOST = process.env.NPMPLUS_API_HOST || 'npm.netmaster.pt';
const API_EMAIL = process.env.NPMPLUS_API_EMAIL;
const API_PASSWORD = process.env.NPMPLUS_API_PASSWORD;

// Pedido HTTPS ao NPMplus. Sempre com header Host (senão cai no default server → 302) e cert ignorado.
async function apiRequest(method, path, { cookie, body } = {}) {
  const https = await import('node:https');
  const base = new URL(API_URL);
  const opts = {
    method,
    hostname: base.hostname,
    port: base.port || 443,
    path,
    agent: new https.Agent({ rejectUnauthorized: false }),
    headers: { Host: API_HOST, Accept: 'application/json' },
  };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['Content-Length'] = Buffer.byteLength(payload);
  }
  if (cookie) opts.headers.Cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Login: POST /api/tokens → o JWT vem num COOKIE `token=…` (o backend lê SÓ do cookie; Bearer não funciona).
// GOTCHA: password errada → HTTP 400 + cookie vazio → chamadas seguintes dão "Permission Denied" (parece
// erro de autz mas é token ausente). Por isso exigimos login===200 e devolvemos um erro claro.
async function apiLogin() {
  if (!API_EMAIL || !API_PASSWORD) {
    throw new Error('método api: faltam NPMPLUS_API_EMAIL / NPMPLUS_API_PASSWORD no ambiente');
  }
  const res = await apiRequest('POST', '/api/tokens', { body: { identity: API_EMAIL, secret: API_PASSWORD } });
  if (res.status !== 200) {
    throw new Error(`login falhou (HTTP ${res.status}) — verifica NPMPLUS_API_EMAIL/PASSWORD (400 = credenciais). Corpo: ${res.body.slice(0, 200)}`);
  }
  const setCookie = res.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('token='));
  if (!cookie) throw new Error('login devolveu 200 mas sem cookie `token` no Set-Cookie');
  return cookie; // 'token=…'
}

async function apiListHosts(cookie) {
  const res = await apiRequest('GET', '/api/nginx/proxy-hosts', { cookie });
  if (res.status !== 200) throw new Error(`GET /api/nginx/proxy-hosts falhou (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

// API host → linha declarativa (mesmo shape que o export sqlite): JSON cols → string; booleans → 0/1.
function hostToRow(h) {
  const row = {};
  for (const c of COLS) {
    let v = h[c];
    if (JSON_COLS.has(c)) v = typeof v === 'string' ? v : JSON.stringify(v ?? (c === 'meta' ? {} : []));
    else if (v === true) v = 1;
    else if (v === false) v = 0;
    row[c] = v === undefined ? null : v;
  }
  return row;
}

// Linha declarativa (routes.json) → corpo da API: JSON cols → objeto/array; 0/1 → boolean.
function rowToApiBody(r) {
  const body = {};
  for (const c of COLS) {
    let v = r[c];
    if (JSON_COLS.has(c)) v = v == null ? (c === 'meta' ? {} : []) : (typeof v === 'string' ? JSON.parse(v) : v);
    else if (BOOL_COLS.has(c)) v = v === 1 || v === true || v === '1';
    body[c] = v;
  }
  return body;
}

async function exportRoutesApi() {
  const cookie = await apiLogin();
  const hosts = await apiListHosts(cookie);
  emitRows(hosts.map(hostToRow));
}

async function applyRoutesApi(routesPath) {
  const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
  const cookie = await apiLogin();
  const hosts = await apiListHosts(cookie);
  const byKey = new Map(hosts.map((h) => [domainKey(h.domain_names), h]));
  let changed = 0;
  for (const r of routes) {
    const host = byKey.get(domainKey(r.domain_names));
    if (host) {
      if (rowsEqual(hostToRow(host), r)) continue; // idempotente
      const res = await apiRequest('PUT', `/api/nginx/proxy-hosts/${host.id}`, { cookie, body: rowToApiBody(r) });
      if (res.status !== 200) throw new Error(`PUT ${r.domain_names} falhou (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
      changed++; process.stderr.write(`~ atualizado: ${r.domain_names}\n`);
    } else {
      const res = await apiRequest('POST', '/api/nginx/proxy-hosts', { cookie, body: rowToApiBody(r) });
      if (res.status !== 200 && res.status !== 201) throw new Error(`POST ${r.domain_names} falhou (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
      changed++; process.stderr.write(`+ criado: ${r.domain_names}\n`);
    }
  }
  // NB: NÃO apagamos hosts existentes que não estejam no git (segurança, igual ao método sqlite).
  process.stdout.write(changed ? `CHANGED ${changed}\n` : 'NOCHANGE\n');
}

// ──────────────────────────────────── dispatch ────────────────────────────────────
const METHOD = (process.env.NPMPLUS_ROUTES_METHOD || 'api').toLowerCase();
const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'export') {
    if (METHOD === 'api') await exportRoutesApi();
    else await exportRoutesSqlite();
  } else if (cmd === 'apply') {
    const routesPath = arg || '/routes/routes.json';
    if (METHOD === 'api') await applyRoutesApi(routesPath);
    else await applyRoutesSqlite(routesPath);
  } else {
    process.stderr.write('uso: npmplus-routes.mjs export | apply <routes.json>  (env NPMPLUS_ROUTES_METHOD=api|sqlite)\n');
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`erro (método=${METHOD}): ${e.message}\n`);
  process.exit(1);
}
