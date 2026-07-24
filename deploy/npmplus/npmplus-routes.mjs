// npmplus-routes.mjs — versiona os proxy hosts do NPMplus (Camada B: routing) entre a DB SQLite e o git.
// A UI/API do NPMplus fica OIDC-gated → escrevemos a DB direto (node:sqlite nativo, sem deps).
// Corre num container node com a DB montada; ver npmplus-routes.sh (o wrapper que trata da regen).
//
//   node npmplus-routes.mjs export            → imprime routes.json (stdout) da DB
//   node npmplus-routes.mjs apply <routes>    → upsert na DB por domínio (imprime CHANGED se mexeu)
//
// Env: NPMPLUS_DB (default /db/database.sqlite). Identidade de um host = domain_names (json ordenado).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const DB = process.env.NPMPLUS_DB || '/db/database.sqlite';
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
// Chave estável de identidade (domínios ordenados) p/ casar git↔DB.
const domainKey = (dn) => JSON.stringify([...JSON.parse(dn || '[]')].sort());

function openDb() { return new DatabaseSync(DB); }

function exportRoutes() {
  const db = openDb();
  const rows = db.prepare(`SELECT ${COLS.join(',')} FROM proxy_host WHERE is_deleted=0`).all();
  db.close();
  // ordenar por domínio primário p/ diffs estáveis
  rows.sort((a, b) => domainKey(a.domain_names).localeCompare(domainKey(b.domain_names)));
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

function applyRoutes(routesPath) {
  const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
  const db = openDb();
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
      if (COLS.every((c) => String(cur[c] ?? '') === String(r[c] ?? ''))) continue;
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

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'export') exportRoutes();
else if (cmd === 'apply') applyRoutes(arg || '/routes/routes.json');
else { process.stderr.write('uso: npmplus-routes.mjs export | apply <routes.json>\n'); process.exit(2); }
