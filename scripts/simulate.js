// End-to-end simulation: drives the real bot with fake Telegram updates (Telegram API calls are intercepted)
// against the real mail providers, plus a custom-domain inbound delivery. Usage: node scripts/simulate.js
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
  assert.ok(text.length <= 4096, `${method} text too long (${text.length})`);
  for (const row of payload.reply_markup?.inline_keyboard ?? []) {
    for (const b of row) {
      assert.ok(String(b.text).trim(), 'empty button text');
      if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64, `callback too long: ${b.callback_data}`);
    }
  }
  const ok = (result) => ({ ok: true, result });
  if (method === 'sendMessage' || method === 'sendDocument') return ok({ message_id: ++mid, date: 0, chat: { id: payload.chat_id, type: 'private' }, text });
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

const lastPanel = () => [...calls].reverse().find((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
async function say(text) {
  calls.length = 0;
  const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined;
  await bot.handleUpdate({ update_id: ++uid, message: { message_id: ++mid, date: 0, chat, from: user, text, entities } });
  return lastPanel()?.payload;
}
async function tap(data) {
  calls.length = 0;
  await bot.handleUpdate({
    update_id: ++uid,
    callback_query: { id: String(uid), from: user, chat_instance: 'x', data, message: { message_id: store.getUser(user.id)?.panel_msg ?? 1, date: 0, chat, text: '…' } },
  });
  return lastPanel()?.payload;
}
const buttons = (p) => (p?.reply_markup?.inline_keyboard ?? []).flat();
const find = (p, re) => buttons(p).find((b) => re.test(b.text) || re.test(b.callback_data || ''));
const step = (name, p) => console.log(`✓ ${name.padEnd(28)} ${(p?.text || '').split('\n')[0].replace(/<[^>]+>/g, '').slice(0, 60)}`);

// ── flows ─────────────────────────────────────────────────────────────────
const t0 = Date.now();
let p = await say('/start');
assert.ok(calls.some((c) => c.payload.reply_markup?.keyboard), 'reply keyboard sent');
step('/start → welcome', p);

const domains = await publicDomains();
const byProvider = Object.groupBy(domains, (d) => d.provider);
console.log(`  domains: ${domains.length} → ${Object.entries(byProvider).map(([k, v]) => `${k}:${v.length}`).join(' ')}`);
assert.ok(domains.length >= 5, 'expected several public domains');

p = await say('✨ New Mail');
step('menu: New Mail → picker', p);
assert.ok(find(p, /^nr:/), 'domain buttons');
p = await tap('np:1');
step('picker page 2', p);

// one address per provider
const created = [];
for (const [pid, list] of Object.entries(byProvider)) {
  const d = list[0];
  const t = Date.now();
  p = await tap(`nr:${pid}:${d.domain}`);
  const ok = /address ready/.test(p?.text || '');
  console.log(`${ok ? '✓' : '✗'} create on ${pid.padEnd(4)} @${d.domain.padEnd(22)} ${Date.now() - t}ms ${ok ? '' : p?.text?.slice(0, 80)}`);
  if (ok) created.push(store.getActiveInbox(store.getUser(user.id)));
}
assert.ok(created.length >= 2, 'at least two providers should work');

for (const ib of created) {
  const t = Date.now();
  p = await tap(`inb:${ib.id}:0:r`);
  console.log(`✓ inbox ${ib.provider.padEnd(4)} ${String(Date.now() - t).padStart(5)}ms  ${p.text.split('\n')[1]?.replace(/<[^>]+>/g, '') || ''}`);
}

p = await tap('nc');
step('custom name prompt', p);
p = await say('My.Shop 1');
step('custom name → picker', p);
assert.match(p.text, /my-shop-1@/);
p = await tap('home');
step('home dashboard', p);

p = await say('👤 Profile');
step('menu: Profile', p);
assert.match(p.text, /User ID/);
assert.match(p.text, /Generated\s+<b>\d+/);

p = await say('🗂 Addresses');
step('menu: Addresses', p);
p = await tap(`sw:${created[0].id}`);
step('switch address', p);
p = await tap('tmr');
step('timer', p);
p = await tap(`tm:${created[0].id}:600`);
step('timer armed', p);
p = await say('⚙️ Settings');
step('menu: Settings', p);
p = await tap('set:t');
p = await tap('set:n');
step('settings toggled', p);
p = await tap('set:n');

p = await say('✉️ Compose');
step('compose without domain', p);
assert.match(p.text, /own domain/);

// ── custom domain: add, force-verify, inbound mail, compose ──────────────
p = await say('🌐 Domains');
step('menu: Domains', p);
p = await tap('dom:add');
step('add domain prompt', p);
p = await say('https://Mail.Crevio-Test.dev/');
step('domain added (unverified)', p);
const dom = store.findDomain('mail.crevio-test.dev');
assert.ok(dom && !dom.verified);
store.setDomain(dom.id, { verified: 1 }); // pretend the TXT record is in place

p = await tap(`ncx:${dom.id}`);
p = await say('hello');
step('own-domain address', p);
const ownIb = store.findInboxByAddress('hello@mail.crevio-test.dev');
assert.ok(ownIb, 'own inbox created');

// inbound delivery through the real HTTP handler
let pushed = 0;
setInboundHandler(async (ib, id) => {
  pushed++;
  await pushMail(bot, ib, id);
});
const server = http.createServer((req, res) => handleInbound(req, res)).listen(0);
const port = server.address().port;
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
const post = (key, to = 'hello@mail.crevio-test.dev') =>
  fetch(`http://127.0.0.1:${port}/inbound`, { method: 'POST', headers: { 'X-Crevio-Key': key, 'X-Crevio-To': to }, body: raw });
assert.equal((await post('wrong')).status, 403);
assert.equal((await post(dom.key, 'nobody@mail.crevio-test.dev')).status, 404);
calls.length = 0;
assert.equal((await post(dom.key)).status, 200);
await new Promise((r) => setTimeout(r, 300));
const note = calls.find((c) => c.method === 'sendMessage' && /New mail/.test(c.payload.text));
assert.ok(note, 'push notification sent');
assert.ok(find(note.payload, /482913/), 'OTP copy button in push');
console.log('✓ inbound mail → push with OTP button');

p = await tap(`inb:${ownIb.id}:0`);
step('own inbox lists mail', p);
const open = find(p, /^msg:/);
p = await tap(open.callback_data);
step('open mail', p);
assert.ok(find(p, /Verify/), 'verify link button');
assert.ok(find(p, /Attachments/), 'attachments button');
p = await tap(find(p, /Attachments/).callback_data);
p = await tap(find(p, /^atd:/).callback_data);
assert.ok(calls.some((c) => c.method === 'sendDocument'), 'attachment delivered');
console.log('✓ attachment download');

// sending: fake worker
const worker = http
  .createServer(async (req, res) => {
    const body = await new Promise((r) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => r(s));
    });
    if (req.headers['x-crevio-key'] !== dom.key) return res.writeHead(403).end();
    if (req.url === '/ping') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"canSend":true}');
    worker.last = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"id":"m1"}');
  })
  .listen(0);
store.setDomain(dom.id, { worker_url: `http://127.0.0.1:${worker.address().port}`, can_send: 1 });

p = await say('✉️ Compose');
step('compose from own domain', p);
p = await say('friend@example.com');
p = await say('Hi there');
p = await say('Line one\n\nLine two');
step('compose preview', p);
assert.match(p.text, /Ready to send/);
p = await tap('cmgo');
step('sent', p);
assert.equal(worker.last?.from?.email, 'hello@mail.crevio-test.dev');
assert.equal(worker.last?.to, 'friend@example.com');

p = await tap(`inb:${ownIb.id}:0`);
p = await tap(find(p, /^msg:/).callback_data);
p = await tap(find(p, /Reply/).callback_data);
step('reply prefilled', p);
assert.match(p.text, /noreply@github.com/);
await tap('cmx');

p = await say('👤 Profile');
assert.match(p.text, /Sent\s+<b>1<\/b>/);
assert.match(p.text, /Received\s+<b>1<\/b>/);
step('profile counters', p);

p = await say('/stats');
step('/stats (admin)', p);

// cleanup: delete everything (also removes provider accounts)
p = await tap('wipe');
p = await tap('wipey');
step('wipe all', p);
server.close();
worker.close();
await new Promise((r) => setTimeout(r, 1500));

console.log(`\n${errors ? '✗' : '✓'} simulation finished in ${Date.now() - t0}ms with ${errors} bot errors`);
process.exit(errors ? 1 : 0);
