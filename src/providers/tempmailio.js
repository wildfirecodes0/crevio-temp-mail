// temp-mail.io public API — several fresh domains, token-based mailbox.
import { request, parseAddress } from './http.js';

const BASE = 'https://api.internal.temp-mail.io/api/v3';
const call = (path, opts = {}) => request(BASE + path, { label: 'temp-mail.io', ...opts });

const norm = (m) => {
  const text = m.body_text || '';
  return {
    id: String(m.id),
    from: parseAddress(m.from),
    subject: m.subject || '',
    intro: text.replace(/\s+/g, ' ').trim().slice(0, 140),
    createdAt: m.created_at,
    hasAttachments: Boolean(m.attachments?.length),
    text,
    html: m.body_html || '',
    attachments: (m.attachments || []).map((a, i) => ({
      id: String(i),
      filename: a.name || a.filename || `file-${i + 1}`,
      size: a.size || 0,
      contentType: a.content_type || a.type || 'application/octet-stream',
    })),
  };
};

export const tempmailio = {
  id: 'tio',
  label: 'temp-mail.io',
  caps: { attachments: false, delete: false },

  async domains() {
    const r = await call('/domains', { retries: 1 });
    return (r?.domains || []).filter((d) => d.type === 'public').map((d) => d.name);
  },

  async create(local, domain) {
    try {
      const r = await call('/email/new', { method: 'POST', body: { name: local, domain }, retries: 1 });
      if (!r?.email) throw Object.assign(new Error('temp-mail.io: no email returned'), { status: 502 });
      // temp-mail.io silently drops dashes ("nova-kite" → "novakite"); anything else means the name was taken.
      if (r.email.toLowerCase() !== `${local.replace(/-/g, '')}@${domain}`.toLowerCase()) {
        const e = new Error('name taken');
        e.taken = true;
        throw e;
      }
      return { address: r.email, auth: { token: r.token } };
    } catch (e) {
      if (e.status === 400 || e.status === 409 || e.status === 422) e.taken = true;
      throw e;
    }
  },

  async list(ib) {
    const r = await call(`/email/${encodeURIComponent(ib.address).replace("%40", "@")}/messages`);
    return (Array.isArray(r) ? r : []).map(norm).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  async get(ib, msgId) {
    try {
      return norm(await call(`/message/${encodeURIComponent(msgId)}`, { retries: 1 }));
    } catch {
      const hit = (await this.list(ib)).find((m) => m.id === msgId);
      if (!hit) throw Object.assign(new Error('not found'), { status: 404 });
      return hit;
    }
  },

  async destroy(ib) {
    await call(`/email/${encodeURIComponent(ib.address).replace("%40", "@")}`, { method: 'DELETE', body: { token: ib.auth.token }, retries: 0 });
  },
};
