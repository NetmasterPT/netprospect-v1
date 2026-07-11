// lib/campaign-ai.js — Fase F: gera a cópia de e-mail PERSONALIZADA por destinatário.
// Usa os sinais do próprio site (plataforma, velocidade, SEO, segurança, SSL/domínio,
// GMB…) para que cada e-mail seja materialmente diferente (personalização real +
// anti-spam). Ollama (Gemma) quando disponível; senão, template de fallback do
// config/campaign-angles.json — a campanha funciona sempre, com ou sem IA.

import fs from 'node:fs';
import { ollamaGenerate, ollamaEnabled } from './ollama.js';

const CFG = (() => { try { return JSON.parse(fs.readFileSync(new URL('../config/campaign-angles.json', import.meta.url))); } catch { return { angles: {}, sender_org: 'Netmaster' }; } })();
export const ANGLES = Object.keys(CFG.angles || {});
export const angleConfig = (a) => CFG.angles?.[a] || CFG.angles?.general || {};

const firstName = (name) => {
  const t = String(name || '').trim().split(/\s+/)[0];
  return t && /^[a-zà-ÿ'.-]{2,}$/i.test(t) ? t : '';
};
const PLATFORM_WORD = { wordpress: 'WordPress', woocommerce: 'WooCommerce', prestashop: 'PrestaShop', wix: 'Wix', shopify: 'Shopify', joomla: 'Joomla', drupal: 'Drupal' };
const SLOW = new Set(['slow', 'very_slow']);
const isProblem = (s) => ['missing', 'weak', 'invalid'].includes(s);

// Deriva o dicionário de variáveis + "clauses" condicionais a partir dos dados.
export function buildVariables(contact, site, company, campaign = {}) {
  const s = site || {}; const c = contact || {}; const co = company || {};
  const slug = s.primary_platform?.slug || s.primary_platform || '';
  const plat = PLATFORM_WORD[String(slug).toLowerCase()] || '';
  const fn = firstName(c.name) || '';
  const v = {
    first_name: fn || 'Olá',
    company: co.name || s.domain || 'a vossa empresa',
    domain: s.domain || '',
    from_name: campaign.from_name || 'Equipa Netmaster',
    platform: slug || '',
    platform_word: plat || 'como o vosso',
    city: s.business_city || '',
    industry: s.industry || '',
    load_bucket: s.load_bucket || '',
    seo_score: s.seo_score,
    security_findings: s.security_findings,
    ssl_days_left: s.ssl_days_left,
    cms_version: s.cms_version || '',
    cms_outdated: !!s.cms_outdated,
    no_gmb: s.gmb === false,
    spf_problem: isProblem(s.spf_status),
    dmarc_problem: isProblem(s.dmarc_status),
    expiring_soon: !!s.expiring_soon,
    dns_provider: s.dns_provider || '',
  };
  // Saudação: "Olá Ana" quando há nome; "Olá" quando não há (evita "Olá Olá").
  v.greeting = fn ? `Olá ${fn}` : 'Olá';
  // Clauses condicionais (frases só quando o sinal existe).
  v.platform_clause = plat ? `, feito em ${plat},` : '';
  v.platform_word = plat || 'como o vosso';
  v.speed_clause = SLOW.has(v.load_bucket) ? ' e reparei que está a carregar devagar' : '';
  v.seo_clause = (typeof v.seo_score === 'number' && v.seo_score < 60) ? `, o SEO técnico está fraco (${v.seo_score}/100)` : '';
  v.gmb_clause = v.no_gmb ? ' e não encontrei ficha de Google Business' : '';
  const secBits = [];
  if (typeof v.security_findings === 'number' && v.security_findings > 0) secBits.push(`${v.security_findings} alerta${v.security_findings === 1 ? '' : 's'} de segurança`);
  if (v.cms_outdated) secBits.push(`${plat || 'o CMS'} desatualizado${v.cms_version ? ` (${v.cms_version})` : ''}`);
  if (v.spf_problem) secBits.push('SPF em falta');
  if (v.dmarc_problem) secBits.push('DMARC em falta');
  if (typeof v.ssl_days_left === 'number' && v.ssl_days_left >= 0 && v.ssl_days_left <= 30) secBits.push(`certificado a expirar em ${v.ssl_days_left} dias`);
  v.security_clause = secBits.length ? ` (${secBits.slice(0, 3).join(', ')})` : '';
  const hostBits = [];
  if (v.expiring_soon) hostBits.push('o domínio está perto de expirar');
  if (typeof v.ssl_days_left === 'number' && v.ssl_days_left >= 0 && v.ssl_days_left <= 30) hostBits.push('o certificado SSL está a expirar');
  v.hosting_clause = hostBits.length ? `, e ${hostBits.join(' e ')},` : '';
  v.maintenance_clause = v.cms_outdated ? ` está em ${plat || 'uma versão'} desatualizada${v.cms_version ? ` (${v.cms_version})` : ''}` : (plat ? ` está feito em ${plat}` : '');
  // pain_clause — resumo dos 2 principais problemas p/ o ângulo geral.
  const pains = [];
  if (SLOW.has(v.load_bucket)) pains.push('velocidade');
  if (typeof v.seo_score === 'number' && v.seo_score < 60) pains.push('SEO');
  if ((v.security_findings > 0) || v.cms_outdated) pains.push('segurança');
  if (v.spf_problem || v.dmarc_problem) pains.push('autenticação de email');
  v.pain_clause = pains.length ? ` (sobretudo ${pains.slice(0, 2).join(' e ')})` : '';
  return v;
}

// Substitui {{var}} pelas variáveis (string vazia se ausente).
export function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => {
    const val = vars[k];
    return val == null || val === false ? '' : String(val);
  }).replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n');
}

// Fallback determinístico (template do config), sem IA.
export function fallbackEmail(vars, angle) {
  const a = angleConfig(angle);
  return {
    subject: renderTemplate(a.fallback?.subject || '{{company}} — o vosso site', vars),
    body: renderTemplate(a.fallback?.body || 'Olá {{first_name}},\n\nGostaria de falar sobre o {{domain}}.\n\n{{from_name}}\nNetmaster', vars),
    ai_generated: false,
  };
}

// Factos concisos p/ a IA (só os sinais presentes/relevantes ao ângulo).
function factsFor(vars) {
  const f = [];
  if (vars.platform) f.push(`plataforma: ${vars.platform_word}`);
  if (vars.city) f.push(`cidade: ${vars.city}`);
  if (vars.industry) f.push(`setor: ${vars.industry}`);
  if (SLOW.has(vars.load_bucket)) f.push('site lento a carregar');
  if (typeof vars.seo_score === 'number' && vars.seo_score < 60) f.push(`SEO fraco (${vars.seo_score}/100)`);
  if (vars.no_gmb) f.push('sem ficha Google Business');
  if (vars.security_findings > 0) f.push(`${vars.security_findings} alertas de segurança`);
  if (vars.cms_outdated) f.push(`${vars.platform_word} desatualizado${vars.cms_version ? ` (${vars.cms_version})` : ''}`);
  if (vars.spf_problem) f.push('SPF em falta');
  if (vars.dmarc_problem) f.push('DMARC em falta');
  if (typeof vars.ssl_days_left === 'number' && vars.ssl_days_left >= 0 && vars.ssl_days_left <= 30) f.push(`certificado a expirar em ${vars.ssl_days_left} dias`);
  if (vars.expiring_soon) f.push('domínio perto de expirar');
  return f;
}

// Gera com Ollama (JSON estruturado). Devolve null em falha/timeout → cai no fallback.
async function aiEmail(vars, angle, campaign, { model, timeoutMs = 45000 } = {}) {
  const a = angleConfig(angle);
  const facts = factsFor(vars);
  if (!facts.length && angle !== 'general') return null; // sem factos p/ este ângulo → fallback genérico
  const format = { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] };
  const prompt = [
    `És o(a) ${vars.from_name}, da Netmaster (agência web portuguesa: manutenção de sites + alojamento gerido).`,
    `Escreve um e-mail de prospeção B2B, em português de Portugal, CURTO (máx. 110 palavras), pessoal e direto — NÃO promocional a mais.`,
    `Ângulo: ${a.label || angle}. ${a.ai_guidance || ''}`,
    campaign.subject_hint ? `Pista de assunto: ${campaign.subject_hint}.` : '',
    `Destinatário: ${vars.first_name !== 'Olá' ? vars.first_name : 'contacto'} de "${vars.company}" (site ${vars.domain}).`,
    facts.length ? `Factos REAIS do site (refere 1-2, de forma natural, para mostrar que analisaste): ${facts.join('; ')}.` : 'Sem métricas específicas — mantém geral mas pessoal.',
    `Termina com uma pergunta simples (oferece uma auditoria/análise gratuita) e assina como "${vars.from_name}\\nNetmaster".`,
    `NÃO inventes dados. NÃO uses placeholders. Responde só em JSON {subject, body}.`,
  ].filter(Boolean).join('\n');
  const { ok, json } = await ollamaGenerate(prompt, { format, model, timeoutMs, options: { temperature: 0.6 } });
  if (!ok || !json) return null;
  const subject = String(json.subject || '').trim().slice(0, 200);
  const bodyTxt = String(json.body || '').trim();
  if (!subject || bodyTxt.length < 30) return null; // resposta pobre → fallback
  return { subject, body: bodyTxt, ai_generated: true };
}

// Ponto de entrada: gera o e-mail para 1 destinatário. `useAI=false` força template.
export async function generateEmail({ contact, site, company, campaign, angle, useAI = true, model, timeoutMs } = {}) {
  const ang = ANGLES.includes(angle) ? angle : 'general';
  const vars = buildVariables(contact, site, company, campaign || {});
  let out = null;
  if (useAI && ollamaEnabled()) out = await aiEmail(vars, ang, campaign || {}, { model, timeoutMs });
  if (!out) out = fallbackEmail(vars, ang);
  return { ...out, variables: vars };
}
