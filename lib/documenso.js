// lib/documenso.js — cliente HTTP do Documenso (assinatura de contratos). Port 1:1
// do netmaster (self-contained, fetch nativo). Bearer token; sem sandbox/live.
// Fail-soft: documensoEnabled().
import { loadEnv } from './env.js';
loadEnv();

export function getDocumensoConfig() {
  const e = process.env;
  // DOCUMENSO_API_BASE = hostname interno p/ REST server-to-server; fallback ao BASE_URL público.
  const cfg = {
    apiBase: e.DOCUMENSO_API_BASE || e.DOCUMENSO_BASE_URL || '',
    token: e.DOCUMENSO_API_TOKEN || '',
    webhookSecret: e.DOCUMENSO_WEBHOOK_SECRET || '',
  };
  if (!cfg.apiBase) throw new Error('Documenso não configurado: falta DOCUMENSO_API_BASE');
  if (!cfg.token) throw new Error('Documenso não configurado: falta DOCUMENSO_API_TOKEN');
  if (!cfg.webhookSecret) throw new Error('Documenso não configurado: falta DOCUMENSO_WEBHOOK_SECRET');
  return cfg;
}
export function documensoEnabled() { try { getDocumensoConfig(); return true; } catch { return false; } }
export const isDocumensoConfigured = documensoEnabled;

export async function documensoCall(path, opts = {}) {
  const cfg = getDocumensoConfig();
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json', ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const text = await res.text();
  if (!text) { if (!res.ok) throw new Error(`Documenso ${path}: HTTP ${res.status} (vazio)`); return {}; }
  let parsed; try { parsed = JSON.parse(text); } catch { throw new Error(`Documenso ${path}: resposta não-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`Documenso ${path}: HTTP ${res.status} — ${String(parsed.message || parsed.error || JSON.stringify(parsed).slice(0, 300))}`);
  return parsed;
}

// Descarrega o PDF assinado de um documento concluído (v2-beta db-transport, fallback v1/S3).
export async function fetchSignedDocumentPdf(documentId) {
  const cfg = getDocumensoConfig();
  const tryUrls = [
    `${cfg.apiBase}/api/v2-beta/document/${encodeURIComponent(documentId)}/download`,
    `${cfg.apiBase}/api/v1/documents/${encodeURIComponent(documentId)}/download`,
  ];
  for (const url of tryUrls) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/pdf,application/json' } });
      if (!res.ok) { console.warn(`[documenso] download ${url} → HTTP ${res.status}`); continue; }
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (ctype.includes('application/json')) {
        const json = await res.json();
        if (!json.downloadUrl) continue;
        const r2 = await fetch(json.downloadUrl);
        if (!r2.ok) continue;
        return Buffer.from(await r2.arrayBuffer());
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) { console.warn(`[documenso] download ${url} erro:`, err.message); }
  }
  return null;
}

// Gera um documento a partir de um template (mapeia o cliente no 1º recipient). Cache 5 min.
const templateCache = new Map();
const TEMPLATE_TTL_MS = 5 * 60000;
async function getTemplateInfo(templateId) {
  const cached = templateCache.get(templateId);
  if (cached && Date.now() - cached.fetchedAt < TEMPLATE_TTL_MS) return cached.info;
  const res = await documensoCall(`/api/v1/templates/${encodeURIComponent(templateId)}`, { method: 'GET' }).catch(() => null);
  let recipients = [];
  if (res && res.recipients && res.recipients.length) recipients = res.recipients;
  else if (res && res.Recipient && res.Recipient.length) recipients = res.Recipient;
  else {
    const list = await documensoCall(`/api/v1/templates?perPage=100`, { method: 'GET' });
    const match = (list.templates || []).find((tpl) => String(tpl.id) === String(templateId));
    recipients = (match && (match.recipients || match.Recipient)) || [];
  }
  const info = { id: (res && res.id) || templateId, recipients };
  templateCache.set(templateId, { fetchedAt: Date.now(), info });
  return info;
}

export async function generateDocumentFromTemplate(params) {
  const tpl = await getTemplateInfo(params.templateId);
  if (!tpl.recipients.length) throw new Error(`Documenso: template ${params.templateId} sem recipients — adiciona um signatário no UI.`);
  const first = tpl.recipients[0];
  const res = await documensoCall(`/api/v1/templates/${encodeURIComponent(params.templateId)}/generate-document`, {
    json: { title: params.title, externalId: params.externalId, recipients: [{ id: first.id, email: params.recipientEmail, name: params.recipientName || params.recipientEmail, role: first.role || 'SIGNER' }], meta: { formValues: params.formValues || {} } },
  });
  const documentId = String(res.documentId || '');
  if (!documentId) throw new Error('Documenso: sem documentId na resposta');
  const signingUrl = (res.recipients && res.recipients[0] && res.recipients[0].signingUrl) || res.signingUrl || `${getDocumensoConfig().apiBase}/sign/${(res.recipients && res.recipients[0] && res.recipients[0].token) || ''}`;
  // generate-document cria em DRAFT → enviar (sem emails; as nossas notificações são canónicas).
  try { await documensoCall(`/api/v1/documents/${encodeURIComponent(documentId)}/send`, { json: { sendEmail: false, sendCompletionEmails: false } }); }
  catch (err) { console.warn(`[documenso] auto-send falhou ${documentId}:`, err.message); }
  return { documentId, signingUrl };
}
