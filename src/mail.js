// Thin client for the mail.tm-compatible API family (mail.tm, mail.gw).
import { config } from './config.js';
import { sleep } from './utils.js';

export const PROVIDERS = {
  tm: { name: 'mail.tm', base: 'https://api.mail.tm' },
  gw: { name: 'mail.gw', base: 'https://api.mail.gw' },
};

const enabled = config.providers.filter((p) => PROVIDERS[p]);
if (!enabled.length) enabled.push('tm');

export class MailError extends Error {
  constructor(message, status = 0, body = '') {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(provider, path, { method = 'GET', token, body, as = 'json', retries = 2 } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new MailError(`unknown provider ${provider}`);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(p.base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw new MailError(`${p.name} unreachable: ${e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new MailError(`${p.name} ${method} ${path} → ${res.status}`, res.status, text);
    }
    if (res.status === 204) return null;
    if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

const members = (d) => (Array.isArray(d) ? d : d?.['hydra:member'] ?? []);

let domainCache = { at: 0, list: [] };

/** @returns {Promise<{provider:string, domain:string}[]>} */
export async function getDomains() {
  if (domainCache.list.length && Date.now() - domainCache.at < 10 * 60_000) return domainCache.list;
  const results = await Promise.allSettled(
    enabled.map(async (provider) =>
      members(await call(provider, '/domains', { retries: 1 }))
        .filter((d) => d.isActive && !d.isPrivate)
        .map((d) => ({ provider, domain: d.domain })),
    ),
  );
  const list = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (list.length) domainCache = { at: Date.now(), list };
  return list.length ? list : domainCache.list;
}

export async function login(provider, address, password) {
  const r = await call(provider, '/token', { method: 'POST', body: { address, password } });
  return r.token;
}

export async function createAccount(provider, address, password) {
  const acc = await call(provider, '/accounts', { method: 'POST', body: { address, password }, retries: 1 });
  // Freshly created accounts can take a moment before /token accepts them.
  for (let i = 0; ; i++) {
    try {
      return { accountId: acc.id, token: await login(provider, address, password) };
    } catch (e) {
      if (e.status !== 401 || i >= 3) throw e;
      await sleep(700 * (i + 1));
    }
  }
}

export const deleteAccount = (provider, token, accountId) =>
  call(provider, `/accounts/${accountId}`, { method: 'DELETE', token, retries: 0 });

export const listMessages = (provider, token, page = 1) =>
  call(provider, `/messages?page=${page}`, { token }).then(members);

export const getMessage = (provider, token, id) => call(provider, `/messages/${id}`, { token });

export const markRead = (provider, token, id) =>
  call(provider, `/messages/${id}`, { method: 'PATCH', token, body: { seen: true }, retries: 0 });

export const deleteMessage = (provider, token, id) =>
  call(provider, `/messages/${id}`, { method: 'DELETE', token, retries: 0 });

export const download = (provider, token, path) => call(provider, path, { token, as: 'buffer' });
