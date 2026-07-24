import { describe, it, expect } from 'vitest';
import { qualify, TARGET_PLATFORMS } from '../lib/qualify.js';

const cfg = { require_email: true, signals_any: ['target_platform', 'cpanel', 'weak_seo'] };

describe('qualify', () => {
  it('qualifica com email + ≥1 sinal', () => {
    const r = qualify({ slug: 'wordpress', has_email: true }, cfg);
    expect(r.qualified).toBe(true);
    expect(r.reasons).toContain('target_platform');
  });
  it('sem email não qualifica quando require_email', () => {
    expect(qualify({ slug: 'wordpress', has_email: false }, cfg).qualified).toBe(false);
  });
  it('email mas nenhum sinal → não qualifica', () => {
    const r = qualify({ slug: 'drupal', has_email: true }, cfg);
    expect(r.qualified).toBe(false);
    expect(r.reasons).toEqual([]);
  });
  it('require_email:false ignora o email', () => {
    const r = qualify({ slug: 'wix' }, { require_email: false, signals_any: ['target_platform'] });
    expect(r.qualified).toBe(true);
  });
  it('acumula múltiplas razões', () => {
    const r = qualify({ slug: 'wordpress', is_cpanel: true, has_email: true }, cfg);
    expect(r.reasons).toEqual(expect.arrayContaining(['target_platform', 'cpanel']));
  });
  it('TARGET_PLATFORMS = os 4 alvos', () => {
    expect([...TARGET_PLATFORMS].sort()).toEqual(['prestashop', 'wix', 'woocommerce', 'wordpress']);
  });
});
