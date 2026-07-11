// lib/audit/tranco.js
// Tráfego (proxy) via ranking Tranco top-1M. Carrega o CSV uma vez para um Map
// (~150MB) e devolve rank+balde. A maioria dos domínios de países pequenos fica
// `unranked` (= sem dados, não "pouco tráfego"). CSV via fetch-tranco.js.

import fs from 'fs';
import { getDomain } from 'tldts';

let RANKS = null;

export function loadTranco(csvPath = process.env.TRANCO_CSV || 'data/tranco/top-1m.csv') {
  if (RANKS) return RANKS;
  RANKS = new Map();
  if (!fs.existsSync(csvPath)) { console.warn(`[tranco] CSV em falta: ${csvPath} — tudo unranked`); return RANKS; }
  const txt = fs.readFileSync(csvPath, 'utf8');
  for (const line of txt.split('\n')) {
    const c = line.indexOf(',');
    if (c < 0) continue;
    const rank = parseInt(line.slice(0, c), 10);
    const domain = line.slice(c + 1).trim().toLowerCase();
    if (domain && Number.isFinite(rank) && !RANKS.has(domain)) RANKS.set(domain, rank);
  }
  return RANKS;
}

export function bucketOf(rank) {
  if (rank == null) return 'unranked';
  if (rank <= 10000) return 'top10k';
  if (rank <= 100000) return 'top100k';
  return 'top1m';
}

export function trafficOf(domain) {
  if (!RANKS) loadTranco();
  const apex = getDomain(domain) || domain;
  const rank = RANKS.get(apex) ?? RANKS.get(domain) ?? null;
  return { rank, bucket: bucketOf(rank) };
}
