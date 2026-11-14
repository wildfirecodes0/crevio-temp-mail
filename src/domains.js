// Custom domain onboarding: ownership via DNS TXT, mail via Cloudflare Email Routing → Worker → /inbound.
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { config } from './config.js';
import * as store from './db.js';
import { request } from './providers/http.js';

const WORKER_TEMPLATE = new URL('../worker/crevio-worker.js', import.meta.url);

export const txtHost = (domain) => `_crevio.${domain}`;

const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

/** DNS + worker health for a domain. Marks verified when the TXT record matches. */
export async function checkDomain(d) {
  const [txt, mx] = await Promise.allSettled([resolver.resolveTxt(txtHost(d.domain)), resolver.resolveMx(d.domain)]);
  const txtOk = txt.status === 'fulfilled' && txt.value.some((parts) => parts.join('').trim() === config.verifyToken(d.domain));
  const mxHosts = mx.status === 'fulfilled' ? mx.value.map((r) => r.exchange.toLowerCase()) : [];
  const mxCloudflare = mxHosts.some((h) => h.endsWith('mx.cloudflare.net'));
  let worker = null;
  if (d.worker_url) worker = await pingWorker(d.worker_url, d.key);
  if (txtOk && !d.verified) store.setDomain(d.id, { verified: 1 });
  if (worker && Boolean(worker.canSend) !== Boolean(d.can_send)) store.setDomain(d.id, { can_send: worker.canSend ? 1 : 0 });
  return { txtOk, mxHosts, mxCloudflare, worker };
}

export async function pingWorker(url, key) {
  try {
    const r = await request(`${url.replace(/\/+$/, '')}/ping`, { headers: { 'X-Crevio-Key': key }, retries: 0, timeout: 8000, label: 'worker' });
    return { ok: Boolean(r?.ok), canSend: Boolean(r?.canSend) };
  } catch (e) {
    return { ok: false, canSend: false, error: e.status === 403 ? 'key mismatch' : e.message };
  }
}

/** Ready-to-deploy worker + wrangler config for a domain. */
export async function workerFiles(d) {
  const tpl = await fs.readFile(WORKER_TEMPLATE, 'utf8');
  const js = tpl.replace('__BOT_URL__', config.publicUrl || 'https://YOUR-BOT.onrender.com').replace('__KEY__', d.key);
  const name = `crevio-${d.domain.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`.slice(0, 54);
  const toml = `name = "${name}"
main = "crevio-worker.js"
compatibility_date = "2026-10-01"

# Lets the bot send mail from @${d.domain}.
# Onboard the domain under Email Service → Sending first.
# Sending to any recipient needs the Workers Paid plan; without it only verified addresses work.
[[send_email]]
name = "EMAIL"
`;
  return { js, toml };
}
