// lib/mailer.js — envio de e-mails de campanha.
//   Fase F: transporte SMTP único (env SMTP_*), dry-run sem config.
//   Outreach Fase 2: POOL multi-conta (makeMailerPool) — 1 transporte por mailbox
//   das VMs de envio (config/sending-accounts.json), para round-robin + caps + warmup.
//
// Tracking: pixel de abertura + wrapping de links (clique) → /t/o/:token e /t/c/:token.
// Rodapé de opt-out + cabeçalho List-Unsubscribe one-click (exigido pelo Gmail/Yahoo 2024).

import nodemailer from 'nodemailer';

const S = {
  host: process.env.SMTP_HOST || '',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  secure: process.env.SMTP_SECURE === 'true', // true=465, false=587/STARTTLS
};
const TRACK_BASE = (process.env.CAMPAIGN_TRACK_BASE || process.env.DIRECTUS_PUBLIC_URL || '').replace(/\/$/, '');
const UNSUB_MAILTO = process.env.CAMPAIGN_UNSUB_EMAIL || '';

export const mailerMode = () => (S.host && S.user ? 'smtp' : 'dry');
export const mailerEnabled = () => mailerMode() === 'smtp';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unsubUrl = (token) => (TRACK_BASE && token ? `${TRACK_BASE}/t/u/${encodeURIComponent(token)}` : '');

// Corpo texto → HTML: escapa, nl→<br>, envolve URLs em links de tracking, rodapé opt-out.
function textToHtml(text, token) {
  let html = esc(text).replace(/\r?\n/g, '<br>\n');
  html = html.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    const href = (TRACK_BASE && token) ? `${TRACK_BASE}/t/c/${encodeURIComponent(token)}?u=${encodeURIComponent(url)}` : url;
    return `<a href="${esc(href)}" style="color:#2563eb">${esc(url)}</a>`;
  });
  const pixel = (TRACK_BASE && token) ? `<img src="${esc(TRACK_BASE)}/t/o/${encodeURIComponent(token)}" width="1" height="1" alt="" style="display:none">` : '';
  const u = unsubUrl(token);
  const unsub = `<div style="margin-top:24px;color:#9aa0a6;font-size:11px">Se não quer receber mais contactos, ${u ? `<a href="${esc(u)}" style="color:#9aa0a6">clique aqui para sair</a> ou ` : ''}responda com "remover"${UNSUB_MAILTO ? ` ou escreva para <a href="mailto:${esc(UNSUB_MAILTO)}" style="color:#9aa0a6">${esc(UNSUB_MAILTO)}</a>` : ''}.</div>`;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;color:#202124">${html}${unsub}${pixel}</div>`;
}

// Constrói o objeto de mensagem nodemailer (comum a sendEmail e ao pool).
function buildMessage({ to, toName, from, fromName, replyTo, subject, body, token }) {
  const headers = {};
  const parts = [];
  const u = unsubUrl(token);
  if (u) { parts.push(`<${u}>`); headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'; }
  if (UNSUB_MAILTO) parts.push(`<mailto:${UNSUB_MAILTO}?subject=unsubscribe>`);
  if (parts.length) headers['List-Unsubscribe'] = parts.join(', ');
  return {
    from: fromName ? `${fromName} <${from}>` : from,
    to: toName ? `${toName} <${to}>` : to,
    replyTo: replyTo || undefined,
    subject,
    text: `${body}\n\n---\nNetmaster`,
    html: textToHtml(body, token),
    headers,
  };
}

// --- Fase F: transporte único (env) ------------------------------------------
let _tx = null;
function transport() {
  if (_tx) return _tx;
  _tx = nodemailer.createTransport({ host: S.host, port: S.port, secure: S.secure, auth: { user: S.user, pass: S.pass } });
  return _tx;
}
// Envia via o transporte env (ou dry-run). Devolve { ok, dryRun?, messageId?, error? }.
export async function sendEmail({ to, toName, from, fromName, replyTo, subject, body, token } = {}) {
  if (!to || !subject || !body) return { ok: false, error: 'to/subject/body em falta' };
  if (mailerMode() === 'dry') return { ok: true, dryRun: true, messageId: `dry-${token || to}` };
  try {
    const info = await transport().sendMail(buildMessage({ to, toName, from, fromName, replyTo, subject, body, token }));
    return { ok: true, messageId: info.messageId };
  } catch (e) { return { ok: false, error: e.message }; }
}
export async function verifyTransport() {
  if (mailerMode() === 'dry') return { ok: true, mode: 'dry' };
  try { await transport().verify(); return { ok: true, mode: 'smtp', host: S.host }; }
  catch (e) { return { ok: false, mode: 'smtp', error: e.message }; }
}

// --- Outreach Fase 2: pool multi-conta ---------------------------------------
// accounts = [{ id, host, port, secure, user, pass, from_email, from_name }].
// Um transporte memoizado por conta. sendVia(id, {...}) usa a identidade da conta
// (from_email/from_name da conta prevalecem se não forem passados no argumento).
export function makeMailerPool(accounts = []) {
  const byId = new Map(accounts.filter((a) => a && a.id).map((a) => [a.id, a]));
  const tx = new Map();
  const transportFor = (a) => {
    if (!tx.has(a.id)) tx.set(a.id, nodemailer.createTransport({ host: a.host, port: a.port, secure: !!a.secure, auth: { user: a.user, pass: a.pass } }));
    return tx.get(a.id);
  };
  async function sendVia(id, { to, toName, replyTo, subject, body, token } = {}) {
    const a = byId.get(id);
    if (!a) return { ok: false, error: `conta '${id}' desconhecida` };
    if (!to || !subject || !body) return { ok: false, error: 'to/subject/body em falta' };
    const msg = buildMessage({ to, toName, from: a.from_email || a.user, fromName: a.from_name, replyTo: replyTo || a.from_email || a.user, subject, body, token });
    try { const info = await transportFor(a).sendMail(msg); return { ok: true, messageId: info.messageId, account: id }; }
    catch (e) { return { ok: false, error: e.message, account: id }; }
  }
  async function verify(id) {
    const a = byId.get(id); if (!a) return { ok: false, error: 'unknown' };
    try { await transportFor(a).verify(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  }
  return { has: (id) => byId.has(id), accountIds: () => [...byId.keys()], sendVia, verify };
}
