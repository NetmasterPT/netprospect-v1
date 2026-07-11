// imap-poller.js — Outreach Fase 2: lê as mailboxes de ENVIO por IMAP e trata
//   • Bounces (DSN)  → contacts.email_status='bounced' + do_not_contact + dnc(bounce)
//   • Respostas humanas → contacts.responded=true + dnc(replied_stop) (para o cold);
//     o contacto passa a candidato do tier morno (Fase 3/4).
//
// Corre no HOST (acesso a config/sending-accounts.json). Idempotente: marca as
// mensagens como lidas (\Seen) depois de processar.
//
// Uso: node imap-poller.js --once            (uma passagem a todas as mailboxes)
//      node imap-poller.js                   (contínuo; usar pm2/nohup)
//      node imap-poller.js --dry-run         (classifica e imprime, não escreve)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readItems, updateItem, createItem } from '@directus/sdk';
import { makeClient } from './lib/directus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const ONCE = argv.includes('--once');
const POLL_MS = parseInt((argv.find((a) => a.startsWith('--interval=')) || '').split('=')[1] || '300', 10) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'sending-accounts.json'), 'utf8')).filter((a) => a && a.id && a.host); }
  catch { return []; }
}

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery|delivery-status/i;
const BOUNCE_SUBJ = /undeliver|delivery status|mail delivery (failed|subsystem)|returned mail|failure notice|delivery failure/i;
const emailRe = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/i;

// Extrai o destinatário que falhou + severidade de um corpo de DSN.
function parseBounce(text) {
  const t = text || '';
  const rcpt = (t.match(/(?:Final-Recipient|Original-Recipient)\s*:\s*[^;]*;\s*<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24})>?/i) || [])[1];
  const status = (t.match(/Status\s*:\s*([245])\.\d+\.\d+/i) || [])[1];
  const hard = status ? status === '5' : /5\.\d\.\d|550|551|553|554/.test(t);
  return { rcpt: rcpt ? rcpt.toLowerCase() : null, hard };
}

async function upsertDnc(client, { email, domain, reason, source }) {
  const filter = email ? { email: { _eq: email } } : { domain: { _eq: domain } };
  const ex = await client.request(readItems('dnc', { filter, fields: ['id'], limit: 1 }));
  if (ex.length) return;
  await client.request(createItem('dnc', { email: email || null, domain: domain || null, reason, source }));
}

async function findContactByEmail(client, email) {
  const rows = await client.request(readItems('contacts', { filter: { email: { _eq: email } }, fields: ['id', 'company'], limit: 1 }));
  return rows[0] || null;
}

async function handleMessage(client, parsed, accountId) {
  const from = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  const subject = parsed.subject || '';
  const body = `${parsed.text || ''}\n${parsed.html || ''}`;
  const isBounce = BOUNCE_FROM.test(from) || BOUNCE_SUBJ.test(subject) || /content-type:\s*message\/delivery-status/i.test(body);

  if (isBounce) {
    const { rcpt, hard } = parseBounce(body);
    const failed = rcpt || (body.match(emailRe) || [])[0]?.toLowerCase();
    if (!failed) return { type: 'bounce', skipped: true };
    if (!DRY) {
      const c = await findContactByEmail(client, failed);
      if (c) await client.request(updateItem('contacts', c.id, { email_status: 'bounced', email_verified: false, do_not_contact: true }));
      await upsertDnc(client, { email: failed, reason: 'bounce', source: accountId });
      // marca os emails desta campanha para este destinatário como bounced
      const ems = await client.request(readItems('emails', { filter: { to_email: { _eq: failed } }, fields: ['id'], limit: -1 }));
      for (const e of ems) await client.request(updateItem('emails', e.id, { status: 'bounced', bounce_type: hard ? 'hard' : 'soft' }));
    }
    return { type: 'bounce', failed, hard };
  }

  // Resposta humana → responded + stop cold (dnc replied_stop). Candidato warm.
  if (from) {
    if (!DRY) {
      const c = await findContactByEmail(client, from);
      if (c) await client.request(updateItem('contacts', c.id, { responded: true, responded_at: new Date().toISOString() }));
      await upsertDnc(client, { email: from, reason: 'replied_stop', source: accountId });
    }
    return { type: 'reply', from };
  }
  return { type: 'other' };
}

async function pollAccount(client, a) {
  const imap = new ImapFlow({
    host: a.imap_host || a.host, port: a.imap_port || 993, secure: a.imap_secure !== false,
    auth: { user: a.user, pass: a.pass }, logger: false,
  });
  let n = 0;
  try {
    await imap.connect();
    const lock = await imap.getMailboxLock('INBOX');
    try {
      for await (const msg of imap.fetch({ seen: false }, { source: true, uid: true })) {
        const parsed = await simpleParser(msg.source);
        const r = await handleMessage(client, parsed, a.id);
        console.log(`  [${a.id}] ${r.type}${r.failed ? ` ${r.failed}(${r.hard ? 'hard' : 'soft'})` : ''}${r.from ? ` ${r.from}` : ''}`);
        if (!DRY) await imap.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
        n++;
      }
    } finally { lock.release(); }
  } catch (e) { console.error(`  [${a.id}] IMAP erro: ${e.message}`); }
  finally { try { await imap.logout(); } catch { /* ignore */ } }
  return n;
}

async function main() {
  const accounts = loadAccounts();
  if (!accounts.length) { console.error('Sem config/sending-accounts.json — nada para consultar.'); process.exit(1); }
  const client = makeClient();
  console.log(`IMAP poller: ${accounts.length} mailbox(es)${DRY ? ' (DRY-RUN)' : ''}.`);
  for (;;) {
    let total = 0;
    for (const a of accounts) total += await pollAccount(client, a);
    console.log(`Passagem: ${total} mensagem(ns) processada(s).`);
    if (ONCE) break;
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error('Erro fatal:', e.errors ? JSON.stringify(e.errors) : e.message); process.exit(1); });
