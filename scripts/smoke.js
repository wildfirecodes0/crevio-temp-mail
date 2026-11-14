// Offline sanity checks for the extractor + screen text builders (no Telegram / network needed).
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
  attachments: [{ filename: 'a.pdf', size: 10 }],
};
assert.equal(extractActionLinks(msg)[0].url, 'https://acme.io/verify?t=1');
assert.ok(bodyText(msg).includes('Hi!'));

const ib = { id: 1, provider: 'tm', address: 'lunar-otter47@example.com', created_at: Date.now(), expires_at: Date.now() + 3600e3 };
const user = { id: 1, first_name: 'Sam', created_at: Date.now(), notify: 1, default_ttl: 3600, generated: 3 };
const sender = { email: 'lunar-otter47@relay.dev', replyTo: ib.address };
const draft = { to: 'a@b.co', subject: 's', text: 'x'.repeat(5000), attachments: [] };
const texts = [
  ui.welcome('Sam', 18), ui.help(), ui.dashboard(ib, { total: 3, unread: 1, index: 1, count: 2, route: { mode: 'relay' } }),
  ui.created(ib), ui.picker([{ provider: 'tm', domain: 'a.com', kind: 'mine' }]), ui.askCustom('x.dev'),
  ui.inbox(ib, [], 0, 1), ui.inbox(ib, Array.from({ length: 20 }, (_, i) => ({ ...msg, id: 'm' + i, seen: i % 2 })), 1, 3),
  ui.message(ib, msg, { body: 'x'.repeat(9000), codes: ['482913'], links: extractActionLinks(msg) }),
  ui.attachments(msg, true), ui.notification(ib, msg, { codes: ['482913'], links: [] }).text,
  ui.addresses([ib], 1), ui.confirmDelete(ib), ui.timer(ib), ui.settings(user), ui.confirmWipe(),
  ui.profile(user, { myDomains: [{ domain: 'x.dev', verified: 1 }], domainCount: 18, sentToday: 0, sendLimit: 50, route: null }),
  ui.domainsHub([{ provider: 'tm', domain: 'a.com', kind: 'public' }], [], { allowAdd: true }),
  ui.domainManage({ id: 1, domain: 'example.com', key: 'k' }, { txtOk: false, mxHosts: [] }, { botUrl: '' }),
  ui.composeAsk('to', draft, ib, sender), ui.composePreview(draft, ib, sender, { sentToday: 1, limit: 0 }),
  ui.sent(draft, sender), ui.composeUnavailable(true), ui.problem('sendfail', 'E_X'),
];
for (const t of texts) {
  assert.equal(typeof t, 'string');
  assert.ok(t.length <= 4096, 'text too long');
}
assert.ok(ui.profile(user, { myDomains: [], domainCount: 18, sentToday: 0, sendLimit: 0, route: null }).length <= 1024, 'profile caption fits a photo');
console.log('✓ smoke checks passed');
