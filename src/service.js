// Inbox operations on top of providers, with short-lived caches so the UI never waits twice.
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';
import { provider, publicDomains, providerLabel, markDown, markUp, isUp } from './providers/index.js';
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
const reason = (pid, e) => `${providerLabel(pid)}: ${e.status ? `HTTP ${e.status}` : e.message?.replace(/^.*unreachable: /, 'unreachable, ') || 'error'}`;

/** Try one provider/domain. Random names retry on collisions; a custom name fails fast with "taken". */
async function tryCreate(user, pid, domain, local) {
  const p = provider(pid);
  for (let attempt = 0; attempt < (local ? 1 : 3); attempt++) {
    try {
      const { address, auth } = await p.create(local || randomLocal(), domain);
      markUp(pid);
      const ttl = Number(user.default_ttl) || 0;
      const ib = await store.createInbox({ userId: user.id, provider: pid, address, auth, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
      lists.set(ib.id, { at: Date.now(), list: [] });
      return ib;
    } catch (e) {
      if (e.taken) {
        if (local) throw new UserFacingError('taken');
        continue;
      }
      throw e;
    }
  }
  throw Object.assign(new Error('every random name was taken'), { status: 409 });
}

/**
 * Create an address. With a chosen domain we try that domain first; if its provider is down we fall back
 * to other providers automatically (same name when a custom name was given), so the user still gets an address.
 */
export async function createInbox(user, opts = {}) {
  if (store.countInboxes(user.id) >= config.maxInboxes) throw new UserFacingError('limit');
  const { local } = opts;

  const custom = store.usableDomains(user.id).map((d) => ({ provider: 'own', domain: d.domain }));
  const pub = await publicDomains();
  const candidates = [];
  if (opts.provider && opts.domain) {
    if (![...custom, ...pub].some((d) => d.provider === opts.provider && d.domain === opts.domain)) throw new UserFacingError('nodomain');
    candidates.push({ provider: opts.provider, domain: opts.domain });
    if (opts.provider === 'own') return tryCreate(user, 'own', opts.domain, local).catch((e) => fail(e, 'own'));
  }
  // Fallbacks: one random domain per other healthy provider, healthy ones first.
  const byProvider = new Map();
  for (const d of [...pub].sort(() => Math.random() - 0.5)) if (!byProvider.has(d.provider)) byProvider.set(d.provider, d);
  const others = [...byProvider.values()].filter((d) => d.provider !== candidates[0]?.provider);
  candidates.push(...others.filter((d) => isUp(d.provider)), ...others.filter((d) => !isUp(d.provider)));
  if (!candidates.length) throw new UserFacingError('down');

  const errors = [];
  for (const c of candidates.slice(0, 4)) {
    try {
      const ib = await tryCreate(user, c.provider, c.domain, local);
      if (errors.length) ib.fallbackFrom = opts.domain || null;
      return ib;
    } catch (e) {
      if (e instanceof UserFacingError) throw e;
      console.warn(`[create] ${c.provider} @${c.domain}: ${e.message}${e.body ? ` · ${e.body.slice(0, 120)}` : ''}`);
      if (e.status !== 409) markDown(c.provider);
      errors.push(reason(c.provider, e));
    }
  }
  const err = new UserFacingError(errors.length && errors.every((x) => /429/.test(x)) ? 'slow' : 'down');
  err.code = errors.join(' · ');
  throw err;
}

function fail(e, pid) {
  if (e instanceof UserFacingError) throw e;
  const err = new UserFacingError('down');
  err.code = reason(pid, e);
  throw err;
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
