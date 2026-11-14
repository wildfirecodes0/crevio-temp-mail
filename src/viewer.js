// Full-email viewer served as a Telegram Mini App. Links are HMAC-signed and expire.
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';
import { getMessage } from './service.js';
import { esc, escAttr, fmtDate, fmtSize } from './utils.js';

const TTL = 6 * 3600; // seconds a viewer link stays valid

const sig = (payload) => crypto.createHmac('sha256', config.signingKey).update(payload).digest('base64url').slice(0, 27);

export function viewerUrl(inboxId, msgId) {
  if (!config.publicUrl.startsWith('https://')) return null;
  const payload = `${inboxId}.${msgId}.${Math.floor(Date.now() / 1000) + TTL}`;
  return `${config.publicUrl}/v/${payload}.${sig(payload)}`;
}

function verify(token) {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [inboxId, msgId, exp, s] = parts;
  const payload = `${inboxId}.${msgId}.${exp}`;
  const good = Buffer.from(sig(payload));
  const given = Buffer.from(s);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  if (!/^\d+$/.test(inboxId) || !/^[\w-]{1,64}$/.test(msgId)) return null;
  return { inboxId: Number(inboxId), msgId };
}

function send(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https: data: cid:; frame-src 'self' about:; base-uri 'none'; form-action 'none'",
  });
  res.end(html);
}

export async function handleViewer(req, res, token) {
  const v = verify(token);
  if (!v) return send(res, 403, shell('Link expired', '<div class="empty">This link has expired.<br>Open the mail again from the bot.</div>'));
  const ib = store.getInbox(v.inboxId);
  if (!ib) return send(res, 404, shell('Gone', '<div class="empty">This address no longer exists.</div>'));
  let msg;
  try {
    msg = await getMessage(ib, v.msgId);
  } catch (e) {
    return send(res, e.status === 404 ? 404 : 502, shell('Unavailable', '<div class="empty">Couldn’t load this mail right now.</div>'));
  }

  const html = Array.isArray(msg.html) ? msg.html.join('\n') : msg.html || '';
  const doc = html
    ? `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:12px;font-family:system-ui,sans-serif;word-wrap:break-word;background:#fff;color:#111}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`
    : `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font:15px/1.55 system-ui,sans-serif;white-space:pre-wrap;word-wrap:break-word;color:#111;background:#fff}</style></head><body>${esc(msg.text || '(empty)')}</body></html>`;

  const att = (msg.attachments || [])
    .map((a) => `<span class="chip">📎 ${esc(a.filename || 'file')} · ${fmtSize(a.size)}</span>`)
    .join('');

  const body = `
    <header>
      <div class="brand">✦ CREVIO</div>
      <h1>${esc(msg.subject || '(no subject)')}</h1>
      <div class="meta">
        <div><span>From</span> ${esc(msg.from?.name || '')} <em>${esc(msg.from?.address || '')}</em></div>
        <div><span>To</span> ${esc(ib.address)}</div>
        <div><span>Date</span> ${esc(fmtDate(msg.createdAt))}</div>
      </div>
      ${att ? `<div class="chips">${att}</div>` : ''}
    </header>
    <main><iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${escAttr(doc)}" title="email"></iframe></main>`;
  send(res, 200, shell(msg.subject || 'Mail', body));
}

function shell(title, inner) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)} · Crevio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root{
    --bg:var(--tg-theme-bg-color,#0e0f13);--fg:var(--tg-theme-text-color,#eef0f6);
    --muted:var(--tg-theme-hint-color,#8a90a2);--card:var(--tg-theme-secondary-bg-color,#171922);
    --accent:var(--tg-theme-button-color,#7c5cff);
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:Inter,system-ui,sans-serif}
  body{display:flex;flex-direction:column}
  header{padding:18px 16px 14px;background:linear-gradient(160deg,color-mix(in srgb,var(--accent) 22%,var(--card)),var(--card));border-bottom:1px solid color-mix(in srgb,var(--fg) 8%,transparent)}
  .brand{font:700 11px/1 'Space Grotesk',sans-serif;letter-spacing:.22em;color:var(--accent);margin-bottom:10px}
  h1{font:700 19px/1.3 'Space Grotesk',sans-serif;margin:0 0 12px;word-break:break-word}
  .meta{display:grid;gap:4px;font-size:13px}
  .meta span{display:inline-block;width:44px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
  .meta em{color:var(--muted);font-style:normal}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
  .chip{font-size:12px;padding:5px 9px;border-radius:999px;background:color-mix(in srgb,var(--fg) 8%,transparent)}
  main{flex:1;padding:12px;min-height:0}
  iframe{width:100%;height:100%;min-height:70vh;border:0;border-radius:14px;background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.18)}
  .empty{margin:auto;padding:40px 24px;text-align:center;color:var(--muted);line-height:1.6}
</style></head>
<body>${inner}
<script>try{const t=Telegram.WebApp;t.ready();t.expand();t.setHeaderColor&&t.setHeaderColor('secondary_bg_color')}catch(e){}</script>
</body></html>`;
}
