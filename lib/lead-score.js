// lib/lead-score.js
// Índice de lead (0-100) por combinação ponderada de sinais (config/lead-score.json).
// score = min(max_score, soma dos pesos dos sinais presentes). Devolve também o
// breakdown {sinal: pontos} para transparência no dashboard. Pesos editáveis sem
// redeploy; sinais de Fase D (ssl/whois/cms) já previstos com peso 0.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TARGET_PLATFORMS } from './qualify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CFG_PATH = path.join(__dirname, '..', 'config', 'lead-score.json');
const bad = (v) => ['missing', 'weak', 'invalid'].includes(v);

// Cada sinal: predicado sobre o registo do site (campos de `sites`).
export const SCORE_SIGNALS = {
  target_platform: (s) => TARGET_PLATFORMS.has(s.slug) || (s.platforms || []).some((p) => TARGET_PLATFORMS.has(p)),
  cpanel: (s) => s.is_cpanel === true,
  has_decision_maker: (s) => s.has_decision_maker === true,
  has_email: (s) => s.has_email === true,
  has_valid_email: (s) => s.has_valid_email === true, // email entregável verificado (Reacher/API) — sinal forte
  has_phone: (s) => s.has_phone === true,
  spf_problem: (s) => bad(s.spf_status),
  dmarc_problem: (s) => bad(s.dmarc_status),
  security_high: (s) => ['high', 'critical'].includes(s.security_severity),
  security_any: (s) => (s.security_findings || 0) > 0,
  no_gmb: (s) => s.gmb === false,
  weak_seo: (s) => s.seo_score != null && s.seo_score < 60,
  slow_site: (s) => ['slow', 'very_slow'].includes(s.load_bucket),
  traffic_ranked: (s) => s.traffic_bucket && s.traffic_bucket !== 'unranked',
  // Fase D (peso 0 até serem recolhidos):
  ssl_expiring: (s) => s.ssl_days_left != null && s.ssl_days_left <= 21,
  whois_expiring: (s) => s.expiring_soon === true,
  cms_outdated: (s) => s.cms_outdated === true,
};

let _cachedCfg = null;
export function loadScoreConfig(cfgPath = process.env.LEAD_SCORE_CONFIG || DEFAULT_CFG_PATH) {
  if (_cachedCfg) return _cachedCfg;
  try { _cachedCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch { _cachedCfg = { max_score: 100, weights: {} }; }
  return _cachedCfg;
}

export function scoreSite(site, cfg = loadScoreConfig()) {
  const breakdown = {};
  let total = 0;
  for (const [sig, w] of Object.entries(cfg.weights || {})) {
    if (w && SCORE_SIGNALS[sig] && SCORE_SIGNALS[sig](site)) { breakdown[sig] = w; total += w; }
  }
  return { score: Math.min(cfg.max_score || 100, Math.round(total)), breakdown };
}
