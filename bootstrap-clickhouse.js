// bootstrap-clickhouse.js — aplica db/clickhouse-schema.sql ao ClickHouse (Fase E).
// Idempotente (CREATE ... IF NOT EXISTS). Requer CLICKHOUSE_URL no ambiente.
//   CLICKHOUSE_URL=http://localhost:8123 node bootstrap-clickhouse.js
// (com o perfil analytics em pé: docker compose --profile analytics up -d clickhouse)

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureSchema, metricsEnabled } from './lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!metricsEnabled()) {
    console.error('CLICKHOUSE_URL não definido — nada a fazer. Define-o e tenta de novo.');
    process.exit(1);
  }
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'clickhouse-schema.sql'), 'utf8');
  console.log('A aplicar esquema ClickHouse (observations + change_events)...');
  const ok = await ensureSchema(sql);
  if (!ok) { console.error('Falha ao aplicar (ver ClickHouse). Verifica credenciais/URL.'); process.exit(1); }
  console.log('✓ Esquema ClickHouse aplicado.');
}
main().catch((e) => { console.error(e); process.exit(1); });
