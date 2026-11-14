import * as mail from './mail.js';
import * as store from './db.js';
import { randomLocal, randomPassword } from './names.js';
import crypto from 'node:crypto';
import { config } from './config.js';

/** Run fn(token), transparently re-logging in once if the JWT has expired. */
export async function authed(ib, fn) {
  try {
    return await fn(ib.token);
  } catch (e) {
    if (e.status !== 401) throw e;
    const token = await mail.login(ib.provider, ib.address, ib.password);
    ib.token = token;
    await store.updateToken(ib.id, token);
    return fn(token);
  }
}

export class UserFacingError extends Error {}

/**
 * Create a new inbox for a user.
 * @param {object} user  users row
 * @param {{local?:string, provider?:string, domain?:string}} opts
 */
export async function createInbox(user, opts = {}) {
  const count = await store.countInboxes(user.id);
  if (count >= config.maxInboxes) throw new UserFacingError('limit');

  let { provider, domain } = opts;
  if (!provider || !domain) {
    const domains = await mail.getDomains();
    if (!domains.length) throw new UserFacingError('down');
    ({ provider, domain } = domains[crypto.randomInt(domains.length)]);
  }

  const custom = Boolean(opts.local);
  const password = randomPassword();
  for (let attempt = 0; attempt < (custom ? 1 : 4); attempt++) {
    const address = `${custom ? opts.local : randomLocal()}@${domain}`;
    try {
      const { accountId, token } = await mail.createAccount(provider, address, password);
      const ttl = Number(user.default_ttl) || 0;
      const id = await store.createInbox({
        userId: user.id,
        provider,
        address,
        password,
        accountId,
        token,
        expiresAt: ttl ? Date.now() + ttl * 1000 : null,
      });
      return store.getInbox(id);
    } catch (e) {
      if (e.status === 422 || e.status === 409) {
        if (custom) throw new UserFacingError('taken');
        continue;
      }
      if (e.status === 429) throw new UserFacingError('slow');
      throw e;
    }
  }
  throw new UserFacingError('down');
}

/** Delete at the provider (best effort) and locally. */
export async function destroyInbox(ib) {
  try {
    await authed(ib, (t) => mail.deleteAccount(ib.provider, t, ib.account_id));
  } catch (e) {
    if (e.status !== 404) console.warn(`[destroy] ${ib.address}: ${e.message}`);
  }
  await store.deleteInbox(ib.id);
}
