// lib/audit/lighthouse.js
// Lighthouse (config mobile por omissão) contra o Chromium partilhado via
// chrome-launcher. Deriva seo_score + mobile_score + mobile_friendly e guarda o
// lhr completo em site_reports(kind:'lighthouse_*'). ~25-35s/site.

import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { browserProxyArg } from '../egress.js';

const FLAGS = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox'];

export async function runLighthouse(url, { chromePath = process.env.CHROME_PATH } = {}) {
  const chrome = await chromeLauncher.launch({ chromePath, chromeFlags: [...FLAGS, browserProxyArg()].filter(Boolean) });
  try {
    const runnerResult = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['seo', 'performance', 'accessibility', 'best-practices'],
    });
    const lhr = runnerResult.lhr;
    const cat = lhr.categories || {};
    const audits = lhr.audits || {};
    const catScore = (k) => (cat[k] && cat[k].score != null ? Math.round(cat[k].score * 100) : null);
    const auditScore = (id) => (audits[id] && audits[id].score != null ? audits[id].score : null);

    const seo_score = catScore('seo');
    const performance = catScore('performance');
    // Mobile-friendliness: viewport + tamanho de letra + tap targets (auditorias SEO/mobile).
    const vp = auditScore('viewport');
    const font = auditScore('font-size');
    const tap = auditScore('tap-targets');
    const parts = [vp, font, tap].filter((x) => x != null);
    const mobile_score = parts.length ? Math.round((100 * parts.reduce((s, x) => s + x, 0)) / parts.length) : performance;
    const mobile_friendly = vp === 1 && (font == null || font >= 0.9) && (tap == null || tap >= 0.9);

    return { seo_score, mobile_score, mobile_friendly, performance, lhr };
  } finally {
    try { await chrome.kill(); } catch { /* ignora */ }
  }
}

// Resumo pequeno p/ site_reports.summary (o lhr completo vai em .report).
export function lighthouseSummary(res) {
  return {
    seo_score: res.seo_score, mobile_score: res.mobile_score,
    mobile_friendly: res.mobile_friendly, performance: res.performance,
  };
}

// O `lhr` integral tem vários MB (details/traces/screenshots por auditoria) e o Directus
// rejeita-o ("request entity too large") → o relatório perdia-se. Guardamos só o essencial:
// scores por categoria + score/título de cada auditoria, sem os `details` (que são o grosso).
export function trimLhr(lhr) {
  if (!lhr) return null;
  const audits = Object.fromEntries(
    Object.entries(lhr.audits || {}).map(([k, a]) => [k, { score: a.score ?? null, displayValue: a.displayValue ?? null, title: a.title ?? null }]),
  );
  return { finalUrl: lhr.finalUrl ?? null, fetchTime: lhr.fetchTime ?? null, categories: lhr.categories ?? null, audits };
}

// Relatório INTEGRAL para object storage — igual ao lhr, MENOS os screenshots.
// Medido (site real): lhr completo 899 KB / 396 KB gzip; sem screenshots 435 KB / 71 KB gzip.
// Os screenshots são 82% do peso gzipado porque são base64 de JPEG (já comprimido → o gzip
// não os reduz). Tudo o que é ACIONÁVEL fica: network-requests, elementos com mau contraste,
// ficheiros CSS/JS não usados, cada `details` de cada auditoria. A imagem, se for precisa,
// regenera-se on-demand (o Lighthouse corre em ~19 s).
export function leanLhr(lhr) {
  if (!lhr) return null;
  const { fullPageScreenshot, ...rest } = lhr; // eslint-disable-line no-unused-vars
  const audits = Object.fromEntries(
    Object.entries(lhr.audits || {}).filter(([k]) => !/screenshot/i.test(k)),
  );
  return { ...rest, audits };
}
