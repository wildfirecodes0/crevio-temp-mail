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

const store = await import('../src/db.js');
const { createBot } = await import('../src/bot.js');
const { handleInbound, setInboundHandler } = await import('../src/inbound.js');
const { pushMail } = await import('../src/poller.js');
const { publicDomains } = await import('../src/providers/index.js');
const assert = (await import('node:assert/strict')).default;

await store.migrate();
const bot = createBot();
bot.botInfo = { id: 1, is_bot: true, first_name: 'Crevio', username: 'crevio_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };

// ── fake Telegram API ─────────────────────────────────────────────────────
let mid = 100;
const calls = [];
bot.api.config.use(async (prev, method, payload) => {
  calls.push({ method, payload });
  const text = payload.text ?? payload.caption ?? '';
  const limit = method === 'sendPhoto' ? 1024 : 4096;
  assert.ok(text.length <= limit, `${method} text too long (${text.length})`);
  for (const row of payload.reply_markup?.keyboard ?? []) for (const b of row) assert.ok(String(b.text).trim(), 'empty key');
  for (const row of payload.reply_markup?.inline_keyboard ?? []) {
    for (const b of row) if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64, `callback too long: ${b.callback_data}`);
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

const panel = () => [...calls].reverse().find((c) => ['sendMessage', 'sendPhoto'].includes(c.method) && c.payload.reply_markup?.keyboard);
async function say(text) {
  calls.length = 0;
  const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined;
  await bot.handleUpdate({ update_id: ++uid, message: { message_id: ++mid, date: 0, chat, from: user, text, entities } });
  const p = panel();
  return p ? { ...p.payload, text: p.payload.text ?? p.payload.caption, photo: p.method === 'sendPhoto' } : null;
}
async function callback(data) {
  calls.length = 0;
  await bot.handleUpdate({ update_id: ++uid, callback_query: { id: String(uid), from: user, chat_instance: 'x', data, message: { message_id: 5, date: 0, chat, text: '…' } } });
  const p = panel();
  return p ? { ...p.payload, text: p.payload.text ?? p.payload.caption } : null;
}
const keys = (p) => (p?.reply_markup?.keyboard ?? []).flat().map((b) => b.text);
const key = (p, re) => {
  const k = keys(p).find((t) => re.test(t));
  assert.ok(k, `no key matching ${re} in [${keys(p).join(' | ')}]`);
  return k;
};
const step = (name, p) => console.log(`✓ ${name.padEnd(30)} ${(p?.text || '').split('\n')[0].replace(/<[^>]+>/g, '').slice(0, 56)}${p?.photo ? '  🖼' : ''}`);

// ── flows ─────────────────────────────────────────────────────────────────
const t0 = Date.now();
let p = await say('/start');
assert.ok(p.photo, 'welcome is a photo card');
assert.ok(!calls.some((c) => c.payload.reply_markup?.inline_keyboard), 'no inline keyboards on screens');
step('/start → welcome card', p);

const domains = await publicDomains();
const byProvider = Object.groupBy(domains, (d) => d.provider);
console.log(`  domains: ${domains.length} → ${Object.entries(byProvider).map(([k, v]) => `${k}:${v.length}`).join(' ')}`);

p = await say(key(p, /Choose domain/));
step('Choose domain → picker', p);
assert.ok(keys(p).filter((k) => k.startsWith('@')).length >= 5);

const created = [];
for (const [pid, list] of Object.entries(byProvider)) {
  p = await say('✨ New Mail');
  const t = Date.now();
  p = await say(key(p, new RegExp(`^@${list[0].domain.replace(/\./g, '\\.')}$`)));
  const ok = /live/.test(p?.text || '') && p.photo;
  console.log(`${ok ? '✓' : '✗'} create on ${pid.padEnd(4)} @${list[0].domain.padEnd(22)} ${Date.now() - t}ms${ok ? '  🖼' : ` ${p?.text?.slice(0, 80)}`}`);
  if (ok) created.push(store.getActiveInbox(store.getUser(user.id)));
}
assert.ok(created.length >= 2, 'at least two providers should work');

for (const ib of created) {
  store.setUser(user.id, { active_inbox: ib.id });
  const t = Date.now();
  p = await say('📥 Inbox');
  console.log(`✓ inbox ${ib.provider.padEnd(4)} ${String(Date.now() - t).padStart(5)}ms  ${p.text.split('\n')[0].replace(/<[^>]+>/g, '')}`);
}

p = await say('✨ New Mail');
p = await say('✍️ Custom name');
step('custom name prompt', p);
p = await say('My.Shop 1');
step('custom name → picker', p);
assert.match(p.text, /my-shop-1@/);
p = await say('✖ Cancel');
step('cancel → home', p);
assert.ok(keys(p).some((k) => k.startsWith('📥 Inbox')));

p = await say('👤 Profile');
assert.ok(p.photo, 'profile is a photo card');
step('Profile card', p);

p = await say('🗂 Addresses');
step('Addresses', p);
p = await say(key(p, /^○ /));
step('switch address', p);
p = await say('💣 Timer');
step('Timer', p);
p = await say(key(p, /10 min/));
assert.match(p.text, /Self-destructs in/);
step('timer armed', p);
p = await say('⚙️ Settings');
p = await say(key(p, /Notifications/));
assert.ok(keys(p).some((k) => /OFF/.test(k)));
p = await say(key(p, /Notifications/));
p = await say(key(p, /Default timer/));
step('settings toggled', p);

p = await say('✉️ Compose');
step('compose (no relay yet)', p);
assert.match(p.text, /isn’t switched on/);

// ── custom domain as admin → share → becomes relay ───────────────────────
p = await say('🌐 Domains');
step('Domains', p);
p = await say('➕ Add my domain');
p = await say('https://Mail.Crevio-Test.dev/');
step('domain added', p);
const dom = store.findDomain('mail.crevio-test.dev');
store.setDomain(dom.id, { verified: 1 }); // pretend the TXT record exists

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
p = await say('🌐 Domains');
p = await say(key(p, /mail\.crevio-test\.dev/));
p = await say(key(p, /worker URL/));
calls.length = 0;
const fakeWorkerUrl = `http://127.0.0.1:${worker.address().port}`;
// the bot requires https for user input; set directly as if pinged
store.setDomain(dom.id, { worker_url: fakeWorkerUrl, can_send: 1 });
p = await say('✖ Cancel');
step('domain manage', p);
p = await say(key(p, /Share with everyone/));
assert.match(p.text, /send relay/);
step('shared → relay', p);

// relay send from a public temp address
store.setUser(user.id, { active_inbox: created[0].id });
p = await say('✉️ Compose');
step('compose via relay', p);
assert.match(p.text, /Replies/);
p = await say('friend@example.com');
p = await say('⏭ No subject');
p = await say('Hello from a temp address');
step('preview', p);
p = await say('🚀 Send now');
step('sent', p);
const local = created[0].address.split('@')[0];
assert.equal(worker.last.from.email, `${local}@mail.crevio-test.dev`);
assert.equal(worker.last.replyTo.email, created[0].address);
console.log(`  relay: From ${worker.last.from.email}  Reply-To ${worker.last.replyTo.email}`);

// own-domain address + inbound mail
p = await say('🌐 Domains');
p = await say(key(p, /mail\.crevio-test\.dev/));
p = await say('✨ Address on this domain');
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
const note = calls.find((c) => c.method === 'sendMessage' && /New mail/.test(c.payload.text));
assert.ok(note?.payload.reply_markup.inline_keyboard.flat().some((b) => b.copy_text?.text === '482913'), 'push has OTP copy');
console.log('✓ inbound mail → push (inline copy + open)');

p = await callback(note.payload.reply_markup.inline_keyboard.flat().find((b) => b.callback_data).callback_data);
step('push → Open mail', p);
assert.match(p.text, /482913/);
assert.match(p.text, /href="https:\/\/github.com\/verify/);
assert.ok(keys(p).includes('🖥 Open full email'));
p = await say(key(p, /Attachments/));
p = await say(key(p, /note\.txt/));
assert.ok(calls.some((c) => c.method === 'sendDocument'), 'attachment delivered');
console.log('✓ attachment download');
p = await say('‹ Back to mail');
p = await say('↩️ Reply');
step('reply prefilled', p);
p = await say('Thanks!');
p = await say('🚀 Send now');
assert.equal(worker.last.from.email, 'hello@mail.crevio-test.dev');
assert.equal(worker.last.replyTo, undefined);
console.log(`  direct: From ${worker.last.from.email} → ${worker.last.to}`);

p = await say('📥 Inbox');
p = await say(key(p, /GitHub/));
p = await say('🗑 Delete mail');
assert.match(p.text, /nothing here yet/);
step('delete mail', p);

p = await say('👤 Profile');
assert.match(p.text, /Sent today <b>2/);
step('profile after sends', p);

p = await say('/stats');
p = await say('random text');
step('unknown text → home', p);

p = await say('⚙️ Settings');
p = await say('🧨 Erase all my data');
p = await say('🧨 Yes, erase everything');
step('wipe all', p);
server.close();
worker.close();
await new Promise((r) => setTimeout(r, 1500));

console.log(`\n${errors ? '✗' : '✓'} simulation finished in ${Date.now() - t0}ms with ${errors} bot errors`);
process.exit(errors ? 1 : 0);
