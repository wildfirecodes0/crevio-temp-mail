// Guerrilla Mail public API. One mailbox name works across all of its domains.
// Note: Guerrilla keeps mail for ~1 hour, and sessions expire when idle, so we re-claim the name as needed.
import { request } from './http.js';
import { decodeEntities } from '../utils.js';

const BASE = 'https://api.guerrillamail.com/ajax.php';
const DOMAINS = [
  'sharklasers.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz',
  'guerrillamail.de', 'grr.la', 'guerrillamailblock.com', 'pokemail.net', 'spam4.me',
];

const call = (params) =>
  request(`${BASE}?${new URLSearchParams({ lang: 'en', ...params })}`, { label: 'guerrillamail', retries: 1 });

async function claim(auth, local) {
  if (!auth.sid) auth.sid = (await call({ f: 'get_email_address' })).sid_token;
  const r = await call({ f: 'set_email_user', email_user: local, sid_token: auth.sid });
  auth.sid = r.sid_token || auth.sid;
  auth._dirty = true;
  return r;
}

const isWelcome = (m) => m.mail_from === 'no-reply@guerrillamail.com' && /^Welcome to Guerrilla Mail/.test(m.mail_subject || '');
const local = (ib) => ib.address.split('@')[0];

const norm = (m) => ({
  id: String(m.mail_id),
  from: { name: '', address: m.mail_from || '' },
  subject: decodeEntities(m.mail_subject || ''),
  intro: decodeEntities(m.mail_excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 140),
  createdAt: Number(m.mail_timestamp) ? Number(m.mail_timestamp) * 1000 : Date.now(),
  hasAttachments: Number(m.att) > 0,
});

export const guerrilla = {
  id: 'gm',
  label: 'guerrillamail',
  caps: { attachments: false, delete: true },

  async domains() {
    return DOMAINS;
  },

  async create(name, domain) {
    const auth = {};
    const r = await claim(auth, name);
    if (r.email_addr?.split('@')[0]?.toLowerCase() !== name.toLowerCase()) {
      const e = new Error('name taken');
      e.taken = true;
      throw e;
    }
    delete auth._dirty;
    return { address: `${name}@${domain}`, auth };
  },

  async list(ib) {
    let r = await call({ f: 'get_email_list', offset: 0, sid_token: ib.auth.sid || '' });
    if (!r?.email || r.email.split('@')[0] !== local(ib)) {
      await claim(ib.auth, local(ib));
      r = await call({ f: 'get_email_list', offset: 0, sid_token: ib.auth.sid });
    }
    if (r?.sid_token && r.sid_token !== ib.auth.sid) {
      ib.auth.sid = r.sid_token;
      ib.auth._dirty = true;
    }
    return (r?.list || []).filter((m) => !isWelcome(m)).map(norm);
  },

  async get(ib, msgId) {
    let m = await call({ f: 'fetch_email', email_id: msgId, sid_token: ib.auth.sid || '' });
    if (!m || m === false || !m.mail_id) {
      await claim(ib.auth, local(ib));
      m = await call({ f: 'fetch_email', email_id: msgId, sid_token: ib.auth.sid });
    }
    if (!m?.mail_id) throw Object.assign(new Error('not found'), { status: 404 });
    const body = m.mail_body || '';
    const isHtml = /<\w+[^>]*>/.test(body);
    return { ...norm(m), text: isHtml ? '' : body, html: isHtml ? body : '', attachments: [] };
  },

  async remove(ib, msgId) {
    await request(`${BASE}?${new URLSearchParams({ f: 'del_email', sid_token: ib.auth.sid || '', 'email_ids[]': msgId })}`, {
      label: 'guerrillamail',
      retries: 0,
    });
  },

  async destroy(ib) {
    if (ib.auth.sid) await call({ f: 'forget_me', email_addr: ib.address, sid_token: ib.auth.sid }).catch(() => {});
  },
};
