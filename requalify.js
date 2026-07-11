// requalify.js
// Recalcula `qualified` + `qualified_reasons` para TODOS os sites com a
// qualificação v2 (config/qualification.json), a partir dos campos já gravados.
// Faz um UPDATE em massa via SQL (rápido; 600k+ linhas seriam inviáveis por API).
//
// Uso: node requalify.js            (aplica)
//      node requalify.js --dry-run  (só mostra a contagem que ficaria)

import { execFileSync } from 'node:child_process';
import { loadQualifyConfig } from './lib/qualify.js';
import { loadEnv } from './lib/env.js';

loadEnv();
const PG = process.env.PG_CONTAINER || 'netprospect-postgres-1';
const DB = process.env.POSTGRES_DB || 'netprospect';
const USER = process.env.POSTGRES_USER || 'netprospect';
const DRY = process.argv.includes('--dry-run');

const psql = (sql) => execFileSync('docker', ['exec', '-i', PG, 'psql', '-U', USER, '-d', DB, '-tAc', sql], { encoding: 'utf8' }).trim();

// SQL por sinal (espelha lib/qualify.js). `TARGET`/`SHOPIFY` = ids de plataforma.
function signalSql(sig, ids) {
  switch (sig) {
    case 'target_platform': return ids.target.length ? `primary_platform IN (${ids.target.join(',')})` : 'false';
    case 'shopify': return ids.shopify ? `primary_platform = ${ids.shopify}` : 'false';
    case 'cpanel': return 'is_cpanel = true';
    case 'spf_problem': return `spf_status IN ('missing','weak','invalid')`;
    case 'dmarc_problem': return `dmarc_status IN ('missing','weak','invalid')`;
    case 'security_findings': return 'COALESCE(security_findings,0) > 0';
    case 'no_gmb': return 'gmb = false';
    case 'weak_seo': return 'seo_score IS NOT NULL AND seo_score < 60';
    default: return 'false';
  }
}

function main() {
  const cfg = loadQualifyConfig();
  const target = psql(`SELECT string_agg(id::text, ',') FROM platforms WHERE slug IN ('wordpress','woocommerce','prestashop','wix')`);
  const shopify = psql(`SELECT id FROM platforms WHERE slug='shopify' LIMIT 1`);
  const ids = { target: target ? target.split(',') : [], shopify: shopify || null };

  const conds = cfg.signals_any.map((s) => `(${signalSql(s, ids)})`);
  const anySignal = conds.length ? conds.join(' OR ') : 'false';
  const emailGate = cfg.require_email ? 'has_email = true AND ' : '';
  const qualifiedExpr = `(${emailGate}(${anySignal}))`;
  // reasons = array dos sinais presentes (independente do email), como json.
  const reasonsExpr = `to_json(array_remove(ARRAY[${cfg.signals_any.map((s) => `CASE WHEN ${signalSql(s, ids)} THEN '${s}' END`).join(', ')}], NULL))`;

  console.log(`Config: require_email=${cfg.require_email} signals=[${cfg.signals_any.join(', ')}]`);
  const before = psql('SELECT count(*) FROM sites WHERE qualified');
  const would = psql(`SELECT count(*) FROM sites WHERE ${qualifiedExpr}`);
  console.log(`qualified: agora=${before} -> ficaria=${would}`);
  if (DRY) { console.log('(dry-run — nada gravado)'); return; }

  const n = psql(`WITH upd AS (UPDATE sites SET qualified = ${qualifiedExpr}, qualified_reasons = ${reasonsExpr} RETURNING 1) SELECT count(*) FROM upd`);
  console.log(`Atualizados ${n} sites. qualified agora = ${psql('SELECT count(*) FROM sites WHERE qualified')}.`);
}

main();
