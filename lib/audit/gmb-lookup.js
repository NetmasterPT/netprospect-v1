// lib/audit/gmb-lookup.js
// Google My Business via BROWSER (sem Places API) — fonte de verdade da
// localidade QUANDO encontra. Best-effort e frágil: o Google pode bloquear/mudar
// o HTML e mostrar consent walls (sobretudo de IPs de datacenter). Degrada para o
// sinal on-site (lib/audit/gmb.js) quando não encontra. Rate-limit próprio.

import puppeteer from 'puppeteer-core';
import { browserProxyArg } from '../egress.js';

const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

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
    if (blocked) return null;

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

    const data = await page.evaluate(() => {
      const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
      const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) || null;
      const name = txt('h1');
      // Rating + reviews costumam estar em spans com aria-label.
      const ratingEl = document.querySelector('[role="img"][aria-label*="estrela"], [role="img"][aria-label*="star"], span[aria-hidden="true"]');
      const rating = document.querySelector('div.fontDisplayLarge')?.textContent
        || document.querySelector('span[aria-label*="estrela"]')?.getAttribute('aria-label')
        || (ratingEl && ratingEl.getAttribute('aria-label'));
      const reviews = document.body.innerText.match(/([\d.\s]+)\s*(?:coment|review|avalia)/i)?.[1] || null;
      const category = txt('button[jsaction*="category"]') || txt('[jsaction*="category"]');
      const address = attr('button[data-item-id="address"]', 'aria-label') || txt('button[data-item-id="address"]');
      const phone = (attr('button[data-item-id^="phone"]', 'aria-label') || txt('button[data-item-id^="phone"]') || '').replace(/^[^:+\d]*/, '');
      const url = attr('a[data-item-id="authority"]', 'href');
      return { name, rating, reviews, category, address, phone, url, mapsUrl: location.href };
    });

    if (!data || !data.name) return null;
    // GUARDA anti-lixo: quando o Google serve anúncios / página de resultados (sem um negócio
    // específico), o h1 vinha como "Porquê este anúncio?", "Por que esse anúncio?", "Resultados",
    // etc. — envenenava a BD com 2.760 registos falsos. Rejeita esses e degrada para o sinal on-site.
    const BAD_NAME = /por\s*qu[eê].*(an[úu]ncio|ad\b)|why this ad|about this (ad|result)|sobre este (an[úu]ncio|resultado)|acerca deste|patrocinad|sponsored|^resultados?$|^results?$|^mapa$|^map$|consentimento|consent|^defini[çc][õo]es$|^settings$|^einstellungen$|^ajustes$|^men[uú]$|iniciar sess[ãa]o|sign in|^log ?in$|^entrar$|^\d+\s*(min|h|hr)\b.*\bkm\b/i;
    if (BAD_NAME.test(data.name.trim())) return null;
    // GUARDA DETERMINISTA: um negócio real está SEMPRE numa página /maps/place/. As páginas de
    // anúncios / consentimento / "/sorry/" / resultados de pesquisa NUNCA lá chegam. Só aceitar
    // aqui elimina o "Porquê este anúncio?" e métricas falsas quando a pesquisa não resolve.
    if (!/\/maps\/place\//.test(data.mapsUrl || '')) return null;
    // Reforço: além do place, exige ≥1 sinal de negócio (categoria/rating/morada/telefone).
    if (!data.category && !data.rating && !data.address && !data.phone) return null;
    // Normaliza morada -> cidade (heurística: último ou penúltimo componente antes do país).
    let city2 = null, region = null;
    if (data.address) {
      const cleaned = data.address.replace(/^Endereço:\s*/i, '').trim();
      const parts = cleaned.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) { city2 = parts[parts.length - 1]; region = parts[parts.length - 2]; }
    }
    return {
      name: data.name,
      category: (data.category || '').slice(0, 120) || null,
      rating: flt(data.rating),
      reviews: num(data.reviews),
      phone: (data.phone || '').slice(0, 60) || null,
      address: (data.address || '').replace(/^Endereço:\s*/i, '').slice(0, 255) || null,
      city: (city2 || '').slice(0, 120) || null,
      region: (region || '').slice(0, 120) || null,
      url: (data.url || data.mapsUrl || '').slice(0, 255) || null,
      placeId: null,
    };
  } catch {
    return null; // Google bloqueou / mudou HTML — degrada para o sinal on-site.
  } finally {
    clearTimeout(guard);
    try { await browser.close(); } catch { /* ignora */ }
    try { browser.process()?.kill('SIGKILL'); } catch { /* garante que não fica zombie */ }
  }
}
