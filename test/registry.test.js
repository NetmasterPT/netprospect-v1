import { describe, it, expect } from 'vitest';
import { KB_COLLECTION, collectionFor, contentModules, activeModules, moduleFilter } from '../docs-site/kb/registry.mjs';

// Testa a federação contra os configs REAIS (content.json + plans.json) — invariantes robustas.
describe('registry — federação por coleção única + filtro', () => {
  it('coleção única (escape hatch)', () => {
    expect(KB_COLLECTION).toBe('netprospect_kb');
    expect(collectionFor('qualquer/modulo')).toBe('netprospect_kb');
  });

  it('contentModules: array ordenado, com core', () => {
    const m = contentModules();
    expect(Array.isArray(m)).toBe(true);
    expect(m.length).toBeGreaterThan(0);
    expect(m).toContain('core');
    expect([...m]).toEqual([...m].sort());
  });

  it("perfil 'interno' (=*) ativa TUDO → moduleFilter null (sem filtro)", () => {
    expect(activeModules('interno').length).toBe(contentModules().length);
    expect(moduleFilter('interno')).toBeNull();
  });

  it("perfil restrito inclui sempre 'core'; se filtrar, é um filtro Qdrant válido", () => {
    expect(activeModules('starter')).toContain('core');
    const f = moduleFilter('starter');
    if (f !== null) {
      expect(f.must[0].key).toBe('module');
      expect(Array.isArray(f.must[0].match.any)).toBe(true);
      expect(f.must[0].match.any).toContain('core');
    }
  });
});
