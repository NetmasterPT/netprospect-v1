// score-leads.js
// Recalcula `lead_score` + `lead_score_breakdown` (+ lead_score_at) para TODOS os
// sites, a partir dos campos gravados e dos pesos em config/lead-score.json.
// UPDATE em massa via SQL (rápido). Ignora sinais com peso 0 (ex.: os de Fase D,
// cujas colunas ainda não existem).
//
// Uso: node score-leads.js            (aplica)
//      node score-leads.js --dry-run  (mostra distribuição sem gravar)

import { execFileSync } from 'node:child_process';
import { loadScoreConfig } from './lib/lead-score.js';
import { loadEnv } from './lib/env.js';

loadEnv();
const DB = process.env.POSTGRES_DB || 'netprospect';
const USER = process.env.POSTGRES_USER || 'netprospect';
const DRY = process.argv.includes('--dry-run');
// Postgres migrado p/ o CT np-db → psql via `docker run` (o host não tem psql binário) contra
// o CT :5432 direto (bulk SQL, não o pgbouncer). Config via env; imagem já puxada localmente.
const HOST = process.env.PG_WRITE_HOST || '100.77.60.44';
const PORT = process.env.PG_DIRECT_PORT || '5432';
const PASS = process.env.POSTGRES_PASSWORD || '';
const IMG = process.env.PG_CLIENT_IMAGE || 'postgis/postgis:16-3.4-alpine';
const psql = (sql) => execFileSync('docker', ['run', '--rm', '-e', `PGPASSWORD=${PASS}`, IMG, 'psql', '-h', HOST, '-p', PORT, '-U', USER, '-d', DB, '-tAc', sql], { encoding: 'utf8' }).trim();

function signalSql(sig, ids) {
  switch (sig) {
    case 'target_platform': return ids.target.length ? `primary_platform IN (${ids.target.join(',')})` : 'false';
    case 'cpanel': return 'is_cpanel = true';
    case 'has_decision_maker': return 'has_decision_maker = true';
    case 'has_email': return 'has_email = true';
    case 'has_valid_email': return 'has_valid_email = true';
    case 'has_phone': return 'has_phone = true';
    case 'spf_problem': return `spf_status IN ('missing','weak','invalid')`;
    case 'dmarc_problem': return `dmarc_status IN ('missing','weak','invalid')`;
    case 'security_high': return `security_severity IN ('high','critical')`;
    case 'security_any': return 'COALESCE(security_findings,0) > 0';
    case 'no_gmb': return 'gmb = false';
    case 'weak_seo': return 'seo_score IS NOT NULL AND seo_score < 60';
    case 'slow_site': return `load_bucket IN ('slow','very_slow')`;
    case 'traffic_ranked': return `traffic_bucket IS NOT NULL AND traffic_bucket <> 'unranked'`;
    // Fase D (colunas já existem) — devem BATER com lib/lead-score.js scoreSite.
    case 'ssl_expiring': return 'ssl_days_left IS NOT NULL AND ssl_days_left <= 21';
    case 'whois_expiring': return 'expiring_soon = true';
    case 'cms_outdated': return 'cms_outdated = true';
    default: return null; // sinal sem SQL — só é ignorado se não tiver mapeamento aqui
  }
}

function main() {
  const cfg = loadScoreConfig();
  const max = cfg.max_score || 100;
  const target = psql(`SELECT string_agg(id::text, ',') FROM platforms WHERE slug IN ('wordpress','woocommerce','prestashop','wix')`);
  const ids = { target: target ? target.split(',') : [] };

  const active = Object.entries(cfg.weights || {}).filter(([sig, w]) => w > 0 && signalSql(sig, ids) != null);
  const scoreExpr = `LEAST(${max}, ${active.map(([sig, w]) => `(CASE WHEN ${signalSql(sig, ids)} THEN ${w} ELSE 0 END)`).join(' + ') || '0'})`;
  const bdExpr = `jsonb_strip_nulls(jsonb_build_object(${active.map(([sig, w]) => `'${sig}', CASE WHEN ${signalSql(sig, ids)} THEN ${w} END`).join(', ')}))`;

  console.log(`Pesos ativos: ${active.map(([s, w]) => `${s}=${w}`).join(' ')}`);
  console.log('Distribuição de score (buckets de 20):');
  console.log(psql(`SELECT width_bucket(${scoreExpr},0,${max + 1},5) AS b, count(*) FROM sites GROUP BY b ORDER BY b`).replace(/\n/g, '  |  ') || '(vazio)');
  if (DRY) { console.log('(dry-run — nada gravado)'); return; }

  const n = psql(`WITH upd AS (UPDATE sites SET lead_score = ${scoreExpr}, lead_score_breakdown = ${bdExpr}, lead_score_at = now() RETURNING 1) SELECT count(*) FROM upd`);
  console.log(`Pontuados ${n} sites. média=${psql('SELECT round(avg(lead_score),1) FROM sites WHERE lead_score IS NOT NULL')} máx=${psql('SELECT max(lead_score) FROM sites')}`);
}

main();
