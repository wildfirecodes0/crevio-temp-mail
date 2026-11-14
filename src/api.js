// Crevio developer API: users create keys in the bot and send mail / OTP codes from their own apps.
//   GET  /api/v1/me            account, addresses, today's usage
//   POST /api/v1/send          send an email
//   POST /api/v1/otp/send      generate + email a one-time code
//   POST /api/v1/otp/verify    check a code
// Auth: "Authorization: Bearer crv_live_…" (or "X-API-Key"). Keys are stored as SHA-256 hashes only.
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';
import * as svc from './service.js';
import { UserFacingError } from './service.js';
import { sendMail, sendLimitFor } from './send.js';
import { esc, isEmail } from './utils.js';

export const apiBase = () => `${config.publicUrl || 'https://YOUR-BOT.onrender.com'}/api/v1`;
export const docsUrl = () => (config.publicUrl.startsWith('https://') ? `${config.publicUrl}/docs` : null);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── keys ─────────────────────────────────────────────────────────────────
export async function createKey(userId, name) {
  if (store.userApiKeys(userId).length >= config.apiMaxKeys) throw new UserFacingError('keylimit');
  const secret = `crv_live_${crypto.randomBytes(24).toString('base64url')}`;
  const key = await store.addApiKey({ userId, name: (name || 'Default').slice(0, 40), prefix: secret.slice(0, 14), hash: sha(secret) });
  return { key, secret };
}

// ── per-key rate limit (requests per minute, in memory) ─────────────────
const buckets = new Map();
function rateOk(keyId) {
  const t = Date.now();
  let b = buckets.get(keyId);
  if (!b || t > b.reset) buckets.set(keyId, (b = { n: 0, reset: t + 60_000 }));
  b.n += 1;
  return b.n <= config.apiRatePerMin;
}

// ── http helpers ─────────────────────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const fail = (res, status, code, message) => json(res, status, { ok: false, error: { code, message } });

function readJson(req, max = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('body must be valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function authenticate(req) {
  const h = String(req.headers.authorization || '');
  const token = (h.toLowerCase().startsWith('bearer ') ? h.slice(7) : String(req.headers['x-api-key'] || '')).trim();
  return token ? store.findApiKeyByHash(sha(token)) : null;
}

const toList = (to) => (Array.isArray(to) ? to : String(to || '').split(/[,;\s]+/)).map((s) => String(s).trim()).filter(Boolean);

/** The address mail goes out from: the requested one, else the active one, else any that can send. */
function pickSender(user, from) {
  const all = store.listInboxes(user.id);
  if (from) return all.find((ib) => ib.address.toLowerCase() === String(from).toLowerCase()) ?? 'not_yours';
  const active = store.getActiveInbox(user);
  if (active && svc.sendRoute(active)) return active;
  return all.find((ib) => svc.sendRoute(ib)) ?? (all.length ? all[0] : null);
}

function sendError(res, e) {
  if (e instanceof UserFacingError) {
    const map = {
      nosend: [503, 'sending_disabled', 'Sending is not enabled on this bot yet.'],
      sendlimit: [429, 'daily_limit', 'Daily send limit reached for this account.'],
      banned: [403, 'banned', 'This account is not allowed to send mail.'],
      sendfail: [502, 'delivery_failed', `The mail service refused the message${e.code ? ` (${e.code})` : ''}.`],
    };
    const [status, code, message] = map[e.message] ?? [400, e.message, e.message];
    return fail(res, status, code, message);
  }
  console.error('[api send]', e);
  return fail(res, 500, 'internal', 'Something went wrong.');
}

// ── OTP email ────────────────────────────────────────────────────────────
function otpEmail(app, code, minutes) {
  const spaced = code.split('').join(' ');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5fa;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" style="max-width:440px;background:#ffffff;border-radius:18px;box-shadow:0 8px 30px rgba(20,22,38,.08)">
<tr><td style="padding:28px 28px 8px;font-size:13px;letter-spacing:.14em;color:#8b6cff;font-weight:700">${esc(app.toUpperCase())}</td></tr>
<tr><td style="padding:0 28px;font-size:20px;font-weight:700;color:#141626">Your verification code</td></tr>
<tr><td style="padding:22px 28px"><div style="background:#f1eeff;border-radius:14px;padding:18px;text-align:center;font-size:34px;font-weight:800;letter-spacing:.32em;color:#141626;font-family:ui-monospace,Menlo,Consolas,monospace">${spaced}</div></td></tr>
<tr><td style="padding:0 28px 26px;font-size:14px;line-height:1.6;color:#5d6178">This code expires in <b>${minutes} minute${minutes === 1 ? '' : 's'}</b>. If you didn’t request it, you can ignore this email.</td></tr>
</table>
<div style="padding:16px;font-size:12px;color:#9a9db3">Sent with Crevio Mail</div>
</td></tr></table></body></html>`;
  const text = `${app}\n\nYour verification code: ${code}\nIt expires in ${minutes} minute${minutes === 1 ? '' : 's'}.\nIf you didn't request it, ignore this email.`;
  return { html, text };
}

// ── endpoints ────────────────────────────────────────────────────────────
async function me(res, key, user) {
  const addrs = store.listInboxes(user.id);
  const active = store.getActiveInbox(user);
  json(res, 200, {
    ok: true,
    user: { id: user.id, username: user.username || null },
    key: { name: key.name, prefix: key.prefix },
    addresses: addrs.map((ib) => ({ address: ib.address, active: ib.id === active?.id, can_send: Boolean(svc.sendRoute(ib)) })),
    sending: {
      enabled: addrs.some((ib) => svc.sendRoute(ib)),
      sent_today: await store.sentLast24h(user.id),
      daily_limit: active ? sendLimitFor(user, active) || null : config.sendLimitShared || null,
    },
  });
}

async function send(res, user, body) {
  const to = toList(body.to);
  if (!to.length || to.length > 10 || !to.every(isEmail)) return fail(res, 400, 'invalid_to', '"to" must be 1–10 valid email addresses.');
  if (!body.subject || String(body.subject).length > 200) return fail(res, 400, 'invalid_subject', '"subject" is required (max 200 chars).');
  if (!body.text && !body.html) return fail(res, 400, 'missing_body', 'Provide "text" and/or "html".');
  if (body.reply_to && !isEmail(body.reply_to)) return fail(res, 400, 'invalid_reply_to', '"reply_to" must be an email address.');
  const ib = pickSender(user, body.from);
  if (ib === 'not_yours') return fail(res, 400, 'invalid_from', '"from" must be one of your Crevio addresses.');
  if (!ib) return fail(res, 400, 'no_address', 'Create an address in the bot first.');
  try {
    const r = await sendMail(user, ib, {
      to: to.join(', '),
      subject: String(body.subject),
      text: body.text ? String(body.text).slice(0, 100_000) : '',
      html: body.html ? String(body.html).slice(0, 400_000) : undefined,
      replyTo: body.reply_to,
      fromName: body.from_name ? String(body.from_name).slice(0, 60) : undefined,
    });
    json(res, 200, { ok: true, id: r.id, from: r.from, reply_to: r.replyTo, to: r.to });
  } catch (e) {
    sendError(res, e);
  }
}

async function otpSend(res, key, user, body) {
  const to = String(body.to || '').trim();
  if (!isEmail(to)) return fail(res, 400, 'invalid_to', '"to" must be a valid email address.');
  const length = Math.min(8, Math.max(4, Number(body.length) || 6));
  const ttl = Math.min(3600, Math.max(60, Number(body.ttl) || 600));
  const app = String(body.app_name || user.first_name || 'Crevio').slice(0, 40);
  const ib = pickSender(user, body.from);
  if (ib === 'not_yours') return fail(res, 400, 'invalid_from', '"from" must be one of your Crevio addresses.');
  if (!ib) return fail(res, 400, 'no_address', 'Create an address in the bot first.');

  const code = Array.from({ length }, () => crypto.randomInt(10)).join('');
  const id = `otp_${crypto.randomBytes(12).toString('base64url')}`;
  const minutes = Math.round(ttl / 60);
  const { html, text } = otpEmail(app, code, minutes);
  try {
    await sendMail(user, ib, { to, subject: `${code} is your ${app} verification code`, text, html, fromName: app, replyTo: body.reply_to });
  } catch (e) {
    return sendError(res, e);
  }
  await store.addOtp({ id, userId: user.id, keyId: key.id, to, codeHash: sha(`${id}:${code}`), expiresAt: Date.now() + ttl * 1000 });
  json(res, 200, { ok: true, otp_id: id, to, expires_in: ttl });
}

async function otpVerify(res, user, body) {
  const id = String(body.otp_id || '');
  const code = String(body.code || '').trim();
  if (!id || !code) return fail(res, 400, 'missing_fields', 'Provide "otp_id" and "code".');
  const row = await store.getOtp(id);
  if (!row || Number(row.user_id) !== Number(user.id)) return json(res, 200, { ok: true, valid: false, reason: 'not_found' });
  if (row.expires_at < Date.now()) {
    await store.deleteOtp(id);
    return json(res, 200, { ok: true, valid: false, reason: 'expired' });
  }
  if (row.attempts >= 5) return json(res, 200, { ok: true, valid: false, reason: 'too_many_attempts' });
  const good = Buffer.from(sha(`${id}:${code}`));
  if (!crypto.timingSafeEqual(good, Buffer.from(row.code_hash))) {
    await store.bumpOtpAttempts(id);
    return json(res, 200, { ok: true, valid: false, reason: 'invalid_code', attempts_left: Math.max(0, 4 - row.attempts) });
  }
  await store.deleteOtp(id); // one-time
  json(res, 200, { ok: true, valid: true, to: row.to_addr });
}

const ROUTES = {
  'GET /me': (res, key, user) => me(res, key, user),
  'POST /send': (res, key, user, body) => send(res, user, body),
  'POST /otp/send': (res, key, user, body) => otpSend(res, key, user, body),
  'POST /otp/verify': (res, key, user, body) => otpVerify(res, user, body),
};

export async function handleApi(req, res, pathname) {
  const route = ROUTES[`${req.method} ${pathname.replace(/^\/api\/v1/, '').replace(/\/+$/, '')}`];
  if (!route) return fail(res, 404, 'not_found', 'Unknown endpoint. See /docs.');
  const key = authenticate(req);
  if (!key) return fail(res, 401, 'unauthorized', 'Missing or invalid API key.');
  const user = store.getUser(key.user_id);
  if (!user) return fail(res, 401, 'unauthorized', 'This key’s account no longer exists.');
  if (user.banned) return fail(res, 403, 'banned', 'This account is not allowed to use the API.');
  if (!rateOk(key.id)) return fail(res, 429, 'rate_limited', `Max ${config.apiRatePerMin} requests per minute per key.`);
  let body = {};
  if (req.method === 'POST') {
    try {
      body = await readJson(req);
    } catch (e) {
      return fail(res, e.status || 400, 'bad_request', e.message);
    }
  }
  store.touchApiKey(key);
  return route(res, key, user, body);
}

export function startApiHousekeeping() {
  setInterval(() => store.purgeOtps(), 10 * 60_000).unref();
}

// ── docs page ────────────────────────────────────────────────────────────
export function handleDocs(req, res) {
  const base = apiBase();
  const ex = (s) => `<pre><code>${esc(s)}</code></pre>`;
  const section = (method, path, desc, body, resp) =>
    `<section><h2><span class="m ${method.toLowerCase()}">${method}</span> ${path}</h2><p>${desc}</p>${body ? ex(body) : ''}${resp ? `<p class="lbl">Response</p>${ex(resp)}` : ''}</section>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crevio Mail API</title>
<style>
:root{--bg:#0b0c14;--card:#141626;--fg:#eef0f8;--muted:#8c90ad;--violet:#8b6cff;--cyan:#3ee6d2;--line:rgba(255,255,255,.08)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 Inter,system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 18px 80px}
.brand{font-weight:800;letter-spacing:.24em;font-size:12px;color:var(--violet)}
h1{font-size:34px;margin:8px 0 6px;letter-spacing:-.02em}h1 b{color:var(--cyan)}
.lead{color:var(--muted);margin:0 0 28px}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px;margin:16px 0}
h2{font-size:17px;margin:0 0 6px;font-family:ui-monospace,Menlo,Consolas,monospace}
.m{display:inline-block;font-size:12px;padding:2px 8px;border-radius:6px;margin-right:6px;color:#0b0c14;font-weight:800}
.m.get{background:var(--cyan)}.m.post{background:var(--violet)}
p{margin:6px 0;color:#c9ccdc}.lbl{color:var(--muted);font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin-top:12px}
pre{background:#0d0f19;border:1px solid var(--line);border-radius:12px;padding:14px;overflow:auto;font-size:13px;margin:8px 0}
code{font-family:ui-monospace,Menlo,Consolas,monospace;color:#d8dbff}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 0;border-bottom:1px solid var(--line);vertical-align:top}td:first-child{color:var(--cyan);font-family:ui-monospace,monospace;width:38%}
</style></head><body><main>
<div class="brand">✦ CREVIO MAIL</div>
<h1>Send mail &amp; OTPs <b>from your app</b></h1>
<p class="lead">Create an API key in the bot (🔑 API), then call these endpoints from your <b>server</b>. Never put the key in browser or app code.</p>
<section><h2>Base URL</h2>${ex(base)}<p>Authenticate every request with <code>Authorization: Bearer crv_live_…</code></p>
<table><tr><td>Rate limit</td><td>${config.apiRatePerMin} requests / minute / key</td></tr>
<tr><td>Daily sends</td><td>${config.sendLimitShared ? `${config.sendLimitShared} per account through the shared relay (no limit on your own domain)` : 'no daily limit'}</td></tr>
<tr><td>Errors</td><td><code>{"ok":false,"error":{"code","message"}}</code> with a matching HTTP status</td></tr></table></section>
${section('POST', '/send', 'Send an email from one of your Crevio addresses (your active address if <code>from</code> is omitted).',
  `curl -X POST ${base}/send \\
  -H "Authorization: Bearer $CREVIO_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"user@example.com","subject":"Welcome!","html":"<h1>Hi</h1>","text":"Hi"}'`,
  '{"ok":true,"id":"…","from":"you@relay.dev","reply_to":"you@lnovic.com","to":["user@example.com"]}')}
<section><table>
<tr><td>to</td><td>string or array, 1–10 addresses</td></tr><tr><td>subject</td><td>required, max 200 chars</td></tr>
<tr><td>text / html</td><td>at least one</td></tr><tr><td>from</td><td>optional, one of your addresses</td></tr>
<tr><td>from_name</td><td>optional display name</td></tr><tr><td>reply_to</td><td>optional email</td></tr></table></section>
${section('POST', '/otp/send', 'Generate a one-time code and email it in a clean branded template. Store the returned <code>otp_id</code>.',
  `curl -X POST ${base}/otp/send \\
  -H "Authorization: Bearer $CREVIO_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"user@example.com","app_name":"MyApp","length":6,"ttl":600}'`,
  '{"ok":true,"otp_id":"otp_…","to":"user@example.com","expires_in":600}')}
${section('POST', '/otp/verify', 'Check the code the user typed. Codes are single-use and allow 5 attempts.',
  `curl -X POST ${base}/otp/verify \\
  -H "Authorization: Bearer $CREVIO_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"otp_id":"otp_…","code":"482913"}'`,
  '{"ok":true,"valid":true,"to":"user@example.com"}\n{"ok":true,"valid":false,"reason":"invalid_code","attempts_left":3}')}
${section('GET', '/me', 'Your account, addresses and today’s usage.', `curl ${base}/me -H "Authorization: Bearer $CREVIO_KEY"`, null)}
<section><h2>Node.js</h2>${ex(`const r = await fetch("${base}/otp/send", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.CREVIO_KEY}\`, "Content-Type": "application/json" },
  body: JSON.stringify({ to: "user@example.com", app_name: "MyApp" }),
});
const { otp_id } = await r.json();`)}</section>
<section><h2>Python</h2>${ex(`import requests, os
r = requests.post("${base}/otp/verify",
    headers={"Authorization": f"Bearer {os.environ['CREVIO_KEY']}"},
    json={"otp_id": otp_id, "code": code})
print(r.json()["valid"])`)}</section>
</main></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  res.end(html);
}
