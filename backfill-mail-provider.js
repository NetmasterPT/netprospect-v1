// backfill-mail-provider.js
// One-off: preenche contacts.mail_provider (gmail/microsoft/yahoo/corp) nos contactos
// VERIFICADOS antes do código que o grava (email_status definido, mail_provider NULL).
// Deriva do MX do domínio da empresa (resolveMx → providerClass), 1 lookup por domínio.
// Idempotente + rate-limited; erros de DNS transitórios saltam (ficam p/ a próxima corrida).
// Domínios sem MX ficam NULL (mail_provider é irrelevante p/ no_mx). NÃO toca em contactos
// não-verificados (esses ganham mail_provider quando forem verificados).
//
// Uso: node backfill-mail-provider.js [--limit=N] [--conc=8] [--dry-run]

import pg from 'pg';
import { loadEnv } from './lib/env.js';
import { resolveMx } from './lib/email-verify.js';
import { providerClass } from './lib/reacher.js';

loadEnv();
const DRY = process.argv.includes('--dry-run');
const flag = (n, d) => { const f = process.argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const CONC = Math.max(1, parseInt(flag('conc', '8'), 10));

const pool = new pg.Pool({
  host: process.env.PG_WRITE_HOST || '100.77.60.44',
  port: parseInt(process.env.PG_DIRECT_PORT || process.env.PG_WRITE_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || process.env.PG_WRITE_USER || 'netprospect',
  password: process.env.POSTGRES_PASSWORD || process.env.PG_WRITE_PASSWORD || '',
  database: process.env.POSTGRES_DB || process.env.PG_WRITE_DB || 'netprospect',
  max: CONC + 2,
});

async function main() {
  const { rows } = await pool.query(`
    SELECT co.org_domain AS domain, count(*)::int AS n
      FROM contacts ct JOIN companies co ON co.id = ct.company
     WHERE ct.mail_provider IS NULL AND ct.email_status IS NOT NULL AND co.org_domain IS NOT NULL
     GROUP BY co.org_domain
     ORDER BY count(*) DESC
     ${LIMIT ? `LIMIT ${LIMIT}` : ''}`);
  console.log(`${rows.length} domínios com contactos verificados sem mail_provider${DRY ? '  [DRY-RUN]' : ''}...`);

  let done = 0, updated = 0, noMx = 0, dnsErr = 0;
  const queue = [...rows];
  async function worker() {
    for (;;) {
      const row = queue.shift();
      if (!row) break;
      done++;
      const mx = await resolveMx(row.domain).catch(() => null);
      if (mx === null) { dnsErr++; continue; }       // DNS transitório → salta (mantém NULL, próxima corrida)
      if (mx.length === 0) { noMx++; continue; }      // sem MX → mail_provider é irrelevante (no_mx permanente)
      const cls = providerClass(mx);
      if (DRY) { if (done <= 20) console.log(`  ${row.domain} → ${cls} (${row.n} contactos)`); continue; }
      const r = await pool.query(
        `UPDATE contacts SET mail_provider = $1
           WHERE mail_provider IS NULL AND email_status IS NOT NULL
             AND company IN (SELECT id FROM companies WHERE org_domain = $2)`,
        [cls, row.domain]);
      updated += r.rowCount;
      if (done % 200 === 0) console.log(`  ${done}/${rows.length} domínios · ${updated} contactos atualizados`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`\nFeito. ${done} domínios (${updated} contactos atualizados · ${noMx} sem-MX saltados · ${dnsErr} erros DNS).`);
  if (DRY) console.log('[DRY-RUN] nada gravado.');
  await pool.end();
}

main().catch((e) => { console.error('Erro fatal:', e.message); process.exit(1); });
