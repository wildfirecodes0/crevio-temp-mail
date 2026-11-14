// mail.tm-compatible APIs (mail.tm, mail.gw). Real accounts with JWT auth.
import { request } from './http.js';
import { sleep } from '../utils.js';
import { randomPassword } from '../names.js';

const members = (d) => (Array.isArray(d) ? d : d?.['hydra:member'] ?? []);

export function mailtm(id, label, base) {
  const call = (path, opts = {}) => request(base + path, { label, ...opts });

  async function login(auth, address) {
    const r = await call('/token', { method: 'POST', body: { address, password: auth.password } });
    auth.token = r.token;
    auth._dirty = true;
    return r.token;
  }

  /** Run fn(token) and transparently re-login once on 401. */
  async function authed(ib, fn) {
    const a = ib.auth;
    try {
      return await fn(a.token);
    } catch (e) {
      if (e.status !== 401) throw e;
      return fn(await login(a, ib.address));
    }
  }

  const norm = (m) => ({
    id: m.id,
    from: { name: m.from?.name || '', address: m.from?.address || '' },
    subject: m.subject || '',
    intro: m.intro || '',
    createdAt: m.createdAt,
    hasAttachments: Boolean(m.hasAttachments || m.attachments?.length),
  });

  return {
    id,
    label,
    caps: { attachments: true, delete: true },

    async domains() {
      return members(await call('/domains', { retries: 1 }))
        .filter((d) => d.isActive && !d.isPrivate)
        .map((d) => d.domain);
    },

    async create(local, domain) {
      const address = `${local}@${domain}`;
      const auth = { password: randomPassword() };
      try {
        const acc = await call('/accounts', { method: 'POST', body: { address, password: auth.password }, retries: 1 });
        auth.accountId = acc.id;
      } catch (e) {
        if (e.status === 422 || e.status === 409) e.taken = true;
        throw e;
      }
      for (let i = 0; ; i++) {
        try {
          await login(auth, address);
          break;
        } catch (e) {
          if (e.status !== 401 || i >= 3) throw e;
          await sleep(600 * (i + 1));
        }
      }
      delete auth._dirty;
      return { address, auth };
    },

    async list(ib) {
      return members(await authed(ib, (t) => call('/messages?page=1', { headers: { Authorization: `Bearer ${t}` } }))).map(norm);
    },

    async get(ib, msgId) {
      const m = await authed(ib, (t) => call(`/messages/${msgId}`, { headers: { Authorization: `Bearer ${t}` } }));
      return {
        ...norm(m),
        text: m.text || '',
        html: Array.isArray(m.html) ? m.html.join('\n') : m.html || '',
        attachments: (m.attachments || []).map((a) => ({
          id: a.id,
          filename: a.filename,
          size: a.size,
          contentType: a.contentType,
          path: a.downloadUrl?.startsWith('http') ? new URL(a.downloadUrl).pathname : a.downloadUrl,
        })),
      };
    },

    async remove(ib, msgId) {
      await authed(ib, (t) => call(`/messages/${msgId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` }, retries: 0 }));
    },

    async destroy(ib) {
      if (!ib.auth.accountId) return;
      await authed(ib, (t) =>
        call(`/accounts/${ib.auth.accountId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` }, retries: 0 }),
      );
    },

    async attachment(ib, msgId, att) {
      return authed(ib, (t) => call(att.path, { headers: { Authorization: `Bearer ${t}` }, as: 'buffer' }));
    },
  };
}
