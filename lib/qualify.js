// lib/qualify.js
// Qualificação v2, CONFIGURÁVEL (config/qualification.json). Um site é "qualified"
// se tiver ≥1 contacto de email (has_email) E ≥1 sinal da lista signals_any.
// Substitui a qualificação só-por-plataforma (WP/Woo/Presta/Wix) anterior.
//
// Sinais avaliados a partir do registo do site (campos já existentes em `sites`):

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CFG_PATH = path.join(__dirname, '..', 'config', 'qualification.json');

export const TARGET_PLATFORMS = new Set(['wordpress', 'woocommerce', 'prestashop', 'wix']);

// Cada sinal é um predicado sobre o registo do site. `slug` = primary_platform.slug;
// `platforms` = array opcional de slugs detetados.
const SIGNALS = {
  target_platform: (s) => TARGET_PLATFORMS.has(s.slug) || (s.platforms || []).some((p) => TARGET_PLATFORMS.has(p)),
  cpanel: (s) => s.is_cpanel === true,
  shopify: (s) => s.slug === 'shopify' || (s.platforms || []).includes('shopify'),
  spf_problem: (s) => ['missing', 'weak', 'invalid'].includes(s.spf_status),
  dmarc_problem: (s) => ['missing', 'weak', 'invalid'].includes(s.dmarc_status),
  security_findings: (s) => (s.security_findings || 0) > 0,
  no_gmb: (s) => s.gmb === false,
  weak_seo: (s) => s.seo_score != null && s.seo_score < 60,
};

let _cachedCfg = null;
export function loadQualifyConfig(cfgPath = process.env.QUALIFY_CONFIG || DEFAULT_CFG_PATH) {
  if (_cachedCfg) return _cachedCfg;
  try { _cachedCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch { _cachedCfg = { require_email: true, signals_any: ['target_platform'] }; }
  return _cachedCfg;
}

// site: { slug, platforms?, is_cpanel, spf_status, dmarc_status, security_findings, gmb, seo_score, has_email }
// Devolve { qualified, reasons }.
export function qualify(site, cfg = loadQualifyConfig()) {
  const reasons = [];
  for (const sig of cfg.signals_any) if (SIGNALS[sig] && SIGNALS[sig](site)) reasons.push(sig);
  const emailOk = cfg.require_email ? !!site.has_email : true;
  return { qualified: emailOk && reasons.length > 0, reasons };
}
