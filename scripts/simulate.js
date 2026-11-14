// End-to-end simulation: drives the real bot with fake Telegram updates (Telegram API calls are intercepted)
// against the real mail providers, plus custom-domain inbound mail and relay/direct sending via a fake worker.
// Usage: node scripts/simulate.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crevio-sim-'));
process.env.BOT_TOKEN ||= '0:simulated';
process.env.TURSO_DATABASE_URL = `file:${path.join(tmp, 'sim.db').replace(/\\/g, '/')}`;
process.env.ADMIN_IDS = '1001';
process.env.PUBLIC_URL = 'https://crevio.test';

// Start from the v1 schema (what long-running production databases have), so migrations and
// inserts are tested against old NOT NULL constraints, not just a fresh schema.
{
  const { createClient } = await import('@libsql/client');
  const v1 = createClient({ url: process.env.TURSO_DATABASE_URL });
  await v1.batch([
    `CREATE TABLE users (id INTEGER PRIMARY KEY, first_name TEXT, username TEXT, active_inbox INTEGER, notify INTEGER NOT NULL DEFAULT 1,
      default_ttl INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
    `CREATE TABLE inboxes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, provider TEXT NOT NULL, address TEXT NOT NULL,
      password TEXT NOT NULL, account_id TEXT, token TEXT, expires_at INTEGER, received INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
    `CREATE TABLE seen (inbox_id INTEGER NOT NULL, msg_id TEXT NOT NULL, PRIMARY KEY (inbox_id, msg_id))`,
  ], 'write');
  v1.close();
}

const store = await import('../src/db.js');
const { createBot } = await import('../src/bot.js');
const { handleInbound, setInboundHandler } = await import('../src/inbound.js');
const { pushMail } = await import('../src/poller.js');
const { publicDomains, provider, markUp } = await import('../src/providers/index.js');
const assert = (await import('node:assert/strict')).default;

await store.migrate();
const bot = createBot();
bot.botInfo = { id: 1, is_bot: true, first_name: 'Crevio Mail Bot', username: 'CrevioMailBot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };

// ── fake Telegram API ─────────────────────────────────────────────────────
let mid = 100;
const calls = [];
bot.api.config.use(async (prev, method, payload) => {
  calls.push({ method, payload });
  // The menu carrier must survive all navigation, or Telegram hides the bottom menu.
  if (method === 'deleteMessage' && payload.message_id === store.getUser(1001)?.anchor_msg) {
    errors++;
    console.error('✗ menu carrier message was deleted');
  }
  const text = payload.text ?? payload.caption ?? payload.media?.caption ?? '';
  const limit = ['sendPhoto', 'editMessageMedia'].includes(method) ? 1024 : 4096;
  assert.ok(text.length <= limit, `${method} text too long (${text.length})`);
  for (const row of payload.reply_markup?.inline_keyboard ?? []) {
    for (const b of row) {
      assert.ok(String(b.text).trim(), 'empty button');
      assert.ok(!/Home/.test(b.text), `inline Home button found: ${b.text}`);
      if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64, `callback too long: ${b.callback_data}`);
    }
  }
  const ok = (result) => ({ ok: true, result });
  const msg = { message_id: ++mid, date: 0, chat: { id: payload.chat_id, type: 'private' }, text };
  if (method === 'sendPhoto') return ok({ ...msg, photo: [{ file_id: `photo${mid}`, file_unique_id: 'u', width: 1200, height: 630 }] });
  if (method === 'sendMessage' || method === 'sendDocument') return ok(msg);
  if (method === 'getFile') return ok({ file_id: 'x', file_unique_id: 'x', file_path: 'x' });
  return ok(true);
});

const user = { id: 1001, is_bot: false, first_name: 'Sam', username: 'sam', language_code: 'en' };
const chat = { id: 1001, type: 'private', first_name: 'Sam' };
let uid = 0;
let errors = 0;
bot.catch((e) => {
  errors++;
  console.error('BOT ERROR', e.error);
});

const PANEL_METHODS = ['sendMessage', 'sendPhoto', 'editMessageText', 'editMessageMedia'];
let cur = null; // current panel
function track() {
  const c = [...calls].reverse().find((x) => PANEL_METHODS.includes(x.method) && x.payload.reply_markup?.inline_keyboard && !/^🛰/.test(x.payload.text || ''));
  if (!c) return cur;
  cur = {
    text: c.payload.text ?? c.payload.caption ?? c.payload.media?.caption,
    kb: c.payload.reply_markup.inline_keyboard.flat(),
    photo: c.method === 'sendPhoto' || c.method === 'editMessageMedia',
    edited: c.method.startsWith('edit'),
  };
  return cur;
}
async function say(text) {
  calls.length = 0;
  const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined;
  await bot.handleUpdate({ update_id: ++uid, message: { message_id: ++mid, date: 0, chat, from: user, text, entities } });
  return track();
}
async function callback(data) {
  calls.length = 0;
  const id = store.getUser(user.id)?.panel_msg ?? 5;
  const message = { message_id: id, date: 0, chat, ...(cur?.photo ? { photo: [{}] } : { text: '…' }) };
  await bot.handleUpdate({ update_id: ++uid, callback_query: { id: String(uid), from: user, chat_instance: 'x', data, message } });
  return track();
}
const btns = () => cur?.kb ?? [];
const find = (re) => {
  const b = btns().find((x) => re.test(x.text));
  assert.ok(b, `no button matching ${re} in [${btns().map((x) => x.text).join(' | ')}]`);
  return b;
};
const tap = (re) => callback(find(re).callback_data);
const step = (name, p = cur) =>
  console.log(`✓ ${name.padEnd(30)} ${(p?.text || '').split('\n')[0].replace(/<[^>]+>/g, '').slice(0, 50)}${p?.photo ? '  🖼' : ''}${p?.edited ? '  ✎' : ''}`);

// ── flows ─────────────────────────────────────────────────────────────────
const t0 = Date.now();
let p = await say('/start');
const anchor = calls.find((c) => c.payload.reply_markup?.keyboard);
assert.ok(anchor, 'main menu keyboard sent');
assert.equal(anchor.payload.text, '📬');
assert.equal(calls.filter((c) => c.payload.reply_markup?.keyboard).length, 1, 'exactly one menu carrier on /start');
const carrierId = store.getUser(user.id).anchor_msg;
assert.ok(carrierId, 'carrier id stored');
assert.deepEqual(anchor.payload.reply_markup.keyboard.flat().map((k) => k.text), ['🏠 Home', '📥 Inbox', '✨ New Mail', '✉️ Compose', '🗂 Addresses', '🌐 Domains', '👤 Profile', '⚙️ Settings', '❔ Help']);
assert.ok(p.photo, 'welcome is a photo card');
step('/start → menu + welcome', p);

const domains = await publicDomains();
const byProvider = Object.groupBy(domains, (d) => d.provider);
console.log(`  domains: ${domains.length} → ${Object.entries(byProvider).map(([k, v]) => `${k}:${v.length}`).join(' ')}`);

p = await tap(/Choose domain/);
step('Choose domain → inline grid', p);
assert.ok(btns().filter((b) => b.text.startsWith('@')).length >= 10);

const created = [];
for (const [pid, list] of Object.entries(byProvider)) {
  p = await say('✨ New Mail');
  const re = new RegExp(`^@${list[0].domain.replace(/\./g, '\\.')}$`);
  if (!btns().some((b) => re.test(b.text))) p = await tap(/Next/);
  const t = Date.now();
  p = await tap(re);
  const ok = /live/.test(p?.text || '') && p.photo;
  console.log(`${ok ? '✓' : '✗'} create on ${pid.padEnd(4)} @${list[0].domain.padEnd(22)} ${Date.now() - t}ms${ok ? '  🖼' : ` ${p?.text?.slice(0, 80)}`}`);
  if (ok) created.push(store.getActiveInbox(store.getUser(user.id)));
}
assert.ok(created.length >= 2, 'at least two providers should work');

// A provider that is blocked (e.g. it bans datacenter IPs) → automatic fallback to another provider.
const blocked = async () => {
  throw Object.assign(new Error('blocked'), { status: 403 });
};
{
  const victim = created[1].provider;
  const prov = provider(victim);
  const orig = prov.create;
  prov.create = blocked;
  const dom0 = byProvider[victim][1] ?? byProvider[victim][0];
  p = await say('✨ New Mail');
  const isDom = (b) => b.text === `@${dom0.domain}`;
  if (!btns().some(isDom)) p = await tap(/Next/);
  p = await callback(btns().find(isDom).callback_data);
  assert.match(p.text, /wasn’t responding/);
  assert.ok(find(/Copy address/).copy_text, 'copy address button');
  step(`${victim} blocked → fallback`, p);
  created.push(store.getActiveInbox(store.getUser(user.id)));

  // Every provider blocked → a clear error that shows the reason.
  const saved = Object.keys(byProvider).map((id) => [provider(id), provider(id).create]);
  for (const [pv] of saved) pv.create = blocked;
  p = await say('✨ New Mail');
  p = await tap(/Instant/);
  assert.match(p.text, /Reason: .*HTTP 403/);
  step('all blocked → reason shown', p);
  for (const [pv, fn] of saved) pv.create = fn;
  prov.create = orig;
  Object.keys(byProvider).forEach(markUp);
}

for (const ib of created) {
  store.setUser(user.id, { active_inbox: ib.id });
  const t = Date.now();
  p = await say('📥 Inbox');
  if (process.env.DEBUG) console.log(calls.map((c) => c.method + ':' + JSON.stringify(c.payload).slice(0, 160)));
  console.log(`✓ inbox ${ib.provider.padEnd(4)} ${String(Date.now() - t).padStart(5)}ms  ${p.text.split('\n')[0].replace(/<[^>]+>/g, '')}`);
}
p = await tap(/Refresh/);
assert.ok(p.edited, 'refresh edits in place');
step('inbox refresh', p);

p = await say('✨ New Mail');
p = await tap(/Custom name/);
step('custom name prompt', p);
p = await say('My.Shop 1');
assert.ok(p.edited, 'prompt panel edited after typing');
assert.match(p.text, /my-shop-1@/);
step('custom name → domain grid', p);
p = await tap(/Cancel/);
step('cancel → home', p);

p = await say('🏠 Home');
step('Home dashboard', p);
p = await tap(/Timer/);
step('timer', p);
p = await tap(/10 min/);
assert.match(p.text, /Self-destructs in/);
step('timer armed', p);

p = await say('👤 Profile');
assert.ok(p.photo && find(/Copy my ID/).copy_text);
step('Profile card', p);
p = await tap(/Settings/);
step('profile → settings', p);
p = await tap(/Notifications/);
assert.ok(btns().some((b) => /OFF/.test(b.text)));
p = await tap(/Notifications/);
p = await tap(/Default timer/);
step('settings toggles', p);

p = await say('🗂 Addresses');
assert.match(p.text, /<b>1\.<\/b> [●○] <code>.+<\/code> ~ <b>/);
assert.equal((p.text.match(/●/g) || []).length, 2, 'one ● in the list plus the legend');
assert.ok(find(/^« 1 »$/));
step('addresses list', p);
p = await tap(/^« 1 »$/);
assert.match(p.text, /Address 1 of/);
step('address detail', p);
p = await tap(/Make active/);
assert.match(p.text, /● <b>active<\/b>/);
step('make active', p);
p = await tap(/Timer/);
p = await tap(/1 hour/);
assert.match(p.text, /Address 1 of/);
assert.match(p.text, /self-destructs in/);
step('per-address timer → back to detail', p);
p = await tap(/All addresses/);

// paging: more than 10 addresses → « n » buttons for 10, then Next ›
for (let i = 0; i < 8; i++) await store.createInbox({ userId: user.id, provider: 'own', address: `bulk${i}@paging.test`, auth: {} });
p = await say('🗂 Addresses'); // opens on the page holding the active address
if (btns().some((b) => b.text === 'Next ›')) p = await tap(/Next/);
else p = await tap(/Prev/);
assert.match(p.text, /page \d of 2/);
step('addresses paging', p);
for (const ib of store.listInboxes(user.id).filter((x) => x.address.endsWith('@paging.test'))) store.deleteInbox(ib.id);

p = await say('✉️ Compose');
assert.match(p.text, /isn’t switched on/);
step('compose (no relay yet)', p);

// ── custom domain as admin → share → becomes relay ───────────────────────
p = await say('🌐 Domains');
p = await tap(/Add my domain/);
p = await say('https://Mail.Crevio-Test.dev/');
step('domain added', p);
assert.ok(find(/TXT value/).copy_text.text.startsWith('crevio-verify='), 'copy TXT value');
const dom = store.findDomain('mail.crevio-test.dev');
store.setDomain(dom.id, { verified: 1 });

const worker = http
  .createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.headers['x-crevio-key'] !== dom.key) return res.writeHead(403).end();
    if (req.url === '/ping') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"canSend":true}');
    worker.last = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"id":"m1"}');
  })
  .listen(0);
store.setDomain(dom.id, { worker_url: `http://127.0.0.1:${worker.address().port}`, can_send: 1 });
p = await tap(/Check again/);
p = await tap(/Share with everyone/);
assert.match(p.text, /send relay/);
step('shared → relay', p);

store.setUser(user.id, { active_inbox: created[0].id });
p = await say('✉️ Compose');
assert.match(p.text, /Replies/);
step('compose via relay', p);
p = await say('friend@example.com');
p = await tap(/No subject/);
p = await say('Hello from a temp address');
step('preview', p);
p = await tap(/Send now/);
step('sent', p);
const local = created[0].address.split('@')[0];
assert.equal(worker.last.from.email, `${local}@mail.crevio-test.dev`);
assert.equal(worker.last.replyTo.email, created[0].address);
console.log(`  relay: From ${worker.last.from.email}  Reply-To ${worker.last.replyTo.email}`);

p = await say('🌐 Domains');
p = await tap(/mail\.crevio-test\.dev/);
p = await tap(/Create address here/);
p = await say('hello');
step('own-domain address', p);
const ownIb = store.findInboxByAddress('hello@mail.crevio-test.dev');
assert.ok(ownIb);

setInboundHandler((ib, id) => pushMail(bot, ib, id));
const server = http.createServer((req, res) => handleInbound(req, res)).listen(0);
const raw = [
  'From: "GitHub" <noreply@github.com>',
  'To: hello@mail.crevio-test.dev',
  'Subject: Your GitHub launch code',
  'Content-Type: multipart/mixed; boundary=XX',
  '',
  '--XX',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Use code <b>482913</b> to sign in.</p><a href="https://github.com/verify?t=1">Verify email</a>',
  '--XX',
  'Content-Type: text/plain; name=note.txt',
  'Content-Disposition: attachment; filename=note.txt',
  '',
  'hello attachment',
  '--XX--',
  '',
].join('\r\n');
const post = (k, to = 'hello@mail.crevio-test.dev') =>
  fetch(`http://127.0.0.1:${server.address().port}/inbound`, { method: 'POST', headers: { 'X-Crevio-Key': k, 'X-Crevio-To': to }, body: raw });
assert.equal((await post('wrong')).status, 403);
assert.equal((await post(dom.key, 'nobody@mail.crevio-test.dev')).status, 404);
calls.length = 0;
assert.equal((await post(dom.key)).status, 200);
await new Promise((r) => setTimeout(r, 300));
const note = calls.find((c) => c.method === 'sendMessage' && /^🛰 <b>New mail/.test(c.payload.text));
assert.ok(note?.payload.reply_markup.inline_keyboard.flat().some((b) => b.copy_text?.text === '482913'), 'push has OTP copy');
console.log('✓ inbound mail → push (copy + open)');

p = await callback(note.payload.reply_markup.inline_keyboard.flat().find((b) => b.callback_data).callback_data);
step('push → Open mail', p);
assert.ok(find(/Copy 482913/).copy_text);
assert.ok(find(/Verify/).url);
assert.ok(find(/Open full email/).web_app);
p = await tap(/Files/);
p = await tap(/note\.txt/);
assert.ok(calls.some((c) => c.method === 'sendDocument'), 'attachment delivered');
console.log('✓ attachment download');
p = await tap(/Back to mail/);
p = await tap(/Reply/);
step('reply prefilled', p);
p = await say('Thanks!');
p = await tap(/Send now/);
assert.equal(worker.last.from.email, 'hello@mail.crevio-test.dev');
console.log(`  direct: From ${worker.last.from.email} → ${worker.last.to}`);

p = await say('📥 Inbox');
p = await tap(/GitHub/);
p = await tap(/Delete/);
assert.match(p.text, /nothing here yet/);
step('delete mail', p);

p = await say('👤 Profile');
assert.match(p.text, /Sent today <b>2/);
step('profile after sends', p);

p = await callback('t:zzzz');
step('expired button → fresh home', p);
p = await say('random text');
step('unknown text → home', p);

p = await say('⚙️ Settings');
p = await tap(/Erase all/);
p = await tap(/Yes, erase/);
step('wipe all', p);
server.close();
worker.close();
await new Promise((r) => setTimeout(r, 1500));

console.log(`\n${errors ? '✗' : '✓'} simulation finished in ${Date.now() - t0}ms with ${errors} bot errors`);
process.exit(errors ? 1 : 0);
