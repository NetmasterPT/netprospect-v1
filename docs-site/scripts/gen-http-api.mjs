// Gera docs/reference/http-api.md a partir das rotas de dashboard/server.mjs.
// Node puro (sem deps). Correr: npm run gen:http  (a partir de docs-site/)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'dashboard/server.mjs');
const OUT = path.join(ROOT, 'docs/reference/http-api.md');

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ROUTE_RE = /app\.(get|post|put|delete|patch|use)\(\s*(['"`])([^'"`]+)\2/;

// prefixo → título de grupo (ordem = ordem de apresentação)
const GROUPS = [
  [/^\/api\/queues/, 'Filas (NATS)'],
  [/^\/api\/(fleet|workers)/, 'Frota (deploy / env / workers)'],
  [/^\/api\/autoscale/, 'Autoscaler'],
  [/^\/api\/(coverage|data-coverage)/, 'Cobertura'],
  [/^\/api\/moloni/, 'Moloni (contabilidade)'],
  [/^\/api\/(agendament|calendar)/, 'Agendamentos'],
  [/^\/api\/(campaign|import)/, 'Campanhas / Import'],
  [/^\/api\/(segment|directory|contacts|audit|report)/, 'Diretório / Segmentos / Relatórios'],
  [/^\/api\/verify/, 'Verify (validação de email)'],
  [/^\/api\/(config|isps|stats|logs|alert)/, 'Config / Telemetria'],
  [/^\/api\/agents/, 'Agentes IA'],
  [/^\/api\/(triggers|timeline)/, 'Triggers / Timeline'],
  [/^\/(t|r)\//, 'Tracking público (open/click/unsub/redirect)'],
  [/^\/metrics/, 'Métricas Prometheus'],
];
const groupOf = (p) => (GROUPS.find(([re]) => re.test(p)) || [null, 'Outros / raiz'])[1];
const order = GROUPS.map((g) => g[1]).concat('Outros / raiz');

const commentAbove = (i) => {
  let j = i - 1; const buf = [];
  while (j >= 0 && /^\s*\/\//.test(lines[j])) { buf.unshift(lines[j].replace(/^\s*\/\/\s?/, '')); j--; }
  return buf.length ? buf[buf.length - 1].trim() : '';
};

const routes = []; const seen = new Set();
lines.forEach((line, i) => {
  const m = line.match(ROUTE_RE);
  if (!m) return;
  const method = m[1].toUpperCase();
  const p = m[3];
  if (!p.startsWith('/')) return;
  const key = method + ' ' + p;
  if (seen.has(key)) return; seen.add(key);
  const inline = (line.split(') //')[1] || line.split('// ')[1] || '').trim();
  routes.push({ method, path: p, desc: (inline || commentAbove(i)).replace(/\|/g, '\\|'), group: groupOf(p) });
});
routes.sort((a, b) => (order.indexOf(a.group) - order.indexOf(b.group)) || a.path.localeCompare(b.path));

const today = new Date().toISOString().slice(0, 10);
let out = `---
title: Referência da API HTTP
type: reference
tags: [api, dashboard, generated]
related: [[README]]
owner: plataforma
status: living
updated: ${today}
visibility: internal
---

<!-- GERADO por docs-site/scripts/gen-http-api.mjs — NÃO editar à mão. Correr: npm run gen:http -->

# Referência da API HTTP (dashboard)

**${routes.length} endpoints** expostos por \`dashboard/server.mjs\`. Servido em \`netprospect.netmaster.pt\`
**atrás do Authentik** (NPMplus); as rotas \`/t/*\` e \`/r/*\` (tracking público) são exceções abertas.
`;
let cur = '';
for (const r of routes) {
  if (r.group !== cur) { cur = r.group; out += `\n## ${cur}\n\n| Método | Caminho | Descrição |\n|---|---|---|\n`; }
  out += `| \`${r.method}\` | \`${r.path}\` | ${r.desc || '—'} |\n`;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`${routes.length} endpoints → docs/reference/http-api.md`);
