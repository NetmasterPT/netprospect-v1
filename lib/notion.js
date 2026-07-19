// lib/notion.js — cliente Notion focado nos Agendamentos (Fase G). Reusa as técnicas
// do netmaster (descoberta de data source + property-aliases type-aware + blocos com
// links), SEM a cauda order/lead-cêntrica. notionEnabled() fail-soft.
import { loadEnv } from './env.js';
import { Client } from '@notionhq/client';
import { withRetry, isNotionRetryable, notionRetryAfterMs } from './with-retry.js';
loadEnv();

const NOTION_TEXT_MAX = 2000;
const NOTION_ACCESS_TOKEN = process.env.NOTION_ACCESS_TOKEN || '';
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || '';

let cachedClient = null;
function getClient() { if (!NOTION_ACCESS_TOKEN) return null; if (!cachedClient) cachedClient = new Client({ auth: NOTION_ACCESS_TOKEN }); return cachedClient; }
export function notionEnabled() { return Boolean(NOTION_ACCESS_TOKEN && NOTION_DATABASE_ID); }
export const isNotionConfigured = notionEnabled;

// ── Schema (data source + tipos de propriedade), cache por processo ────
let cachedSchema = null;
async function fetchSchema(client) {
  if (cachedSchema) return cachedSchema;
  try {
    const db = await withRetry(() => client.databases.retrieve({ database_id: NOTION_DATABASE_ID }), { isRetryable: isNotionRetryable, retryAfterMs: notionRetryAfterMs, label: 'notion.db.retrieve' });
    const dsId = db.data_sources?.[0]?.id;
    if (!dsId) { console.warn('[Notion] DB sem data sources — não dá para criar páginas'); return null; }
    // dataSources não está na superfície tipada do SDK → escape hatch request().
    const ds = await withRetry(() => client.request({ path: `data_sources/${dsId}`, method: 'get' }), { isRetryable: isNotionRetryable, retryAfterMs: notionRetryAfterMs, label: 'notion.ds.retrieve' });
    const propMap = {};
    for (const [name, p] of Object.entries(ds.properties || {})) propMap[name] = p.type;
    cachedSchema = { id: dsId, properties: propMap };
    return cachedSchema;
  } catch (err) { console.warn('[Notion] schema falhou:', err.message); return null; }
}

// Cada campo semântico → lista de nomes possíveis; escolhe o 1º que existir no schema.
const PROP_ALIASES = {
  title: ['Title', 'Name', 'Nome', 'Agendamento', 'Lead'],
  email: ['Email', 'E-mail'],
  date: ['Meeting', 'Booking Date', 'Reunião', 'Data', 'When', 'Date'],
  company: ['Company', 'Empresa'],
  status: ['Status', 'Estado'],
};
function findProp(schema, semantic) {
  for (const c of PROP_ALIASES[semantic]) if (schema.properties[c]) return { name: c, type: schema.properties[c] };
  return null;
}

function rt(text) { return [{ type: 'text', text: { content: String(text).slice(0, NOTION_TEXT_MAX - 100) } }]; }
function bullet(text) { return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(text) } }; }
function bulletWithLink(label, linkText, url) {
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [
    { type: 'text', text: { content: `${label}: ` } },
    { type: 'text', text: { content: String(linkText).slice(0, 200), link: { url: String(url).slice(0, NOTION_TEXT_MAX - 100) } } },
  ] } };
}

// Define uma propriedade de forma type-aware (só se existir no schema).
function setProp(props, schema, semantic, value) {
  const p = findProp(schema, semantic);
  if (!p || value == null || value === '') return;
  const v = String(value);
  switch (p.type) {
    case 'title': props[p.name] = { title: rt(v) }; break;
    case 'rich_text': props[p.name] = { rich_text: rt(v) }; break;
    case 'email': props[p.name] = { email: v }; break;
    case 'phone_number': props[p.name] = { phone_number: v }; break;
    case 'url': props[p.name] = { url: v }; break;
    case 'date': props[p.name] = { date: { start: v } }; break; // faz aparecer no calendário Notion
    case 'select': props[p.name] = { select: { name: v } }; break;
    case 'multi_select': props[p.name] = { multi_select: [{ name: v }] }; break;
    default: break;
  }
}

// Cria a página do agendamento (propriedade date → calendário Notion) + corpo com os
// links Meet/Calendar. Devolve { pageId, url } ou null se desligado/sem schema.
export async function createAgendamentoPage(input) {
  const client = getClient();
  if (!client) return null;
  const schema = await fetchSchema(client);
  if (!schema) return null;
  const props = {};
  setProp(props, schema, 'title', input.title || 'Agendamento');
  setProp(props, schema, 'email', input.email);
  setProp(props, schema, 'company', input.company);
  if (input.startIso) setProp(props, schema, 'date', input.startIso);
  const children = [];
  if (input.meetLink) children.push(bulletWithLink('Google Meet', 'Abrir Meet', input.meetLink));
  if (input.calendarLink) children.push(bulletWithLink('Calendário', 'Abrir evento', input.calendarLink));
  if (input.notes) children.push(bullet(input.notes));
  const page = await withRetry(
    () => client.pages.create({ parent: { type: 'data_source_id', data_source_id: schema.id }, properties: props, children }),
    { isRetryable: isNotionRetryable, retryAfterMs: notionRetryAfterMs, label: 'notion.pages.create' },
  );
  return { pageId: page.id, url: page.url };
}
