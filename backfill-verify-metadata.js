// backfill-verify-metadata.js
// One-off: preenche a metadata de re-verificação inteligente (reacher-coordinated-plan)
// nos contactos/sites JÁ verificados ANTES do código novo — que ficaram com
// reverify_after=NULL (→ excluídos do re-verify para sempre) e has_valid_email=false.
//
// Faz 3 coisas, tudo bulk-SQL (idempotente; correr as vezes que quiser):
//   1. sites.has_valid_email = true    onde ≥1 contacto email_status='valid'  (→ +10 lead score já)
//   2. contacts.reverify_after         por política, só onde ainda é NULL:
//        valid → +90d · catch_all → +180d · unknown → +5d
//        (permanentes no_mx/role/invalid/disposable ficam NULL — nunca re-verificar)
//   3. companies.catch_all = true      onde ≥1 contacto catch_all (evita re-sondar domínios catch-all)
//
// NÃO faz o mail_provider (precisa do MX por-domínio; preenche-se no próximo re-verify).
// Depois de correr: `node score-leads.js` para propagar o has_valid_email ao lead_score.
//
// Uso: node backfill-verify-metadata.js            (aplica)
//      node backfill-verify-metadata.js --dry-run  (mostra o que mudaria, sem gravar)

import { execFileSync } from 'node:child_process';
import { loadEnv } from './lib/env.js';

loadEnv();
const DRY = process.argv.includes('--dry-run');
const DB = process.env.PG_WRITE_DB || process.env.POSTGRES_DB || 'netprospect';
const USER = process.env.PG_WRITE_USER || process.env.POSTGRES_USER || 'netprospect';
const HOST = process.env.PG_WRITE_HOST || '100.77.60.44';
const PORT = process.env.PG_WRITE_PORT || process.env.PG_DIRECT_PORT || '5432';
const PASS = process.env.PG_WRITE_PASSWORD || process.env.POSTGRES_PASSWORD || '';
const IMG = process.env.PG_CLIENT_IMAGE || 'postgis/postgis:16-3.4-alpine';
const psql = (sql) => execFileSync('docker', ['run', '--rm', '-e', `PGPASSWORD=${PASS}`, IMG, 'psql', '-h', HOST, '-p', PORT, '-U', USER, '-d', DB, '-tAc', sql], { encoding: 'utf8' }).trim();

// [rótulo, SQL de contagem (preview), SQL de UPDATE]
const STEPS = [
  ['sites.has_valid_email (≥1 valid)',
    `SELECT count(*) FROM sites WHERE has_valid_email IS DISTINCT FROM true AND id IN (SELECT site FROM contacts WHERE email_status='valid' AND site IS NOT NULL)`,
    `UPDATE sites SET has_valid_email=true WHERE has_valid_email IS DISTINCT FROM true AND id IN (SELECT site FROM contacts WHERE email_status='valid' AND site IS NOT NULL)`],
  ['contacts.reverify_after valid +90d',
    `SELECT count(*) FROM contacts WHERE email_status='valid' AND reverify_after IS NULL`,
    `UPDATE contacts SET reverify_after = now() + interval '90 days' WHERE email_status='valid' AND reverify_after IS NULL`],
  ['contacts.reverify_after catch_all +180d',
    `SELECT count(*) FROM contacts WHERE email_status='catch_all' AND reverify_after IS NULL`,
    `UPDATE contacts SET reverify_after = now() + interval '180 days' WHERE email_status='catch_all' AND reverify_after IS NULL`],
  ['contacts.reverify_after unknown +5d',
    `SELECT count(*) FROM contacts WHERE email_status='unknown' AND reverify_after IS NULL`,
    `UPDATE contacts SET reverify_after = now() + interval '5 days' WHERE email_status='unknown' AND reverify_after IS NULL`],
  ['companies.catch_all (≥1 catch_all)',
    `SELECT count(*) FROM companies WHERE catch_all IS DISTINCT FROM true AND id IN (SELECT company FROM contacts WHERE email_status='catch_all' AND company IS NOT NULL)`,
    `UPDATE companies SET catch_all=true WHERE catch_all IS DISTINCT FROM true AND id IN (SELECT company FROM contacts WHERE email_status='catch_all' AND company IS NOT NULL)`],
];

console.log(`Backfill de metadata de verificação${DRY ? '  [DRY-RUN]' : ''}\n`);
for (const [label, countSql, updSql] of STEPS) {
  const n = psql(countSql);
  if (DRY) { console.log(`  ${label}: ${n} linhas a mudar`); continue; }
  psql(updSql);
  console.log(`  ${label}: ${n} linhas atualizadas`);
}
if (DRY) console.log('\n[DRY-RUN] nada gravado.');
else console.log('\nFeito. Correr `node score-leads.js` para propagar has_valid_email ao lead_score.');
