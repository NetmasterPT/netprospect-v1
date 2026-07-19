// lib/moloni-sync.js — sync de LEITURA Moloni → Directus (A3), COM THROTTLING.
//
// Estratégia (evita o "Under pressure" do Directus): em vez de N lookups por linha,
// faz 1 leitura batched das chaves relevantes → match EM MEMÓRIA → escreve EM LOTE
// com pausas. Tipos de documento resolvidos dinamicamente via /documentTypes/getAll
// (SAFT code → slug). Corre onde a lib/ + @directus/sdk existem (container/host).
import { readItems, createItem, updateItem } from '@directus/sdk';
import { makeClient } from './directus.js';
import { moloniCall, moloniEnabled } from './moloni.js';

const client = () => makeClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripVat = (v) => String(v || '').replace(/^[A-Z]{2}/i, '').trim();

// Paginação Moloni (offset/qty) com pausa entre páginas.
async function moloniPaginate(path, body = {}, qty = 50, pausePages = 250) {
  const out = [];
  for (let offset = 0; ; offset += qty) {
    const page = await moloniCall(path, { ...body, offset, qty });
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < qty) break;
    await sleep(pausePages);
  }
  return out;
}

// Carrega Map(String(keyValue) → row) para uma lista de valores, em chunks (≤100/query).
async function loadMap(c, collection, keyField, values, extraFields = []) {
  const map = new Map();
  const uniq = [...new Set(values.filter((v) => v != null && v !== '').map(String))];
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    const rows = await c.request(readItems(collection, { filter: { [keyField]: { _in: chunk } }, fields: ['id', keyField, ...extraFields], limit: -1 }));
    for (const r of rows) if (r[keyField] != null) map.set(String(r[keyField]), r);
    if (i + 100 < uniq.length) await sleep(120);
  }
  return map;
}

// Executa ops de escrita em lotes (Promise.allSettled) com pausa entre lotes.
async function batchWrite(ops, { batch = 15, pause = 500 } = {}) {
  let created = 0, updated = 0, errors = 0; const errSample = [];
  for (let i = 0; i < ops.length; i += batch) {
    const res = await Promise.allSettled(ops.slice(i, i + batch).map((op) => op()));
    for (const r of res) {
      if (r.status === 'rejected') { errors++; if (errSample.length < 3) errSample.push(String(r.reason?.message || r.reason).slice(0, 80)); }
      else if (r.value === 'created') created++; else updated++;
    }
    if (i + batch < ops.length) await sleep(pause);
  }
  return { created, updated, errors, ...(errSample.length ? { errSample } : {}) };
}

// ── Customers → companies (match moloni_customer_id → NIF → email, em memória) ──
export async function syncCustomers() {
  const c = client();
  const customers = await moloniPaginate('/customers/getAll/');
  const byMid = await loadMap(c, 'companies', 'moloni_customer_id', customers.map((x) => x.customer_id));
  const byNif = await loadMap(c, 'companies', 'nif', customers.map((x) => stripVat(x.vat)));
  const byEmail = await loadMap(c, 'companies', 'general_email', customers.map((x) => (x.email || '').trim()));
  const ops = [];
  for (const cust of customers) {
    const mid = String(cust.customer_id || ''); if (!mid) continue;
    const nif = stripVat(cust.vat); const email = (cust.email || '').trim();
    const data = { moloni_customer_id: mid, is_client: true };
    if (nif) data.nif = nif;
    if (cust.name) data.name = String(cust.name).trim();
    if (email) data.general_email = email;
    const addr = [cust.address, cust.zip_code, cust.city].filter(Boolean).join(', '); if (addr) data.address = addr;
    // match em memória (não faço name-match p/ evitar merges falsos)
    const match = byMid.get(mid) || (nif && byNif.get(nif)) || (email && byEmail.get(email));
    if (match) ops.push(() => c.request(updateItem('companies', match.id, data)).then(() => 'updated'));
    else ops.push(() => c.request(createItem('companies', { source: 'moloni', ...data })).then(() => 'created'));
  }
  return { entity: 'customers', total: customers.length, ...(await batchWrite(ops)) };
}

// ── Products → products ────────────────────────────────────────────────
export async function syncProducts() {
  const c = client();
  const products = await moloniPaginate('/products/getAll/');
  const byMid = await loadMap(c, 'products', 'moloni_id', products.map((p) => p.product_id));
  const ops = [];
  for (const p of products) {
    const mid = String(p.product_id || ''); if (!mid) continue;
    const data = { name: p.name || '', kind: Number(p.type) === 2 ? 'servico' : 'produto' };
    if (p.reference) data.reference = p.reference;
    if (p.summary) data.summary = p.summary;
    if (p.price != null) data.price = Number(p.price);
    if (Array.isArray(p.taxes) && p.taxes[0]?.tax_id) data.tax_id = Number(p.taxes[0].tax_id);
    const match = byMid.get(mid);
    if (match) ops.push(() => c.request(updateItem('products', match.id, data)).then(() => 'updated'));
    else ops.push(() => c.request(createItem('products', { moloni_id: mid, ...data })).then(() => 'created'));
  }
  return { entity: 'products', total: products.length, ...(await batchWrite(ops)) };
}

// ── Tipos de documento: SAFT code → slug (mapa buscado ao Moloni) ──────
export const SAFT_SLUG = {
  FT: 'fatura', FS: 'fatura_simplificada', FR: 'fatura_recibo', VD: 'venda_dinheiro',
  RE: 'recibo', NC: 'nota_credito', ND: 'nota_debito',
  FF: 'fatura_fornecedor', REF: 'fatura_recibo_fornecedor', VDF: 'venda_dinheiro_fornecedor',
  OR: 'orcamento', GT: 'guia_transporte', GR: 'guia_remessa', GC: 'guia_consignacao',
  PF: 'proforma', AV: 'aviso', NE: 'nota_encomenda',
};
async function docTypeMap() {
  const types = await moloniCall('/documentTypes/getAll/', {}, { skipCompanyId: true }).catch(() => moloniCall('/documentTypes/getAll/', {}));
  const map = {};
  for (const t of (types || [])) {
    const code = String(t.saft_code || t.name || '').toUpperCase();
    map[t.document_type_id] = SAFT_SLUG[code] || ('outro_' + code.toLowerCase());
  }
  return map;
}

// ── Documents → moloni_documents (todos os tipos) ──────────────────────
// syncDocuments(): todos; syncDocumentsByType(saftCode): filtra a um tipo.
export async function syncDocuments({ dateFrom, documentTypeId } = {}) {
  const c = client();
  const typeMap = await docTypeMap();
  const body = {};
  if (dateFrom) body.date = dateFrom;
  if (documentTypeId) body.document_type_id = documentTypeId;
  const docs = await moloniPaginate('/documents/getAll/', body, 50, 300);
  const compByMid = await loadMap(c, 'companies', 'moloni_customer_id', docs.map((d) => d.customer_id ?? d.entity?.customer_id));
  const byMid = await loadMap(c, 'moloni_documents', 'moloni_id', docs.map((d) => d.document_id));
  const ops = []; const unknown = new Set();
  for (const d of docs) {
    const mid = String(d.document_id || ''); if (!mid) continue;
    const typeId = Number(d.document_type_id ?? d.document_type?.document_type_id);
    const slug = typeMap[typeId] || 'outro'; if (!typeMap[typeId]) unknown.add(typeId);
    const custMid = String(d.customer_id ?? d.entity?.customer_id ?? '');
    const comp = custMid ? compByMid.get(custMid) : null;
    const data = {
      document_type: slug, number: d.number || null,
      customer_moloni_id: custMid || null, customer_name: d.entity_name || d.entity?.name || null,
      date: d.date || null,
      net: d.net_value != null ? Number(d.net_value) : null,
      vat: d.taxes_value != null ? Number(d.taxes_value) : null,
      total: d.gross_value != null ? Number(d.gross_value) : null,
      status: d.status != null ? Number(d.status) : null,
      company: comp ? comp.id : null,
    };
    const match = byMid.get(mid);
    if (match) ops.push(() => c.request(updateItem('moloni_documents', match.id, data)).then(() => 'updated'));
    else ops.push(() => c.request(createItem('moloni_documents', { moloni_id: mid, ...data })).then(() => 'created'));
  }
  return { entity: 'documents', total: docs.length, unknownTypes: [...unknown], ...(await batchWrite(ops)) };
}

// Sync por tipo (SAFT code, ex.: 'FT'). Resolve o document_type_id e delega.
export async function syncDocumentsByType(saftCode, opts = {}) {
  const types = await moloniCall('/documentTypes/getAll/', {}).catch(() => []);
  const t = (types || []).find((x) => String(x.saft_code || x.name || '').toUpperCase() === String(saftCode).toUpperCase());
  if (!t) throw new Error(`tipo SAFT desconhecido: ${saftCode}`);
  return syncDocuments({ ...opts, documentTypeId: t.document_type_id });
}

export async function syncAvencas() {
  // A API clássica não tem endpoint de "avenças". Candidato: documentos SAFT "AV" (type 12).
  return { entity: 'avencas', total: 0, created: 0, updated: 0, skipped: true, reason: 'fonte por definir (ver documentos tipo AV)' };
}

const SYNCERS = { customers: syncCustomers, products: syncProducts, documents: syncDocuments, avencas: syncAvencas };
export async function syncEntity(entity, opts) {
  if (!moloniEnabled()) throw new Error('Moloni desligado (creds em falta).');
  const fn = SYNCERS[entity];
  if (!fn) throw new Error(`entidade inválida: ${entity} (customers|products|documents|avencas)`);
  return fn(opts);
}
export async function syncAll(opts) {
  const results = [];
  for (const e of ['customers', 'products', 'documents', 'avencas']) {
    try { results.push(await syncEntity(e, opts)); } catch (err) { results.push({ entity: e, error: (err.message || '').slice(0, 140) }); }
  }
  return results;
}
