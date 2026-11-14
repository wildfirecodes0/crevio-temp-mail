// Every screen the bot can show. Each view returns { text, kb } — text is Telegram HTML.
import { InlineKeyboard, Keyboard } from 'grammy';
import { config } from './config.js';
import { esc, truncate, ago, shortDur, fmtSize, fmtDate } from './utils.js';
import { providerLabel } from './providers/index.js';
import { txtHost } from './domains.js';

const H = (sub) => `✦ <b>𝗖𝗥𝗘𝗩𝗜𝗢</b>${sub ? `  <i>· ${sub}</i>` : ''}`;
const copy = (text, value) => ({ text, copy_text: { text: String(value).slice(0, 256) } });
const cb = (text, data) => ({ text, callback_data: data });
const back = (data = 'home', text = '‹  Back') => cb(text, data);

// ── reply-keyboard main menu ─────────────────────────────────────────────
export const MENU = {
  inbox: '📥 Inbox',
  new: '✨ New Mail',
  addresses: '🗂 Addresses',
  compose: '✉️ Compose',
  domains: '🌐 Domains',
  profile: '👤 Profile',
  settings: '⚙️ Settings',
  help: '❔ Help',
};

export const mainKeyboard = () =>
  new Keyboard()
    .text(MENU.inbox).text(MENU.new).text(MENU.addresses).row()
    .text(MENU.compose).text(MENU.domains).row()
    .text(MENU.profile).text(MENU.settings).text(MENU.help)
    .resized()
    .persistent()
    .placeholder('Crevio · tap a button or send /new');

export const TIMERS = [
  [600, '10 min'],
  [3600, '1 hour'],
  [86400, '24 hours'],
  [604800, '7 days'],
  [0, 'Never'],
];
const ttlLabel = (sec) => TIMERS.find(([s]) => s === Number(sec))?.[1] ?? 'Never';

const timerLine = (ib) => {
  if (!ib.expires_at) return '♾ lives until you delete it';
  const left = (Number(ib.expires_at) - Date.now()) / 1000;
  return left > 0 ? `💣 self-destructs in <b>${shortDur(left)}</b>` : '💣 self-destructing…';
};

const senderName = (from) => esc(truncate(from?.name || from?.address?.split('@')[0] || 'Unknown', 28));
const KIND_BADGE = { mine: '⭐', premium: '💎', public: '◦' };

// ── loading frame (shown only if work takes long) ────────────────────────
export const loading = (what = 'Loading') => ({
  text: `${H()}\n\n<code>◐</code>  <i>${esc(what)}…</i>`,
  kb: new InlineKeyboard().add(cb('·  ·  ·', 'noop')),
});

export const menuReady = (name) =>
  `✦ <b>𝗖𝗥𝗘𝗩𝗜𝗢</b> is ready, ${esc(name || 'friend')}.\n<i>Your menu is pinned below ⌨️</i>`;

// ── onboarding ───────────────────────────────────────────────────────────
export function welcome(firstName, domainCount) {
  const text = [
    H('disposable mail'),
    '',
    `Hey ${esc(firstName || 'there')} 👋`,
    'Your burner inbox is one tap away. Sign up anywhere and keep your real email out of it.',
    '',
    `⚡ <b>Instant</b>  <i>${domainCount || 'many'} domains to choose from</i>`,
    '🔑 <b>Smart</b>  <i>OTP codes detected, one-tap copy</i>',
    '🛰 <b>Live</b>  <i>new mail pushed to this chat</i>',
    '🏷 <b>Your domain</b>  <i>receive (and send) on your own domain</i>',
    '💣 <b>Self-destruct</b>  <i>set a timer, forget it exists</i>',
  ].join('\n');
  const kb = new InlineKeyboard()
    .add(cb('✨  Instant address', 'nr'))
    .row()
    .add(cb('🌐  Choose domain', 'np:0'), cb('✍️  Custom name', 'nc'));
  return { text, kb };
}

export function help() {
  const text = [
    H('how it works'),
    '',
    '<b>1.</b> Create an address: instant, or pick a domain and your own name.',
    '<b>2.</b> Use it on any site that wants an email.',
    '<b>3.</b> Mail lands here instantly. Codes get a ⧉ copy button, and verify links become buttons.',
    '',
    '<b>Your own domain</b>',
    '🌐 Domains → ➕ Add my domain. Crevio walks you through Cloudflare Email Routing (free). After that you can receive on <i>anything</i>@yourdomain and send mail from it too.',
    '',
    '<b>Tips</b>',
    `• Keep up to <b>${config.maxInboxes}</b> addresses and switch anytime.`,
    '• 💣 The timer wipes an address and all its mail automatically.',
    '• 🖥 Open any mail in the full viewer to see it exactly as it was sent.',
    '',
    '<i>Public temp domains can be read by anyone who guesses the name. Never use them for banking or anything you can’t afford to lose.</i>',
  ].join('\n');
  return { text, kb: new InlineKeyboard().add(back()) };
}

// ── dashboard ────────────────────────────────────────────────────────────
export function dashboard(ib, { total, unread, index, count, canSend }) {
  const mailLine =
    total === null
      ? '📡 <i>syncing…</i>'
      : total
        ? `📬 <b>${total}</b> mail${total === 1 ? '' : 's'}${unread ? ` · <b>${unread}</b> new` : ''}`
        : '📭 empty, waiting for mail';
  const domain = ib.address.split('@')[1];
  const text = [
    H(`address ${index} of ${count}`),
    '',
    `<code>${esc(ib.address)}</code>`,
    '',
    `├ ${mailLine}`,
    `├ 🌐 ${esc(domain)} <i>· ${ib.provider === 'own' ? 'custom domain' : providerLabel(ib.provider)}</i>`,
    `├ 🕓 created ${ago(Number(ib.created_at))}`,
    `└ ${timerLine(ib)}`,
    '',
    canSend ? '<i>✉️ This address can also send mail.</i>' : '<i>Tap the address to copy it.</i>',
  ].join('\n');

  const inboxLabel = total ? `📥  Inbox · ${total}${unread ? ` ● ${unread}` : ''}` : '📥  Inbox';
  const kb = new InlineKeyboard()
    .add(copy('⧉  Copy address', ib.address))
    .row()
    .add(cb(inboxLabel, `inb:${ib.id}:0`), cb('↻', 'home:r'))
    .row()
    .add(cb('✨  New', 'np:0'), cb('🗂  Switch', 'adr'), cb('💣  Timer', 'tmr'));
  if (canSend) kb.row().add(cb('✉️  Send from this address', `cmp:${ib.id}`));
  return { text, kb };
}

// ── create flow ──────────────────────────────────────────────────────────
export const DOMAIN_PAGE = 10;

export function domainPicker(domains, page = 0, { pendingLocal } = {}) {
  const pages = Math.max(1, Math.ceil(domains.length / DOMAIN_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = domains.slice(page * DOMAIN_PAGE, page * DOMAIN_PAGE + DOMAIN_PAGE);
  const mine = domains.filter((d) => d.kind !== 'public').length;

  const text = pendingLocal
    ? [H('custom address'), '', `<code>${esc(pendingLocal)}@</code><b>…</b>`, '', `Pick a domain to finish it. <i>${domains.length} available</i>`]
    : [
        H('new address'),
        '',
        `Pick a domain. <i>${domains.length} available${mine ? `, ${mine} custom` : ''}</i>`,
        '',
        '🎲 Tap a domain for a random name, or ✍️ choose your own name first.',
        mine ? '\n⭐ your domain   💎 premium   ✉ can send' : '',
      ];

  const kb = new InlineKeyboard();
  if (!pendingLocal) kb.add(cb('⚡  Instant (random domain)', 'nr')).row();
  slice.forEach((d, i) => {
    const badge = d.kind === 'public' ? '' : `${KIND_BADGE[d.kind]} `;
    const send = d.canSend ? ' ✉' : '';
    kb.add(cb(`${badge}@${d.domain}${send}`, `${pendingLocal ? 'ncd' : 'nr'}:${d.provider}:${d.domain}`));
    if (i % 2 === 1) kb.row();
  });
  kb.row();
  if (pages > 1) {
    const nav = pendingLocal ? 'npc' : 'np';
    kb.add(
      cb(page > 0 ? '‹' : '·', page > 0 ? `${nav}:${page - 1}` : 'noop'),
      cb(`${page + 1} / ${pages}`, 'noop'),
      cb(page < pages - 1 ? '›' : '·', page < pages - 1 ? `${nav}:${page + 1}` : 'noop'),
    ).row();
  }
  if (!pendingLocal) kb.add(cb('✍️  Custom name', 'nc'), cb('➕  My domain', 'dom:add')).row();
  kb.add(back());
  return { text: text.join('\n'), kb };
}

export function askCustom() {
  const text = [
    H('custom address'),
    '',
    'Send me the name you want before the <b>@</b>.',
    '',
    '<i>3–30 chars · a–z, 0–9, dash, underscore</i>',
    'e.g. <code>shop-alerts</code>  or  <code>neo_2077</code>',
  ].join('\n');
  return { text, kb: new InlineKeyboard().add(cb('✕  Cancel', 'home')) };
}

export function created(ib) {
  const text = [
    H('address ready'),
    '',
    '✨ Your new inbox is live and listening:',
    '',
    `<code>${esc(ib.address)}</code>`,
    '',
    `└ ${timerLine(ib)}`,
    '',
    '<i>Use it anywhere. I’ll ping you the moment mail arrives.</i>',
  ].join('\n');
  const kb = new InlineKeyboard()
    .add(copy('⧉  Copy address', ib.address))
    .row()
    .add(cb('📥  Open inbox', `inb:${ib.id}:0`), cb('🏠  Home', 'home'));
  return { text, kb };
}

// ── inbox ────────────────────────────────────────────────────────────────
export const PAGE = 6;

export function inbox(ib, msgs, page) {
  const pages = Math.max(1, Math.ceil(msgs.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = msgs.slice(page * PAGE, page * PAGE + PAGE);
  const kb = new InlineKeyboard();

  if (!msgs.length) {
    const text = [
      `📥 <b>Inbox</b>  <code>${esc(ib.address)}</code>`,
      '',
      '<code>      ·  nothing here yet  ·      </code>',
      '',
      'Use this address anywhere. Mail shows up here',
      'and I’ll ping you the moment it arrives.',
    ].join('\n');
    kb.add(copy('⧉  Copy address', ib.address)).row().add(cb('↻  Refresh', `inb:${ib.id}:0:r`), back());
    return { text, kb };
  }

  const unread = msgs.filter((m) => !m.seen).length;
  const lines = [
    `📥 <b>Inbox</b>  <code>${esc(ib.address)}</code>`,
    `<i>${msgs.length} mail${msgs.length === 1 ? '' : 's'}${unread ? ` · ${unread} new` : ''}${pages > 1 ? ` · page ${page + 1}/${pages}` : ''}</i>`,
    '',
  ];
  slice.forEach((m, i) => {
    lines.push(
      `${m.seen ? '○' : '●'} <b>${senderName(m.from)}</b> <i>· ${ago(m.createdAt)}</i>${m.hasAttachments ? ' 📎' : ''}`,
      `   ${esc(truncate(m.subject || '(no subject)', 46))}`,
    );
    if (i < slice.length - 1) lines.push('');
    kb.add(cb(`${m.seen ? '○' : '●'}  ${truncate(m.from?.name || m.from?.address || '', 14)} — ${truncate(m.subject || '(no subject)', 26)}`, `msg:${ib.id}:${m.id}`)).row();
  });

  if (pages > 1) {
    kb.add(
      cb(page > 0 ? '‹' : '·', page > 0 ? `inb:${ib.id}:${page - 1}` : 'noop'),
      cb(`${page + 1} / ${pages}`, 'noop'),
      cb(page < pages - 1 ? '›' : '·', page < pages - 1 ? `inb:${ib.id}:${page + 1}` : 'noop'),
    ).row();
  }
  kb.add(cb('↻  Refresh', `inb:${ib.id}:${page}:r`), back());
  return { text: lines.join('\n'), kb };
}

// ── single message ───────────────────────────────────────────────────────
export function message(ib, msg, { body, codes, links, viewerUrl, canReply }) {
  const from = msg.from || {};
  const head = [
    `✉️ <b>${esc(truncate(msg.subject || '(no subject)', 120))}</b>`,
    '',
    `<b>From</b>  ${senderName(from)} <i>‹${esc(from.address || '')}›</i>`,
    `<b>To</b>      <code>${esc(ib.address)}</code>`,
    `<b>When</b>  ${fmtDate(msg.createdAt)} · ${ago(msg.createdAt)}`,
  ];
  if (codes.length) head.push('', `🔑 <b>Code</b>   ${codes.map((c) => `<code>${esc(c)}</code>`).join('  ·  ')}`);
  const att = msg.attachments || [];
  const foot = att.length ? `\n📎 <i>${att.length} attachment${att.length === 1 ? '' : 's'} · ${fmtSize(att.reduce((s, a) => s + (a.size || 0), 0))}</i>` : '';

  const headText = head.join('\n');
  const budget = 3900 - headText.length - foot.length - 60;
  const shown = body ? esc(truncate(body, Math.max(200, Math.floor(budget * 0.85)))) : '<i>(empty message)</i>';
  const text = `${headText}\n\n<blockquote expandable>${shown}</blockquote>${foot}`;

  const kb = new InlineKeyboard();
  codes.forEach((c) => kb.add(copy(`⧉  Copy ${c}`, c)));
  if (codes.length) kb.row();
  links.forEach((l) => kb.url(l.label, l.url));
  if (links.length) kb.row();
  if (viewerUrl) kb.webApp('🖥  Open full email', viewerUrl).row();
  if (att.length) kb.add(cb(`📎  Attachments · ${att.length}`, `att:${ib.id}:${msg.id}`)).row();
  if (canReply && from.address) kb.add(cb('↩  Reply', `rpl:${ib.id}:${msg.id}`));
  kb.add(cb('🗑  Delete', `del:${ib.id}:${msg.id}`), cb('‹  Inbox', `inb:${ib.id}:0`));
  return { text, kb };
}

export function attachments(ib, msg, { downloadable }) {
  const att = msg.attachments || [];
  const text = [
    `📎 <b>Attachments</b>`,
    `<i>${esc(truncate(msg.subject || '(no subject)', 60))}</i>`,
    '',
    ...att.map((a, i) => `<b>${i + 1}.</b> ${esc(truncate(a.filename || 'file', 48))} <i>· ${fmtSize(a.size)}</i>`),
    '',
    downloadable ? '<i>Tap one to get it here. Max 20 MB.</i>' : '<i>This domain’s provider doesn’t allow attachment downloads. Use 🖥 Open full email instead.</i>',
  ].join('\n');
  const kb = new InlineKeyboard();
  if (downloadable) att.slice(0, 10).forEach((a, i) => kb.add(cb(`⬇  ${truncate(a.filename || 'file', 30)}`, `atd:${ib.id}:${msg.id}:${i}`)).row());
  kb.add(back(`msg:${ib.id}:${msg.id}`, '‹  Back to mail'));
  return { text, kb };
}

// ── push notification ────────────────────────────────────────────────────
export function notification(ib, msg, { codes, links }) {
  const from = msg.from || {};
  const lines = [
    `🛰 <b>New mail</b>  →  <code>${esc(ib.address)}</code>`,
    '',
    `<b>${senderName(from)}</b>  <i>${esc(from.address || '')}</i>`,
    `${esc(truncate(msg.subject || '(no subject)', 140))}`,
  ];
  if (codes.length) lines.push('', `🔑  <code>${esc(codes[0])}</code>${codes[1] ? `   ·   <code>${esc(codes[1])}</code>` : ''}`);
  else if (msg.intro) lines.push('', `<i>${esc(truncate(msg.intro, 160))}</i>`);

  const kb = new InlineKeyboard();
  if (codes.length) kb.add(copy(`⧉  ${codes[0]}`, codes[0]));
  kb.add(cb('Open  ›', `msg:${ib.id}:${msg.id}`)).row();
  if (links[0]) kb.url(links[0].label, links[0].url);
  return { text: lines.join('\n'), kb };
}

export function expired(address) {
  return {
    text: `💥 <code>${esc(address)}</code> self-destructed.\n<i>The address and all of its mail are gone for good.</i>`,
    kb: new InlineKeyboard().add(cb('✨  New address', 'nr'), cb('🏠  Home', 'home')),
  };
}

// ── addresses ────────────────────────────────────────────────────────────
export function addresses(list, activeId) {
  const lines = [`🗂 <b>Your addresses</b>  <i>${list.length}/${config.maxInboxes}</i>`, ''];
  const kb = new InlineKeyboard();
  if (!list.length) lines.push('<i>No addresses yet.</i>');
  list.forEach((ib) => {
    const on = Number(ib.id) === Number(activeId);
    const exp = ib.expires_at ? ` · 💣 ${shortDur((Number(ib.expires_at) - Date.now()) / 1000)}` : '';
    lines.push(`${on ? '◉' : '○'} <code>${esc(ib.address)}</code>`, `   <i>${ago(Number(ib.created_at))}${exp}</i>`);
    kb.add(cb(`${on ? '◉' : '○'}  ${truncate(ib.address, 34)}`, `sw:${ib.id}`)).row();
  });
  if (list.length) lines.push('', '<i>Tap one to make it active.</i>');
  if (list.length < config.maxInboxes) kb.add(cb('✨  New', 'np:0'));
  if (activeId) kb.add(cb('🗑  Delete active', `rm:${activeId}`));
  kb.row().add(back());
  return { text: lines.join('\n'), kb };
}

export function confirmDelete(ib) {
  return {
    text: `🗑 <b>Delete this address?</b>\n\n<code>${esc(ib.address)}</code>\n\n<i>The address and every mail in it will be wiped. This can’t be undone.</i>`,
    kb: new InlineKeyboard().add(cb('Yes, delete', `rmy:${ib.id}`), cb('Keep it', 'adr')),
  };
}

export function limitReached() {
  return {
    text: `🗂 <b>All ${config.maxInboxes} slots are in use</b>\n\nDelete an address to make room for a new one.`,
    kb: new InlineKeyboard().add(cb('🗂  Manage addresses', 'adr'), back()),
  };
}

// ── timer ────────────────────────────────────────────────────────────────
export function timer(ib) {
  const text = [
    `💣 <b>Self-destruct timer</b>`,
    '',
    `<code>${esc(ib.address)}</code>`,
    `└ ${timerLine(ib)}`,
    '',
    '<i>When the timer hits zero, the address and its mail are erased.</i>',
  ].join('\n');
  const kb = new InlineKeyboard();
  TIMERS.forEach(([sec, label], i) => {
    kb.add(cb(label, `tm:${ib.id}:${sec}`));
    if (i === 1 || i === 3) kb.row();
  });
  kb.row().add(back());
  return { text, kb };
}

// ── settings ─────────────────────────────────────────────────────────────
export function settings(user) {
  const text = [
    `⚙️ <b>Settings</b>`,
    '',
    `├ 🛰 Live notifications   <b>${user.notify ? 'ON' : 'OFF'}</b>`,
    `└ 💣 Default timer        <b>${ttlLabel(user.default_ttl)}</b>`,
    '',
    '<i>The default timer applies to new addresses.</i>',
  ].join('\n');
  const kb = new InlineKeyboard()
    .add(cb(user.notify ? '🔕  Mute notifications' : '🔔  Turn on notifications', 'set:n'))
    .row()
    .add(cb(`💣  Default timer: ${ttlLabel(user.default_ttl)}  ›`, 'set:t'))
    .row()
    .add(cb('🧨  Erase all my data', 'wipe'))
    .row()
    .add(back());
  return { text, kb };
}

export function confirmWipe() {
  return {
    text: '🧨 <b>Erase everything?</b>\n\nAll your addresses, their mail, your domains and your settings will be deleted.',
    kb: new InlineKeyboard().add(cb('Yes, erase all', 'wipey'), cb('Cancel', 'set')),
  };
}

export function wiped() {
  return {
    text: `${H()}\n\n🧹 All clean. Nothing of yours is left here.\n<i>Send /start whenever you need a new inbox.</i>`,
    kb: new InlineKeyboard().add(cb('✨  Start fresh', 'nr')),
  };
}

// ── profile ──────────────────────────────────────────────────────────────
export function profile(user, { live, myDomains, domainCount, sentToday, sendLimit, isAdmin }) {
  const days = Math.max(0, Math.floor((Date.now() - Number(user.created_at)) / 86_400_000));
  const domainLines = myDomains.length
    ? myDomains.map((d, i) => `${i === myDomains.length - 1 ? '└' : '├'} ${d.verified ? '✅' : '⏳'} ${esc(d.domain)}${d.can_send && d.worker_url ? ' ✉' : ''}${d.public ? ' 💎' : ''}`)
    : ['└ <i>none yet · add one in 🌐 Domains</i>'];
  const joined = new Date(Number(user.created_at)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const text = [
    `👤 <b>Profile</b>${isAdmin ? '  <i>· admin</i>' : ''}`,
    '',
    `├ <b>Name</b>        ${esc(user.first_name || '—')}`,
    `├ <b>Username</b>  ${user.username ? `@${esc(user.username)}` : '—'}`,
    `├ <b>User ID</b>    <code>${user.id}</code>`,
    `├ <b>Language</b>  ${esc(user.lang || '—')}`,
    `└ <b>Joined</b>      ${joined} · ${days}d ago`,
    '',
    '<b>Mail activity</b>',
    `├ ✨ Generated     <b>${user.generated || 0}</b>`,
    `├ 🗑 Disposed       <b>${user.disposed || 0}</b>`,
    `├ 📬 Live now       <b>${live}</b> / ${config.maxInboxes}`,
    `├ 📥 Received       <b>${user.received || 0}</b>`,
    `└ 📤 Sent              <b>${user.sent || 0}</b>  <i>· today ${sentToday}${sendLimit ? `/${sendLimit}` : ' · unlimited'}</i>`,
    '',
    `<b>Domains</b>  <i>${domainCount} available to you</i>`,
    ...domainLines,
    '',
    '<b>Preferences</b>',
    `├ 🛰 Notifications  <b>${user.notify ? 'ON' : 'OFF'}</b>`,
    `└ 💣 Default timer  <b>${ttlLabel(user.default_ttl)}</b>`,
  ].join('\n');
  const kb = new InlineKeyboard()
    .add(copy('⧉  Copy my ID', String(user.id)))
    .row()
    .add(cb('🌐  My domains', 'dom'), cb('🗂  Addresses', 'adr'))
    .row()
    .add(cb('⚙️  Settings', 'set'), back());
  return { text, kb };
}

// ── domains hub ──────────────────────────────────────────────────────────
export function domainsHub(all, myDomains, { allowAdd }) {
  const groups = {};
  for (const d of all.filter((x) => x.kind === 'public')) (groups[providerLabel(d.provider)] ||= []).push(d.domain);
  const premium = all.filter((d) => d.kind === 'premium');
  const lines = [`🌐 <b>Domains</b>  <i>${all.length} available</i>`, ''];
  if (myDomains.length) {
    lines.push('<b>⭐ Yours</b>');
    myDomains.forEach((d) => lines.push(`  ${d.verified ? '✅' : '⏳'} <code>${esc(d.domain)}</code>${d.can_send && d.worker_url ? '  ✉ can send' : ''}`));
    lines.push('');
  }
  if (premium.length) lines.push('<b>💎 Premium</b>', `  ${premium.map((d) => esc(d.domain)).join(' · ')}`, '');
  for (const [label, list] of Object.entries(groups)) {
    lines.push(`<b>◦ ${esc(label)}</b>  <i>${list.length}</i>`, `  <i>${list.map(esc).join(' · ')}</i>`, '');
  }
  if (allowAdd) lines.push('<i>Own a domain? Add it to receive, and even send, from any name @yourdomain.</i>');

  const kb = new InlineKeyboard().add(cb('✨  Create on a domain', 'np:0')).row();
  myDomains.forEach((d) => kb.add(cb(`${d.verified ? '✅' : '⏳'}  ${truncate(d.domain, 30)}  ›`, `dm:${d.id}`)).row());
  if (allowAdd) kb.add(cb('➕  Add my domain', 'dom:add')).row();
  kb.add(back());
  return { text: lines.join('\n'), kb };
}

export function askDomain() {
  const text = [
    `➕ <b>Add your domain</b>`,
    '',
    'Send me the domain you own, e.g. <code>example.com</code> or <code>mail.example.com</code>.',
    '',
    '<b>You’ll need</b>',
    '├ the domain added to a free Cloudflare account',
    '└ about 5 minutes for setup (I’ll guide you)',
  ].join('\n');
  return { text, kb: new InlineKeyboard().add(cb('✕  Cancel', 'dom')) };
}

export function domainManage(d, check, { isAdmin, botUrl }) {
  const tick = (ok) => (ok ? '✅' : '▫️');
  const c = check || {};
  const w = c.worker;
  const steps = [
    `${tick(true)} <b>1.</b> Add <code>${esc(d.domain)}</code> to Cloudflare (free plan is fine)`,
    `${tick(c.txtOk || d.verified)} <b>2.</b> DNS → add a <b>TXT</b> record`,
    `      name  <code>${esc(txtHost(d.domain))}</code>`,
    `      value <code>${esc(config.verifyToken(d.domain))}</code>`,
    `${tick(c.mxCloudflare)} <b>3.</b> Email → <b>Email Routing</b> → enable (adds MX records)`,
    `${tick(w?.ok)} <b>4.</b> Deploy the worker file I send you (📄 below)`,
    `      Routing rules → <b>Catch-all</b> → Send to a Worker → it`,
    `${tick(w?.ok)} <b>5.</b> Paste the worker URL here (🔗 below)`,
    `${tick(w?.canSend)} <b>6.</b> <i>Optional, for sending:</i> Email Service → onboard domain, add a <code>send_email</code> binding named <code>EMAIL</code>`,
  ];
  const status = d.verified ? (w?.ok ? (w.canSend ? '🟢 receiving + sending' : '🟢 receiving') : '🟡 verified, connect the worker') : '⏳ waiting for the DNS TXT record';
  const text = [
    `🏷 <b>${esc(d.domain)}</b>${d.public ? '  💎 <i>shared with all users</i>' : ''}`,
    `<i>${status}</i>`,
    '',
    ...steps,
    '',
    c.mxHosts?.length ? `<i>MX: ${esc(c.mxHosts.slice(0, 3).join(', '))}</i>` : '<i>MX: not found yet</i>',
    w && !w.ok && w.error ? `<i>Worker: ${esc(w.error)}</i>` : '',
    !botUrl ? '\n⚠️ <i>The bot has no public URL yet. Deploy it on Render first.</i>' : '',
  ].filter((l) => l !== '').join('\n');

  const kb = new InlineKeyboard()
    .add(cb('🔄  Check now', `dmc:${d.id}`), cb('📄  Worker files', `dmf:${d.id}`))
    .row()
    .add(cb(d.worker_url ? '🔗  Change worker URL' : '🔗  Set worker URL', `dmw:${d.id}`))
    .row();
  if (d.verified) kb.add(cb('✨  Create address here', `ncx:${d.id}`)).row();
  if (isAdmin) kb.add(cb(d.public ? '🔒  Make private' : '💎  Share with all users', `dmp:${d.id}`)).row();
  kb.add(cb('🗑  Remove', `dmr:${d.id}`), back('dom'));
  return { text, kb };
}

export function askWorkerUrl(d) {
  return {
    text: `🔗 <b>Worker URL for ${esc(d.domain)}</b>\n\nSend the URL Cloudflare shows after deploy, e.g.\n<code>https://crevio-${esc(d.domain.replace(/\./g, '-'))}.yourname.workers.dev</code>`,
    kb: new InlineKeyboard().add(cb('✕  Cancel', `dm:${d.id}`)),
  };
}

export function confirmRemoveDomain(d, n) {
  return {
    text: `🗑 <b>Remove ${esc(d.domain)}?</b>\n\n${n ? `<b>${n}</b> address${n === 1 ? '' : 'es'} on this domain will stop receiving mail.\n` : ''}<i>You can add it again later.</i>`,
    kb: new InlineKeyboard().add(cb('Yes, remove', `dmry:${d.id}`), cb('Keep', `dm:${d.id}`)),
  };
}

// ── compose ──────────────────────────────────────────────────────────────
export function composeNoSender(hasDomain) {
  const text = [
    `✉️ <b>Compose</b>`,
    '',
    'Mail is sent from <b>your own domain</b>, through your own Cloudflare. No third-party sender is involved.',
    '',
    hasDomain
      ? '⚠️ Your domain isn’t ready to send yet. Open it in 🌐 Domains and finish steps 4–6, then create an address on it.'
      : 'Public temp domains (mail.tm, guerrilla…) are receive-only. Add your domain once to unlock sending.',
  ].join('\n');
  return {
    text,
    kb: new InlineKeyboard().add(cb(hasDomain ? '🌐  Open my domains' : '➕  Add my domain', hasDomain ? 'dom' : 'dom:add')).row().add(back()),
  };
}

export function composePickFrom(list) {
  const kb = new InlineKeyboard();
  list.forEach((ib) => kb.add(cb(`✉  ${truncate(ib.address, 36)}`, `cmp:${ib.id}`)).row());
  kb.add(back());
  return { text: `✉️ <b>Compose</b>\n\nWhich address should it come from?`, kb };
}

export function composeAsk(step, draft, ib) {
  const prompts = {
    to: ['Who is it going to?', 'Send the recipient’s email address.'],
    subject: ['Subject?', 'Send the subject line, or tap Skip.'],
    body: ['Message', 'Write your message and send it.\n📎 You can also send files or photos to attach them.'],
  };
  const [title, hint] = prompts[step];
  const meta = [
    draft.to ? `├ <b>To</b>  ${esc(draft.to)}` : null,
    draft.subject ? `├ <b>Subject</b>  ${esc(truncate(draft.subject, 60))}` : null,
    draft.attachments?.length ? `├ 📎 ${draft.attachments.length} file(s)` : null,
  ].filter(Boolean);
  const text = [`✉️ <b>Compose</b>  <i>from ${esc(ib.address)}</i>`, '', ...meta, ...(meta.length ? [''] : []), `<b>${title}</b>`, `<i>${hint}</i>`].join('\n');
  const kb = new InlineKeyboard();
  if (step === 'subject') kb.add(cb('Skip  ›', 'cms:skip'));
  if (step === 'body' && draft.text) kb.add(cb('Preview  ›', 'cmv'));
  kb.add(cb('✕  Discard', 'cmx'));
  return { text, kb };
}

export function composePreview(draft, ib, { sentToday, limit }) {
  const size = (draft.attachments || []).reduce((s, a) => s + a.size, 0);
  const text = [
    `✉️ <b>Ready to send</b>`,
    '',
    `├ <b>From</b>  <code>${esc(ib.address)}</code>`,
    `├ <b>To</b>      ${esc(draft.to)}`,
    `└ <b>Subject</b>  ${esc(draft.subject || '(no subject)')}`,
    '',
    `<blockquote expandable>${esc(truncate(draft.text || '', 3000))}</blockquote>`,
    draft.attachments?.length ? `📎 <i>${draft.attachments.map((a) => esc(a.filename)).join(', ')} · ${fmtSize(size)}</i>` : '',
    `<i>Sent today: ${sentToday}${limit ? ` / ${limit}` : ' · no limit on your domain'}</i>`,
  ].filter(Boolean).join('\n');
  const kb = new InlineKeyboard()
    .add(cb('🚀  Send', 'cmgo'))
    .row()
    .add(cb('✏️  To', 'cme:to'), cb('✏️  Subject', 'cme:subject'), cb('✏️  Message', 'cme:body'))
    .row()
    .add(cb('✕  Discard', 'cmx'));
  return { text, kb };
}

export function sent(draft, ib) {
  return {
    text: `🚀 <b>Sent</b>\n\n<code>${esc(ib.address)}</code> → ${esc(draft.to)}\n<i>${esc(draft.subject || '(no subject)')}</i>`,
    kb: new InlineKeyboard().add(cb('✉️  Write another', `cmp:${ib.id}`), cb('🏠  Home', 'home')),
  };
}

// ── errors ───────────────────────────────────────────────────────────────
export function problem(kind, extra = '') {
  const map = {
    down: '🛠 <b>Mail servers are busy</b>\nCouldn’t reach them just now. Try again in a moment, or pick another domain.',
    slow: '⏳ <b>Easy there</b>\nToo many requests in a row. Give it a few seconds.',
    taken: '🙅 <b>That name is taken</b>\nTry another one. Adding a number or a dash usually works.',
    gone: '🫥 <b>Not found</b>\nThat mail or address no longer exists.',
    nodomain: '🌐 <b>Domain unavailable</b>\nThat domain isn’t available any more. Pick another one.',
    invalid: '✍️ <b>That name won’t work</b>\nUse 3–30 characters: a–z, 0–9, dash or underscore. Start and end with a letter or number.',
    baddomain: '🌐 <b>That doesn’t look like a domain</b>\nSend it like <code>example.com</code>, without http:// or slashes.',
    domaintaken: '🔒 <b>Already registered</b>\nThat domain is already set up by someone else.',
    domainoff: '🔒 <b>Custom domains are disabled</b> on this bot.',
    nosend: '✉️ <b>Can’t send from this address</b>\nSending only works from a verified custom domain with its worker connected.',
    sendlimit: `⏳ <b>Daily send limit reached</b>\nYou can send ${config.sendLimitShared} mails a day from shared domains. Add your own domain for no limit.`,
    sendfail: `⚠️ <b>Cloudflare refused the mail</b>\n<code>${esc(extra)}</code>\n<i>E_SENDER_NOT_VERIFIED → onboard the domain in Email Service.\nE_RECIPIENT_NOT_ALLOWED → the free plan only sends to verified addresses; Workers Paid sends to anyone.</i>`,
    banned: '⛔ <b>Sending is disabled for your account.</b>',
    noatt: '📎 This domain’s provider doesn’t allow attachment downloads.',
    badurl: '🔗 <b>That URL won’t work</b>\nSend the full https:// address of your worker.',
    badto: '📮 <b>That’s not an email address</b>\nSend it like <code>name@example.com</code>.',
  };
  return { text: map[kind] || map.down, kb: new InlineKeyboard().add(cb('🏠  Home', 'home')) };
}
