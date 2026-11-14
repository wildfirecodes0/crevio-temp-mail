// Outbound mail through a Cloudflare Worker (no third-party ESP).
//  direct: from the user's own custom-domain address
//  relay:  any other address → sent as local@<shared relay domain>, Reply-To = the user's address
import { config } from './config.js';
import * as store from './db.js';
import { request } from './providers/http.js';
import { esc } from './utils.js';
import { UserFacingError, sendRoute } from './service.js';

export function sendLimitFor(user, ib) {
  const route = sendRoute(ib);
  if (route?.mode === 'direct' && Number(route.domain.owner_id) === Number(user.id)) return config.sendLimitOwn;
  return config.sendLimitShared;
}

/** Sender identity shown to recipients. */
export function senderFor(ib, route = sendRoute(ib)) {
  if (!route) return null;
  if (route.mode === 'direct') return { email: ib.address, replyTo: null };
  const local = ib.address.split('@')[0].replace(/[^a-z0-9._-]/gi, '').slice(0, 40) || 'crevio';
  return { email: `${local}@${route.domain.domain}`, replyTo: ib.address };
}

const textToHtml = (t) =>
  `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#111">${esc(t)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`)
    .join('')}</div>`;

/**
 * @param {object} user
 * @param {object} ib  the user's address the mail is "from"
 * @param {{to:string, subject:string, text:string, inReplyTo?:string, attachments?:{filename:string,type:string,content:string}[]}} draft
 */
export async function sendMail(user, ib, draft) {
  const route = sendRoute(ib);
  if (!route) throw new UserFacingError('nosend');
  if (user.banned) throw new UserFacingError('banned');

  const limit = sendLimitFor(user, ib);
  if (limit && (await store.sentLast24h(user.id)) >= limit) throw new UserFacingError('sendlimit');

  const sender = senderFor(ib, route);
  const name = (user.first_name || ib.address.split('@')[0]).slice(0, 60);
  const payload = {
    from: { email: sender.email, name },
    to: draft.to.split(/,\s*/),
    subject: draft.subject || '(no subject)',
    text: draft.text,
    html: textToHtml(draft.text),
    ...(sender.replyTo ? { replyTo: { email: sender.replyTo, name } } : {}),
    ...(draft.inReplyTo ? { headers: { 'In-Reply-To': draft.inReplyTo, References: draft.inReplyTo } } : {}),
    ...(draft.attachments?.length
      ? { attachments: draft.attachments.map((a) => ({ content: a.content, filename: a.filename, type: a.type, disposition: 'attachment' })) }
      : {}),
  };

  const d = route.domain;
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
