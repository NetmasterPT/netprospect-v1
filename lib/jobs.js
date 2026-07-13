// lib/jobs.js
// Camada fina sobre NATS JetStream para a pipeline orientada a jobs.
//
// UM stream workqueue (`NP_JOBS`, storage=file, dedup 24h) com vários subjects;
// cada subject tem o SEU consumer durável (filtros disjuntos — requisito do
// workqueue). Prioridade das auditorias = 3 subjects (JetStream não tem
// prioridade nativa): o worker drena ondemand → qualified → rest.
//
// Idempotência: publicar com `Nats-Msg-Id` (o dedup do stream ignora repetições
// dentro da janela). Redelivery reescreve o mesmo registo (upsert por domínio).

import { connect, headers, nanos, AckPolicy, RetentionPolicy, StorageType, DeliverPolicy } from 'nats';

// STREAM + SUBJECT_PREFIX parametrizáveis por env para dar uma fila DEDICADA a um host
// (ex.: DE1 com JOB_STREAM=NP_JOBS_DE1 + JOB_SUBJECT_PREFIX=de1. consome de1.jobs.* da sua
// própria stream, alimentada pelo feeder — sem competir com o HEL1 na workqueue partilhada).
// Defaults vazios ⇒ comportamento idêntico ao anterior (HEL1/dashboard/enqueue).
export const STREAM = process.env.JOB_STREAM || 'NP_JOBS';
export const SUBJECT_PREFIX = process.env.JOB_SUBJECT_PREFIX || '';
export const SUBJECTS = {
  // Coarse (mantidos p/ migração — o caminho standalone/coarse continua a funcionar)
  enrich: 'jobs.enrich',
  contacts: 'jobs.contacts',
  auditOndemand: 'jobs.audit.ondemand',
  auditQualified: 'jobs.audit.qualified',
  auditRest: 'jobs.audit.rest',
  verify: 'jobs.verify',
  // Fine-grained (Fase B) — um job por passo. DAG por publicação de sucessores.
  discover: 'jobs.discover',
  dns: 'jobs.dns',
  geoip: 'jobs.geoip',
  fetch: 'jobs.fetch',
  fingerprint: 'jobs.fingerprint',
  social: 'jobs.social',
  locality: 'jobs.locality',
  emailauth: 'jobs.emailauth',
  traffic: 'jobs.traffic',
  industry: 'jobs.industry',
  lighthouseDesktop: 'jobs.lighthouse.desktop',
  lighthouseMobile: 'jobs.lighthouse.mobile',
  nuclei: 'jobs.nuclei',
  wpscan: 'jobs.wpscan',
  gmb: 'jobs.gmb',
  subdomains: 'jobs.subdomains',
  ssl: 'jobs.ssl',
  whois: 'jobs.whois',
  dnsprovider: 'jobs.dnsprovider',
  score: 'jobs.score',
  // A3 write-behind — resultados de escrita de sites (o worker publica; o pool de
  // writers junta em lote e faz 1 UPDATE por flush). Só ativo com WRITE_BEHIND=true.
  resultSite: 'jobs.result.site',
  // Fase F — campanhas (geração de cópia por IA + envio).
  campaignGenerate: 'jobs.campaign.generate',
  campaignSend: 'jobs.campaign.send',
};

// Consumidores duráveis (nome -> {filtro, ackWait, role}). Filtros disjuntos
// (requisito do workqueue). `role` agrupa por imagem de worker:
//   base    = leves (fetch/dns/geoip/parse/contacts/social/…/score/discover/subdomains/ssl/whois/dnsprovider + coarse enrich/contacts)
//   verify  = validação de email via APIs free (jobs.verify) — corre em VMs remotas
//             pequenas; cada IP/VM traz a SUA quota free (config/verify-providers.json local)
//   browser = Chromium (lighthouse.*)
//   security= Nuclei/WPScan (nuclei, wpscan)
//   ai      = Ollama (industry)
//   residential = precisa de IP RESIDENCIAL, não datacenter (gmb — o Google bloqueia Hetzner).
//                 Só o portátil (gpedro-laptop) o corre; ninguém mais lhe toca.
// WORKER_ROLES (env) seleciona que consumers um worker corre (vazio=todos).
export const CONSUMERS = {
  // coarse
  enrich: { durable: 'enrich', filter: SUBJECTS.enrich, ackWait: 60, maxDeliver: 4, role: 'base' },
  contacts: { durable: 'contacts', filter: SUBJECTS.contacts, ackWait: 90, maxDeliver: 4, maxAckPending: 512, role: 'base' },
  audit_ondemand: { durable: 'audit_ondemand', filter: SUBJECTS.auditOndemand, ackWait: 300, maxDeliver: 3, maxAckPending: 32, role: 'browser' },
  audit_qualified: { durable: 'audit_qualified', filter: SUBJECTS.auditQualified, ackWait: 300, maxDeliver: 3, maxAckPending: 32, role: 'browser' },
  audit_rest: { durable: 'audit_rest', filter: SUBJECTS.auditRest, ackWait: 300, maxDeliver: 3, maxAckPending: 32, role: 'browser' },
  verify: { durable: 'verify', filter: SUBJECTS.verify, ackWait: 120, maxDeliver: 6, role: 'verify' },
  // fine-grained — base
  discover: { durable: 'discover', filter: SUBJECTS.discover, ackWait: 300, maxDeliver: 4, maxAckPending: 4, role: 'base' },
  dns: { durable: 'dns', filter: SUBJECTS.dns, ackWait: 30, maxDeliver: 4, role: 'base' },
  geoip: { durable: 'geoip', filter: SUBJECTS.geoip, ackWait: 30, maxDeliver: 4, role: 'base' },
  fetch: { durable: 'fetch', filter: SUBJECTS.fetch, ackWait: 45, maxDeliver: 4, role: 'base' },
  fingerprint: { durable: 'fingerprint', filter: SUBJECTS.fingerprint, ackWait: 30, maxDeliver: 4, maxAckPending: 512, role: 'base' },
  social: { durable: 'social', filter: SUBJECTS.social, ackWait: 30, maxDeliver: 4, role: 'base' },
  locality: { durable: 'locality', filter: SUBJECTS.locality, ackWait: 30, maxDeliver: 4, role: 'base' },
  emailauth: { durable: 'emailauth', filter: SUBJECTS.emailauth, ackWait: 30, maxDeliver: 4, role: 'base' },
  traffic: { durable: 'traffic', filter: SUBJECTS.traffic, ackWait: 20, maxDeliver: 4, role: 'base' },
  score: { durable: 'score', filter: SUBJECTS.score, ackWait: 30, maxDeliver: 4, role: 'base' },
  // A3 — pool de writers (perto do Postgres): junta os patches de sites e faz 1 UPDATE
  // por flush. maxAckPending alto p/ puxar lotes grandes. Idempotente (redelivery → re-UPDATE).
  result_site: { durable: 'result_site', filter: SUBJECTS.resultSite, ackWait: 60, maxDeliver: 6, maxAckPending: 4000, role: 'writer' },
  subdomains: { durable: 'subdomains', filter: SUBJECTS.subdomains, ackWait: 120, maxDeliver: 3, maxAckPending: 4, role: 'base' },
  ssl: { durable: 'ssl', filter: SUBJECTS.ssl, ackWait: 30, maxDeliver: 3, role: 'base' },
  whois: { durable: 'whois', filter: SUBJECTS.whois, ackWait: 45, maxDeliver: 3, role: 'base' },
  dnsprovider: { durable: 'dnsprovider', filter: SUBJECTS.dnsprovider, ackWait: 30, maxDeliver: 3, role: 'base' },
  // Fase F — campanhas (base: gera com Ollama-se-disponível/fallback; envia por SMTP).
  campaign_generate: { durable: 'campaign_generate', filter: SUBJECTS.campaignGenerate, ackWait: 90, maxDeliver: 3, maxAckPending: 8, role: 'base' },
  campaign_send: { durable: 'campaign_send', filter: SUBJECTS.campaignSend, ackWait: 60, maxDeliver: 3, maxAckPending: 8, role: 'base' },
  // fine-grained — ai / browser / security
  industry: { durable: 'industry', filter: SUBJECTS.industry, ackWait: 300, maxDeliver: 3, maxAckPending: 3, role: 'ai' },
  lighthouse_desktop: { durable: 'lighthouse_desktop', filter: SUBJECTS.lighthouseDesktop, ackWait: 120, maxDeliver: 3, maxAckPending: 8, role: 'browser' },
  lighthouse_mobile: { durable: 'lighthouse_mobile', filter: SUBJECTS.lighthouseMobile, ackWait: 120, maxDeliver: 3, maxAckPending: 8, role: 'browser' },
  // GMB: role PRÓPRIO `residential` — o Google bloqueia os IPs de datacenter (Hetzner serve a
  // página /sorry/, que já envenenou a DB). Só um host com IP RESIDENCIAL (o portátil) o consome;
  // como é um consumer distinto, os workers de datacenter NUNCA lhe tocam (nem para descartar).
  gmb: { durable: 'gmb', filter: SUBJECTS.gmb, ackWait: 90, maxDeliver: 2, maxAckPending: 2, role: 'residential' },
  nuclei: { durable: 'nuclei', filter: SUBJECTS.nuclei, ackWait: 200, maxDeliver: 3, maxAckPending: 96, role: 'security' },
  // maxAckPending 48 (era 2, on-demand): o batch keyless (1,5M sites WP) escala pela frota de
  // security. Network-bound, mas cada scan enumera muito → conc modesta por worker (WPSCAN_CONC).
  wpscan: { durable: 'wpscan', filter: SUBJECTS.wpscan, ackWait: 300, maxDeliver: 2, maxAckPending: 48, role: 'security' },
};

// Consumers que uma imagem/worker de um dado role deve correr.
export function consumersForRoles(rolesCsv) {
  const roles = (rolesCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  const wanted = roles.length ? new Set(roles) : null; // vazio = todos
  return Object.entries(CONSUMERS).filter(([, c]) => !wanted || wanted.has(c.role)).map(([name]) => name);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function connectJobs(url = process.env.NATS_URL || 'nats://nats:4222') {
  return connect({ servers: url, name: 'netprospect', maxReconnectAttempts: -1, reconnectTimeWait: 2000 });
}

// Cria/atualiza o stream. Idempotente.
export async function ensureStream(nc) {
  const jsm = await nc.jetstreamManager();
  const cfg = {
    name: STREAM,
    subjects: [`${SUBJECT_PREFIX}jobs.>`], // cobre coarse + fine-grained (Fase B); prefixado p/ streams dedicadas
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    duplicate_window: nanos(24 * 60 * 60 * 1000), // 24h
    max_msgs: -1,
  };
  try { await jsm.streams.add(cfg); }
  catch { try { await jsm.streams.update(STREAM, cfg); } catch { /* config imutável — ok */ } }
  return jsm;
}

// Cria/atualiza um consumer durável (pull). Idempotente.
export async function ensureConsumer(jsm, spec) {
  const cfg = {
    durable_name: spec.durable,
    filter_subject: SUBJECT_PREFIX + spec.filter,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos((spec.ackWait || 60) * 1000),
    max_deliver: spec.maxDeliver || 4,
    max_ack_pending: spec.maxAckPending || 256,
    deliver_policy: DeliverPolicy.All,
    // O NATS rejeita um backoff com mais entradas do que as re-entregas possíveis. Consumers
    // com maxDeliver baixo (gmb/wpscan = 2) faziam a criação FALHAR — e como o erro era engolido,
    // o worker arrancava, tentava consumi-los e morria com "consumer not found".
    backoff: [nanos(5000), nanos(30000), nanos(120000)].slice(0, Math.max(1, (spec.maxDeliver || 4) - 1)),
  };
  try { await jsm.consumers.add(STREAM, cfg); }
  catch { try { await jsm.consumers.update(STREAM, spec.durable, cfg); } catch { /* imutável — ok */ } }
}

// Publica um job (dedup por msgId). `js` = nc.jetstream().
export async function publishJob(js, subject, obj, { msgId } = {}) {
  const h = headers();
  if (msgId) h.set('Nats-Msg-Id', msgId);
  return js.publish(subject, enc.encode(JSON.stringify(obj)), { headers: h });
}

export const decodeJob = (m) => { try { return JSON.parse(dec.decode(m.data)); } catch { return null; } };

// Erros transitórios (rede/Directus/DNS) -> nak + retry; o resto -> term.
export const isTransientJobErr = (e) =>
  (e && e.exhausted) || // quota free esgotada (verify) → nak, volta à fila mais tarde
  /fetch failed|ECONNRESET|socket hang up|terminated|network|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|502|503|504|429|timeout|aborted|exhausted/i.test(
    (e && (e.message || '')) + JSON.stringify(e?.errors || '')
  );
