// lib/audit/gmb-lookup.js
// Google My Business via BROWSER (sem Places API) — fonte de verdade da localidade QUANDO encontra.
// Best-effort e frágil: o Google pode bloquear/mudar o HTML e mostrar consent walls (sobretudo de IPs
// de datacenter). Degrada para o sinal on-site (lib/audit/gmb.js) quando não encontra. Rate-limit próprio.
//
// ESTRATÉGIA (decisão do produto — evitar falsos positivos por construção):
//   1. Pesquisar pelo DOMÍNIO do site (ex.: "livrarialello.pt"), NUNCA por texto/nome. Se o Maps tiver
//      um negócio com esse site, abre a ficha DIRETAMENTE (/maps/place/). Se ficar na LISTA de resultados
//      (/maps/search/), não conseguimos afirmar com confiança que o negócio coincide → null.
//   2. Fallback (só se tivermos morada completa): pesquisar pela MORADA (rua+nº, cód-postal, cidade) e
//      clicar num negócio da secção "Neste local" da página da morada.
// Em ambos os casos, se a ficha tiver site próprio (authority URL) que NÃO bate com o domínio auditado,
// é outro negócio → rejeita (guarda anti-falso-positivo).

import puppeteer from 'puppeteer-core';
import { browserProxyArg } from '../egress.js';

// UA DESKTOP (não mobile): o Maps mobile serve um DOM diferente onde o feed e a ficha não batem com os
// seletores desktop (h1.DUwDvf, role=main, "Neste local"). Com UA desktop o DOM é o do browser normal.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const num = (s) => { const m = String(s || '').replace(/[.\s]/g, '').match(/(\d+)/); return m ? parseInt(m[1], 10) : null; };
const flt = (s) => { const m = String(s || '').replace(',', '.').match(/([\d.]+)/); return m ? parseFloat(m[1]) : null; };

const BAD_NAME = /por\s*qu[eê].*(an[úu]ncio|ad\b)|why this ad|about this (ad|result)|sobre este (an[úu]ncio|resultado)|acerca deste|patrocinad|sponsored|^resultados?$|^results?$|^mapa$|^map$|consentimento|consent|^defini[çc][õo]es$|^settings$|^einstellungen$|^ajustes$|^men[uú]$|iniciar sess[ãa]o|sign in|^log ?in$|^entrar$|^\d+\s*(min|h|hr)\b.*\bkm\b/i;

// Extrai o negócio da ficha /maps/place/ ATUAL da página. Devolve o objeto do negócio, ou
// { name:null, _debug } com a razão. `via` = estratégia usada (domain|address), p/ diagnóstico.
async function buildFromPage(page, domain, via) {
  const data = await page.evaluate(() => {
    const clean = (s) => { const t = (s || '').trim(); return t || null; };
    const txt = (sel) => clean(document.querySelector(sel)?.textContent);
    const attr = (sel, a) => clean(document.querySelector(sel)?.getAttribute(a));
    // O h1 "Porquê este anúncio?" (bloco de anúncio) vinha PRIMEIRO no DOM e era apanhado como nome —
    // mesmo na ficha certa. O nome real está no aria-label do painel role="main", ou num h1 que não seja
    // o do anúncio/"Resultados".
    const AD = /por\s*qu[eê].*(an[úu]ncio|ad\b)|why this ad|an[úu]ncio\b|^resultados?$|^results?$/i;
    const mainAL = attr('[role="main"][aria-label]', 'aria-label');
    let domName = (mainAL && !AD.test(mainAL)) ? mainAL : null;
    if (!domName) {
      const byClass = txt('h1.DUwDvf');
      domName = (byClass && !AD.test(byClass)) ? byClass
        : ([...document.querySelectorAll('h1')].map((h) => clean(h.textContent)).find((t) => t && !AD.test(t)) || null);
    }
    const ratingEl = document.querySelector('[role="img"][aria-label*="estrela"], [role="img"][aria-label*="star"]');
    const rating = txt('div.fontDisplayLarge') || attr('span[aria-label*="estrela"]', 'aria-label') || (ratingEl && ratingEl.getAttribute('aria-label'));
    const reviews = (document.body.innerText.match(/([\d.\s]+)\s*(?:coment|review|avalia)/i) || [])[1] || null;
    const category = txt('button[jsaction*="category"]') || txt('[jsaction*="category"]');
    const address = attr('button[data-item-id="address"]', 'aria-label') || txt('button[data-item-id="address"]');
    const phone = clean((attr('button[data-item-id^="phone"]', 'aria-label') || txt('button[data-item-id^="phone"]') || '').replace(/^[^:+\d]*/, ''));
    const url = attr('a[data-item-id="authority"]', 'href');
    return { domName, rating, reviews, category, address, phone, url, mapsUrl: location.href };
  });

  // A URL /maps/place/<Nome>,+<morada>/@... codifica nome+morada de forma FIÁVEL (imune às classes CSS).
  let urlName = null, urlAddr = null;
  const pm = (data.mapsUrl || '').match(/\/maps\/place\/([^/@]+)/);
  if (pm) {
    try {
      const parts = decodeURIComponent(pm[1]).replace(/\+/g, ' ').trim().split(',').map((s) => s.trim()).filter(Boolean);
      urlName = parts[0] || null;
      if (parts.length > 1) urlAddr = parts.slice(1).join(', ');
    } catch { /* URL malformada */ }
  }
  const name = data.domName || urlName;
  const addressRaw = (data.address || '').replace(/^Endereço:\s*/i, '').trim() || urlAddr;
  const dbg = (reason) => ({ name: null, _debug: { reason, via, url: (data?.mapsUrl || '').slice(0, 140), h1: (name || '').slice(0, 60) } });

  if (!name) return dbg('no-name');
  if (BAD_NAME.test(name.trim())) return dbg('bad-name');
  if (!/\/maps\/place\//.test(data.mapsUrl || '')) return dbg('no-place-url');
  if (!data.category && !data.rating && !addressRaw && !data.phone) return dbg('no-signal');
  // GUARDA anti-falso-positivo: se a ficha tem site próprio e NÃO bate com o domínio auditado, é outro
  // negócio. Só valida quando há host externo real (ignora o fallback google.com/maps → não verificável).
  const authHost = (() => { try { const h = new URL(data.url).hostname.replace(/^www\./, '').toLowerCase(); return /(^|\.)google\./.test(h) ? null : h; } catch { return null; } })();
  const siteHost = (domain || '').replace(/^www\./, '').toLowerCase();
  if (authHost && siteHost && authHost !== siteHost && !authHost.endsWith('.' + siteHost) && !siteHost.endsWith('.' + authHost)) return dbg('domain-mismatch');
  // Normaliza morada -> cidade/região (últimos componentes; tira o cód-postal à cabeça da cidade).
  let city2 = null, region = null;
  if (addressRaw) {
    const parts = addressRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) { city2 = parts[parts.length - 1]; region = parts[parts.length - 2]; }
    else if (parts.length === 1) { city2 = parts[0]; }
    if (city2) city2 = city2.replace(/^\d{3,5}(-\d{2,4})?\s+/, '').trim();
  }
  return {
    name,
    category: (data.category || '').slice(0, 120) || null,
    rating: flt(data.rating),
    reviews: num(data.reviews),
    phone: (data.phone || '').slice(0, 60) || null,
    address: (addressRaw || '').slice(0, 255) || null,
    city: (city2 || '').slice(0, 120) || null,
    region: (region || '').slice(0, 120) || null,
    url: (data.url || data.mapsUrl || '').slice(0, 255) || null,
    placeId: null,
    _via: via,
  };
}

export async function lookupGmb({ domain, address, city } = {}, { chromePath = process.env.CHROME_PATH, timeoutMs = 30000, hardTimeoutMs = 60000 } = {}) {
  if (!domain && !address) return null;
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    timeout: 20000,
    protocolTimeout: hardTimeoutMs,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=pt-PT', '--hl=pt', browserProxyArg()].filter(Boolean),
  });
  const guard = setTimeout(() => { try { browser.process()?.kill('SIGKILL'); } catch { /* ignora */ } }, hardTimeoutMs);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-PT,pt;q=0.9' });
    // Cookies de consentimento (aceite) — evitam o muro "Definições"/consent. Definidos ANTES do goto.
    try {
      await page.setCookie(
        { name: 'SOCS', value: 'CAESEwgDegQIARhK', domain: '.google.com', path: '/' },
        { name: 'CONSENT', value: 'YES+cb.20240101-00-p0.en+FX+' + (100 + Math.floor(Math.random() * 900)), domain: '.google.com', path: '/' },
      );
    } catch { /* setCookie best-effort */ }

    // Navega para uma pesquisa; trata a página /sorry/ (bloqueio) e o consent wall. Devolve 'blocked'|'ok'.
    const goSearch = async (q) => {
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=pt`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const blocked = await page.evaluate(() =>
        /\/sorry\/|\/recaptcha/.test(location.href)
        || /unusual traffic|not a robot|tráfego incomum/i.test(document.body?.innerText || ''));
      if (blocked) return 'blocked';
      try {
        if (/consent\.google\./.test(page.url())) {
          await page.evaluate(() => {
            const b = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
              .find((x) => /aceitar tudo|accept all|concordo|i agree|^aceitar$|^accept$/i.test((x.textContent || x.value || x.getAttribute('aria-label') || '').trim()));
            if (b) b.click();
          });
          await page.waitForNavigation({ timeout: 8000 }).catch(() => {});
          if (!/\/maps\//.test(page.url())) await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=pt`, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
        } else {
          const btn = await page.$('button[aria-label*="Aceitar"], button[aria-label*="Accept"], form[action*="consent"] button');
          if (btn) { await btn.click(); await page.waitForNavigation({ timeout: 8000 }).catch(() => {}); }
        }
      } catch { /* sem consent */ }
      await page.waitForSelector('h1, [role="main"]', { timeout: 8000 }).catch(() => {});
      return 'ok';
    };

    let dbg1 = null;

    // --- ESTRATÉGIA 1: pesquisar pelo DOMÍNIO. Se abre a ficha (/maps/place/) → é o negócio. ---
    if (domain) {
      const st = await goSearch(domain);
      if (st === 'blocked') return { name: null, _debug: { reason: 'blocked-sorry-or-recaptcha', via: 'domain', url: (page.url() || '').slice(0, 140) } };
      if (/\/maps\/place\//.test(page.url())) {
        const r = await buildFromPage(page, domain, 'domain');
        if (r && r.name) return r;
        dbg1 = r && r._debug;
      } else {
        // Ficou na LISTA → não conseguimos confirmar que o negócio coincide (regra do produto).
        dbg1 = { reason: 'domain-not-unique', via: 'domain', url: (page.url() || '').slice(0, 140) };
      }
    }

    // --- ESTRATÉGIA 2 (fallback): pesquisar pela MORADA e clicar num negócio de "Neste local". ---
    if (address) {
      const q = [address, city].filter(Boolean).join(', ');
      const st = await goSearch(q);
      if (st !== 'blocked') {
        // Na página da morada, os negócios ("Neste local") são links /maps/place/. Clica no 1.º.
        const href = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a[href*="/maps/place/"]')].map((a) => a.href).filter((h) => /\/maps\/place\//.test(h));
          return links[0] || null;
        });
        if (href) {
          await page.goto(href, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
          await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});
          if (/\/maps\/place\//.test(page.url())) {
            const r = await buildFromPage(page, domain, 'address');
            if (r && r.name) return r;
          }
        }
      }
    }

    return { name: null, _debug: dbg1 || { reason: 'no-confident-match', url: (page.url() || '').slice(0, 140) } };
  } catch (e) {
    return { name: null, _debug: { reason: 'error:' + (e.message || '').slice(0, 60) } };
  } finally {
    clearTimeout(guard);
    try { await browser.close(); } catch { /* ignora */ }
    try { browser.process()?.kill('SIGKILL'); } catch { /* garante que não fica zombie */ }
  }
}
