// lib/moloni-write.js — escrita no Moloni (Fase B). Layer genérico (o caller passa o
// payload). Catálogos por fallback (1º item da conta, cache).
//
// SEGURANÇA: os documentos criam-se por DEFEITO como RASCUNHO (status=0), mesmo em modo
// live — só finaliza (status=1, comunica à AT, irreversível) se `status:1` for pedido
// explicitamente. Achados dos testes na live: (1) cada linha precisa de product_id real
// → ensureProduct; (2) a série tem de casar com o tipo → auto-heal do document_set_id.
import { moloniCall, getConfig } from './moloni.js';

const todayYmd = () => new Date().toISOString().slice(0, 10);
const stripVat = (v) => String(v || '').replace(/^[A-Z]{2}(?=[0-9A-Z])/i, '').toUpperCase();

// ── Catálogos (fallback: 1º item da conta; cache por processo) ─────────
const _cat = {};
async function firstId(path, key, body = {}) {
  if (_cat[path] != null) return _cat[path];
  const list = await moloniCall(path, body);
  const first = Array.isArray(list) && list[0];
  if (!first) throw new Error(`Moloni: sem itens em ${path} — configura ao menos um na conta.`);
  _cat[path] = first[key];
  return _cat[path];
}
const defaultMaturityDateId = () => firstId('/maturityDates/getAll/', 'maturity_date_id');
const defaultDeliveryMethodId = () => firstId('/deliveryMethods/getAll/', 'delivery_method_id');
const defaultPaymentMethodId = () => firstId('/paymentMethods/getAll/', 'payment_method_id');
const defaultCategoryId = () => firstId('/productCategories/getAll/', 'category_id', { parent_id: 0 });
const defaultUnitId = () => firstId('/measurementUnits/getAll/', 'unit_id');

// ── Clientes ───────────────────────────────────────────────────────────
export async function createCustomer(data = {}) {
  const [maturity, delivery, payment] = await Promise.all([defaultMaturityDateId(), defaultDeliveryMethodId(), defaultPaymentMethodId()]);
  const vat = stripVat(data.vat || data.nif || '999999990');
  const res = await moloniCall('/customers/insert/', {
    vat, name: data.name || data.email || 'Cliente', language_id: 1, country_id: data.country_id || 1,
    email: data.email || '', address: data.address || '', zip_code: data.zip_code || '', city: data.city || '',
    number: String(data.number || Date.now()).replace(/\D/g, '').slice(-10),
    salesman_id: 0, maturity_date_id: maturity, payment_day: 0, discount: 0, credit_limit: 0,
    payment_method_id: payment, delivery_method_id: delivery,
  });
  return { customer_id: res.customer_id, vat, name: data.name };
}
export async function updateCustomer(customerId, data = {}) {
  return moloniCall('/customers/update/', { customer_id: Number(customerId), ...data });
}

// ── Produtos ───────────────────────────────────────────────────────────
export async function createProduct(data = {}) {
  const [category, unit] = await Promise.all([defaultCategoryId(), defaultUnitId()]);
  const res = await moloniCall('/products/insert/', {
    category_id: category, type: (data.type === 'servico' || Number(data.type) === 2) ? 2 : 1,
    name: data.name, reference: String(data.reference || data.name || 'ref').slice(0, 30),
    price: Number(data.price) || 0, unit_id: unit, has_stock: 0, exemption_reason: data.exemption_reason || 'M99',
  });
  return { product_id: res.product_id };
}

// Garante um product_id p/ uma linha (find-by-reference → senão cria). Cache por referência.
const _prodCache = new Map();
export async function ensureProduct(line = {}) {
  if (line.product_id) return line.product_id;
  const ref = String(line.reference || line.name || 'item').slice(0, 30);
  if (_prodCache.has(ref)) return _prodCache.get(ref);
  try {
    const found = await moloniCall('/products/getBySearch/', { search: ref });
    const hit = Array.isArray(found) ? found.find((p) => p.reference === ref) : null;
    if (hit) { _prodCache.set(ref, hit.product_id); return hit.product_id; }
  } catch { /* sem search → cria */ }
  const created = await createProduct({ name: line.name || ref, reference: ref, price: line.price, type: line.kind });
  _prodCache.set(ref, created.product_id);
  return created.product_id;
}

// ── Documentos ─────────────────────────────────────────────────────────
const DOC_ENDPOINT = {
  fatura: 'invoices', fatura_simplificada: 'simplifiedInvoices', fatura_recibo: 'invoiceReceipts',
  recibo: 'receipts', nota_credito: 'creditNotes', nota_debito: 'debitNotes',
  orcamento: 'estimates', guia_transporte: 'billsOfLading',
};
const NEEDS_PAYMENTS = new Set(['fatura_recibo', 'recibo']);
export function docTypeSupported(slug) { return !!DOC_ENDPOINT[slug]; }

// insert com auto-heal do document_set_id: se o Moloni disser "5 document_set_id [X]", tenta X.
async function insertWithSetHeal(ep, body) {
  try { return await moloniCall(`/${ep}/insert/`, body); }
  catch (e) {
    const mm = /document_set_id \[(\d+)\]/.exec(e.message || '');
    if (mm) { body = { ...body, document_set_id: Number(mm[1]) }; return await moloniCall(`/${ep}/insert/`, body); }
    throw e;
  }
}

export async function createDocument(typeSlug, payload = {}) {
  const cfg = getConfig();
  const ep = DOC_ENDPOINT[typeSlug];
  if (!ep) {
    // "Venda a Dinheiro" (VD/VDF) foi descontinuada pela AT em 2013 e substituída pela Fatura-Recibo.
    // A conta tem 0 docs VD e o Moloni não expõe insert de VD → escrita não suportada POR DESIGN (usar FR).
    if (typeSlug === 'venda_dinheiro' || typeSlug === 'venda_dinheiro_fornecedor')
      throw new Error('Moloni: "Venda a Dinheiro" (VD) foi descontinuada pela AT (2013) → usa fatura_recibo. Escrita VD não suportada por design.');
    throw new Error(`Moloni: tipo sem escrita suportada: ${typeSlug} (${Object.keys(DOC_ENDPOINT).join(', ')})`);
  }
  if (!payload.customer_id) throw new Error('Moloni: customer_id obrigatório');
  const ivaTax = (rate) => (Number(rate) === 0 ? cfg.ivaIntracomTaxId : cfg.ivaTaxId);

  // linhas: garante product_id real (achado do teste na live)
  const products = [];
  for (const p of (payload.products || [])) {
    const product_id = await ensureProduct(p);
    products.push({
      product_id, name: p.name || 'Item',
      ...(p.summary ? { summary: String(p.summary).slice(0, 1000) } : {}),
      qty: Number(p.qty) || 1, price: Number(p.price) || 0,
      taxes: [{ tax_id: p.tax_id || ivaTax(p.iva_rate), value: p.iva_rate != null ? Number(p.iva_rate) : 23, order: 1, cumulative: 0 }],
      ...(p.related_id ? { related_id: p.related_id } : {}),
    });
  }
  if (!products.length) throw new Error('Moloni: products[] vazio');

  // SEGURANÇA: default = RASCUNHO. Só finaliza se status:1 for EXPLÍCITO.
  const status = Number(payload.status) === 1 ? 1 : 0;
  const body = {
    date: payload.date || todayYmd(), expiration_date: payload.expiration_date || todayYmd(),
    document_set_id: payload.document_set_id || cfg.documentSetId,
    customer_id: Number(payload.customer_id),
    ...(payload.our_reference ? { our_reference: payload.our_reference } : {}),
    ...(payload.notes ? { notes: payload.notes } : {}),
    products,
    ...(payload.associated_documents ? { associated_documents: payload.associated_documents } : {}),
    status,
  };
  if (NEEDS_PAYMENTS.has(typeSlug)) {
    body.payments = payload.payments || [{
      payment_method_id: await defaultPaymentMethodId(), date: body.date,
      value: products.reduce((s, p) => s + p.price * p.qty * (1 + (p.taxes[0].value / 100)), 0),
    }];
  }
  const res = await insertWithSetHeal(ep, body);
  return { document_id: res.document_id, status, type: typeSlug };
}

// Emite uma Nota de Crédito LIGADA a um documento original (fatura/FR/…). Rascunho por
// defeito. Copia as linhas do original com related_id=document_product_id + associated_documents.
// opts: { ratio (0..1 p/ crédito parcial), reason, date, document_set_id, status:1 p/ finalizar }.
export async function createNotaCredito(originalDocId, opts = {}) {
  const cfg = getConfig();
  const orig = await moloniCall('/documents/getOne/', { document_id: Number(originalDocId) });
  if (!orig || !orig.document_id) throw new Error(`Moloni: documento original ${originalDocId} não encontrado`);
  const ratio = opts.ratio != null ? Number(opts.ratio) : 1;
  const lines = (orig.products || []).filter((p) => p.document_product_id);
  if (!lines.length) throw new Error('Moloni: original sem linhas com document_product_id');
  const products = lines.map((p) => ({
    product_id: p.product_id, name: p.name,
    qty: Number(p.qty) * ratio, price: Number(p.price),
    taxes: (p.taxes && p.taxes.length ? p.taxes : [{ tax_id: cfg.ivaTaxId, value: 23 }]).map((t, i) => ({ tax_id: t.tax_id, value: Number(t.value) || 0, order: t.order || i + 1, cumulative: t.cumulative || 0 })),
    related_id: p.document_product_id,
  }));
  const associatedValue = products.reduce((s, p) => s + p.price * p.qty * (1 + ((p.taxes[0]?.value || 0) / 100)), 0);
  const status = Number(opts.status) === 1 ? 1 : 0;
  const body = {
    date: opts.date || todayYmd(),
    document_set_id: opts.document_set_id || cfg.documentSetId,
    customer_id: Number(orig.customer_id || orig.entity_id),
    ...(opts.reason ? { notes: opts.reason } : {}),
    products,
    associated_documents: [{ associated_id: Number(originalDocId), value: Number(associatedValue.toFixed(2)) }],
    status,
  };
  const res = await insertWithSetHeal('creditNotes', body);
  return { document_id: res.document_id, status, type: 'nota_credito', associated: Number(originalDocId) };
}

// Finaliza um rascunho (status=1 → comunica à AT + gera PDF). Ação explícita.
export async function finalizeDocument(typeSlug, documentId) {
  const ep = DOC_ENDPOINT[typeSlug];
  if (!ep) throw new Error(`Moloni: tipo inválido: ${typeSlug}`);
  return moloniCall(`/${ep}/update/`, { document_id: Number(documentId), status: 1 });
}

// Apaga um rascunho de teste (só funciona em status=0).
export async function deleteDocument(typeSlug, documentId) {
  const ep = DOC_ENDPOINT[typeSlug];
  if (!ep) throw new Error(`Moloni: tipo inválido: ${typeSlug}`);
  return moloniCall(`/${ep}/delete/`, { document_id: Number(documentId) });
}
