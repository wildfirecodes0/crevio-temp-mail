// Provider registry + a merged, cached domain catalogue.
import { config } from '../config.js';
import * as store from '../db.js';
import { mailtm } from './mailtm.js';
import { tempmailio } from './tempmailio.js';
import { guerrilla } from './guerrilla.js';
import { own } from './own.js';

const ALL = {
  tm: mailtm('tm', 'mail.tm', 'https://api.mail.tm'),
  gw: mailtm('gw', 'mail.gw', 'https://api.mail.gw'),
  tio: tempmailio,
  gm: guerrilla,
  own,
};

const enabled = config.providers.filter((p) => ALL[p] && p !== 'own');

export const provider = (id) => {
  const p = ALL[id];
  if (!p) throw new Error(`unknown provider ${id}`);
  return p;
};

let catalogue = []; // [{ provider, domain }]
let refreshedAt = 0;
let refreshing = null;

async function refresh() {
  const results = await Promise.allSettled(
    enabled.map(async (id) => (await ALL[id].domains()).map((domain) => ({ provider: id, domain }))),
  );
  const list = results.flatMap((r, i) => {
    if (r.status === 'rejected') console.warn(`[domains] ${enabled[i]}: ${r.reason?.message}`);
    return r.status === 'fulfilled' ? r.value : [];
  });
  // keep one provider per domain name
  const seen = new Set();
  const dedup = list.filter((d) => !seen.has(d.domain) && seen.add(d.domain));
  if (dedup.length) {
    catalogue = dedup;
    refreshedAt = Date.now();
  }
  return catalogue;
}

/** Public domains. Returns instantly from cache and refreshes in the background when stale. */
export async function publicDomains() {
  const stale = Date.now() - refreshedAt > 10 * 60_000;
  if (!catalogue.length) return (refreshing ??= refresh().finally(() => (refreshing = null)));
  if (stale && !refreshing) refreshing = refresh().finally(() => (refreshing = null));
  return catalogue;
}

/** Everything a given user may create addresses on: their own domains first, then shared custom, then public. */
export async function domainsFor(userId) {
  const custom = store.usableDomains(userId).map((d) => ({
    provider: 'own',
    domain: d.domain,
    kind: Number(d.owner_id) === Number(userId) ? 'mine' : 'premium',
    canSend: Boolean(d.can_send && d.worker_url),
  }));
  const pub = (await publicDomains()).map((d) => ({ ...d, kind: 'public', canSend: false }));
  return [...custom.filter((d) => d.kind === 'mine'), ...custom.filter((d) => d.kind === 'premium'), ...pub];
}

export function warmDomains() {
  refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), 10 * 60_000).unref();
}

export const providerLabel = (id) => ALL[id]?.label ?? id;
