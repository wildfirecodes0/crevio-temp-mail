// Inbox operations on top of providers, with short-lived caches so the UI never waits twice.
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';
import { provider, domainsFor } from './providers/index.js';
import { randomLocal } from './names.js';

export class UserFacingError extends Error {}

// ── message list cache ───────────────────────────────────────────────────
const lists = new Map(); // inboxId → { at, list }
const fulls = new Map(); // `${inboxId}:${msgId}` → full message
const FULL_MAX = 400;

const decorate = async (ib, raw) => {
  const f = await store.flags(ib.id);
  return raw.filter((m) => !f.hidden.has(m.id)).map((m) => ({ ...m, seen: f.read.has(m.id) }));
};

/** Fresh list from the provider (and update cache). */
export async function fetchList(ib) {
  const raw = await provider(ib.provider).list(ib);
  store.saveAuth(ib);
  const list = await decorate(ib, raw);
  lists.set(ib.id, { at: Date.now(), list });
  return list;
}

/** Cached list if younger than maxAgeMs, else fetch. */
export async function getList(ib, maxAgeMs = 0) {
  const c = lists.get(ib.id);
  if (c && Date.now() - c.at <= maxAgeMs) return c.list;
  return fetchList(ib);
}

export const cachedList = (inboxId) => lists.get(inboxId) ?? null;
export const invalidate = (inboxId) => lists.delete(inboxId);

export async function getMessage(ib, msgId) {
  const key = `${ib.id}:${msgId}`;
  if (fulls.has(key)) return fulls.get(key);
  const m = await provider(ib.provider).get(ib, msgId);
  store.saveAuth(ib);
  if (fulls.size >= FULL_MAX) fulls.delete(fulls.keys().next().value);
  fulls.set(key, m);
  return m;
}

export function primeMessage(ib, m) {
  fulls.set(`${ib.id}:${m.id}`, m);
}

export async function markRead(ib, msgId) {
  await store.setFlag(ib.id, msgId, 'read');
  const c = lists.get(ib.id);
  const hit = c?.list.find((m) => m.id === msgId);
  if (hit) hit.seen = true;
}

export async function deleteMessage(ib, msgId) {
  const p = provider(ib.provider);
  if (p.caps.delete && p.remove) {
    try {
      await p.remove(ib, msgId);
    } catch (e) {
      if (e.status !== 404) console.warn(`[delete] ${ib.address}: ${e.message}`);
    }
  }
  await store.setFlag(ib.id, msgId, 'hidden');
  fulls.delete(`${ib.id}:${msgId}`);
  const c = lists.get(ib.id);
  if (c) c.list = c.list.filter((m) => m.id !== msgId);
}

export async function downloadAttachment(ib, msgId, att) {
  const p = provider(ib.provider);
  if (!p.caps.attachments || !p.attachment) throw new UserFacingError('noatt');
  return p.attachment(ib, msgId, att);
}

// ── create / destroy ─────────────────────────────────────────────────────
export async function createInbox(user, opts = {}) {
  if (store.countInboxes(user.id) >= config.maxInboxes) throw new UserFacingError('limit');

  let { provider: pid, domain } = opts;
  const options = await domainsFor(user.id);
  if (pid && domain) {
    if (!options.some((d) => d.provider === pid && d.domain === domain)) throw new UserFacingError('nodomain');
  } else {
    const pub = options.filter((d) => d.kind === 'public');
    if (!pub.length) throw new UserFacingError('down');
    ({ provider: pid, domain } = pub[crypto.randomInt(pub.length)]);
  }

  const p = provider(pid);
  const custom = Boolean(opts.local);
  for (let attempt = 0; attempt < (custom ? 1 : 4); attempt++) {
    const local = custom ? opts.local : randomLocal();
    try {
      const { address, auth } = await p.create(local, domain);
      const ttl = Number(user.default_ttl) || 0;
      const ib = await store.createInbox({
        userId: user.id,
        provider: pid,
        address,
        auth,
        expiresAt: ttl ? Date.now() + ttl * 1000 : null,
      });
      lists.set(ib.id, { at: Date.now(), list: [] });
      return ib;
    } catch (e) {
      if (e.taken) {
        if (custom) throw new UserFacingError('taken');
        continue;
      }
      if (e.status === 429) throw new UserFacingError('slow');
      throw e;
    }
  }
  throw new UserFacingError('down');
}

export async function destroyInbox(ib, { reason = 'deleted' } = {}) {
  store.deleteInbox(ib.id);
  lists.delete(ib.id);
  store.bumpUser(ib.user_id, 'disposed');
  try {
    await provider(ib.provider).destroy(ib);
  } catch (e) {
    if (e.status !== 404) console.warn(`[destroy:${reason}] ${ib.address}: ${e.message}`);
  }
}

const sendReady = (d) => Boolean(d?.verified && d.worker_url && d.can_send);

/** Shared domain that sends on behalf of addresses that can't send themselves (admin-shared 💎 domain). */
export function relayDomain() {
  const all = store.allDomains().filter((d) => d.public && sendReady(d));
  return all.find((d) => d.domain === config.relayDomain) || all[0] || null;
}

/**
 * How mail from this address goes out:
 *  direct → the address is on a custom domain with a working worker (From: the address itself)
 *  relay  → any other address; sent as local@relay-domain with Reply-To set to the address,
 *           so replies land back in the user's temp inbox
 */
export function sendRoute(ib) {
  if (!ib) return null;
  if (ib.provider === 'own') {
    const d = store.findDomain(ib.address.split('@')[1]);
    if (sendReady(d)) return { mode: 'direct', domain: d };
  }
  const relay = relayDomain();
  return relay ? { mode: 'relay', domain: relay } : null;
}

export const canSendFrom = (ib) => Boolean(sendRoute(ib));
