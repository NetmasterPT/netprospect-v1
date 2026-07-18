#!/usr/bin/env node
// moloni-sync.js — runner CLI do sync de leitura Moloni → Directus (Fase A3).
// Corre no HOST (onde a lib/ + @directus/sdk existem), como os enqueue-*.js.
//
// Uso:   node moloni-sync.js [customers|products|documents|avencas|all]
// Cron (moloni-sync-cron), a cada 30 min:
//   */30 * * * *  cd /root/Github/netprospect-v1 && node moloni-sync.js all >> /var/log/moloni-sync.log 2>&1
import { syncEntity, syncAll } from './lib/moloni-sync.js';

const entity = (process.argv[2] || 'all').toLowerCase();
try {
  const result = entity === 'all' ? await syncAll() : await syncEntity(entity);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('moloni-sync falhou:', e.message);
  process.exit(1);
}
