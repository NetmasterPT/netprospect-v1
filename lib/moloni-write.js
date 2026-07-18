// lib/moloni-write.js — escrita no Moloni (Fase B): criar cliente/produto e emitir
// documentos de vários tipos. Layer GENÉRICO (o netmaster é order-cêntrico; aqui o
// caller passa o payload). Catálogos por fallback (1º item da conta, cache).
//
// ⚠️ NÃO verificado ao vivo: depende das permissões dos métodos no app Moloni.
// Emite documentos FISCAIS — em sandbox ficam rascunho (status=0) e são apagáveis.
// Mapa de tipos: FR/NC confirmados (netmaster); restantes best-effort — tipos sem
// endpoint conhecido dão erro claro em vez de adivinhar.
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
  const [maturity, delivery, payment] = await Promise.all([
    defaultMaturityDateId(), defaultDeliveryMethodId(), defaultPaymentMethodId(),
  ]);
  const vat = stripVat(data.vat || data.nif || '999999990');
  const res = await moloniCall('/customers/insert/', {
    vat,
    name: data.name || data.email || 'Cliente',
    language_id: 1,
    country_id: data.country_id || 1, // 1 = Portugal
    email: data.email || '',
    address: data.address || '',
    zip_code: data.zip_code || '',
    city: data.city || '',
    number: String(data.number || Date.now()).replace(/\D/g, '').slice(-10),
    // 7 campos de política obrigatórios (senão erro de validação aninhado)
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
    category_id: category,
    type: (data.type === 'servico' || Number(data.type) === 2) ? 2 : 1, // 1=produto, 2=serviço
    name: data.name,
    reference: String(data.reference || data.name || 'ref').slice(0, 30),
    price: Number(data.price) || 0,
    unit_id: unit,
    has_stock: 0,
    exemption_reason: data.exemption_reason || 'M99', // exigido em contas novas; o IVA real vem do taxes[] da linha
  });
  return { product_id: res.product_id };
}

// ── Documentos (todos os tipos suportados) ─────────────────────────────
// Slug → endpoint Moloni. CONFIRMADOS: invoiceReceipts (FR), creditNotes (NC).
const DOC_ENDPOINT = {
  fatura: 'invoices',
  fatura_simplificada: 'simplifiedInvoices',
  fatura_recibo: 'invoiceReceipts',
  recibo: 'receipts',
  nota_credito: 'creditNotes',
  nota_debito: 'debitNotes',
  orcamento: 'estimates',
  guia_transporte: 'billsOfLading',
  // fatura_fornecedor / fatura_recibo_fornecedor: módulo de compras — fluxo/endpoint distinto, a confirmar
};
const NEEDS_PAYMENTS = new Set(['fatura_recibo', 'recibo']); // documentos que liquidam → payments[]

export function docTypeSupported(slug) { return !!DOC_ENDPOINT[slug]; }

export async function createDocument(typeSlug, payload = {}) {
  const cfg = getConfig();
  const ep = DOC_ENDPOINT[typeSlug];
  if (!ep) throw new Error(`Moloni: tipo de documento sem escrita suportada: ${typeSlug} (suportados: ${Object.keys(DOC_ENDPOINT).join(', ')})`);
  if (!payload.customer_id) throw new Error('Moloni: customer_id obrigatório');

  const ivaTax = (rate) => (Number(rate) === 0 ? cfg.ivaIntracomTaxId : cfg.ivaTaxId);
  const products = (payload.products || []).map((p) => ({
    ...(p.product_id ? { product_id: p.product_id } : {}),
    name: p.name || 'Item',
    ...(p.summary ? { summary: String(p.summary).slice(0, 1000) } : {}),
    qty: Number(p.qty) || 1,
    price: Number(p.price) || 0,
    taxes: [{ tax_id: p.tax_id || ivaTax(p.iva_rate), value: p.iva_rate != null ? Number(p.iva_rate) : 23, order: 1, cumulative: 0 }],
    ...(p.related_id ? { related_id: p.related_id } : {}), // NC/ND: liga à linha do documento original
  }));
  if (!products.length) throw new Error('Moloni: products[] vazio');

  const status = payload.status != null ? Number(payload.status) : ((cfg.finalizeDocuments || !cfg.isSandbox) ? 1 : 0);
  const body = {
    date: payload.date || todayYmd(),
    expiration_date: payload.expiration_date || todayYmd(),
    document_set_id: payload.document_set_id || cfg.documentSetId,
    customer_id: Number(payload.customer_id),
    ...(payload.our_reference ? { our_reference: payload.our_reference } : {}),
    ...(payload.notes ? { notes: payload.notes } : {}),
    products,
    ...(payload.associated_documents ? { associated_documents: payload.associated_documents } : {}), // NC/ND ligam ao original
    status,
  };
  if (NEEDS_PAYMENTS.has(typeSlug)) {
    body.payments = payload.payments || [{
      payment_method_id: await defaultPaymentMethodId(),
      date: body.date,
      value: products.reduce((s, p) => s + p.price * p.qty * (1 + (p.taxes[0].value / 100)), 0),
    }];
  }
  const res = await moloniCall(`/${ep}/insert/`, body);
  return { document_id: res.document_id, status, type: typeSlug };
}

// Rascunho → fechado (comunica à AT + gera PDF).
export async function finalizeDocument(typeSlug, documentId) {
  const ep = DOC_ENDPOINT[typeSlug];
  if (!ep) throw new Error(`Moloni: tipo inválido: ${typeSlug}`);
  return moloniCall(`/${ep}/update/`, { document_id: Number(documentId), status: 1 });
}
