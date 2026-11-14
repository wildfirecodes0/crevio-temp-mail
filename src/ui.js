// Text for every screen (Telegram HTML), built from one small design system:
//   head()  → bold title · italic meta, then a rule
//   card()  → a quoted block for the thing that matters (address, code, sender)
//   tree()  → "├ emoji Label  value" rows, last one "└"
//   list    → "<b>N.</b> marker item ~ <b>age</b>" with « N » buttons underneath (built in bot.js)
//   hint()  → a closing italic line telling the user what to do next
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { esc, truncate, ago, shortDur, fmtSize, fmtDate } from './utils.js';
import { providerLabel } from './providers/index.js';
import { txtHost } from './domains.js';

export const BRAND = 'Crevio Mail Bot';
export const RULE = '────────────────────────';
export const PAGE = 10; // items per list page (inbox, addresses)

const head = (title, meta) => `<b>${title}</b>${meta ? `  ·  <i>${meta}</i>` : ''}\n${RULE}`;
const card = (inner) => `<blockquote>${inner}</blockquote>`;
const addr = (a) => `<code>${esc(a)}</code>`;
const hint = (t) => `<i>${t}</i>`;
// Detail rows in the same rhythm as the address list: "emoji Label ~ value", value in bold, airy spacing.
// (Box-drawing trees don't line up in Telegram's proportional font, so they're not used.)
const tree = (rows) => {
  const r = rows.filter(Boolean);
  if (!r.length) return '';
  return `\n${r.map(([emoji, label, value]) => `${emoji} ${label} ~ ${/<\w/.test(String(value)) ? value : `<b>${value}</b>`}`).join('\n\n')}`;
};
const join = (parts) => parts.filter((p) => p !== null && p !== undefined && p !== false).join('\n');
export const H = (sub) => head('✦ 𝗖𝗥𝗘𝗩𝗜𝗢 𝗠𝗔𝗜𝗟', sub);

export const TIMERS = [
  [600, '10 min'],
  [3600, '1 hour'],
  [86400, '24 hours'],
  [604800, '7 days'],
  [0, 'Never'],
];
export const ttlLabel = (sec) => TIMERS.find(([s]) => s === Number(sec))?.[1] ?? 'Never';
const leftOf = (ib) => Math.max(0, (Number(ib.expires_at) - Date.now()) / 1000);
const timerValue = (ib) => (ib.expires_at ? `<b>self-destructs in ${shortDur(leftOf(ib))}</b>` : '<b>none</b> · <i>lives until deleted</i>');
export const timerShort = (ib) => (ib.expires_at ? `Expires in ${shortDur(leftOf(ib))}` : 'No timer');

const senderName = (from) => esc(truncate(from?.name || from?.address?.split('@')[0] || 'Unknown', 28));
const sourceLabel = (ib) => (ib.provider === 'own' ? 'custom domain' : providerLabel(ib.provider));
const sendingValue = (route) => (route ? (route.mode === 'direct' ? 'sends directly' : 'via Crevio relay') : 'receive only');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ── home ─────────────────────────────────────────────────────────────────
export function welcome(firstName, domainCount) {
  return join([
    head(`👋 Hey ${esc(firstName || 'there')}, welcome to ${BRAND}`),
    'Burner inboxes in one tap. Sign up anywhere and keep your real email clean.',
    '',
    tree([
      ['⚡', 'Instant', `${domainCount}+ domains to choose from`],
      ['🔑', 'Smart', 'OTP codes detected, one-tap copy'],
      ['🛰', 'Live', 'new mail pushed to this chat'],
      ['✉️', 'Send', 'compose & reply from any address'],
      ['🏷', 'Your domain', 'receive on anything@yourdomain'],
      ['💣', 'Self-destruct', 'timers that wipe an address'],
    ]),
    '',
    hint('Tap ⚡ Instant address to get your first inbox.'),
  ]);
}

export function dashboard(ib, { total, unread, index, count, route }) {
  const mails = total === null ? '<i>syncing…</i>' : total ? `<b>${total}</b>${unread ? `  ·  <b>${unread} new</b>` : ''}` : '<i>none yet</i>';
  return join([
    H(`address ${index} of ${count}`),
    card(`${addr(ib.address)}\n<i>tap to copy</i>`),
    tree([
      ['📬', 'Mails', mails],
      ['🌐', 'Domain', `<b>${esc(ib.address.split('@')[1])}</b> · <i>${sourceLabel(ib)}</i>`],
      ['🕓', 'Created', ago(Number(ib.created_at))],
      ['💣', 'Timer', timerValue(ib)],
      ['✉️', 'Sending', sendingValue(route)],
    ]),
  ]);
}

export function created(ib) {
  return join([
    head('✨ Address ready', 'live now'),
    card(`${addr(ib.address)}\n<i>tap to copy</i>`),
    tree([
      ['🌐', 'Domain', esc(ib.address.split('@')[1])],
      ['🛰', 'Provider', sourceLabel(ib)],
      ['💣', 'Timer', timerValue(ib)],
    ]),
    ib.fallbackFrom ? `\n⚠️ <i>@${esc(ib.fallbackFrom)} wasn’t responding, so I used another domain.</i>` : null,
    '',
    hint('Use it anywhere. I’ll ping you the moment mail arrives.'),
  ]);
}

export function help() {
  return join([
    head('❔ How it works'),
    '<b>1.</b> ✨ <b>New Mail</b> → pick a domain, or ⚡ Instant',
    '<b>2.</b> Use the address on any site',
    '<b>3.</b> Mail arrives here instantly, with codes ready to copy',
    '',
    '<b>✉️ Sending</b>',
    'Compose and reply from any of your addresses. Replies come back to the same inbox.',
    '',
    '<b>🏷 Your own domain</b>',
    '🌐 Domains → ➕ Add my domain. Then receive on <i>anything</i>@yourdomain and send from it directly.',
    '',
    '<b>Tips</b>',
    tree([
      ['🗂', 'Addresses', `keep up to <b>${config.maxInboxes}</b>, switch anytime`],
      ['💣', 'Timer', 'wipes an address and its mail automatically'],
      ['🖥', 'Viewer', 'open any mail exactly as it was sent'],
    ]),
    '',
    hint('Public temp domains can be read by anyone who guesses the name. Don’t use them for banking.'),
  ]);
}

// ── create ───────────────────────────────────────────────────────────────
const KIND_MARK = { mine: '⭐', premium: '💎', public: '🎲' };
const kindLabel = (d) => (d.kind === 'mine' ? 'your domain' : d.kind === 'premium' ? 'premium' : providerLabel(d.provider));

/** Domain picker as a numbered list (one page of PAGE), same rhythm as the address list. */
export function picker(slice, { total, offset = 0, page = 0, pages = 1, pendingLocal } = {}) {
  const lines = [
    pendingLocal ? head('✍️ Custom address', `${total} domains`) : head('✨ New address', `${total} domains`),
    '',
  ];
  if (pendingLocal) lines.push(card(`${addr(`${pendingLocal}@`)}<b>…</b>\n<i>pick a domain to finish it</i>`), '');
  slice.forEach((d, i) => lines.push(`<b>${offset + i + 1}.</b> ${KIND_MARK[d.kind] ?? '🎲'} <code>@${esc(d.domain)}</code> ~ <b>${kindLabel(d)}</b>`, ''));
  lines.push(
    hint(
      `${pendingLocal ? '' : '⚡ instant = random domain · ✍️ custom = your name · '}tap a number${pages > 1 ? `  ·  page ${page + 1} of ${pages}` : ''}`,
    ),
  );
  return lines.join('\n');
}

export const askCustom = (domain) =>
  join([
    head('✍️ Custom address', domain ? `@${esc(domain)}` : null),
    domain ? `Send the name you want on <b>@${esc(domain)}</b>.` : 'Send the name you want before the <b>@</b>.',
    '',
    tree([
      ['📏', 'Length', '3–30 characters'],
      ['🔤', 'Allowed', 'a–z, 0–9, dash, underscore'],
      ['💡', 'Examples', '<code>shop-alerts</code> · <code>neo_2077</code>'],
    ]),
  ]);

// ── inbox ────────────────────────────────────────────────────────────────
export function inbox(ib, msgs, page, pages) {
  if (!msgs.length) {
    return join([
      head('📥 Inbox', 'empty'),
      card(`${addr(ib.address)}\n<i>tap to copy</i>`),
      '',
      '📭 <b>No mail yet</b>',
      hint('Use this address on any site. New mail lands here and I’ll ping you instantly.'),
      '',
      hint(`🔄 Auto-checking every ${config.pollIntervalSec}s`),
    ]);
  }
  const unread = msgs.filter((m) => !m.seen).length;
  const lines = [head('📥 Inbox', `${plural(msgs.length, 'mail')}${unread ? ` · ${unread} new` : ''}`), card(addr(ib.address)), ''];
  msgs.slice(page * PAGE, page * PAGE + PAGE).forEach((m, i) => {
    lines.push(
      `<b>${page * PAGE + i + 1}.</b> ${m.seen ? '⚪' : '🔵'} <b>${senderName(m.from)}</b> ~ <b>${ago(m.createdAt)}</b>${m.hasAttachments ? ' 📎' : ''}`,
      `      <i>${esc(truncate(m.subject || '(no subject)', 54))}</i>`,
      '',
    );
  });
  lines.push(hint(`🔵 new${pages > 1 ? `  ·  page ${page + 1} of ${pages}` : ''}  ·  tap a number to open`));
  return lines.join('\n');
}

// ── message ──────────────────────────────────────────────────────────────
export function message(ib, msg, { body, codes }, { index, total, wasNew } = {}) {
  const from = msg.from || {};
  const att = msg.attachments || [];
  const top = join([
    head(`✉️ Mail${index ? ` ${index} of ${total}` : ''}`, wasNew ? '🔵 new' : '⚪ read'),
    `<b>${esc(truncate(msg.subject || '(no subject)', 160))}</b>`,
    '',
    tree([
      ['👤', 'From', senderName(from)],
      ['📧', 'Email', `<code>${esc(from.address || '—')}</code>`],
      ['📮', 'To', addr(ib.address)],
      ['🕓', 'Received', `<b>${fmtDate(msg.createdAt)}</b> · <i>${ago(msg.createdAt)}</i>`],
      att.length ? ['📎', 'Files', `${att.length} · ${fmtSize(att.reduce((s, a) => s + (a.size || 0), 0))}`] : null,
    ]),
    codes.length ? `\n${card(`🔑 <b>Code</b>   ${codes.map(addr).join('   ')}\n<i>tap to copy</i>`)}` : null,
    '',
    '<b>📝 Message</b>',
  ]);
  const budget = 3900 - top.length - 60;
  const shown = body ? esc(truncate(body, Math.max(200, Math.floor(budget * 0.85)))) : '<i>(empty message)</i>';
  return `${top}\n<blockquote expandable>${shown}</blockquote>`;
}

export const attachments = (msg, downloadable) =>
  join([
    head('📎 Files', esc(truncate(msg.subject || '(no subject)', 40))),
    ...(msg.attachments || []).map((a, i) => `<b>${i + 1}.</b> 📄 ${esc(truncate(a.filename || 'file', 44))} ~ <b>${fmtSize(a.size)}</b>`),
    '',
    hint(downloadable ? 'Tap a number to get the file here (max 20 MB).' : 'This provider doesn’t allow downloads. Use 🖥 Open full email instead.'),
  ]);

// ── push notification (inline: copy + open) ─────────────────────────────
export function notification(ib, msg, { codes, links }) {
  const from = msg.from || {};
  const text = join([
    head('🛰 New mail', esc(ib.address)),
    `<b>${senderName(from)}</b> ~ <i>${esc(from.address || '')}</i>`,
    esc(truncate(msg.subject || '(no subject)', 140)),
    codes.length ? `\n${card(`🔑 ${codes.map(addr).join('   ')}`)}` : msg.intro ? `\n<i>${esc(truncate(msg.intro, 160))}</i>` : null,
  ]);
  const kb = new InlineKeyboard();
  if (codes.length) kb.add({ text: `⧉ Copy ${codes[0]}`, copy_text: { text: codes[0] } });
  kb.add({ text: '📖 Open', callback_data: `msg:${ib.id}:${msg.id}` });
  if (links[0]) kb.row().url(links[0].label, links[0].url);
  return { text, kb };
}

export const expired = (address) => ({
  text: join([head('💥 Address expired'), card(addr(address)), hint('Its timer ran out. The address and all of its mail are gone for good.')]),
  kb: new InlineKeyboard().add({ text: '✨ New address', callback_data: 'nr' }),
});

// ── addresses ────────────────────────────────────────────────────────────
export function addresses(list, activeId, { offset = 0, total = list.length, page = 0, pages = 1 } = {}) {
  const lines = [head('🗂 Your addresses', `${total} of ${config.maxInboxes}`), ''];
  if (!list.length) lines.push(hint('No addresses yet. Tap ✨ New Mail.'));
  list.forEach((ib, i) => {
    const on = Number(ib.id) === Number(activeId);
    lines.push(`<b>${offset + i + 1}.</b> ${on ? '●' : '○'} ${addr(ib.address)} ~ <b>${ago(Number(ib.created_at))}</b>`, '');
  });
  if (list.length) lines.push(hint(`● active${pages > 1 ? `  ·  page ${page + 1} of ${pages}` : ''}  ·  tap a number to open`));
  return lines.join('\n');
}

export function addressDetail(ib, { index, count, isActive, counts, route }) {
  const created = Number(ib.created_at);
  const mails = counts ? (counts.total ? `<b>${counts.total}</b>${counts.unread ? `  ·  <b>${counts.unread} new</b>` : ''}` : '<i>none yet</i>') : '<i>syncing…</i>';
  return join([
    head(`📮 Address ${index} of ${count}`, isActive ? '● active' : '○ inactive'),
    card(`${addr(ib.address)}\n<i>tap to copy</i>`),
    tree([
      ['🌐', 'Domain', esc(ib.address.split('@')[1])],
      ['🛰', 'Provider', sourceLabel(ib)],
      ['📬', 'Mails', mails],
      ['📥', 'Received', `<b>${ib.received || 0}</b>   ·   📤 Sent ~ <b>${ib.sent || 0}</b>`],
      ['🕓', 'Created', `<b>${fmtDate(created)}</b> · <i>${ago(created)}</i>`],
      ['💣', 'Timer', timerValue(ib)],
      ['✉️', 'Sending', sendingValue(route)],
    ]),
  ]);
}

export const confirmDelete = (ib) =>
  join([head('🗑 Delete this address?'), card(addr(ib.address)), hint('The address and every mail in it will be wiped. This can’t be undone.')]);

// ── timer / settings ─────────────────────────────────────────────────────
export const timer = (ib) =>
  join([
    head('💣 Self-destruct timer'),
    card(addr(ib.address)),
    tree([['⏱', 'Now', timerValue(ib)]]),
    '',
    hint('Pick when this address should erase itself, along with all its mail.'),
  ]);

export const settings = (user) =>
  join([
    head('⚙️ Settings'),
    tree([
      ['🛰', 'Notifications', `<b>${user.notify ? 'ON' : 'OFF'}</b>`],
      ['💣', 'Default timer', `<b>${ttlLabel(user.default_ttl)}</b> for new addresses`],
      ['🗂', 'Address limit', `<b>${config.maxInboxes}</b>`],
    ]),
    '',
    hint('Tap a setting below to change it.'),
  ]);

export const confirmWipe = () =>
  join([head('🧨 Erase everything?'), hint('All your addresses, their mail, your domains and your settings will be deleted. This can’t be undone.')]);

// ── profile (photo caption, ≤ 1024 chars) ───────────────────────────────
export function profile(user, { myDomains, domainCount, sentToday, sendLimit, isAdmin, route }) {
  const joined = new Date(Number(user.created_at)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const mine = myDomains.length ? myDomains.map((d) => `${d.verified ? '✅' : '⏳'} ${esc(d.domain)}`).join(', ') : '<i>none</i>';
  return join([
    head(`👤 ${esc(truncate(user.first_name || 'Profile', 30))}`, isAdmin ? 'admin' : null),
    tree([
      ['🆔', 'User ID', `<code>${user.id}</code>`],
      ['🔗', 'Username', user.username ? `@${esc(user.username)}` : '<i>none</i>'],
      ['🌍', 'Language', esc(user.lang || '—')],
      ['📅', 'Joined', joined],
      ['📤', 'Sent today', `<b>${sentToday}</b>${route ? (sendLimit ? ` of ${sendLimit}` : ' · no limit') : ' · <i>sending off</i>'}`],
      ['🌐', 'Domains', `<b>${domainCount}</b> available · yours: ${mine}`],
      ['🛰', 'Alerts', `<b>${user.notify ? 'ON' : 'OFF'}</b> · 💣 default <b>${ttlLabel(user.default_ttl)}</b>`],
    ]),
  ]);
}

// ── domains ──────────────────────────────────────────────────────────────
const domainState = (d) => (!d.verified ? 'pending' : d.worker_url ? (d.can_send ? 'receiving + sending' : 'receiving') : 'verified');

export function domainsHub(all, myDomains, { allowAdd }) {
  const groups = {};
  for (const d of all.filter((x) => x.kind === 'public')) (groups[providerLabel(d.provider)] ||= []).push(d.domain);
  const premium = all.filter((d) => d.kind === 'premium');
  const lines = [head('🌐 Domains', `${all.length} available`), ''];
  if (myDomains.length) {
    lines.push('<b>⭐ Your domains</b>');
    myDomains.forEach((d, i) => lines.push(`<b>${i + 1}.</b> ${d.verified ? '✅' : '⏳'} ${addr(d.domain)} ~ <b>${domainState(d)}</b>`));
    lines.push('');
  }
  if (premium.length) lines.push('<b>💎 Premium</b>', `<i>${premium.map((d) => esc(d.domain)).join('  ·  ')}</i>`, '');
  lines.push('<b>◦ Public</b>');
  lines.push(tree(Object.entries(groups).map(([label, list]) => ['🛰', esc(label), `<i>${list.map(esc).join(' · ')}</i>`])));
  lines.push('');
  lines.push(hint(myDomains.length ? 'Tap a number to manage your domain.' : allowAdd ? 'Own a domain? ➕ Add it to receive on any name and send from it.' : 'Tap ✨ to create an address on any of these.'));
  return lines.join('\n');
}

export const askDomain = () =>
  join([
    head('➕ Add your domain'),
    'Send the domain you own, like <code>example.com</code> or <code>mail.example.com</code>.',
    '',
    tree([
      ['☁️', 'Needs', 'a free Cloudflare account'],
      ['⏱', 'Takes', 'about 5 minutes, guided step by step'],
      ['✉️', 'Gives', 'any name @yourdomain, receive + send'],
    ]),
  ]);

export function domainManage(d, check, { botUrl, relay }) {
  const c = check || {};
  const w = c.worker;
  const tick = (ok) => (ok ? '✅' : '▫️');
  const status = d.verified ? (w?.ok ? (w.canSend ? '🟢 receiving + sending' : '🟢 receiving') : '🟡 verified · connect the worker') : '⏳ waiting for DNS';
  return join([
    head(`🏷 ${esc(d.domain)}`, status),
    d.public || relay ? `${d.public ? '💎 shared with everyone' : ''}${relay ? '  ·  🛰 send relay' : ''}\n` : null,
    `${tick(true)} <b>1.</b> Add the domain to Cloudflare (free plan is fine)`,
    `${tick(c.txtOk || d.verified)} <b>2.</b> DNS → add this <b>TXT</b> record`,
    card(`name   <code>${esc(txtHost(d.domain))}</code>\nvalue  <code>${esc(config.verifyToken(d.domain))}</code>`),
    `${tick(c.mxCloudflare)} <b>3.</b> Email → <b>Email Routing</b> → enable`,
    `${tick(w?.ok)} <b>4.</b> Deploy the worker (📄 Worker files) · Routing rules → <b>Catch-all</b> → Send to a Worker`,
    `${tick(w?.ok)} <b>5.</b> 🔗 Set the worker URL here`,
    `${tick(w?.canSend)} <b>6.</b> <i>Sending:</i> Email Service → onboard domain + <code>send_email</code> binding <code>EMAIL</code>`,
    '',
    hint(`MX: ${c.mxHosts?.length ? esc(c.mxHosts.slice(0, 3).join(', ')) : 'not found yet'}`),
    w && !w.ok && w.error ? hint(`Worker: ${esc(w.error)}`) : null,
    !botUrl ? '⚠️ <i>The bot has no public URL yet. Deploy on Render first.</i>' : null,
  ]);
}

export const askWorkerUrl = (d) =>
  join([
    head('🔗 Worker URL', esc(d.domain)),
    'Send the URL Cloudflare shows after you deploy, like',
    `<code>https://crevio-${esc(d.domain.replace(/\./g, '-'))}.yourname.workers.dev</code>`,
  ]);

export const confirmRemoveDomain = (d, n) =>
  join([
    head('🗑 Remove this domain?'),
    card(addr(d.domain)),
    n ? `<b>${n}</b> address${n === 1 ? '' : 'es'} on it will be deleted.` : null,
    hint('You can add the domain again later.'),
  ]);

// ── compose ──────────────────────────────────────────────────────────────
const fromCard = (ib, sender) =>
  card(sender.replyTo ? `<b>From</b>  ${addr(sender.email)}\n<b>Replies</b> →  ${addr(ib.address)}` : `<b>From</b>  ${addr(ib.address)}`);

const STEPS = { to: 1, subject: 2, body: 3 };

export function composeAsk(step, draft, ib, sender) {
  const prompts = {
    to: '📮 <b>Who is it for?</b>\n<i>Send the recipient’s email (up to 10, comma separated).</i>',
    subject: '🏷 <b>Subject?</b>\n<i>Send a subject line, or tap ⏭ No subject.</i>',
    body: '📝 <b>Your message</b>\n<i>Write it and send. Send 📎 files or photos to attach them.</i>',
  };
  const filled = tree([
    draft.to ? ['📮', 'To', esc(draft.to)] : null,
    draft.subject ? ['🏷', 'Subject', esc(truncate(draft.subject, 70))] : null,
    draft.attachments?.length ? ['📎', 'Files', draft.attachments.map((a) => esc(a.filename)).join(', ')] : null,
  ]);
  return join([head('✉️ New mail', `step ${STEPS[step]} of 3`), fromCard(ib, sender), filled || null, filled ? '' : null, prompts[step]]);
}

export function composePreview(draft, ib, sender, { sentToday, limit }) {
  const size = (draft.attachments || []).reduce((s, a) => s + a.size, 0);
  return join([
    head('✉️ Ready to send', 'review'),
    fromCard(ib, sender),
    tree([
      ['📮', 'To', esc(draft.to)],
      ['🏷', 'Subject', esc(draft.subject || '(no subject)')],
      draft.attachments?.length ? ['📎', 'Files', `${draft.attachments.map((a) => esc(a.filename)).join(', ')} · ${fmtSize(size)}`] : null,
    ]),
    '',
    '<b>📝 Message</b>',
    `<blockquote expandable>${esc(truncate(draft.text || '', 3000))}</blockquote>`,
    hint(`Sent today: ${sentToday}${limit ? ` of ${limit}` : ' · no daily limit'}`),
  ]);
}

export const sent = (draft, sender) =>
  join([
    head('🚀 Sent'),
    card(`${addr(sender.email)}\n→ ${esc(draft.to)}`),
    tree([['🏷', 'Subject', esc(draft.subject || '(no subject)')]]),
    sender.replyTo ? `\n${hint(`Replies will arrive in ${esc(sender.replyTo)}.`)}` : null,
  ]);

export const composeUnavailable = (isAdmin) =>
  join([
    head('✉️ Sending isn’t switched on yet'),
    isAdmin
      ? 'As admin: add your domain in 🌐 Domains, finish every step including 6 (sending), then tap 💎 Share with everyone. It becomes the send relay, and <b>every user</b> can send from any address.'
      : 'The bot owner hasn’t enabled sending yet. You can still add your own domain in 🌐 Domains and send from it directly.',
  ]);

// ── errors ───────────────────────────────────────────────────────────────
export function problem(kind, extra = '') {
  const map = {
    down: ['🛠 Couldn’t create the address', 'I tried several mail providers and none of them answered. Try again in a minute.'],
    slow: ['⏳ Easy there', 'The mail providers are rate-limiting right now. Give it a few seconds.'],
    taken: ['🙅 That name is taken', 'Try another one. Adding a number or a dash usually works.'],
    gone: ['🫥 Not found', 'That mail or address no longer exists.'],
    nodomain: ['🌐 Domain unavailable', 'Pick another one.'],
    invalid: ['✍️ That name won’t work', 'Use 3–30 characters: a–z, 0–9, dash or underscore.'],
    baddomain: ['🌐 That doesn’t look like a domain', 'Send it like <code>example.com</code>.'],
    domaintaken: ['🔒 Already registered', 'That domain is set up by someone else.'],
    domainoff: ['🔒 Custom domains are off', 'Only the bot owner can add domains here.'],
    nosend: ['✉️ Sending isn’t available', 'This address can’t send right now.'],
    sendlimit: ['⏳ Daily send limit reached', `You can send ${config.sendLimitShared} mails a day through the shared relay. Add your own domain for no limit.`],
    sendfail: ['⚠️ The mail couldn’t be sent', 'E_SENDER_NOT_VERIFIED → the domain isn’t onboarded in Email Service.\nE_RECIPIENT_NOT_ALLOWED → Cloudflare’s free plan only sends to verified addresses.'],
    banned: ['⛔ Sending is disabled', 'Your account can’t send mail.'],
    noatt: ['📎 No downloads here', 'This provider doesn’t allow attachment downloads.'],
    badurl: ['🔗 That URL won’t work', 'Send the full https:// address of your worker.'],
    badto: ['📮 That’s not an email address', 'Send it like <code>name@example.com</code>.'],
    toobig: ['📎 Too large', 'Attachments are limited to 15 MB in total.'],
    limit: [`🗂 All ${config.maxInboxes} slots are in use`, 'Delete an address in 🗂 Addresses to make room.'],
  };
  const [title, text] = map[kind] || map.down;
  return join([head(title), text, extra ? `\n${hint(`Reason: ${esc(truncate(extra, 300))}`)}` : null]);
}
