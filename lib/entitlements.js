// lib/entitlements.js — planos comerciais + entitlements/limites de utilização.
// Fonte: config/plans.json. Modelo: acesso a uma feature = PostHog feature flag
// (feature.flag); se tem acesso, o plano define o limite por período (daily|weekly|
// monthly, amount:null = ilimitado). O metering (uso no período) é fornecido pelo
// chamador — liga-se aos contadores reais quando as features existirem.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLANS_PATH = process.env.PLANS_CONFIG ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/plans.json');

let _cfg = null;
export function loadPlans() {
  if (!_cfg) _cfg = JSON.parse(fs.readFileSync(PLANS_PATH, 'utf8'));
  return _cfg;
}
export function reloadPlans() { _cfg = null; return loadPlans(); }

export function listFeatures() { return loadPlans().features || []; }
export function getFeature(featureId) { return listFeatures().find((f) => f.id === featureId) || null; }
export function getPlan(planId) { return (loadPlans().plans || {})[planId] || null; }
export function listPlans() { return Object.keys(loadPlans().plans || {}); }

/** Expande os módulos de um plano, resolvendo refs @outroPlano (herança). */
export function planModules(planId, seen = new Set()) {
  const p = getPlan(planId);
  if (!p || seen.has(planId)) return [];
  seen.add(planId);
  const out = [];
  for (const m of (p.modules || [])) {
    if (m.startsWith('@')) out.push(...planModules(m.slice(1), seen));
    else out.push(m);
  }
  return [...new Set(out)];
}

/** Limite do plano para uma feature ({amount, period}) ou null. */
export function planLimit(planId, featureId) {
  const p = getPlan(planId);
  return (p && p.limits && p.limits[featureId]) || null;
}

/**
 * Acesso a uma feature: a flag PostHog decide on/off; o plano dá o limite.
 * @param flags {{[flagKey:string]: boolean}} flags resolvidas pelo PostHog (server/client).
 */
export function featureAccess(planId, featureId, flags = {}) {
  const feat = getFeature(featureId);
  if (!feat) return { access: false, reason: 'unknown-feature', limit: null };
  const access = feat.flag ? !!flags[feat.flag] : true;
  return { access, limit: planLimit(planId, featureId), unit: feat.unit, flag: feat.flag };
}

/**
 * Dado o uso já consumido no período, devolve allowed/remaining.
 * @param usedInPeriod número de utilizações já feitas no período corrente.
 */
export function checkUsage(planId, featureId, usedInPeriod = 0, flags = {}) {
  const { access, limit, unit } = featureAccess(planId, featureId, flags);
  if (!access) return { allowed: false, access: false, remaining: 0, limit, unit };
  if (!limit || limit.amount == null) return { allowed: true, access: true, remaining: Infinity, limit, unit };
  const remaining = Math.max(0, limit.amount - Number(usedInPeriod || 0));
  return { allowed: remaining > 0, access: true, remaining, limit, unit, period: limit.period };
}
