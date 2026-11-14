// Receives raw MIME from a domain's Cloudflare Email Worker and delivers it instantly.
import crypto from 'node:crypto';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import * as store from './db.js';
import { primeMessage, invalidate } from './service.js';

let onMail = async () => {};
export const setInboundHandler = (fn) => (onMail = fn);

const sameKey = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const reply = (res, status, msg) => res.writeHead(status, { 'Content-Type': 'text/plain' }).end(msg);

export async function handleInbound(req, res) {
  const to = String(req.headers['x-crevio-to'] || '').trim().toLowerCase();
  const domainName = to.split('@')[1];
  const d = domainName && store.findDomain(domainName);
  if (!d || !sameKey(req.headers['x-crevio-key'], d.key)) return reply(res, 403, 'forbidden');
  if (!d.verified) return reply(res, 404, 'domain not verified');

  let raw;
  try {
    raw = await readBody(req, config.inboundMaxBytes);
  } catch (e) {
    return reply(res, e.status || 400, e.message);
  }

  const ib = store.findInboxByAddress(to);
  if (!ib) return reply(res, 404, 'no such mailbox');

  const parsed = await simpleParser(raw, { skipImageLinks: true });
  const from = parsed.from?.value?.[0] || { name: '', address: String(req.headers['x-crevio-from'] || '') };
  const text = parsed.text || '';
  const mail = {
    id: crypto.randomBytes(12).toString('hex'),
    inboxId: ib.id,
    from: { name: from.name || '', address: from.address || '' },
    subject: parsed.subject || '',
    intro: text.replace(/\s+/g, ' ').trim().slice(0, 140),
    text,
    html: parsed.html || '',
    createdAt: (parsed.date || new Date()).getTime() || Date.now(),
    attachments: (parsed.attachments || [])
      .filter((a) => a.contentDisposition !== 'inline' || !a.related)
      .slice(0, 10)
      .map((a, i) => ({
        id: String(i),
        filename: a.filename || `file-${i + 1}`,
        size: a.size || a.content?.length || 0,
        contentType: a.contentType,
        data: a.content?.length <= 8 * 1024 * 1024 ? a.content : null,
      })),
  };
  await store.saveMail(mail);
  invalidate(ib.id);
  const { inboxId: _i, ...view } = mail;
  primeMessage(ib, { ...view, attachments: mail.attachments.map(({ data: _d, ...a }) => a), hasAttachments: mail.attachments.length > 0 });
  await store.markSeen(ib.id, [mail.id]);
  reply(res, 200, 'ok');
  onMail(ib, mail.id).catch((e) => console.error('[inbound push]', e));
}
