import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reloadPlans, planModules, planLimit, featureAccess, checkUsage, listPlans, getPlan } from '../lib/entitlements.js';

// Fixture determinístico via PLANS_CONFIG + reloadPlans() (limpa o cache, independente da ordem de import).
const HERE = path.dirname(fileURLToPath(import.meta.url));
beforeAll(() => { process.env.PLANS_CONFIG = path.join(HERE, 'fixtures/plans.json'); reloadPlans(); });

describe('planModules', () => {
  it('expande @base (herança) e deduplica', () => {
    const m = planModules('pro');
    expect(m).toEqual(expect.arrayContaining(['core', 'dashboard/*', 'servers/*']));
    expect(new Set(m).size).toBe(m.length);
  });
  it('plano inexistente → []', () => { expect(planModules('nope')).toEqual([]); });
});

describe('planLimit', () => {
  it('devolve {amount, period} do plano', () => {
    expect(planLimit('base', 'ai-credits')).toEqual({ amount: 100, period: 'monthly' });
  });
  it('feature sem limite → null', () => { expect(planLimit('pro', 'contacts-extracted')).toBeNull(); });
});

describe('featureAccess', () => {
  it('flag off → sem acesso', () => {
    expect(featureAccess('base', 'ai-credits', {}).access).toBe(false);
  });
  it('flag on → acesso + limite', () => {
    const a = featureAccess('base', 'ai-credits', { feat_ai_credits: true });
    expect(a.access).toBe(true);
    expect(a.limit).toEqual({ amount: 100, period: 'monthly' });
  });
  it('feature sem flag → acesso sempre', () => {
    expect(featureAccess('base', 'contacts-extracted', {}).access).toBe(true);
  });
  it('feature desconhecida → unknown-feature', () => {
    expect(featureAccess('base', 'xpto', {}).reason).toBe('unknown-feature');
  });
});

describe('checkUsage', () => {
  it('sem acesso (flag off) → allowed:false', () => {
    expect(checkUsage('base', 'ai-credits', 0, {}).allowed).toBe(false);
  });
  it('ilimitado (amount null) → remaining Infinity', () => {
    const r = checkUsage('base', 'contacts-extracted', 9999, {});
    expect(r.remaining).toBe(Infinity);
    expect(r.allowed).toBe(true);
  });
  it('limitado: remaining = amount − usado, e esgota', () => {
    expect(checkUsage('base', 'ai-credits', 30, { feat_ai_credits: true }).remaining).toBe(70);
    const spent = checkUsage('base', 'ai-credits', 100, { feat_ai_credits: true });
    expect(spent.allowed).toBe(false);
    expect(spent.remaining).toBe(0);
  });
});

describe('config helpers', () => {
  it('listPlans + getPlan', () => {
    expect(listPlans().sort()).toEqual(['base', 'pro']);
    expect(getPlan('nope')).toBeNull();
  });
});
