import { describe, it, expect } from 'vitest';
import { scoreSite, SCORE_SIGNALS } from '../lib/lead-score.js';

// cfg injetado → determinístico (não depende de config/lead-score.json).
const cfg = { max_score: 100, weights: { target_platform: 18, has_email: 8, has_valid_email: 10, has_valid_corp_email: 6, security_high: 10 } };

describe('SCORE_SIGNALS', () => {
  it('target_platform casa slug OU platforms[]', () => {
    expect(SCORE_SIGNALS.target_platform({ slug: 'wordpress' })).toBe(true);
    expect(SCORE_SIGNALS.target_platform({ slug: 'x', platforms: ['woocommerce'] })).toBe(true);
    expect(SCORE_SIGNALS.target_platform({ slug: 'drupal', platforms: [] })).toBe(false);
  });
  it('has_valid_corp_email exige estritamente === true', () => {
    expect(SCORE_SIGNALS.has_valid_corp_email({ has_valid_corp_email: true })).toBe(true);
    expect(SCORE_SIGNALS.has_valid_corp_email({ has_valid_corp_email: 1 })).toBe(false);
    expect(SCORE_SIGNALS.has_valid_corp_email({})).toBe(false);
  });
  it('weak_seo: null não conta; <60 conta; 60 não', () => {
    expect(SCORE_SIGNALS.weak_seo({ seo_score: null })).toBe(false);
    expect(SCORE_SIGNALS.weak_seo({ seo_score: 59 })).toBe(true);
    expect(SCORE_SIGNALS.weak_seo({ seo_score: 60 })).toBe(false);
  });
  it('security_high só high|critical', () => {
    expect(SCORE_SIGNALS.security_high({ security_severity: 'critical' })).toBe(true);
    expect(SCORE_SIGNALS.security_high({ security_severity: 'medium' })).toBe(false);
  });
});

describe('scoreSite', () => {
  it('soma os pesos dos sinais presentes + breakdown por sinal', () => {
    const r = scoreSite({ slug: 'wordpress', has_email: true, has_valid_email: true, has_valid_corp_email: true }, cfg);
    expect(r.score).toBe(18 + 8 + 10 + 6);
    expect(r.breakdown).toEqual({ target_platform: 18, has_email: 8, has_valid_email: 10, has_valid_corp_email: 6 });
  });
  it('corp email empilha sobre valid (+6)', () => {
    const base = scoreSite({ has_email: true, has_valid_email: true }, cfg);
    const corp = scoreSite({ has_email: true, has_valid_email: true, has_valid_corp_email: true }, cfg);
    expect(corp.score - base.score).toBe(6);
  });
  it('clampa a max_score', () => {
    const capped = { max_score: 20, weights: { target_platform: 18, has_email: 8 } };
    expect(scoreSite({ slug: 'wix', has_email: true }, capped).score).toBe(20);
  });
  it('ignora pesos 0 e sinais desconhecidos', () => {
    const r = scoreSite({ slug: 'wordpress' }, { max_score: 100, weights: { target_platform: 0, inexistente: 5 } });
    expect(r.score).toBe(0);
    expect(r.breakdown).toEqual({});
  });
  it('site sem sinais → 0', () => {
    expect(scoreSite({}, cfg).score).toBe(0);
  });
});
