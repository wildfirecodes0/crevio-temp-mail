// Offline sanity checks for the extractor + UI builders (no Telegram / network needed).
process.env.BOT_TOKEN ||= '0:smoke';
const { extractCodes, extractActionLinks, bodyText } = await import('../src/extract.js');
const ui = await import('../src/ui.js');
const assert = (await import('node:assert/strict')).default;

assert.deepEqual(extractCodes('Your GitHub launch code', 'Use code 482913 to sign in. © 2026'), ['482913']);
assert.deepEqual(extractCodes('Welcome!', 'Your verification code is 731-204.'), ['731204']);
assert.deepEqual(extractCodes('Invoice', 'Total ₹1999 paid on 12 Nov 2026'), []);
assert.equal(extractCodes('Discord', 'Your login code: K7Q2ZP')[0], 'K7Q2ZP');

const msg = {
  id: 'abc', subject: 'Confirm your email', createdAt: new Date().toISOString(),
  from: { name: 'Acme', address: 'no-reply@acme.io' }, text: '',
  html: ['<p>Hi!</p><a href="https://acme.io/verify?t=1">Verify email</a> <a href="https://acme.io/unsubscribe">unsubscribe</a>'],
  attachments: [],
};
assert.equal(extractActionLinks(msg)[0].url, 'https://acme.io/verify?t=1');
assert.ok(bodyText(msg).includes('Hi!'));

const ib = { id: 1, provider: 'tm', address: 'lunar-otter47@example.com', created_at: Date.now(), expires_at: Date.now() + 3600e3 };
for (const v of [
  ui.welcome('Sam'), ui.help(), ui.dashboard(ib, { total: 3, unread: 1, index: 1, count: 2 }),
  ui.inbox(ib, [], 0), ui.profile({ id: 1, first_name: 'Sam', created_at: Date.now(), notify: 1, default_ttl: 0, generated: 3 }, { live: 1, myDomains: [{ domain: 'x.dev', verified: 1 }], domainCount: 18, sentToday: 0, sendLimit: 50 }),
  ui.domainsHub([{ provider: 'tm', domain: 'a.com', kind: 'public' }], [], { allowAdd: true }),
  ui.domainManage({ id: 1, domain: 'example.com', key: 'k' }, { txtOk: false, mxHosts: [] }, { isAdmin: true, botUrl: '' }),
  ui.composePreview({ to: 'a@b.co', subject: 's', text: 'x'.repeat(5000), attachments: [] }, ib, { sentToday: 1, limit: 0 }), ui.inbox(ib, Array.from({ length: 9 }, (_, i) => ({ ...msg, id: 'm' + i, seen: i % 2 })), 1),
  ui.message(ib, msg, { body: 'x'.repeat(9000), codes: ['482913'], links: [], viewerUrl: 'https://x.test/v/1', canReply: true }),
  ui.notification(ib, msg, { codes: ['482913'], links: [] }), ui.timer(ib), ui.settings({ notify: 1, default_ttl: 3600 }), ui.attachments(ib, { ...msg, attachments: [{ filename: 'a.pdf', size: 10 }] }, { downloadable: true }),
  ui.addresses([ib], 1), ui.domainPicker(Array.from({ length: 25 }, (_, i) => ({ provider: 'gm', domain: `d${i}.example-domain.com`, kind: i ? 'public' : 'mine', canSend: !i })), 2),
]) {
  assert.ok(v.text.length <= 4096, 'text too long');
  for (const row of v.kb.inline_keyboard) for (const b of row) {
    assert.ok(b.text.trim().length, 'empty button');
    if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64, 'callback too long: ' + b.callback_data);
  }
}
console.log('✓ smoke checks passed');
