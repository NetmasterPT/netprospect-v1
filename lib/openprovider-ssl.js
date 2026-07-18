// lib/openprovider-ssl.js — SSL via OpenProvider. Port 1:1 do netmaster (partilha o
// token de openprovider.js). listSslProducts / orderSslCertificate (dry-run por
// defeito) / getSslOrderStatus. PRODUCT_ID_MAP fica a 0 até confirmar o catálogo.
import { getToken as getOpenProviderToken } from './openprovider.js';

const DEFAULT_API_URL = 'https://api.openprovider.eu/v1beta';
const getApiUrl = () => (process.env.OPENPROVIDER_API_URL || DEFAULT_API_URL).replace(/\/$/, '');

async function opFetch(path, opts) {
  const res = await fetch(`${getApiUrl()}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenProvider SSL ${opts.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 250)}`);
  try { return text ? JSON.parse(text) : null; } catch { throw new Error('OpenProvider SSL: JSON inválido'); }
}

// TBD: preencher os product_id reais via listSslProducts() quando o catálogo estiver confirmado.
const PRODUCT_ID_MAP = { dv: 0, ov: 0, ev: 0 };

export async function listSslProducts() {
  const token = await getOpenProviderToken();
  const json = await opFetch('/ssl/products?limit=200', { token });
  return json?.data?.results || [];
}

// Cria uma ordem SSL. DRY-RUN por defeito — passar { dryRun:false } para submeter a sério.
export async function orderSslCertificate(input) {
  if (!input.csr || !input.csr.includes('BEGIN CERTIFICATE REQUEST')) throw new Error('CSR em falta/malformado (PEM).');
  if (!input.common_name || !input.approver_email) throw new Error('common_name e approver_email obrigatórios.');
  if (input.certType !== 'dv' && !input.organization) throw new Error('OV/EV exigem dados da organização.');
  const productId = PRODUCT_ID_MAP[input.certType];
  const dryRun = input.dryRun !== false;
  if (dryRun) {
    return { order_id: null, status: 'dry_run', dry_run: true, raw: { product_id: productId, period: input.period_years, domain: input.common_name, san_count: (input.san || []).length, approver_email: input.approver_email } };
  }
  if (productId === 0) throw new Error(`PRODUCT_ID_MAP[${input.certType}] não configurado — atualiza lib/openprovider-ssl.js antes de submeter a sério.`);
  const token = await getOpenProviderToken();
  const body = { product_id: productId, period: input.period_years, csr: input.csr, common_name: input.common_name, san_names: input.san || [], organization: input.organization, approver_email: input.approver_email, technical_contact_handle: input.technical_contact_handle };
  try {
    const json = await opFetch('/ssl/orders', { method: 'POST', body, token });
    const orderId = json?.data?.id || null;
    return { order_id: orderId, status: orderId ? 'submitted' : 'failed', raw: json, dry_run: false };
  } catch (err) {
    return { order_id: null, status: 'failed', raw: { error: (err.message || '').slice(0, 500) }, dry_run: false };
  }
}

export async function getSslOrderStatus(orderId) {
  const token = await getOpenProviderToken();
  const json = await opFetch(`/ssl/orders/${orderId}`, { token });
  return json?.data || null;
}
