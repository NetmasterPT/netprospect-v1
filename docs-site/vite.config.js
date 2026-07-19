import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Servido sob /docs/ (custom location no NPMplus → docs-web nginx). Ver docs-plan.md.
export default defineConfig({
  base: '/docs/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
