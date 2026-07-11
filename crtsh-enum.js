// crtsh-enum.js
//
// Enumera SUBDOMÍNIOS de um domínio "semente" específico (ex: todos os *.dns.pt)
// via acesso direto ao PostgreSQL público do crt.sh (Certificate Transparency
// logs), usando o índice de Full Text Search.
//
// NÃO serve para descobrir todos os domínios de um TLD — a réplica do crt.sh
// cancela queries abrangentes. Para a lista de domínios de um TLD (ex: todos os
// .pt com site ativo) usa `tld-domains.js` (Common Crawl). Este script é uma
// fase POSTERIOR da pipeline: expandir subdomínios de um domínio já conhecido.
//
// Instalação:
//   npm install pg
//
// Uso:
//   node crtsh-enum.js dns.pt                      (subdomínios de dns.pt)
//   node crtsh-enum.js dns.pt --active-only        (só certificados válidos)
//   node crtsh-enum.js dns.pt out/dns.txt          (ficheiro de saída à escolha)
//   node crtsh-enum.js pt                           (TLD inteiro — ver AVISO abaixo)
//
// COMO FUNCIONA / MUDANÇAS DE ESQUEMA (2024+):
//   - A antiga tabela `certificate_identity` foi REMOVIDA pelo crt.sh e
//     substituída pela view `certificate_and_identities` + um índice de
//     Full Text Search, consultado com:
//         plainto_tsquery('certwatch', $termo) @@ identities(certificate)
//     (Se voltares a ver o erro "certificate_identity table has been
//      superseded...", é sinal de mais uma mudança de esquema — confirma em
//      https://crt.sh/?q=%.pt&showSQL=Y e ajusta a query abaixo.)
//   - Os hostnames reais vêm do name_type 'san:dNSName' (o antigo 'dNSName').
//
// AVISO SOBRE TLD INTEIRO (ex: `pt`):
//   - A base `guest` do crt.sh é uma RÉPLICA de leitura que CANCELA queries
//     longas/abrangentes com "canceling statement due to conflict with
//     recovery". Um termo específico (ex: `dns.pt`) devolve em segundos; um
//     TLD inteiro é demasiado abrangente e é quase sempre cancelado. Para
//     enumeração em massa, corre este script por cada domínio "semente" que já
//     conheças, em vez de um TLD completo.
//
// ETIQUETA:
//   - É um serviço gratuito e partilhado por toda a comunidade de segurança.
//     Não o corras em paralelo agressivo nem em loop apertado.

import fs from 'fs';
import path from 'path';
import { fetchNames } from './lib/crtsh.js';

// Separa argumentos posicionais das flags (--...), para que `--active-only`
// não seja confundido com o caminho do ficheiro de saída.
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const TERM = (positional[0] || 'pt').replace(/^\.+/, '').toLowerCase().trim();
const ACTIVE_ONLY = process.argv.includes('--active-only');
const OUTPUT_FILE = positional[1] || `out/dominios_${TERM.replace(/[^a-z0-9._-]/g, '_')}.txt`;

async function main() {
  if (!TERM) {
    console.error('Uso: node crtsh-enum.js <dominio|tld> [ficheiro-saida] [--active-only]');
    process.exit(1);
  }
  if (!TERM.includes('.')) {
    console.warn(
      `AVISO: "${TERM}" parece um TLD inteiro. A base do crt.sh cancela queries\n` +
      `       demasiado abrangentes — é provável que isto falhe ou devolva poucos\n` +
      `       resultados. Prefere um domínio específico (ex: exemplo.${TERM}).\n`
    );
  }

  console.log(
    `A extrair domínios que terminam em .${TERM} do crt.sh` +
    `${ACTIVE_ONLY ? ' (só certificados ativos)' : ''}...`
  );

  let names, scanned;
  try {
    ({ names, scanned } = await fetchNames(TERM, {
      activeOnly: ACTIVE_ONLY,
      onRetry: (a, max, err, backoff) =>
        console.error(`  Tentativa ${a}/${max} falhou (${err.message.trim()}). A repetir em ${backoff}ms...`),
    }));
  } catch (err) {
    console.error(
      `\nQuery falhou definitivamente: ${err.message.trim()}\n` +
      `(confirma o esquema atual em https://crt.sh/?q=%.${TERM}&showSQL=Y)`
    );
    process.exit(1);
  }

  const dir = path.dirname(OUTPUT_FILE);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, names.join('\n') + (names.length ? '\n' : ''));

  console.log(
    `\nConcluído. ${names.length} domínios únicos guardados em ${OUTPUT_FILE} ` +
    `(${scanned} identidades analisadas).`
  );
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
