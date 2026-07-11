// export-engaged-to-esp.js — Outreach Fase 3 (escada de reputação).
// Exporta os contactos que JÁ REAGIRAM ao cold outreach (responderam, abriram ou
// clicaram) para um CSV pronto a importar num ESP reputado (Brevo/MailerLite) —
// que empresta a boa reputação de IP deles e serve de peneira de engagement antes
// do tier morno (Mautic+SES). NUNCA exportar a lista fria toda: o Brevo/MailerLite
// bane listas frias/scraped. Só os já-engajados, limpos e sem DNC.
//
// Uso:  node export-engaged-to-esp.js [--out=out/esp-engaged.csv] [--limit=N]
// Depois: importar o CSV no Brevo/MailerLite (ver docs/outreach-ops/05-esp-ladder.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readItems, updateItem } from '@directus/sdk';
import { makeClient } from './lib/directus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const OUT = flag('out', path.join('out', 'esp-engaged.csv'));
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const MARK = argv.includes('--mark'); // marca esp_engaged=true nos exportados

const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
  const client = makeClient();
  const byId = new Map();
  const add = (c, why) => { if (!c?.id || !c.email) return; if (!byId.has(c.id)) byId.set(c.id, { ...c, engagement: why }); };

  // 1) contactos que responderam (imap-poller marcou responded=true).
  const responders = await client.request(readItems('contacts', {
    filter: { responded: { _eq: true }, do_not_contact: { _eq: false }, email: { _nnull: true } },
    fields: ['id', 'name', 'email', 'role', 'company.name', 'site.domain'], limit: -1,
  }));
  for (const c of responders) add(c, 'replied');

  // 2) contactos com e-mails abertos/clicados (engagement de tracking).
  const engagedEmails = await client.request(readItems('emails', {
    filter: { status: { _in: ['opened', 'clicked', 'replied'] } },
    fields: ['status', 'contact.id', 'contact.name', 'contact.email', 'contact.role', 'contact.do_not_contact', 'contact.company.name', 'contact.site.domain'], limit: -1,
  }));
  for (const e of engagedEmails) { const c = e.contact; if (c && !c.do_not_contact) add(c, e.status); }

  let rows = [...byId.values()];
  if (LIMIT) rows = rows.slice(0, LIMIT);
  if (!rows.length) { console.log('Sem contactos engajados a exportar.'); return; }

  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  const header = ['email', 'name', 'role', 'company', 'domain', 'engagement'];
  const lines = [header.join(',')];
  for (const c of rows) lines.push([c.email, c.name || '', c.role || '', c.company?.name || '', c.site?.domain || '', c.engagement].map(csvCell).join(','));
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`✓ ${rows.length} contactos engajados → ${OUT} (importar no Brevo/MailerLite).`);

  if (MARK) { for (const c of rows) await client.request(updateItem('contacts', c.id, { esp_engaged: true })); console.log('  marcados esp_engaged=true.'); }
}

main().catch((e) => { console.error('Erro fatal:', e.errors ? JSON.stringify(e.errors) : e.message); process.exit(1); });
