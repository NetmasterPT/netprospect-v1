// lib/audit/gmb-lookup.js
// Google My Business via BROWSER (sem Places API) — fonte de verdade da localidade QUANDO encontra.
// Best-effort e frágil: o Google pode bloquear/mudar o HTML e mostrar consent walls. Degrada para o
// sinal on-site (lib/audit/gmb.js) quando não encontra. Rate-limit próprio.
//
// ESTRATÉGIA (validada com dados reais — evita falsos positivos por IDENTIDADE, não pela query):
//   · A pesquisa por DOMÍNIO não resolve em headless (0/6, nem a Livraria Lello) → NÃO se usa.
//   1. MORADA (se o site tiver morada rua+nº): pesquisa a morada e clica num negócio de "Neste local"
//      (âncora FÍSICA — o negócio está mesmo naquela morada). Guarda leniente (aceita sem authority).
//   2. NOME (fallback, ~89% dos sites não têm morada): pesquisa nome+cidade, resolve a ficha (auto-
//      redirect ou clica no 1.º resultado) e ACEITA SÓ SE o site do negócio no GMB (authority URL) bater
//      com o domínio auditado — guarda ESTRITA. Assim clicar no 1.º resultado é seguro: um negócio
//      errado (ex.: grillsymbol.fi→homestagingportugal.com) é rejeitado por o site não bater.

import puppeteer from 'puppeteer-core';
import { browserProxyArg } from '../egress.js';

// UA DESKTOP (não mobile): o Maps mobile serve um DOM diferente onde o feed/ficha não batem com os
// seletores desktop (h1.DUwDvf, a.hfpxzc, role=main, "Neste local").
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const num = (s) => { const m = String(s || '').replace(/[.\s]/g, '').match(/(\d+)/); return m ? parseInt(m[1], 10) : null; };
const flt = (s) => { const m = String(s || '').replace(',', '.').match(/([\d.]+)/); return m ? parseFloat(m[1]) : null; };

const BAD_NAME = /por\s*qu[eê].*(an[úu]ncio|ad\b)|why this ad|about this (ad|result)|sobre este (an[úu]ncio|resultado)|acerca deste|patrocinad|sponsored|^resultados?$|^results?$|^mapa$|^map$|consentimento|consent|^defini[çc][õo]es$|^settings$|^einstellungen$|^ajustes$|^men[uú]$|iniciar sess[ãa]o|sign in|^log ?in$|^entrar$|^\d+\s*(min|h|hr)\b.*\bkm\b/i;

const hostsMatch = (authHost, siteHost) => !!authHost && !!siteHost
  && (authHost === siteHost || authHost.endsWith('.' + siteHost) || siteHost.endsWith('.' + authHost));

// Extrai o negócio da ficha /maps/place/ ATUAL. Devolve o objeto ou { name:null, _debug }.
// `strict`: se true, EXIGE que o site do negócio (authority URL) bata com o domínio (senão rejeita).
async function buildFromPage(page, domain, via, { strict = false } = {}) {
  const data = await page.evaluate(() => {
    const clean = (s) => { const t = (s || '').trim(); return t || null; };
    const txt = (sel) => clean(document.querySelector(sel)?.textContent);
    const attr = (sel, a) => clean(document.querySelector(sel)?.getAttribute(a));
    // O h1 "Porquê este anúncio?" (bloco de anúncio) vinha 1.º no DOM. O nome real está no aria-label
    // do painel role="main", senão num h1 que não seja o do anúncio/"Resultados".
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
    // Telefone: tira TUDO antes do 1.º "+" ou dígito (apanhava um ": " à cabeça do aria-label).
    const phone = clean((attr('button[data-item-id^="phone"]', 'aria-label') || txt('button[data-item-id^="phone"]') || '').replace(/^[^+\d]*/, ''));
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
  // GUARDA de identidade pelo site do negócio (authority URL) vs domínio auditado.
  const authHost = (() => { try { const h = new URL(data.url).hostname.replace(/^www\./, '').toLowerCase(); return /(^|\.)google\./.test(h) ? null : h; } catch { return null; } })();
  const siteHost = (domain || '').replace(/^www\./, '').toLowerCase();
  const matches = hostsMatch(authHost, siteHost);
  if (strict) {
    // Via NOME: aceita SÓ com prova de identidade (o site do negócio == domínio). Sem isso → rejeita.
    if (!matches) return dbg(authHost ? 'domain-mismatch' : 'no-identity');
  } else if (authHost && !matches) {
    // Via MORADA: leniente — aceita sem authority, mas se houver e não bater, é outro negócio → rejeita.
    return dbg('domain-mismatch');
  }
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

export async function lookupGmb({ domain, name, address, city } = {}, { chromePath = process.env.CHROME_PATH, timeoutMs = 30000, hardTimeoutMs = 60000 } = {}) {
  if (!name && !address) return null;
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
    try {
      await page.setCookie(
        { name: 'SOCS', value: 'CAESEwgDegQIARhK', domain: '.google.com', path: '/' },
        { name: 'CONSENT', value: 'YES+cb.20240101-00-p0.en+FX+' + (100 + Math.floor(Math.random() * 900)), domain: '.google.com', path: '/' },
      );
    } catch { /* setCookie best-effort */ }

    // Navega para uma pesquisa; trata /sorry/ (bloqueio) e consent wall. Devolve 'blocked' | 'ok'.
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

    // Clica no 1.º link /maps/place/ diferente da página atual e espera a ficha. Devolve true se navegou.
    const gotoFirstPlace = async () => {
      const SEL = 'a.hfpxzc, [role="feed"] a[href*="/maps/place/"], a[href*="/maps/place/"]';
      await page.waitForSelector(SEL, { timeout: 8000 }).catch(() => {});
      const href = await page.evaluate((s, cur) => {
        const links = [...document.querySelectorAll(s)].map((a) => a.href).filter((h) => /\/maps\/place\//.test(h) && h !== cur);
        return links[0] || null;
      }, SEL, page.url());
      if (!href) return false;
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
      await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});
      return /\/maps\/place\//.test(page.url());
    };

    let firstDbg = null;

    // --- ESTRATÉGIA 1: MORADA (âncora física) — clica num negócio de "Neste local". ---
    if (address) {
      const st = await goSearch([address, city].filter(Boolean).join(', '));
      if (st === 'blocked') return { name: null, _debug: { reason: 'blocked-sorry-or-recaptcha', via: 'address', url: (page.url() || '').slice(0, 140) } };
      // A página da morada é ela própria /maps/place/<morada>; os negócios "Neste local" são outros links.
      // Guarda ESTRITA também aqui: a pesquisa por morada pode cair num DISTRITO/área (ex.: filmbib.no →
      // "Sentrum", Oslo) ou noutro negócio da mesma morada. Exigir que o site do negócio bata com o domínio
      // elimina esses falsos positivos (os certos — ceibas/autonoma — têm o site a bater e passam na mesma).
      if (await gotoFirstPlace()) {
        const r = await buildFromPage(page, domain, 'address', { strict: true });
        if (r && r.name) return r;
        firstDbg = r && r._debug;
      }
    }

    // --- ESTRATÉGIA 2: NOME + guarda ESTRITA (só aceita se o site do negócio == domínio). ---
    if (name) {
      const st = await goSearch([name, city].filter(Boolean).join(' '));
      if (st === 'blocked') return { name: null, _debug: firstDbg || { reason: 'blocked-sorry-or-recaptcha', via: 'name', url: (page.url() || '').slice(0, 140) } };
      // Auto-redirect para a ficha, ou clica no 1.º resultado (seguro: a guarda estrita rejeita se não for o nosso).
      if (!/\/maps\/place\//.test(page.url())) await gotoFirstPlace();
      if (/\/maps\/place\//.test(page.url())) {
        const r = await buildFromPage(page, domain, 'name', { strict: true });
        if (r && r.name) return r;
        firstDbg = r && r._debug;
      } else if (!firstDbg) {
        firstDbg = { reason: 'name-not-unique', via: 'name', url: (page.url() || '').slice(0, 140) };
      }
    }

    return { name: null, _debug: firstDbg || { reason: 'no-confident-match', url: (page.url() || '').slice(0, 140) } };
  } catch (e) {
    return { name: null, _debug: { reason: 'error:' + (e.message || '').slice(0, 60) } };
  } finally {
    clearTimeout(guard);
    try { await browser.close(); } catch { /* ignora */ }
    try { browser.process()?.kill('SIGKILL'); } catch { /* garante que não fica zombie */ }
  }
}
