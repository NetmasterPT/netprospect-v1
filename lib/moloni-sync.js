// lib/moloni-sync.js — sync de LEITURA do Moloni → Directus (Fase A3).
//
// Upsert por moloni_id. Corre onde a lib/ + @directus/sdk existem (host via
// moloni-sync.js, ou dentro do container do dashboard/worker que monte ../lib).
//
// ⚠️ NÃO verificado ao vivo: depende de o app Moloni sandbox ter as permissões
// dos métodos getAll ativadas (customers/products/documents). O mapeamento de
// document_type_id (DOC_TYPE_MAP) é best-effort — só 3=FR e 4=NC estão confirmados
// pelo netmaster-app; os restantes há que afinar contra dados reais (loga os
// type_ids desconhecidos). As "avenças" ficam em stub (fonte Moloni por definir).
import { readItems, createItem, updateItem } from '@directus/sdk';
import { makeClient } from './directus.js';
import { moloniCall, moloniEnabled } from './moloni.js';

const client = () => makeClient();
const stripVat = (v) => String(v || '').replace(/^[A-Z]{2}/i, '').trim();

// Paginação Moloni: getAll aceita offset + qty (máx ~50). Percorre até esgotar.
async function moloniPaginate(path, body = {}, qty = 50) {
  const out = [];
  for (let offset = 0; ; offset += qty) {
    const page = await moloniCall(path, { ...body, offset, qty });
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < qty) break;
  }
  return out;
}

// Upsert por chave (ex.: moloni_id). PATCH do Directus é parcial → não apaga campos não enviados.
async function upsertByKey(c, collection, keyField, keyValue, data) {
  const found = await c.request(readItems(collection, { filter: { [keyField]: { _eq: keyValue } }, limit: 1, fields: ['id'] }));
  if (found && found.length) { await c.request(updateItem(collection, found[0].id, data)); return 'updated'; }
  await c.request(createItem(collection, { [keyField]: keyValue, ...data })); return 'created';
}

// ── Customers → companies (match moloni_customer_id → NIF → email → name) ──
export async function syncCustomers() {
  const c = client();
  const customers = await moloniPaginate('/customers/getAll/');
  let created = 0, updated = 0;
  const find = async (filter) => (await c.request(readItems('companies', { filter, limit: 1, fields: ['id'] })))[0];
  for (const cust of customers) {
    const mid = String(cust.customer_id ?? cust.id ?? '');
    if (!mid) continue;
    const nif = stripVat(cust.vat);
    const email = (cust.email || '').trim();
    const name = (cust.name || '').trim();
    const data = { moloni_customer_id: mid, is_client: true };
    if (nif) data.nif = nif;
    if (name) data.name = name;
    if (email) data.general_email = email;
    const addr = [cust.address, cust.zip_code, cust.city].filter(Boolean).join(', ');
    if (addr) data.address = addr;

    let match = await find({ moloni_customer_id: { _eq: mid } });
    if (!match && nif) match = await find({ nif: { _eq: nif } });
    if (!match && email) match = await find({ general_email: { _eq: email } });
    if (!match && name) match = await find({ name: { _eq: name } });

    if (match) { await c.request(updateItem('companies', match.id, data)); updated++; }
    else { await c.request(createItem('companies', { source: 'moloni', ...data })); created++; }
  }
  return { entity: 'customers', total: customers.length, created, updated };
}

// ── Products → products ──────────────────────────────────────────────────
export async function syncProducts() {
  const c = client();
  const products = await moloniPaginate('/products/getAll/');
  let created = 0, updated = 0;
  for (const p of products) {
    const mid = String(p.product_id ?? p.id ?? '');
    if (!mid) continue;
    const data = {
      name: p.name || '',
      kind: Number(p.type) === 2 ? 'servico' : 'produto', // Moloni type 1=produto / 2=serviço
    };
    if (p.reference) data.reference = p.reference;
    if (p.summary) data.summary = p.summary;
    if (p.price != null) data.price = Number(p.price);
    if (Array.isArray(p.taxes) && p.taxes[0]?.tax_id) data.tax_id = Number(p.taxes[0].tax_id);
    (await upsertByKey(c, 'products', 'moloni_id', mid, data)) === 'created' ? created++ : updated++;
  }
  return { entity: 'products', total: products.length, created, updated };
}

// ── Documents → moloni_documents ─────────────────────────────────────────
// CONFIRMADO (netmaster-app): 3=Fatura-Recibo, 4=Nota de Crédito. Resto = best-effort.
const DOC_TYPE_MAP = {
  1: 'fatura',
  2: 'fatura_simplificada',
  3: 'fatura_recibo',
  4: 'nota_credito',
  5: 'nota_debito',
  6: 'recibo',
  // fornecedores / orçamento / guia_transporte: type_ids a confirmar contra dados reais
};
export async function syncDocuments() {
  const c = client();
  const docs = await moloniPaginate('/documents/getAll/');
  let created = 0, updated = 0;
  const unknownTypes = new Set();
  for (const d of docs) {
    const mid = String(d.document_id ?? d.id ?? '');
    if (!mid) continue;
    const typeId = Number(d.document_type_id ?? d.document_type?.document_type_id);
    const slug = DOC_TYPE_MAP[typeId];
    if (!slug) unknownTypes.add(typeId);
    const custMid = String(d.customer_id ?? d.entity?.customer_id ?? '');
    let companyId = null;
    if (custMid) {
      const comp = (await c.request(readItems('companies', { filter: { moloni_customer_id: { _eq: custMid } }, limit: 1, fields: ['id'] })))[0];
      companyId = comp ? comp.id : null;
    }
    const data = {
      document_type: slug || 'outro',
      number: d.number || null,
      customer_moloni_id: custMid || null,
      customer_name: d.entity_name || d.entity?.name || null,
      date: d.date || null,
      net: d.net_value != null ? Number(d.net_value) : null,
      vat: d.taxes_value != null ? Number(d.taxes_value) : null,
      total: d.gross_value != null ? Number(d.gross_value) : null,
      status: d.status != null ? Number(d.status) : null,
      company: companyId,
    };
    (await upsertByKey(c, 'moloni_documents', 'moloni_id', mid, data)) === 'created' ? created++ : updated++;
  }
  if (unknownTypes.size) console.warn('[moloni-sync] document_type_id desconhecidos (afinar DOC_TYPE_MAP):', [...unknownTypes].filter((x) => !Number.isNaN(x)).join(', '));
  return { entity: 'documents', total: docs.length, created, updated, unknownTypes: [...unknownTypes] };
}

// ── Avenças → moloni_avencas (STUB) ──────────────────────────────────────
// A API clássica do Moloni não expõe "avenças"/subscrições. Aguarda o utilizador
// definir a fonte (serviços recorrentes? módulo específico? faturas recorrentes?).
export async function syncAvencas() {
  return { entity: 'avencas', total: 0, created: 0, updated: 0, skipped: true, reason: 'fonte Moloni por definir' };
}

const SYNCERS = { customers: syncCustomers, products: syncProducts, documents: syncDocuments, avencas: syncAvencas };

export async function syncEntity(entity) {
  if (!moloniEnabled()) throw new Error('Moloni desligado (creds em falta).');
  const fn = SYNCERS[entity];
  if (!fn) throw new Error(`entidade inválida: ${entity} (usa customers|products|documents|avencas)`);
  return fn();
}

export async function syncAll() {
  const results = [];
  for (const e of ['customers', 'products', 'documents', 'avencas']) {
    try { results.push(await syncEntity(e)); }
    catch (err) { results.push({ entity: e, error: err.message }); }
  }
  return results;
}
