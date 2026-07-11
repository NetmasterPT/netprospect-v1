// cleanup-contacts.js — Parte A6: limpa os contactos-lixo descobertos no audit.
//   1) PURGE por padrão/provider (isJunkEmail): support@loopia.se, placeholders, etc.
//   2) PURGE por FREQUÊNCIA: um email em >=N empresas diferentes é lixo (template
//      default tipo emma.nilsson@gmail.com ×399, ou spam de agência).
//   3) DEDUP: para emails legítimos repetidos (2..N-1), guarda o contacto mais RICO
//      e apaga os restantes.
// Relações: emails.contact é m2o SET NULL → apagar contactos não parte campanhas.
//
// SEGURO POR OMISSÃO (dry-run). Uso:
//   node cleanup-contacts.js                 # só mostra o que faria
//   node cleanup-contacts.js --apply         # aplica
//   node cleanup-contacts.js --freq=10 --apply

import { readItems, deleteItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { isJunkEmail } from './lib/email-junk.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const APPLY = argv.includes('--apply');
const FREQ = parseInt(flag('freq', '10'), 10);   // email em >=FREQ empresas → lixo

// "Riqueza" de um contacto (para escolher qual manter no dedup).
const richness = (c) => (c.name ? 2 : 0) + (c.role ? 1 : 0) + (c.role_category && c.role_category !== 'unknown' ? 1 : 0) + (c.phone ? 1 : 0) + (c.email_status === 'valid' ? 2 : 0);

async function main() {
  const client = makeClient();
  console.log(`A carregar contactos com email... (freq-junk >= ${FREQ} empresas)${APPLY ? '' : '  [DRY-RUN]'}`);
  const rows = await client.request(readItems('contacts', { filter: { email: { _nnull: true } }, fields: ['id', 'email', 'name', 'role', 'role_category', 'phone', 'email_status', 'company'], limit: -1 }));
  const byEmail = new Map();
  for (const c of rows) { const e = (c.email || '').toLowerCase(); if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(c); }

  const toDelete = [];
  let nJunk = 0, nFreq = 0, nDup = 0;
  for (const [email, group] of byEmail) {
    const companies = new Set(group.map((c) => c.company).filter(Boolean));
    if (isJunkEmail(email)) { for (const c of group) toDelete.push(c.id); nJunk += group.length; continue; }
    if (companies.size >= FREQ || group.length >= FREQ) { for (const c of group) toDelete.push(c.id); nFreq += group.length; continue; }
    if (group.length > 1) {
      const keep = group.slice().sort((a, b) => richness(b) - richness(a) || a.id - b.id)[0];
      for (const c of group) if (c.id !== keep.id) { toDelete.push(c.id); nDup++; }
    }
  }

  console.log(`\nContactos com email: ${rows.length} | emails distintos: ${byEmail.size}`);
  console.log(`A remover: ${toDelete.length}  (junk-pattern/provider: ${nJunk} · freq>=${FREQ}: ${nFreq} · dedup: ${nDup})`);
  console.log(`Ficam: ${rows.length - toDelete.length} contactos com email + os ${''}sem email (intactos).`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada apagado. Correr com --apply para aplicar.'); return; }
  let done = 0;
  for (let i = 0; i < toDelete.length; i += 200) {
    await client.request(deleteItems('contacts', toDelete.slice(i, i + 200)));
    done += Math.min(200, toDelete.length - i);
    if (done % 2000 === 0 || done === toDelete.length) console.log(`  apagados ${done}/${toDelete.length}`);
  }
  console.log(`\n✓ ${toDelete.length} contactos-lixo removidos.`);
}

main().catch((e) => { console.error('Erro fatal:', e.errors ? JSON.stringify(e.errors) : e.message); process.exit(1); });
