// Imprime "<pending_main> <pending_de1>" para um consumer (default: fingerprint).
// Usado pelos orquestradores de backfill (cms watcher + feeder do DE1).
import { connectJobs } from '../lib/jobs.js';
const consumer = process.argv[2] || 'fingerprint';
const nc = await connectJobs(process.env.NATS_URL || 'nats://localhost:4222');
const jsm = await nc.jetstreamManager();
const m = await jsm.consumers.info('NP_JOBS', consumer).catch(() => null);
const d = await jsm.consumers.info('NP_JOBS_DE1', consumer).catch(() => null);
console.log(`${m?.num_pending ?? 0} ${d?.num_pending ?? 0}`);
await nc.close();
