// lib/audit/gmb-lookup.js
// Google My Business via BROWSER (sem Places API) — fonte de verdade da
// localidade QUANDO encontra. Best-effort e frágil: o Google pode bloquear/mudar
// o HTML e mostrar consent walls (sobretudo de IPs de datacenter). Degrada para o
// sinal on-site (lib/audit/gmb.js) quando não encontra. Rate-limit próprio.

import puppeteer from 'puppeteer-core';
import { browserProxyArg } from '../egress.js';

// UA DESKTOP (não mobile): o Maps mobile serve um DOM diferente onde o feed de resultados e a ficha
// não batem com os seletores desktop (h1.DUwDvf, a.hfpxzc, role=main). Com UA desktop o DOM é o que
// se vê no browser normal → os seletores e o clique no 1.º resultado funcionam.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const num = (s) => { const m = String(s || '').replace(/[.\s]/g, '').match(/(\d+)/); return m ? parseInt(m[1], 10) : null; };
const flt = (s) => { const m = String(s || '').replace(',', '.').match(/([\d.]+)/); return m ? parseFloat(m[1]) : null; };

export async function lookupGmb({ name, city, domain }, { chromePath = process.env.CHROME_PATH, timeoutMs = 30000, hardTimeoutMs = 60000 } = {}) {
  const query = ([name, city].filter(Boolean).join(' ') || domain || '').trim();
  if (!query) return null;
  // launch pode pendurar se o Chromium morrer -> timeout duro + protocolTimeout.
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    timeout: 20000,
    protocolTimeout: hardTimeoutMs,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=pt-PT', '--hl=pt', browserProxyArg()].filter(Boolean),
  });
  // Rede de segurança: fecha o browser à força se o todo demorar demais.
  const guard = setTimeout(() => { try { browser.process()?.kill('SIGKILL'); } catch { /* ignora */ } }, hardTimeoutMs);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 900 }); // desktop → o feed de resultados renderiza
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-PT,pt;q=0.9' });
    // Cookies de consentimento do Google — evitam o muro "Definições"/consent que aparece
    // (mesmo em IP residencial) e que o scraper apanhava como nome. SOCS (moderno) + CONSENT
    // (clássico), ambos = "aceite". Definidos ANTES do goto.
    try {
      await page.setCookie(
        { name: 'SOCS', value: 'CAESEwgDegQIARhK', domain: '.google.com', path: '/' },
        { name: 'CONSENT', value: 'YES+cb.20240101-00-p0.en+FX+' + (100 + Math.floor(Math.random() * 900)), domain: '.google.com', path: '/' },
      );
    } catch { /* setCookie best-effort */ }
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=pt`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // ARMADILHA (medida em IPs Hetzner): quando o Google bloqueia, serve a página /sorry/
    // ("Our systems have detected unusual traffic...") — e o scraper, sem esta guarda, fazia
    // scrape DELA e devolvia lixo como negócio real (name="Por que esse anúncio?",
    // category="Restaurantes") para TODOS os sites. Isso envenenava a BD em silêncio.
    // Detetar e degradar para null (o sinal on-site de lib/audit/gmb.js continua válido).
    const blocked = await page.evaluate(() =>
      /\/sorry\/|\/recaptcha/.test(location.href)
      || /unusual traffic|not a robot|tráfego incomum/i.test(document.body?.innerText || ''));
    if (blocked) return { name: null, _debug: { reason: 'blocked-sorry-or-recaptcha', url: (page.url() || '').slice(0, 140) } };

    // Consent wall de reserva (se o cookie não bastou). Trata o redirect p/ consent.google.com
    // (submete "Aceitar tudo" e volta ao Maps) e o botão de consentimento inline.
    try {
      if (/consent\.google\./.test(page.url())) {
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
            .find((x) => /aceitar tudo|accept all|concordo|i agree|^aceitar$|^accept$/i.test((x.textContent || x.value || x.getAttribute('aria-label') || '').trim()));
          if (b) b.click();
        });
        await page.waitForNavigation({ timeout: 8000 }).catch(() => {});
        if (!/\/maps\//.test(page.url())) await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=pt`, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
      } else {
        const btn = await page.$('button[aria-label*="Aceitar"], button[aria-label*="Accept"], form[action*="consent"] button');
        if (btn) { await btn.click(); await page.waitForNavigation({ timeout: 8000 }).catch(() => {}); }
      }
    } catch { /* sem consent */ }

    // Espera o painel do resultado (aria-label do cabeçalho principal).
    await page.waitForSelector('h1, [role="main"]', { timeout: 8000 }).catch(() => {});

    // Se aterrou numa LISTA de resultados (/maps/search/) em vez da ficha do negócio (/maps/place/),
    // clica no 1.º resultado do feed para lá navegar. O /maps/search/ só AUTO-redireciona a /maps/place/
    // quando a query dá UM resultado; a maioria fica na lista (h1 = query/"Resultados"), e era isso que
    // fazia (quase) TODOS caírem no guard no-place-url. Diagnóstico: quantos place-links tinha o feed.
    let listCount = 0;
    if (!/\/maps\/place\//.test(page.url())) {
      try {
        // a.hfpxzc = card de resultado do Maps desktop; os fallbacks apanham variações do feed.
        const SEL = 'a.hfpxzc, [role="feed"] a[href*="/maps/place/"], a[href*="/maps/place/"]';
        await page.waitForSelector(SEL, { timeout: 10000 }).catch(() => {});
        const feed = await page.evaluate((s) => {
          const links = [...document.querySelectorAll(s)].filter((a) => /\/maps\/place\//.test(a.href || ''));
          return { count: links.length, href: links[0]?.href || null };
        }, SEL);
        listCount = feed.count;
        if (feed.href) {
          await page.goto(feed.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
          await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});
        }
      } catch { /* sem feed clicável */ }
    }

    const data = await page.evaluate(() => {
      const clean = (s) => { const t = (s || '').trim(); return t || null; };
      const txt = (sel) => clean(document.querySelector(sel)?.textContent);
      const attr = (sel, a) => clean(document.querySelector(sel)?.getAttribute(a));
      // O h1 "Porquê este anúncio?" (bloco de anúncio) vinha PRIMEIRO no DOM e era apanhado como nome —
      // mesmo na ficha certa. O nome real está no aria-label do painel role="main", ou num h1 que NÃO
      // seja o do anúncio/"Resultados". (Era a causa dos bad-name em massa, com a URL já em /maps/place/.)
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

    // A URL /maps/place/<Nome>,+<morada>/@... codifica nome+morada de forma FIÁVEL (não depende do DOM,
    // cujas classes o Google muda). Fonte primária do nome/morada quando estamos numa ficha.
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

    // DIAGNÓSTICO: razão do null (URL final + nome apanhado + nº de resultados no feed).
    const dbg = (reason) => ({ name: null, _debug: { reason, url: (data?.mapsUrl || '').slice(0, 140), h1: (name || '').slice(0, 60), list: listCount } });
    if (!name) return dbg('no-name');
    // GUARDA anti-lixo: anúncios/consentimento/resultados/direções.
    const BAD_NAME = /por\s*qu[eê].*(an[úu]ncio|ad\b)|why this ad|about this (ad|result)|sobre este (an[úu]ncio|resultado)|acerca deste|patrocinad|sponsored|^resultados?$|^results?$|^mapa$|^map$|consentimento|consent|^defini[çc][õo]es$|^settings$|^einstellungen$|^ajustes$|^men[uú]$|iniciar sess[ãa]o|sign in|^log ?in$|^entrar$|^\d+\s*(min|h|hr)\b.*\bkm\b/i;
    if (BAD_NAME.test(name.trim())) return dbg('bad-name');
    // GUARDA: um negócio real está SEMPRE numa página /maps/place/ (ads/consent/sorry/results não).
    if (!/\/maps\/place\//.test(data.mapsUrl || '')) return dbg('no-place-url');
    // Reforço: além do place, exige ≥1 sinal de negócio (categoria/rating/morada/telefone).
    if (!data.category && !data.rating && !addressRaw && !data.phone) return dbg('no-signal');
    // GUARDA anti-falso-positivo (crítica): se a ficha tem site próprio (authority URL) e o domínio NÃO
    // bate com o site auditado, é OUTRO negócio — uma query má devolve um negócio qualquer (ex.: real:
    // grillsymbol.fi casou em homestagingportugal.com). Só valida quando há host externo real (ignora o
    // fallback google.com/maps, onde não há authority link → não dá para verificar → aceita).
    const authHost = (() => { try { const h = new URL(data.url).hostname.replace(/^www\./, '').toLowerCase(); return /(^|\.)google\./.test(h) ? null : h; } catch { return null; } })();
    const siteHost = (domain || '').replace(/^www\./, '').toLowerCase();
    if (authHost && siteHost && authHost !== siteHost && !authHost.endsWith('.' + siteHost) && !siteHost.endsWith('.' + authHost)) return dbg('domain-mismatch');
    // Normaliza morada -> cidade/região (últimos componentes; tira o código-postal à cabeça da cidade).
    let city2 = null, region = null;
    if (addressRaw) {
      const parts = addressRaw.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) { city2 = parts[parts.length - 1]; region = parts[parts.length - 2]; }
      else if (parts.length === 1) { city2 = parts[0]; }
      if (city2) city2 = city2.replace(/^\d{3,5}(-\d{2,4})?\s+/, '').trim(); // "2725-659 Sintra" -> "Sintra"
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
    };
  } catch (e) {
    return { name: null, _debug: { reason: 'error:' + (e.message || '').slice(0, 60) } }; // Google bloqueou / mudou HTML
  } finally {
    clearTimeout(guard);
    try { await browser.close(); } catch { /* ignora */ }
    try { browser.process()?.kill('SIGKILL'); } catch { /* garante que não fica zombie */ }
  }
}
