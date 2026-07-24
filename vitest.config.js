import { defineConfig } from 'vitest/config';

// Testes unitários do NetProspect. Home = raiz (lib/ + backend dos docs). Node env, sem DOM.
// Coverage v8 → LCOV (para o SonarQube na Fase 6) + texto + html.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{js,mjs}', 'docs-site/**/*.test.{js,mjs}'],
    exclude: ['node_modules/**', 'dist/**', 'out/**', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      // Só o código exercitado por testes conta (all:false por defeito) — evita carregar módulos
      // com efeitos de import (rede/DB). Cresce à medida que se adicionam testes.
      include: ['lib/**/*.js', 'docs-site/mcp/**/*.mjs', 'docs-site/kb/**/*.mjs'],
      exclude: ['**/*.test.*', 'test/**', '**/node_modules/**'],
    },
  },
});
