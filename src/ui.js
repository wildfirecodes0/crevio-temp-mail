// Every screen the bot can show. Each view returns { text, kb } — text is Telegram HTML.
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { esc, truncate, ago, shortDur, fmtSize, fmtDate } from './utils.js';

const BRAND = '<b>✦ CREVIO</b>';
const RULE = '<code>┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈</code>';

const copy = (text, value) => ({ text, copy_text: { text: String(value).slice(0, 256) } });
const cb = (text, data) => ({ text, callback_data: data });

export const TIMERS = [
  [600, '10 min'],
  [3600, '1 hour'],
  [86400, '24 hours'],
  [604800, '7 days'],
  [0, 'Never'],
];

const timerLine = (ib) => {
  if (!ib.expires_at) return '♾ lives until you delete it';
  const left = (Number(ib.expires_at) - Date.now()) / 1000;
  return left > 0 ? `💣 self-destructs in <b>${shortDur(left)}</b>` : '💣 self-destructing…';
};

const senderName = (from) => esc(truncate(from?.name || from?.address?.split('@')[0] || 'Unknown', 28));

// ── onboarding ───────────────────────────────────────────────────────────
export function welcome(firstName) {
  const text = [
    `${BRAND} <i>· disposable mail</i>`,
    '',
    `Hey ${esc(firstName || 'there')} 👋`,
    'A burner inbox, one tap away. Sign up anywhere — keep your real email out of it.',
    '',
    '⚡ <b>Instant</b>  <i>address ready in a second</i>',
    '🔑 <b>Smart</b>  <i>OTP codes pulled out, one-tap copy</i>',
    '🛰 <b>Live</b>  <i>new mail pushed straight to this chat</i>',
    '💣 <b>Self-destruct</b>  <i>set a timer, forget it exists</i>',
    '',
    RULE,
  ].join('\n');
  const kb = new InlineKeyboard()
    .add(cb('✨  Create my first address', 'nr'))
    .row()
    .add(cb('✍️  Pick a custom name', 'nc'), cb('❔  How it works', 'help'));
  return { text, kb };
}

export function help() {
  const text = [
    `${BRAND} <i>· how it works</i>`,
    '',
    '<b>1.</b> Create an address — random or your own name.',
    '<b>2.</b> Use it on any site that wants an email.',
    '<b>3.</b> Mail lands here instantly. Codes are detected and get a ⧉ copy button; verify links become buttons.',
    '',
    '<b>Tips</b>',
    `• You can keep up to <b>${config.maxInboxes}</b> addresses and switch between them.`,
    '• 💣 Timer wipes an address (and all its mail) automatically.',
    '• Open any mail in the full viewer to see it exactly as sent.',
    '',
    '<b>Commands</b>',
    '/new — fresh address   /inbox — open inbox',
    '/addresses — manage   /settings — preferences',
    '',
    '<i>Temp addresses are public-domain mailboxes. Never use them for banking or anything you can’t lose.</i>',
  ].join('\n');
  return { text, kb: new InlineKeyboard().add(cb('‹  Back', 'home')) };
}

// ── dashboard ────────────────────────────────────────────────────────────
export function dashboard(ib, { total, unread, index, count }) {
  const mailLine =
    total === null
      ? '📭 <i>mail server is slow — tap ↻</i>'
      : total
        ? `📬 <b>${total}</b> mail${total === 1 ? '' : 's'}${unread ? ` · <b>${unread}</b> unread` : ''}`
        : '📭 empty — waiting for mail';
  const text = [
    `${BRAND} <i>· address ${index} of ${count}</i>`,
    '',
    `<code>${esc(ib.address)}</code>`,
    '',
    `├ ${mailLine}`,
    `├ 🕓 created ${ago(Number(ib.created_at))}`,
    `└ ${timerLine(ib)}`,
    '',
    '<i>Tap the address to copy it.</i>',
  ].join('\n');

  const inboxLabel = total ? `📥  Inbox · ${total}${unread ? ` ● ${unread}` : ''}` : '📥  Inbox';
  const kb = new InlineKeyboard()
    .add(copy('⧉  Copy address', ib.address))
    .row()
    .add(cb(inboxLabel, `inb:${ib.id}:0`), cb('↻', `home:r`))
    .row()
    .add(cb('✨  New', 'new'), cb('🗂  Addresses', 'adr'))
    .row()
    .add(cb('💣  Timer', 'tmr'), cb('⚙  Settings', 'set'));
  return { text, kb };
}

// ── create flow ──────────────────────────────────────────────────────────
export function newAddress(domains, { pendingLocal } = {}) {
  const head = pendingLocal
    ? [`${BRAND} <i>· custom address</i>`, '', `<code>${esc(pendingLocal)}@</code><b>…</b>`, '', 'Pick a domain to finish it:']
    : [
        `${BRAND} <i>· new address</i>`,
        '',
        '🎲 Tap a domain for a <b>random</b> address,',
        'or ✍️ choose your own name.',
      ];
  const kb = new InlineKeyboard();
  domains.slice(0, 8).forEach((d, i) => {
    kb.add(cb(`${pendingLocal ? '◦' : '🎲'}  @${d.domain}`, `${pendingLocal ? 'ncd' : 'nr'}:${d.provider}:${d.domain}`));
    if (i % 2 === 1) kb.row();
  });
  kb.row();
  if (!pendingLocal) kb.add(cb('✍️  Custom name', 'nc')).row();
  kb.add(cb('‹  Back', 'home'));
  return { text: head.join('\n'), kb };
}

export function askCustom() {
  const text = [
    `${BRAND} <i>· custom address</i>`,
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
    `${BRAND} <i>· address ready</i>`,
    '',
    '✨ Fresh inbox, live and listening:',
    '',
    `<code>${esc(ib.address)}</code>`,
    '',
    `└ ${timerLine(ib)}`,
    '',
    '<i>Use it anywhere — I’ll ping you the moment mail lands.</i>',
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
      'Use this address anywhere — mail lands here',
      'and I’ll ping you the moment it arrives.',
    ].join('\n');
    kb.add(copy('⧉  Copy address', ib.address)).row().add(cb('↻  Refresh', `inb:${ib.id}:0:r`), cb('‹  Back', 'home'));
    return { text, kb };
  }

  const unread = msgs.filter((m) => !m.seen).length;
  const lines = [
    `📥 <b>Inbox</b>  <code>${esc(ib.address)}</code>`,
    `<i>${msgs.length} mail${msgs.length === 1 ? '' : 's'}${unread ? ` · ${unread} unread` : ''}${pages > 1 ? ` · page ${page + 1}/${pages}` : ''}</i>`,
    '',
  ];
  slice.forEach((m, i) => {
    const n = page * PAGE + i + 1;
    lines.push(
      `${m.seen ? '○' : '●'} <b>${senderName(m.from)}</b> <i>· ${ago(m.createdAt)}</i>${m.hasAttachments ? ' 📎' : ''}`,
      `   ${esc(truncate(m.subject || '(no subject)', 46))}`,
    );
    if (i < slice.length - 1) lines.push('');
    kb.add(cb(`${n}  ${m.seen ? '○' : '●'}  ${truncate(m.from?.name || m.from?.address || '', 14)} — ${truncate(m.subject || '(no subject)', 26)}`, `msg:${ib.id}:${m.id}`)).row();
  });

  if (pages > 1) {
    kb.add(
      cb(page > 0 ? '‹' : '·', page > 0 ? `inb:${ib.id}:${page - 1}` : 'noop'),
      cb(`${page + 1} / ${pages}`, 'noop'),
      cb(page < pages - 1 ? '›' : '·', page < pages - 1 ? `inb:${ib.id}:${page + 1}` : 'noop'),
    ).row();
  }
  kb.add(cb('↻  Refresh', `inb:${ib.id}:${page}:r`), cb('‹  Back', 'home'));
  return { text: lines.join('\n'), kb };
}

// ── single message ───────────────────────────────────────────────────────
export function message(ib, msg, { body, codes, links, viewerUrl }) {
  const from = msg.from || {};
  const head = [
    `✉️ <b>${esc(truncate(msg.subject || '(no subject)', 120))}</b>`,
    '',
    `<b>From</b>  ${senderName(from)} <i>‹${esc(from.address || '')}›</i>`,
    `<b>To</b>      <code>${esc(ib.address)}</code>`,
    `<b>When</b>  ${fmtDate(msg.createdAt)} · ${ago(msg.createdAt)}`,
  ];
  if (codes.length) {
    head.push('', `🔑 <b>Code detected</b>   ${codes.map((c) => `<code>${esc(c)}</code>`).join('  ·  ')}`);
  }
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
  kb.add(cb('🗑  Delete', `del:${ib.id}:${msg.id}`), cb('‹  Inbox', `inb:${ib.id}:0`));
  return { text, kb };
}

export function attachments(ib, msg) {
  const att = msg.attachments || [];
  const text = [
    `📎 <b>Attachments</b>`,
    `<i>${esc(truncate(msg.subject || '(no subject)', 60))}</i>`,
    '',
    ...att.map((a, i) => `<b>${i + 1}.</b> ${esc(truncate(a.filename || 'file', 48))} <i>· ${fmtSize(a.size)}</i>`),
    '',
    '<i>Tap one to receive it here. Max 20 MB.</i>',
  ].join('\n');
  const kb = new InlineKeyboard();
  att.slice(0, 10).forEach((a, i) => kb.add(cb(`⬇  ${truncate(a.filename || 'file', 30)}`, `atd:${ib.id}:${msg.id}:${i}`)).row());
  kb.add(cb('‹  Back to mail', `msg:${ib.id}:${msg.id}`));
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
  if (codes.length) kb.add(copy(`⧉  Copy ${codes[0]}`, codes[0]));
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
  list.forEach((ib) => {
    const on = Number(ib.id) === Number(activeId);
    const exp = ib.expires_at ? ` · 💣 ${shortDur((Number(ib.expires_at) - Date.now()) / 1000)}` : '';
    lines.push(`${on ? '◉' : '○'} <code>${esc(ib.address)}</code>`, `   <i>${ago(Number(ib.created_at))}${exp}</i>`);
    kb.add(cb(`${on ? '◉' : '○'}  ${truncate(ib.address, 34)}`, `sw:${ib.id}`)).row();
  });
  lines.push('', '<i>Tap one to make it active.</i>');
  if (list.length < config.maxInboxes) kb.add(cb('✨  New', 'new'));
  if (activeId) kb.add(cb('🗑  Delete active', `rm:${activeId}`));
  kb.row().add(cb('‹  Back', 'home'));
  return { text: lines.join('\n'), kb };
}

export function confirmDelete(ib) {
  return {
    text: `🗑 <b>Delete this address?</b>\n\n<code>${esc(ib.address)}</code>\n\n<i>It and every mail in it will be wiped. This can’t be undone.</i>`,
    kb: new InlineKeyboard().add(cb('Yes, delete', `rmy:${ib.id}`), cb('Keep it', 'adr')),
  };
}

export function limitReached() {
  return {
    text: `🗂 <b>All ${config.maxInboxes} slots in use</b>\n\nDelete an address to make room for a new one.`,
    kb: new InlineKeyboard().add(cb('🗂  Manage addresses', 'adr'), cb('‹  Back', 'home')),
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
    '<i>When the timer hits zero the address and its mail are erased.</i>',
  ].join('\n');
  const kb = new InlineKeyboard();
  TIMERS.forEach(([sec, label], i) => {
    kb.add(cb(label, `tm:${ib.id}:${sec}`));
    if (i === 1 || i === 3) kb.row();
  });
  kb.row().add(cb('‹  Back', 'home'));
  return { text, kb };
}

// ── settings ─────────────────────────────────────────────────────────────
export function settings(user) {
  const ttl = TIMERS.find(([s]) => s === Number(user.default_ttl))?.[1] ?? 'Never';
  const text = [
    `⚙ <b>Settings</b>`,
    '',
    `├ 🛰 Live notifications   <b>${user.notify ? 'ON' : 'OFF'}</b>`,
    `└ 💣 Default timer        <b>${ttl}</b>`,
    '',
    '<i>Default timer applies to new addresses.</i>',
  ].join('\n');
  const kb = new InlineKeyboard()
    .add(cb(user.notify ? '🔕  Mute notifications' : '🔔  Turn on notifications', 'set:n'))
    .row()
    .add(cb(`💣  Default timer: ${ttl}  ›`, 'set:t'))
    .row()
    .add(cb('🧨  Erase all my data', 'wipe'))
    .row()
    .add(cb('‹  Back', 'home'));
  return { text, kb };
}

export function confirmWipe() {
  return {
    text: '🧨 <b>Erase everything?</b>\n\nAll your addresses, their mail and your settings will be deleted.',
    kb: new InlineKeyboard().add(cb('Yes, erase all', 'wipey'), cb('Cancel', 'set')),
  };
}

export function wiped() {
  return {
    text: `${BRAND}\n\n🧹 All clean. Nothing of yours is left here.\n<i>Send /start whenever you need a new inbox.</i>`,
    kb: new InlineKeyboard().add(cb('✨  Start fresh', 'nr')),
  };
}

export function problem(kind) {
  const map = {
    down: '🛠 <b>Mail servers are busy</b>\nCouldn’t reach them just now — try again in a moment.',
    slow: '⏳ <b>Easy there</b>\nToo many requests in a row. Give it a few seconds.',
    taken: '🙅 <b>That name is taken</b>\nTry another one — add a number or a dash.',
    gone: '🫥 <b>Not found</b>\nThat mail or address no longer exists.',
    invalid:
      '✍️ <b>That name won’t work</b>\nUse 3–30 characters: a–z, 0–9, dash or underscore. Start and end with a letter or number.',
  };
  return {
    text: map[kind] || map.down,
    kb: new InlineKeyboard().add(cb('🏠  Home', 'home')),
  };
}
