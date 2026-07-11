// campaign-drip.js — Outreach Fase 2: envia cold outreach em ritmo HUMANIZADO,
// multi-conta, com caps diários + warmup + supressão DNC. Corre no HOST (tem acesso
// a config/sending-accounts.json — segredos não vão para a imagem do worker).
//
// Modelo: o drip é o ÚNICO emissor do cold (não usa a fila NATS) — o volume é baixo
// e deliberadamente lento, por isso um loop controlado é mais simples e seguro que
// nak-thrashing. Escolhe campanhas em status 'sending', puxa e-mails 'ready', salta
// DNC, distribui pelas contas respeitando cap+cooldown, envia e atualiza contadores.
//
// Uso:
//   node campaign-drip.js --dry-run --once            (testa o fluxo, não envia)
//   node campaign-drip.js --gap-min=60 --gap-max=180  (contínuo; usar pm2/nohup)
// Requer: config/sending-accounts.json (exceto em --dry-run sem contas → conta virtual).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readItems, updateItem, createItem } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { makeMailerPool } from './lib/mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const DRY = has('dry-run');
const ONCE = has('once');
const GAP_MIN = parseInt(flag('gap-min', '60'), 10) * 1000;   // gap humanizado por conta (ms)
const GAP_MAX = parseInt(flag('gap-max', '180'), 10) * 1000;
const BATCH = parseInt(flag('batch', '200'), 10);
const IDLE_SLEEP = 60000;                                     // sem trabalho → espera 60s

// Rampa de warmup: cap diário por etapa (dia). Sobe até ao warmup_max da conta.
const WARMUP_RAMP = [5, 10, 15, 25, 35, 50];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1) + a);
const today = () => new Date().toISOString().slice(0, 10);

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'sending-accounts.json'), 'utf8')).filter((a) => a && a.id && a.host); }
  catch { return []; }
}

async function main() {
  const client = makeClient();
  const accounts = loadAccounts();
  const pool = makeMailerPool(accounts);
  if (!accounts.length && !DRY) { console.error('Sem config/sending-accounts.json e não é --dry-run. Nada a enviar.'); process.exit(1); }
  console.log(`Drip: ${accounts.length} conta(s)${DRY ? ' (DRY-RUN)' : ''}. gap ${GAP_MIN / 1000}-${GAP_MAX / 1000}s.`);

  // Estado por conta em memória (espelha o Directus sending_accounts).
  const state = new Map(); // id -> { rowId, sent_today, sent_date, last_sent_at, daily_cap, active }
  async function syncAccounts() {
    for (const a of (accounts.length ? accounts : [{ id: 'dry', warmup_max: 9999 }])) {
      let rows = await client.request(readItems('sending_accounts', { filter: { account_id: { _eq: a.id } }, limit: 1 }));
      let row = rows[0];
      if (!row) row = await client.request(createItem('sending_accounts', { account_id: a.id, label: a.from_email || a.id, from_email: a.from_email, domain: a.domain, ip: a.ip, provider: a.provider, warmup_stage: 0, daily_cap: WARMUP_RAMP[0], sent_today: 0, sent_date: today(), active: true }));
      // reset diário + avanço de warmup
      const patch = {};
      if (row.sent_date !== today()) { patch.sent_today = 0; patch.sent_date = today(); patch.warmup_stage = Math.min((row.warmup_stage || 0) + 1, WARMUP_RAMP.length - 1); }
      const stage = patch.warmup_stage ?? row.warmup_stage ?? 0;
      const cap = Math.min(a.warmup_max || 50, WARMUP_RAMP[Math.min(stage, WARMUP_RAMP.length - 1)]);
      if (cap !== row.daily_cap) patch.daily_cap = cap;
      if (Object.keys(patch).length && !DRY) { await client.request(updateItem('sending_accounts', row.id, patch)); Object.assign(row, patch); }
      state.set(a.id, { rowId: row.id, sent_today: row.sent_today || 0, sent_date: row.sent_date, last_sent_at: row.last_sent_at ? Date.parse(row.last_sent_at) : 0, daily_cap: cap, active: DRY ? true : row.active !== false });
    }
  }

  // Conjunto DNC (emails + domínios) — recarregado por passagem.
  async function loadDnc() {
    const rows = await client.request(readItems('dnc', { fields: ['email', 'domain'], limit: -1 }));
    const emails = new Set(); const domains = new Set();
    for (const r of rows) { if (r.email) emails.add(r.email.toLowerCase()); if (r.domain) domains.add(r.domain.toLowerCase()); }
    return { emails, domains };
  }

  const COOLDOWN = DRY ? 0 : GAP_MIN; // dry-run não espera o gap humanizado
  // Escolhe uma conta disponível (cap não atingido + fora do cooldown). Devolve id|null.
  function pickAccount() {
    const now = Date.now();
    let best = null; let bestWait = Infinity;
    for (const [id, s] of state) {
      if (!s.active || s.sent_today >= s.daily_cap) continue;
      const wait = Math.max(0, (s.last_sent_at + COOLDOWN) - now);
      if (wait === 0) return { id, wait: 0 };
      if (wait < bestWait) { bestWait = wait; best = id; }
    }
    return best ? { id: best, wait: bestWait } : null;
  }

  async function pass() {
    await syncAccounts();
    const dnc = await loadDnc();
    const campaigns = await client.request(readItems('campaigns', { filter: { status: { _eq: 'sending' } }, fields: ['id', 'name'], limit: -1 }));
    if (!campaigns.length) return { sent: 0, idle: true };

    let sent = 0;
    for (const camp of campaigns) {
      const emails = await client.request(readItems('emails', { filter: { campaign: { _eq: camp.id }, status: { _eq: 'ready' } }, fields: ['id', 'to_email', 'to_name', 'subject', 'body', 'token', 'contact.do_not_contact', 'site.domain'], sort: ['id'], limit: BATCH }));
      if (!emails.length) { if (!DRY) await client.request(updateItem('campaigns', camp.id, { status: 'sent', sent_at: new Date().toISOString() })); continue; }

      for (const em of emails) {
        const to = (em.to_email || '').toLowerCase();
        const dom = (em.site?.domain || to.split('@')[1] || '').toLowerCase();
        if (em.contact?.do_not_contact || dnc.emails.has(to) || dnc.domains.has(dom)) {
          if (!DRY) await client.request(updateItem('emails', em.id, { status: 'skipped', error: 'DNC' }));
          continue;
        }
        // espera uma conta disponível
        let acc = pickAccount();
        while (acc && acc.wait > 0) { await sleep(Math.min(acc.wait, 5000)); acc = pickAccount(); }
        if (!acc) break; // todas no cap diário → fim da passagem
        const s = state.get(acc.id);
        const res = DRY ? { ok: true, dryRun: true } : await pool.sendVia(acc.id, { to: em.to_email, toName: em.to_name, subject: em.subject, body: em.body, token: em.token });
        const now = Date.now(); s.last_sent_at = now;
        if (res.ok) {
          s.sent_today++;
          if (!DRY) {
            await client.request(updateItem('emails', em.id, { status: 'sent', sent_at: new Date().toISOString(), send_account: acc.id, error: res.dryRun ? 'dry-run' : null }));
            await client.request(updateItem('sending_accounts', s.rowId, { sent_today: s.sent_today, last_sent_at: new Date().toISOString(), sent_date: today() }));
          }
          sent++;
          console.log(`[${acc.id}] ${em.to_email} ✓ (${s.sent_today}/${s.daily_cap})`);
        } else {
          if (!DRY) await client.request(updateItem('emails', em.id, { status: 'failed', error: (res.error || '').slice(0, 255), send_account: acc.id }));
          console.log(`[${acc.id}] ${em.to_email} ✗ ${res.error}`);
        }
        await sleep(DRY ? 15 : rand(GAP_MIN, GAP_MAX) / Math.max(1, state.size)); // espalha entre contas
        if (DRY && sent >= 10) return { sent, idle: false }; // dry: amostra 10 e sai
      }
    }
    return { sent, idle: sent === 0 };
  }

  for (;;) {
    const { sent, idle } = await pass();
    if (ONCE) { console.log(`\nPassagem concluída. ${sent} enviado(s).`); break; }
    if (idle) await sleep(IDLE_SLEEP);
  }
}

main().catch((e) => { console.error('Erro fatal:', e.errors ? JSON.stringify(e.errors) : e.message); process.exit(1); });
