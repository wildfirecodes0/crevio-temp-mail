// Custom domains: mail arrives via the Cloudflare Email Worker → POST /inbound and is stored in Turso.
import * as store from '../db.js';

export const own = {
  id: 'own',
  label: 'custom domain',
  caps: { attachments: true, delete: true },

  async domains() {
    return []; // per-user; resolved in providers/index.js
  },

  async create(local, domain) {
    const address = `${local}@${domain}`.toLowerCase();
    if (store.findInboxByAddress(address)) {
      const e = new Error('taken');
      e.taken = true;
      throw e;
    }
    return { address, auth: {} };
  },

  list: (ib) => store.listMails(ib.id),

  async get(ib, id) {
    const m = await store.getMail(ib.id, id);
    if (!m) throw Object.assign(new Error('not found'), { status: 404 });
    return m;
  },

  remove: (ib, id) => store.deleteMail(ib.id, id),

  async destroy() {},

  async attachment(ib, msgId, att) {
    const buf = await store.getMailAttachment(msgId, Number(att.id));
    if (!buf) throw Object.assign(new Error('attachment not stored'), { status: 404 });
    return buf;
  },
};
