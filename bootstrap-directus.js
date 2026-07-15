// bootstrap-directus.js
//
// Cria de forma idempotente o modelo de dados do NetProspect no Directus:
// coleções Platforms, Sites, Companies, Contacts (+ junção sites_platforms),
// as relações entre elas e faz seed do catálogo de plataformas.
//
// Uso:  node bootstrap-directus.js
// Requer docker/.env preenchido (DIRECTUS_URL + DIRECTUS_TOKEN/ADMIN_TOKEN)
// e a stack a correr (docker compose -f docker/docker-compose.yml up -d).

import {
  readCollections,
  createCollection,
  readFieldsByCollection,
  createField,
  updateField,
  readRelations,
  createRelation,
  readItems,
  createItem,
} from '@directus/sdk';
import { makeClient, ensureStaticToken, DIRECTUS_URL } from './lib/directus.js';

let client;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDirectus() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${DIRECTUS_URL}/server/health`);
      if (res.ok && (await res.json()).status === 'ok') {
        console.log(`Directus pronto em ${DIRECTUS_URL}`);
        return;
      }
    } catch {
      /* ainda a arrancar */
    }
    await sleep(2000);
  }
  throw new Error(`Directus não respondeu a tempo em ${DIRECTUS_URL}`);
}

// --- Helpers idempotentes -----------------------------------------------------
async function ensureCollection(name, meta = {}) {
  const cols = await client.request(readCollections());
  if (cols.some((c) => c.collection === name)) {
    console.log(`= coleção ${name}`);
    return;
  }
  await client.request(
    createCollection({
      collection: name,
      meta: { icon: meta.icon || 'box', note: meta.note || null, hidden: !!meta.hidden },
      schema: {},
      fields: [
        {
          field: 'id',
          type: 'integer',
          meta: { hidden: true, interface: 'input', readonly: true },
          schema: { is_primary_key: true, has_auto_increment: true },
        },
      ],
    })
  );
  console.log(`+ coleção ${name}`);
}

async function ensureField(collection, field, spec) {
  const fields = await client.request(readFieldsByCollection(collection));
  if (fields.some((f) => f.field === field)) return;
  await client.request(createField(collection, { field, ...spec }));
  console.log(`  + ${collection}.${field}`);
}

// Atualiza as choices de um campo select-dropdown JÁ existente (o ensureField ignora
// campos que já existem). Idempotente: só faz PATCH se faltar alguma choice.
async function ensureEnumChoices(collection, field, choices) {
  const fields = await client.request(readFieldsByCollection(collection));
  const f = fields.find((x) => x.field === field);
  if (!f) { await ensureField(collection, field, enumS(choices)); return; }
  const cur = new Set((f.meta?.options?.choices || []).map((c) => c.value));
  if (choices.every((c) => cur.has(c))) return;
  await client.request(updateField(collection, field, { meta: { options: { choices: choices.map((v) => ({ text: v, value: v })) } } }));
  console.log(`  ~ ${collection}.${field} choices += ${choices.filter((c) => !cur.has(c)).join(',')}`);
}

async function ensureRelation(rel) {
  const rels = await client.request(readRelations());
  if (rels.some((r) => r.collection === rel.collection && r.field === rel.field)) return;
  await client.request(createRelation(rel));
  console.log(`  ~ ${rel.collection}.${rel.field} -> ${rel.related_collection}`);
}

// Construtores de spec de campo
const str = (extra = {}) => ({ type: 'string', meta: { interface: 'input' }, schema: {}, ...extra });
const strUnique = () => ({ type: 'string', meta: { interface: 'input' }, schema: { is_unique: true } });
const int = () => ({ type: 'integer', meta: { interface: 'input' }, schema: {} });
const bool = (def = false) => ({ type: 'boolean', meta: { interface: 'boolean' }, schema: { default_value: def } });
const json = () => ({ type: 'json', meta: { interface: 'input-code' }, schema: {} });
const text = () => ({ type: 'text', meta: { interface: 'input-multiline' }, schema: {} });
const ts = () => ({ type: 'timestamp', meta: { interface: 'datetime' }, schema: {} });
const dateCreated = () => ({
  type: 'timestamp',
  meta: { interface: 'datetime', special: ['date-created'], readonly: true },
  schema: {},
});
const m2oField = () => ({ type: 'integer', meta: { interface: 'select-dropdown-m2o' }, schema: {} });
const aliasO2M = () => ({ type: 'alias', meta: { interface: 'list-o2m', special: ['o2m'] } });
const float = () => ({ type: 'float', meta: { interface: 'input' }, schema: {} });
const enumS = (choices) => ({ type: 'string', meta: { interface: 'select-dropdown', options: { choices: choices.map((v) => ({ text: v, value: v })) } }, schema: {} });
const aliasM2M = () => ({ type: 'alias', meta: { interface: 'list-m2m', special: ['m2m'] } });

const PLATFORMS = [
  ['WordPress', 'wordpress', 'cms'],
  ['WooCommerce', 'woocommerce', 'ecommerce'],
  ['PrestaShop', 'prestashop', 'ecommerce'],
  ['Wix', 'wix', 'site-builder'],
  ['Joomla', 'joomla', 'cms'],
  ['Drupal', 'drupal', 'cms'],
  ['Shopify', 'shopify', 'ecommerce'],
  ['Squarespace', 'squarespace', 'site-builder'],
  ['Custom / Coded', 'custom', 'framework'],
];

async function main() {
  await waitForDirectus();
  await ensureStaticToken();
  client = makeClient();

  // 1) Coleções base + junção M2M (escondida)
  await ensureCollection('platforms', { icon: 'widgets', note: 'Catálogo de plataformas/tecnologias' });
  await ensureCollection('companies', { icon: 'business', note: 'Empresas' });
  await ensureCollection('sites', { icon: 'language', note: 'Domínios com site ativo + enriquecimento' });
  await ensureCollection('contacts', { icon: 'contacts', note: 'Contactos de pessoas (multi-fonte)' });
  await ensureCollection('sites_platforms', { icon: 'link', hidden: true });
  await ensureCollection('segments', { icon: 'bookmark', note: 'Segmentos guardados (combinações de filtros)' });
  await ensureCollection('site_reports', { icon: 'assessment', note: 'Relatórios de auditoria (Lighthouse / Nuclei / WPScan / GMB)' });
  // Fase F — Campanhas + e-mail personalizado por IA.
  await ensureCollection('campaigns', { icon: 'campaign', note: 'Campanhas de outreach (segmento + ângulo + e-mails gerados)' });
  await ensureCollection('emails', { icon: 'outgoing_mail', note: 'E-mails renderizados por destinatário (1 por contacto)' });
  // Outreach Fase 2 — envio cold multi-conta + supressão.
  await ensureCollection('sending_accounts', { icon: 'alternate_email', note: 'Mailboxes de envio (estado + warmup + contadores; credenciais em config/sending-accounts.json)' });
  await ensureCollection('dnc', { icon: 'block', note: 'Do-Not-Contact (unsubscribes, bounces, complaints)' });

  // 2) Campos escalares
  console.log('Campos: platforms');
  await ensureField('platforms', 'name', str());
  await ensureField('platforms', 'slug', strUnique());
  await ensureField('platforms', 'category', {
    type: 'string',
    meta: {
      interface: 'select-dropdown',
      options: {
        choices: ['cms', 'ecommerce', 'site-builder', 'framework', 'language'].map((v) => ({ text: v, value: v })),
      },
    },
    schema: {},
  });
  await ensureField('platforms', 'created_at', dateCreated());

  console.log('Campos: sites');
  await ensureField('sites', 'domain', { type: 'string', meta: { interface: 'input' }, schema: { is_unique: true, is_nullable: false } });
  await ensureField('sites', 'hostnames', json());
  await ensureField('sites', 'hosting_ip', str());
  await ensureField('sites', 'ptr', str());
  await ensureField('sites', 'asn', int());
  await ensureField('sites', 'isp', str());
  await ensureField('sites', 'ip_country', str());
  await ensureField('sites', 'ip_city', str());
  await ensureField('sites', 'cdn', str());
  await ensureField('sites', 'is_live', bool(false));
  await ensureField('sites', 'http_status', int());
  await ensureField('sites', 'final_url', str());
  await ensureField('sites', 'redirects_www', bool(false));
  await ensureField('sites', 'language', str());
  await ensureField('sites', 'tech_detected', json());
  await ensureField('sites', 'qualified', bool(false));
  await ensureField('sites', 'discovered_via', { type: 'string', meta: { interface: 'input' }, schema: { default_value: 'common_crawl' } });
  await ensureField('sites', 'checked_at', ts());
  await ensureField('sites', 'contacts_checked_at', ts()); // marca de resume da extração de contactos
  await ensureField('sites', 'created_at', dateCreated());

  console.log('Campos: sites (auditoria/filtros)');
  // Contactos (rollup)
  await ensureField('sites', 'has_email', bool(false));
  await ensureField('sites', 'has_phone', bool(false));
  // Localidade do negócio (do GMB quando existe, senão on-site)
  await ensureField('sites', 'business_city', str());
  await ensureField('sites', 'business_region', str());
  await ensureField('sites', 'business_address', text());
  // Redes sociais
  await ensureField('sites', 'social', json());
  await ensureField('sites', 'social_facebook', bool(false));
  await ensureField('sites', 'social_instagram', bool(false));
  await ensureField('sites', 'social_linkedin', bool(false));
  await ensureField('sites', 'social_twitter', bool(false));
  await ensureField('sites', 'social_youtube', bool(false));
  await ensureField('sites', 'social_tiktok', bool(false));
  await ensureField('sites', 'social_pinterest', bool(false));
  await ensureField('sites', 'social_whatsapp', bool(false));   // sinal ALTA-prioridade (PMEs PT)
  await ensureField('sites', 'whatsapp_number', str());
  // Anti-bot / WAF / IP-bloqueado: o site tem de ser re-corrido a partir de IP residencial (laptop).
  await ensureField('sites', 'blocked_datacenter', bool(false));
  await ensureField('sites', 'blocked_at', ts());
  // Google My Business
  await ensureField('sites', 'gmb', bool(false));
  await ensureField('sites', 'gmb_signal', str());
  await ensureField('sites', 'gmb_place_id', str());
  await ensureField('sites', 'gmb_name', str());
  await ensureField('sites', 'gmb_category', str());
  await ensureField('sites', 'gmb_rating', float());
  await ensureField('sites', 'gmb_reviews', int());
  await ensureField('sites', 'gmb_phone', str());
  await ensureField('sites', 'gmb_url', str());
  // Infra
  await ensureField('sites', 'is_cpanel', bool(false));
  await ensureField('sites', 'cpanel_signal', str());
  // Performance / tráfego
  await ensureField('sites', 'load_ms', int());
  await ensureField('sites', 'load_bucket', enumS(['fast', 'medium', 'slow', 'very_slow']));
  await ensureField('sites', 'traffic_rank', int());
  await ensureField('sites', 'traffic_bucket', enumS(['top10k', 'top100k', 'top1m', 'unranked']));
  // Email auth
  await ensureField('sites', 'spf_status', enumS(['ok', 'weak', 'missing', 'invalid']));
  await ensureField('sites', 'dmarc_status', enumS(['ok', 'weak', 'missing', 'invalid']));
  // Atividade + auditorias pesadas
  await ensureField('sites', 'industry', str());
  await ensureField('sites', 'industry_confidence', float());
  await ensureField('sites', 'seo_score', int());
  await ensureField('sites', 'mobile_score', int());
  await ensureField('sites', 'mobile_friendly', bool(false));
  await ensureField('sites', 'wp_vuln_count', int());
  await ensureField('sites', 'security_findings', int());
  await ensureField('sites', 'security_severity', enumS(['info', 'low', 'medium', 'high', 'critical']));
  await ensureField('sites', 'audit_status', { type: 'string', meta: { interface: 'select-dropdown', options: { choices: ['pending', 'queued', 'running', 'done', 'error', 'skipped'].map((v) => ({ text: v, value: v })) } }, schema: { default_value: 'pending' } });
  await ensureField('sites', 'audit_error', text());
  await ensureField('sites', 'cheap_checked_at', ts());
  await ensureField('sites', 'audit_checked_at', ts());

  console.log('Campos: sites (qualificação v2 + lead score)');
  await ensureField('sites', 'has_decision_maker', bool(false)); // rollup de contacts com role decisor
  await ensureField('sites', 'qualified_reasons', json());       // que sinais fizeram qualificar (transparência)
  await ensureField('sites', 'lead_score', int());               // 0-100
  await ensureField('sites', 'lead_score_breakdown', json());    // {sinal: pontos}
  await ensureField('sites', 'lead_score_at', ts());

  console.log('Campos: sites (Fase D — SSL/WHOIS/DNS/CMS)');
  await ensureField('sites', 'ssl_issuer', str());
  await ensureField('sites', 'ssl_not_after', ts());
  await ensureField('sites', 'ssl_days_left', int());
  await ensureField('sites', 'ssl_grade', str());
  await ensureField('sites', 'whois_registrar', str());
  await ensureField('sites', 'domain_created', ts());
  await ensureField('sites', 'domain_expiry', ts());
  await ensureField('sites', 'domain_age_days', int());
  await ensureField('sites', 'expiring_soon', bool(false)); // WHOIS expira em ≤90d
  await ensureField('sites', 'whois_checked_at', ts()); // resume do router WHOIS (não reprocessar .pt sem dados)
  await ensureField('sites', 'dns_provider', str());
  await ensureField('sites', 'cms_version', str());
  await ensureField('sites', 'cms_outdated', bool(false));

  console.log('Campos: campaigns / emails (Fase F)');
  const ANGLES = ['general', 'speed', 'seo', 'security', 'hosting', 'maintenance'];
  const CAMPAIGN_STATUS = ['draft', 'generating', 'ready', 'sending', 'sent', 'paused'];
  const EMAIL_STATUS = ['pending', 'generating', 'ready', 'sending', 'sent', 'failed', 'opened', 'clicked', 'replied', 'bounced', 'unsubscribed', 'skipped'];
  await ensureField('campaigns', 'name', str());
  await ensureField('campaigns', 'status', enumS(CAMPAIGN_STATUS));
  await ensureField('campaigns', 'angle', enumS(ANGLES));
  await ensureField('campaigns', 'audience_filters', json());   // snapshot do filtro do segmento
  await ensureField('campaigns', 'from_name', str());
  await ensureField('campaigns', 'from_email', str());
  await ensureField('campaigns', 'reply_to', str());
  await ensureField('campaigns', 'subject_hint', str());        // pista p/ a IA (opcional)
  await ensureField('campaigns', 'notes', text());
  await ensureField('campaigns', 'total', int());
  await ensureField('campaigns', 'generated', int());
  await ensureField('campaigns', 'sent', int());
  await ensureField('campaigns', 'opened', int());
  await ensureField('campaigns', 'clicked', int());
  await ensureField('campaigns', 'created_at', dateCreated());
  await ensureField('campaigns', 'sent_at', ts());

  await ensureField('emails', 'to_email', str());
  await ensureField('emails', 'to_name', str());
  await ensureField('emails', 'subject', str());
  await ensureField('emails', 'body', text());
  await ensureField('emails', 'status', enumS(EMAIL_STATUS));
  await ensureField('emails', 'ai_generated', bool(false));
  await ensureField('emails', 'variables', json());             // sinais do site usados na cópia
  await ensureField('emails', 'token', str());                  // token de tracking (open/click)
  await ensureField('emails', 'error', str());
  await ensureField('emails', 'created_at', dateCreated());
  await ensureField('emails', 'sent_at', ts());
  await ensureField('emails', 'opened_at', ts());
  await ensureField('emails', 'clicked_at', ts());
  await ensureField('emails', 'send_account', str());           // conta atribuída pelo drip (Fase 2)
  await ensureField('emails', 'bounce_type', str());            // hard/soft (do imap-poller)

  console.log('Campos: sending_accounts / dnc (Outreach Fase 2)');
  await ensureField('sending_accounts', 'account_id', strUnique()); // = id em config/sending-accounts.json
  await ensureField('sending_accounts', 'label', str());
  await ensureField('sending_accounts', 'from_email', str());
  await ensureField('sending_accounts', 'from_name', str());
  await ensureField('sending_accounts', 'domain', str());
  await ensureField('sending_accounts', 'ip', str());
  await ensureField('sending_accounts', 'provider', str());     // self|workspace|m365|mxroute|...
  await ensureField('sending_accounts', 'warmup_stage', int()); // dia/etapa do warmup
  await ensureField('sending_accounts', 'daily_cap', int());    // limite diário atual (ramp)
  await ensureField('sending_accounts', 'sent_today', int());
  await ensureField('sending_accounts', 'sent_date', str());    // 'YYYY-MM-DD' do contador
  await ensureField('sending_accounts', 'last_sent_at', ts());
  await ensureField('sending_accounts', 'active', bool(false));
  await ensureField('sending_accounts', 'created_at', dateCreated());

  await ensureField('dnc', 'email', str());
  await ensureField('dnc', 'domain', str());
  await ensureField('dnc', 'reason', enumS(['unsubscribe', 'bounce', 'complaint', 'manual', 'replied_stop']));
  await ensureField('dnc', 'source', str());                    // campanha/mailbox de origem
  await ensureField('dnc', 'created_at', dateCreated());

  console.log('Campos: site_reports');
  await ensureField('site_reports', 'kind', enumS(['lighthouse_seo', 'lighthouse_mobile', 'nuclei', 'wpscan', 'gmb']));
  await ensureField('site_reports', 'score', int());
  await ensureField('site_reports', 'summary', json());
  await ensureField('site_reports', 'report', json());
  await ensureField('site_reports', 'created_at', dateCreated());

  console.log('Campos: companies');
  await ensureField('companies', 'org_domain', strUnique()); // chave de deduplicação
  await ensureField('companies', 'name', str());
  await ensureField('companies', 'website', str());
  await ensureField('companies', 'general_email', str());
  await ensureField('companies', 'general_phone', str());
  await ensureField('companies', 'phones', json()); // todos os telefones da empresa (E.164), fixos+móveis
  await ensureField('companies', 'address', text());
  await ensureField('companies', 'country', str());
  await ensureField('companies', 'source', str());
  await ensureField('companies', 'notes', text());
  await ensureField('companies', 'created_at', dateCreated());
  // B3 — Clientes (empresas convertidas de prospeto → cliente): flag + metadados.
  await ensureField('companies', 'is_client', bool(false));
  await ensureField('companies', 'client_since', ts());
  await ensureField('companies', 'client_mrr', float());   // mensalidade (manutenção + alojamento), €
  await ensureField('companies', 'client_notes', text());

  console.log('Campos: contacts');
  await ensureField('contacts', 'name', str());
  await ensureField('contacts', 'role', str());
  await ensureField('contacts', 'email', str());
  await ensureField('contacts', 'phone', str());
  await ensureField('contacts', 'source', {
    type: 'string',
    meta: {
      interface: 'select-dropdown',
      options: {
        choices: ['site', 'social', 'directory', 'dork', 'database', 'csv_import'].map((v) => ({ text: v, value: v })),
      },
    },
    schema: {},
  });
  await ensureField('contacts', 'source_detail', str());
  await ensureField('contacts', 'phone_country', str()); // ISO2 do telefone (E.164 normalizado em phone)
  await ensureField('contacts', 'role_category', enumS(['decision_maker', 'manager', 'dpo', 'staff', 'general', 'unknown']));
  await ensureEnumChoices('contacts', 'role_category', ['decision_maker', 'manager', 'dpo', 'staff', 'general', 'unknown']); // 'general' = caixa da empresa (info@/geral@), não pessoa
  await ensureField('contacts', 'social_profiles', json());
  await ensureField('contacts', 'gdpr_basis', { type: 'string', meta: { interface: 'input' }, schema: { default_value: 'legitimate_interest' } });
  await ensureField('contacts', 'email_verified', bool(false));
  await ensureField('contacts', 'email_source', str()); // pattern_smtp / api:<provider> / pattern_guess / existing
  await ensureField('contacts', 'email_status', {
    type: 'string',
    meta: { interface: 'select-dropdown', options: { choices: ['valid', 'invalid', 'catch_all', 'role', 'disposable', 'no_mx', 'unknown'].map((v) => ({ text: v, value: v })) } },
    schema: {},
  });
  await ensureField('contacts', 'verified_at', ts());
  await ensureField('contacts', 'created_at', dateCreated());
  // Outreach Fase 2/3 — supressão + funil de resposta.
  await ensureField('contacts', 'do_not_contact', bool(false)); // DNC (unsub/bounce/complaint) + exclusão manual de audiência
  await ensureField('contacts', 'reviewed', bool(false));       // correção manual general↔pessoa já feita (não re-tocar)
  await ensureField('contacts', 'reviewed_at', ts());
  await ensureField('contacts', 'responded', bool(false));      // respondeu ao cold → candidato warm
  await ensureField('contacts', 'responded_at', ts());
  await ensureField('contacts', 'esp_engaged', bool(false));    // abriu/clicou no ESP (Fase 3)

  console.log('Campos: segments');
  await ensureField('segments', 'name', str());
  await ensureField('segments', 'description', text());
  await ensureField('segments', 'accent', str()); // cor de destaque (token/hex)
  await ensureField('segments', 'filters', json()); // {q,qualified,platform,country}
  await ensureField('segments', 'shared', bool(false));
  await ensureField('segments', 'owner', str());
  await ensureField('segments', 'created_at', dateCreated());

  // 3) Campos relacionais (M2O FK + junção)
  await ensureField('sites', 'company', m2oField());
  await ensureField('sites', 'primary_platform', m2oField());
  await ensureField('contacts', 'company', m2oField());
  await ensureField('contacts', 'site', m2oField());
  await ensureField('sites_platforms', 'site', m2oField());
  await ensureField('sites_platforms', 'platform', m2oField());
  await ensureField('site_reports', 'site', m2oField());
  // Fase F
  await ensureField('campaigns', 'segment', m2oField());
  await ensureField('emails', 'campaign', m2oField());
  await ensureField('emails', 'contact', m2oField());
  await ensureField('emails', 'site', m2oField());

  // Aliases reversos (O2M / M2M)
  await ensureField('companies', 'sites', aliasO2M());
  await ensureField('companies', 'contacts', aliasO2M());
  await ensureField('sites', 'platforms', aliasM2M());
  await ensureField('sites', 'reports', aliasO2M());
  await ensureField('campaigns', 'emails', aliasO2M());

  // 4) Relações
  console.log('Relações');
  await ensureRelation({
    collection: 'sites',
    field: 'company',
    related_collection: 'companies',
    meta: { many_field: 'company', one_field: 'sites', sort_field: null, one_deselect_action: 'nullify' },
    schema: { on_delete: 'SET NULL' },
  });
  await ensureRelation({
    collection: 'sites',
    field: 'primary_platform',
    related_collection: 'platforms',
    meta: { many_field: 'primary_platform', one_field: null, sort_field: null },
    schema: { on_delete: 'SET NULL' },
  });
  await ensureRelation({
    collection: 'contacts',
    field: 'company',
    related_collection: 'companies',
    meta: { many_field: 'company', one_field: 'contacts', sort_field: null, one_deselect_action: 'nullify' },
    schema: { on_delete: 'SET NULL' },
  });
  await ensureRelation({
    collection: 'contacts',
    field: 'site',
    related_collection: 'sites',
    meta: { many_field: 'site', one_field: null, sort_field: null },
    schema: { on_delete: 'SET NULL' },
  });
  // M2M sites <-> platforms via sites_platforms
  await ensureRelation({
    collection: 'sites_platforms',
    field: 'site',
    related_collection: 'sites',
    meta: { many_field: 'site', one_field: 'platforms', junction_field: 'platform', sort_field: null },
    schema: { on_delete: 'CASCADE' },
  });
  await ensureRelation({
    collection: 'sites_platforms',
    field: 'platform',
    related_collection: 'platforms',
    meta: { many_field: 'platform', one_field: null, junction_field: 'site', sort_field: null },
    schema: { on_delete: 'CASCADE' },
  });
  // site_reports -> sites (O2M; relatórios apagam com o site)
  await ensureRelation({
    collection: 'site_reports',
    field: 'site',
    related_collection: 'sites',
    meta: { many_field: 'site', one_field: 'reports', sort_field: null },
    schema: { on_delete: 'CASCADE' },
  });
  // Fase F — campanhas / e-mails
  await ensureRelation({
    collection: 'campaigns',
    field: 'segment',
    related_collection: 'segments',
    meta: { many_field: 'segment', one_field: null, sort_field: null },
    schema: { on_delete: 'SET NULL' },
  });
  await ensureRelation({
    collection: 'emails',
    field: 'campaign',
    related_collection: 'campaigns',
    meta: { many_field: 'campaign', one_field: 'emails', sort_field: null },
    schema: { on_delete: 'CASCADE' }, // apagar a campanha apaga os e-mails
  });
  await ensureRelation({
    collection: 'emails',
    field: 'contact',
    related_collection: 'contacts',
    meta: { many_field: 'contact', one_field: null, sort_field: null },
    schema: { on_delete: 'SET NULL' },
  });
  await ensureRelation({
    collection: 'emails',
    field: 'site',
    related_collection: 'sites',
    meta: { many_field: 'site', one_field: null, sort_field: null },
    schema: { on_delete: 'SET NULL' },
  });

  // 5) Seed do catálogo de plataformas
  console.log('Seed: platforms');
  const existing = await client.request(readItems('platforms', { fields: ['slug'], limit: -1 }));
  const have = new Set(existing.map((p) => p.slug));
  for (const [name, slug, category] of PLATFORMS) {
    if (!have.has(slug)) {
      await client.request(createItem('platforms', { name, slug, category }));
      console.log(`  seed ${slug}`);
    }
  }

  console.log('\nBootstrap concluído.');
}

main().catch((err) => {
  console.error('Erro no bootstrap:', err.errors ? JSON.stringify(err.errors, null, 2) : err.message);
  process.exit(1);
});
