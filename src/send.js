// Outbound mail through the domain owner's own Cloudflare Worker (no third-party ESP).
import { config } from './config.js';
import * as store from './db.js';
import { request } from './providers/http.js';
import { esc } from './utils.js';
import { UserFacingError } from './service.js';

export function sendLimitFor(user, ib) {
  const d = store.findDomain(ib.address.split('@')[1]);
  return d && Number(d.owner_id) === Number(user.id) ? config.sendLimitOwn : config.sendLimitShared;
}

const textToHtml = (t) =>
  `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#111">${esc(t)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`)
    .join('')}</div>`;

/**
 * @param {object} user
 * @param {object} ib  sending inbox (custom domain)
 * @param {{to:string, subject:string, text:string, inReplyTo?:string, attachments?:{filename:string,type:string,content:string}[]}} draft
 */
export async function sendMail(user, ib, draft) {
  const d = store.findDomain(ib.address.split('@')[1]);
  if (!d?.verified || !d.worker_url) throw new UserFacingError('nosend');
  if (user.banned) throw new UserFacingError('banned');

  const limit = sendLimitFor(user, ib);
  if (limit && (await store.sentLast24h(user.id)) >= limit) throw new UserFacingError('sendlimit');

  const payload = {
    from: { email: ib.address, name: user.first_name || ib.address.split('@')[0] },
    to: draft.to,
    subject: draft.subject || '(no subject)',
    text: draft.text,
    html: textToHtml(draft.text),
    ...(draft.inReplyTo ? { headers: { 'In-Reply-To': draft.inReplyTo, References: draft.inReplyTo } } : {}),
    ...(draft.attachments?.length
      ? { attachments: draft.attachments.map((a) => ({ content: a.content, filename: a.filename, type: a.type, disposition: 'attachment' })) }
      : {}),
  };

  let r;
  try {
    r = await request(`${d.worker_url.replace(/\/+$/, '')}/send`, {
      method: 'POST',
      headers: { 'X-Crevio-Key': d.key },
      body: payload,
      retries: 0,
      timeout: 30_000,
      label: 'worker',
    });
  } catch (e) {
    let code = '';
    try {
      code = JSON.parse(e.body || '{}').code || '';
    } catch {}
    const err = new UserFacingError('sendfail');
    err.code = code || (e.status === 403 ? 'KEY_MISMATCH' : `HTTP_${e.status || 0}`);
    throw err;
  }
  store.logSent(user.id, ib.id, draft.to, payload.subject);
  store.noteSent(user.id);
  return r;
}
