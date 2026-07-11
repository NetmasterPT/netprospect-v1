// lib/audit/gmb.js
// Sinal ON-SITE de Google My Business (best-effort). NÃO é a fonte de verdade —
// na Fase 2 o `gmb-lookup` (browser) confirma e extrai a ficha. Aqui só detetamos
// indícios no HTML: link g.page / business.google, embed de Google Maps, place_id.
// A presença de JSON-LD LocalBusiness é um indício fraco (a empresa é local, mas
// pode não ter ficha Google).

import { parseJsonLd, typesOf } from './jsonld.js';

const LOCAL_BUSINESS = new Set([
  'LocalBusiness', 'Restaurant', 'Store', 'Hotel', 'Dentist', 'Physician', 'Attorney',
  'LegalService', 'ProfessionalService', 'HomeAndConstructionBusiness', 'AutomotiveBusiness',
  'HealthAndBeautyBusiness', 'FoodEstablishment', 'MedicalBusiness', 'RealEstateAgent',
  'TravelAgency', 'BeautySalon', 'HairSalon', 'Bakery', 'CafeOrCoffeeShop', 'BarOrPub',
  'AutoRepair', 'Electrician', 'Plumber', 'GeneralContractor', 'ShoppingCenter',
]);
const isLocalBusinessType = (t) =>
  LOCAL_BUSINESS.has(t) || /Business$|Store$|Service$|Shop$/.test(t);

export function detectGmb(html) {
  const empty = { gmb: false, signal: null, placeId: null, url: null };
  if (!html) return empty;
  const signals = [];
  let placeId = null;
  let url = null;

  const pid = html.match(/[?&](?:place_id|placeid)=([A-Za-z0-9_-]{10,})/i);
  if (pid) { placeId = pid[1]; signals.push('place_id'); }

  const gpage = html.match(/https?:\/\/(?:g\.page\/[^\s"'<>)]+|business\.google\.[a-z.]+\/[^\s"'<>)]+)/i);
  if (gpage) { url = gpage[0]; signals.push('g.page'); }

  const place = html.match(/https?:\/\/(?:www\.)?google\.[a-z.]+\/maps\/place\/[^\s"'<>)]+/i);
  if (place) { url = url || place[0]; signals.push('maps:place'); }

  if (!signals.includes('maps:place') && /google\.[a-z.]+\/maps\/embed|maps\.google\.[a-z.]+\/maps\?/i.test(html)) {
    signals.push('maps:embed');
  }

  for (const node of parseJsonLd(html)) {
    if (typesOf(node).some(isLocalBusinessType)) { signals.push('jsonld:LocalBusiness'); break; }
  }

  return {
    gmb: signals.length > 0,
    signal: signals[0] || null,
    placeId,
    url: url ? url.slice(0, 255) : null,
    signals,
  };
}
