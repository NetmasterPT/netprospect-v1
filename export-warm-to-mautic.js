// export-warm-to-mautic.js — Outreach Fase 4 (tier morno).
// Empurra os contactos MORNOS (responderam ao cold e/ou engajaram no ESP) para o
// Mautic, que depois faz nurture em massa via AWS SES (reputação impecável porque
// já conhecem a marca). Push via API REST do Mautic; fallback = CSV.
//
// Uso:
//   MAUTIC_URL=https://mautic.tld MAUTIC_USER=api MAUTIC_PASS=... node export-warm-to-mautic.js
//   node export-warm-to-mautic.js --out=out/warm.csv        (sem MAUTIC_URL → só CSV)
//   node export-warm-to-mautic.js --engaged-only            (só esp_engaged=true)
// Requer no Mautic: API ativada + Basic Auth (Settings → Configuration → API).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readItems, updateItem } from '@directus/sdk';
import { makeClient } from './lib/directus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const OUT = flag('out', path.join('out', 'warm-contacts.csv'));
const ENGAGED_ONLY = argv.includes('--engaged-only');
const MAUTIC_URL = (process.env.MAUTIC_URL || '').replace(/\/$/, '');
const MAUTIC_AUTH = process.env.MAUTIC_USER ? 'Basic ' + Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS || ''}`).toString('base64') : '';

const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const firstLast = (name) => { const p = String(name || '').trim().split(/\s+/); return { first: p[0] || '', last: p.slice(1).join(' ') || '' }; };

async function pushMautic(c) {
  const { first, last } = firstLast(c.name);
  const body = { email: c.email, firstname: first, lastname: last, company: c.company?.name || '', tags: ['netprospect', 'warm'] };
  const r = await fetch(`${MAUTIC_URL}/api/contacts/new`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: MAUTIC_AUTH }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Mautic HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return (await r.json())?.contact?.id;
}

async function main() {
  const client = makeClient();
  const filter = { do_not_contact: { _eq: false }, email: { _nnull: true }, email_status: { _nin: ['bounced', 'invalid', 'no_mx'] } };
  if (ENGAGED_ONLY) filter.esp_engaged = { _eq: true };
  else filter._or = [{ responded: { _eq: true } }, { esp_engaged: { _eq: true } }];
  const rows = await client.request(readItems('contacts', { filter, fields: ['id', 'name', 'email', 'role', 'company.name', 'site.domain'], limit: -1 }));
  if (!rows.length) { console.log('Sem contactos mornos a exportar.'); return; }

  if (MAUTIC_URL && MAUTIC_AUTH) {
    let ok = 0, fail = 0;
    for (const c of rows) {
      try { await pushMautic(c); ok++; } catch (e) { fail++; console.error(`  ! ${c.email}: ${e.message}`); }
    }
    console.log(`✓ Mautic: ${ok} enviados, ${fail} falhas (de ${rows.length}).`);
  } else {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    const lines = ['email,firstname,lastname,company,domain,role'];
    for (const c of rows) { const { first, last } = firstLast(c.name); lines.push([c.email, first, last, c.company?.name || '', c.site?.domain || '', c.role || ''].map(csvCell).join(',')); }
    fs.writeFileSync(OUT, lines.join('\n') + '\n');
    console.log(`✓ ${rows.length} contactos mornos → ${OUT} (importar no Mautic). Define MAUTIC_URL+MAUTIC_USER para push via API.`);
  }
}

main().catch((e) => { console.error('Erro fatal:', e.errors ? JSON.stringify(e.errors) : e.message); process.exit(1); });
