// Gera docs/reference/modules.md — mapa dos módulos lib/ e worker/ a partir do
// comentário de cabeçalho (//) e dos exports. Node puro. Correr: npm run gen:modules
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs/reference/modules.md');

const files = execSync(`find lib worker -type f \\( -name '*.js' -o -name '*.mjs' \\)`, { cwd: ROOT })
  .toString().trim().split('\n').sort();

const headerOf = (src) => {
  const out = [];
  for (const l of src.split('\n')) {
    if (/^#!/.test(l)) continue;                       // shebang
    if (/^\s*\/\//.test(l)) out.push(l.replace(/^\s*\/\/\s?/, ''));
    else if (l.trim() === '' && out.length === 0) continue;
    else break;
  }
  return out.join(' ').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
};
const exportsOf = (src) => {
  const set = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) set.add(m[1] + '()');
  for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=/g)) set.add(m[1]);
  for (const m of src.matchAll(/export\s+class\s+(\w+)/g)) set.add('class ' + m[1]);
  for (const m of src.matchAll(/export\s+\{([^}]+)\}/g))
    m[1].split(',').forEach((s) => { const n = s.trim().split(/\s+as\s+/).pop().trim(); if (n) set.add(n); });
  return [...set];
};

const groups = {}; // dir → [{file, header, exports}]
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const dir = path.dirname(f);
  (groups[dir] ||= []).push({ file: f, name: path.basename(f), header: headerOf(src), exports: exportsOf(src) });
}

const DIR_TITLE = { lib: 'lib/ — biblioteca', 'lib/audit': 'lib/audit/ — jobs de auditoria', worker: 'worker/ — o worker' };
const today = new Date().toISOString().slice(0, 10);
let out = `---
title: Mapa de Módulos (código)
type: reference
tags: [code, modules, generated]
related: [[README]]
owner: plataforma
status: living
updated: ${today}
visibility: internal
---

<!-- GERADO por docs-site/scripts/gen-module-api.mjs — NÃO editar à mão. Correr: npm run gen:modules -->

# Mapa de Módulos (código)

Sumário de cada módulo (do comentário de cabeçalho) + exports. **${files.length} ficheiros**.
`;
for (const dir of Object.keys(groups).sort()) {
  out += `\n## ${DIR_TITLE[dir] || dir + '/'}\n\n`;
  for (const m of groups[dir].sort((a, b) => a.name.localeCompare(b.name))) {
    out += `### \`${m.file}\`\n`;
    if (m.header) out += `${m.header}\n\n`;
    if (m.exports.length) out += `**Exports:** ${m.exports.map((e) => '`' + e + '`').join(' · ')}\n\n`;
    else out += `\n`;
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`${files.length} módulos → docs/reference/modules.md`);
