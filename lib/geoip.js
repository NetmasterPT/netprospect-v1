// Resolução de IP -> ASN / ISP / país.
//
// Preferência: bases GeoLite2 da MaxMind (.mmdb) lidas offline (ilimitado, sem
// enviar IPs para terceiros — mais limpo do ponto de vista de RGPD). Basta
// colocar GeoLite2-ASN.mmdb e GeoLite2-Country.mmdb em data/geoip/ (precisa de
// uma chave gratuita da MaxMind, uma só vez).
//
// Fallback automático (se as .mmdb não existirem): Team Cymru via DNS
// (origin.asn.cymru.com), sem conta. É um serviço ao vivo — usamos cache por IP.
import maxmind from 'maxmind';
import dns from 'node:dns/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEO_DIR = path.join(__dirname, '..', 'data', 'geoip');

async function cymruLookup(ip) {
  // Só IPv4 (resolvemos apenas registos A).
  const rev = ip.split('.').reverse().join('.');
  const txt = await dns.resolveTxt(`${rev}.origin.asn.cymru.com`);
  const parts = txt[0].join('').split('|').map((s) => s.trim());
  const asn = parseInt((parts[0] || '').split(' ')[0], 10) || null;
  const country = parts[2] || null;
  let isp = null;
  if (asn) {
    try {
      const t2 = await dns.resolveTxt(`AS${asn}.asn.cymru.com`);
      isp = t2[0].join('').split('|').pop().trim() || null;
    } catch {
      /* nome de AS opcional */
    }
  }
  return { asn, isp, country };
}

async function tryOpen(file) {
  try {
    return await maxmind.open(path.join(GEO_DIR, file));
  } catch {
    return null; // ausente
  }
}

export async function makeGeoIP() {
  const asnDb = await tryOpen('GeoLite2-ASN.mmdb');
  const countryDb = await tryOpen('GeoLite2-Country.mmdb');
  const cityDb = await tryOpen('GeoLite2-City.mmdb'); // opcional (dá cidade + país)
  const mode = asnDb || countryDb || cityDb ? 'maxmind' : 'cymru';
  const cache = new Map();

  async function lookup(ip) {
    const empty = { asn: null, isp: null, country: null, city: null };
    if (!ip) return empty;
    if (cache.has(ip)) return cache.get(ip);
    let res = empty;
    try {
      if (asnDb || countryDb || cityDb) {
        const a = asnDb ? asnDb.get(ip) : null;
        const cityRec = cityDb ? cityDb.get(ip) : null;
        const c = countryDb ? countryDb.get(ip) : null;
        res = {
          asn: a?.autonomous_system_number ?? null,
          isp: a?.autonomous_system_organization ?? null,
          country: c?.country?.iso_code ?? cityRec?.country?.iso_code ?? null,
          city: cityRec?.city?.names?.en ?? null,
        };
      } else {
        res = { ...(await cymruLookup(ip)), city: null };
      }
    } catch {
      res = empty;
    }
    cache.set(ip, res);
    return res;
  }

  return { mode, lookup };
}
