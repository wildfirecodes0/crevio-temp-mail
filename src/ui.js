// Text for every screen (Telegram HTML). Navigation lives in the bottom keyboard (see screens in bot.js);
// inline buttons are used only on push notifications, where one-tap copy/open matters most.
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { esc, truncate, ago, shortDur, fmtSize, fmtDate } from './utils.js';
import { providerLabel } from './providers/index.js';
import { txtHost } from './domains.js';

export const BRAND = 'Crevio Mail Bot';
export const H = (sub) => `✦ <b>𝗖𝗥𝗘𝗩𝗜𝗢 𝗠𝗔𝗜𝗟</b>${sub ? `  ·  <i>${sub}</i>` : ''}`;
const card = (inner) => `<blockquote>${inner}</blockquote>`;
const addr = (a) => `<code>${esc(a)}</code>`;

export const TIMERS = [
  [600, '10 min'],
  [3600, '1 hour'],
  [86400, '24 hours'],
  [604800, '7 days'],
  [0, 'Never'],
];
export const ttlLabel = (sec) => TIMERS.find(([s]) => s === Number(sec))?.[1] ?? 'Never';

export function timerLine(ib) {
  if (!ib.expires_at) return '♾ No timer, lives until you delete it';
  const left = (Number(ib.expires_at) - Date.now()) / 1000;
  return left > 0 ? `💣 Self-destructs in <b>${shortDur(left)}</b>` : '💣 Self-destructing…';
}
export const timerShort = (ib) =>
  ib.expires_at ? `Expires in ${shortDur(Math.max(0, (Number(ib.expires_at) - Date.now()) / 1000))}` : 'No timer';

const senderName = (from) => esc(truncate(from?.name || from?.address?.split('@')[0] || 'Unknown', 28));
const sourceLabel = (ib) => (ib.provider === 'own' ? 'custom domain' : providerLabel(ib.provider));

// ── home ─────────────────────────────────────────────────────────────────
export function welcome(firstName, domainCount) {
  return [
    `<b>Hey ${esc(firstName || 'there')} 👋  Welcome to ${BRAND}.</b>`,
    '',
    'Burner inboxes in one tap. Sign up anywhere and keep your real email clean.',
    '',
    `⚡ ${domainCount}+ domains   🔑 OTP copy   🛰 live push`,
    '✉️ send mail   🏷 your own domain   💣 self-destruct',
    '',
    '<i>Tap ⚡ Instant address to get your first inbox.</i>',
  ].join('\n');
}

export function dashboard(ib, { total, unread, index, count, route }) {
  const mail =
    total === null ? '📡 <i>syncing…</i>' : total ? `📬 <b>${total}</b> mail${total === 1 ? '' : 's'}${unread ? `  ·  <b>${unread} new</b>` : ''}` : '📭 No mail yet';
  return [
    H(`address ${index} of ${count}`),
    '',
    card(`${addr(ib.address)}\n<i>tap to copy</i>`),
    mail,
    `🌐 ${esc(ib.address.split('@')[1])}  ·  <i>${sourceLabel(ib)}</i>`,
    `🕓 Created ${ago(Number(ib.created_at))}`,
    timerLine(ib),
    route ? `✉️ Can send${route.mode === 'relay' ? '  ·  <i>via Crevio relay</i>' : ''}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function created(ib) {
  return [
    `✨ <b>Your new address is live</b>`,
    '',
    card(addr(ib.address)),
    `🌐 <i>${sourceLabel(ib)}</i>  ·  ${timerLine(ib)}`,
    '',
    '<i>Tap the address to copy. I’ll ping you the moment mail arrives.</i>',
  ].join('\n');
}

export function help() {
  return [
    H('how it works'),
    '',
    '<b>1 ·</b> ✨ <b>New Mail</b> (menu below) → pick a domain, or ⚡ Instant.',
    '<b>2 ·</b> Use the address on any site.',
    '<b>3 ·</b> Mail arrives here instantly. Codes show up as <code>482913</code> (tap to copy), and verify links are clickable.',
    '',
    '<b>✉️ Sending</b>',
    'Compose works from any of your addresses. Replies come back to the same inbox.',
    '',
    '<b>🏷 Your own domain</b>',
    '🌐 Domains → ➕ Add my domain. You can then receive on <i>anything</i>@yourdomain and send from it directly.',
    '',
    '<b>Tips</b>',
    `• Up to <b>${config.maxInboxes}</b> addresses; switch in 🗂 Addresses.`,
    '• 💣 Timer wipes an address and its mail automatically.',
    '',
    '<i>Public temp domains can be read by anyone who guesses the name. Don’t use them for banking.</i>',
  ].join('\n');
}

// ── create ───────────────────────────────────────────────────────────────
export function picker(domains, { pendingLocal } = {}) {
  const custom = domains.filter((d) => d.kind !== 'public').length;
  if (pendingLocal) {
    return [H('custom address'), '', card(`${addr(`${pendingLocal}@`)}<b>…</b>`), '', `Pick a domain below to finish it.  <i>${domains.length} available</i>`].join('\n');
  }
  return [
    H('new address'),
    '',
    `<b>Pick a domain below</b>  <i>${domains.length} available</i>`,
    '',
    '⚡ <b>Instant</b>: random name on a random domain',
    '✍️ <b>Custom name</b>: choose the part before @',
    '🎲 Tap any <b>@domain</b>: random name on that domain',
    custom ? '\n⭐ your domain   💎 premium' : '',
  ].join('\n');
}

export const askCustom = (domain) =>
  [
    H('custom address'),
    '',
    domain ? `Send the name you want on <b>@${esc(domain)}</b>.` : 'Send the name you want before the <b>@</b>.',
    '',
    '<i>3–30 chars · a–z, 0–9, dash, underscore</i>',
    'e.g. <code>shop-alerts</code>  ·  <code>neo_2077</code>',
  ].join('\n');

// ── inbox ────────────────────────────────────────────────────────────────
export const PAGE = 8;

export function inbox(ib, msgs, page, pages) {
  if (!msgs.length) {
    return [
      `📥 <b>Inbox</b>`,
      card(addr(ib.address)),
      '',
      '<code>        ·  nothing here yet  ·        </code>',
      '',
      '<i>Use this address anywhere. New mail is pushed here instantly.</i>',
    ].join('\n');
  }
  const unread = msgs.filter((m) => !m.seen).length;
  const lines = [
    `📥 <b>Inbox</b>  ·  <i>${msgs.length} mail${msgs.length === 1 ? '' : 's'}${unread ? `, ${unread} new` : ''}${pages > 1 ? `  ·  page ${page + 1}/${pages}` : ''}</i>`,
    card(addr(ib.address)),
    '',
  ];
  msgs.slice(page * PAGE, page * PAGE + PAGE).forEach((m, i) => {
    lines.push(
      `<b>${page * PAGE + i + 1}.</b> ${m.seen ? '⚪' : '🔵'} <b>${senderName(m.from)}</b>  <i>${ago(m.createdAt)}</i>${m.hasAttachments ? ' 📎' : ''}`,
      `      ${esc(truncate(m.subject || '(no subject)', 52))}`,
    );
  });
  lines.push('', '<i>Tap a mail below to open it.</i>');
  return lines.join('\n');
}

export const inboxKey = (m, n) =>
  `${n}. ${m.seen ? '⚪' : '🔵'} ${truncate(m.from?.name || m.from?.address?.split('@')[0] || '?', 14)} · ${truncate(m.subject || '(no subject)', 24)}`;

// ── message ──────────────────────────────────────────────────────────────
export function message(ib, msg, { body, codes, links }) {
  const from = msg.from || {};
  const head = [
    `✉️ <b>${esc(truncate(msg.subject || '(no subject)', 140))}</b>`,
    '',
    `👤 ${senderName(from)}  <i>${esc(from.address || '')}</i>`,
    `📮 ${addr(ib.address)}`,
    `🕓 ${fmtDate(msg.createdAt)}  ·  ${ago(msg.createdAt)}`,
  ];
  if (codes.length) head.push('', card(`🔑 <b>Code</b>   ${codes.map((c) => addr(c)).join('   ')}\n<i>tap the code to copy</i>`));
  if (links.length) head.push(links.map((l) => `<a href="${esc(l.url).replace(/"/g, '&quot;')}">${l.label}  ›</a>`).join('    '));
  const att = msg.attachments || [];
  const foot = att.length ? `\n📎 <i>${att.length} attachment${att.length === 1 ? '' : 's'} · ${fmtSize(att.reduce((s, a) => s + (a.size || 0), 0))}</i>` : '';
  const headText = head.join('\n');
  const budget = 3900 - headText.length - foot.length - 80;
  const shown = body ? esc(truncate(body, Math.max(200, Math.floor(budget * 0.85)))) : '<i>(empty message)</i>';
  return `${headText}\n\n<blockquote expandable>${shown}</blockquote>${foot}`;
}

export const attachments = (msg, downloadable) =>
  [
    `📎 <b>Attachments</b>  ·  <i>${esc(truncate(msg.subject || '(no subject)', 50))}</i>`,
    '',
    ...(msg.attachments || []).map((a, i) => `<b>${i + 1}.</b> ${esc(truncate(a.filename || 'file', 48))}  <i>${fmtSize(a.size)}</i>`),
    '',
    downloadable ? '<i>Tap a file below to get it here (max 20 MB).</i>' : '<i>This provider doesn’t allow attachment downloads. Use 🖥 Open full email instead.</i>',
  ].join('\n');

// ── push notification (inline: copy + open) ─────────────────────────────
export function notification(ib, msg, { codes, links }) {
  const from = msg.from || {};
  const lines = [
    `🛰 <b>New mail</b>  →  ${addr(ib.address)}`,
    '',
    `<b>${senderName(from)}</b>  <i>${esc(from.address || '')}</i>`,
    esc(truncate(msg.subject || '(no subject)', 140)),
  ];
  if (codes.length) lines.push('', card(`🔑 ${codes.map(addr).join('   ')}`));
  else if (msg.intro) lines.push('', `<i>${esc(truncate(msg.intro, 160))}</i>`);
  const kb = new InlineKeyboard();
  if (codes.length) kb.add({ text: `⧉  Copy ${codes[0]}`, copy_text: { text: codes[0] } });
  kb.add({ text: '📖  Open', callback_data: `msg:${ib.id}:${msg.id}` });
  if (links[0]) kb.row().url(links[0].label, links[0].url);
  return { text: lines.join('\n'), kb };
}

export const expired = (address) => ({
  text: `💥 ${addr(address)} self-destructed.\n<i>The address and all of its mail are gone for good.</i>`,
  kb: new InlineKeyboard().add({ text: '✨  New address', callback_data: 'nr' }),
});

// ── addresses / timer / settings ─────────────────────────────────────────
export function addresses(list, activeId) {
  const lines = [`🗂 <b>Your addresses</b>  ·  <i>${list.length} of ${config.maxInboxes}</i>`, ''];
  if (!list.length) lines.push('<i>No addresses yet. Tap ✨ New Mail.</i>');
  list.forEach((ib) => {
    const on = Number(ib.id) === Number(activeId);
    lines.push(`${on ? '◉' : '○'} ${addr(ib.address)}${on ? '  <b>active</b>' : ''}`, `     <i>${sourceLabel(ib)} · ${ago(Number(ib.created_at))} · ${timerShort(ib)}</i>`);
  });
  if (list.length) lines.push('', '<i>Tap an address below to switch to it.</i>');
  return lines.join('\n');
}

export const confirmDelete = (ib) => `🗑 <b>Delete this address?</b>\n\n${card(addr(ib.address))}\n<i>The address and every mail in it will be wiped. This can’t be undone.</i>`;

export const timer = (ib) =>
  [`💣 <b>Self-destruct timer</b>`, '', card(addr(ib.address)), timerLine(ib), '', '<i>Pick when this address should erase itself, along with all its mail.</i>'].join('\n');

export const settings = (user) =>
  [
    `⚙️ <b>Settings</b>`,
    '',
    `🛰 Live notifications  ·  <b>${user.notify ? 'ON' : 'OFF'}</b>`,
    `💣 Default timer for new addresses  ·  <b>${ttlLabel(user.default_ttl)}</b>`,
    '',
    '<i>Tap a setting below to change it.</i>',
  ].join('\n');

export const confirmWipe = () => '🧨 <b>Erase everything?</b>\n\nAll your addresses, their mail, your domains and your settings will be deleted. This can’t be undone.';

// ── profile ──────────────────────────────────────────────────────────────
export function profile(user, { myDomains, domainCount, sentToday, sendLimit, isAdmin, route }) {
  const joined = new Date(Number(user.created_at)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return [
    `👤 <b>${esc(user.first_name || 'Profile')}</b>${isAdmin ? '  ·  <i>admin</i>' : ''}`,
    '',
    `🆔 <code>${user.id}</code>   ${user.username ? `@${esc(user.username)}` : '<i>no username</i>'}`,
    `🌍 Language <b>${esc(user.lang || '—')}</b>   📅 Joined <b>${joined}</b>`,
    `📤 Sent today <b>${sentToday}</b>${sendLimit ? ` / ${sendLimit}` : '  <i>(no limit)</i>'}${route ? '' : '  <i>· sending not enabled</i>'}`,
    `🌐 <b>${domainCount}</b> domains available${myDomains.length ? `  ·  yours: ${myDomains.map((d) => `${d.verified ? '✅' : '⏳'} ${esc(d.domain)}`).join(', ')}` : ''}`,
    `🛰 Notifications <b>${user.notify ? 'ON' : 'OFF'}</b>   💣 Default timer <b>${ttlLabel(user.default_ttl)}</b>`,
  ].join('\n');
}

// ── domains ──────────────────────────────────────────────────────────────
export function domainsHub(all, myDomains, { allowAdd }) {
  const groups = {};
  for (const d of all.filter((x) => x.kind === 'public')) (groups[providerLabel(d.provider)] ||= []).push(d.domain);
  const premium = all.filter((d) => d.kind === 'premium');
  const lines = [`🌐 <b>Domains</b>  ·  <i>${all.length} available</i>`, ''];
  if (myDomains.length) {
    lines.push('<b>⭐ Yours</b>');
    myDomains.forEach((d) => lines.push(`   ${d.verified ? '✅' : '⏳'} ${addr(d.domain)}${d.can_send && d.worker_url ? '  ✉ sends' : ''}`));
    lines.push('');
  }
  if (premium.length) lines.push('<b>💎 Premium</b>', `   ${premium.map((d) => esc(d.domain)).join('  ·  ')}`, '');
  for (const [label, list] of Object.entries(groups)) lines.push(`<b>◦ ${esc(label)}</b>  <i>${list.length}</i>`, `   <i>${list.map(esc).join('  ·  ')}</i>`, '');
  if (allowAdd) lines.push('<i>Own a domain? ➕ Add it to receive on any name @yourdomain and send from it.</i>');
  return lines.join('\n');
}

export const askDomain = () =>
  [
    `➕ <b>Add your domain</b>`,
    '',
    'Send the domain you own, like <code>example.com</code> or <code>mail.example.com</code>.',
    '',
    '<i>You’ll need a free Cloudflare account. Setup takes about 5 minutes and I’ll guide you through it.</i>',
  ].join('\n');

export function domainManage(d, check, { botUrl, relay }) {
  const c = check || {};
  const w = c.worker;
  const tick = (ok) => (ok ? '✅' : '▫️');
  const status = d.verified ? (w?.ok ? (w.canSend ? '🟢 receiving + sending' : '🟢 receiving') : '🟡 verified · connect the worker') : '⏳ waiting for the DNS TXT record';
  return [
    `🏷 <b>${esc(d.domain)}</b>${d.public ? '  ·  💎 <i>shared with everyone</i>' : ''}${relay ? '  ·  🛰 <i>send relay</i>' : ''}`,
    `<i>${status}</i>`,
    '',
    `${tick(true)} <b>1</b>  Add the domain to Cloudflare (free plan is fine)`,
    `${tick(c.txtOk || d.verified)} <b>2</b>  DNS → add a <b>TXT</b> record`,
    card(`name   <code>${esc(txtHost(d.domain))}</code>\nvalue  <code>${esc(config.verifyToken(d.domain))}</code>`),
    `${tick(c.mxCloudflare)} <b>3</b>  Email → <b>Email Routing</b> → enable`,
    `${tick(w?.ok)} <b>4</b>  Deploy the worker (📄 Worker files), then set Routing rules → <b>Catch-all</b> → Send to a Worker`,
    `${tick(w?.ok)} <b>5</b>  🔗 Paste the worker URL here`,
    `${tick(w?.canSend)} <b>6</b>  <i>For sending:</i> Email Service → onboard domain + <code>send_email</code> binding <code>EMAIL</code>`,
    '',
    c.mxHosts?.length ? `<i>MX: ${esc(c.mxHosts.slice(0, 3).join(', '))}</i>` : '<i>MX: not found yet</i>',
    w && !w.ok && w.error ? `<i>Worker: ${esc(w.error)}</i>` : '',
    !botUrl ? '⚠️ <i>The bot has no public URL yet. Deploy on Render first.</i>' : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export const askWorkerUrl = (d) =>
  `🔗 <b>Worker URL for ${esc(d.domain)}</b>\n\nSend the URL Cloudflare shows after you deploy, like\n<code>https://crevio-${esc(d.domain.replace(/\./g, '-'))}.yourname.workers.dev</code>`;

export const confirmRemoveDomain = (d, n) =>
  `🗑 <b>Remove ${esc(d.domain)}?</b>\n\n${n ? `<b>${n}</b> address${n === 1 ? '' : 'es'} on it will be deleted.\n` : ''}<i>You can add the domain again later.</i>`;

// ── compose ──────────────────────────────────────────────────────────────
function fromBlock(ib, sender) {
  return sender.replyTo
    ? card(`From  ${addr(sender.email)}\nReplies →  ${addr(ib.address)}`)
    : card(`From  ${addr(ib.address)}`);
}

export function composeAsk(step, draft, ib, sender) {
  const prompts = {
    to: '📮 <b>Who is it for?</b>\nSend the recipient’s email (up to 10, separated by commas).',
    subject: '🏷 <b>Subject?</b>\nSend a subject line, or tap ⏭ No subject.',
    body: '📝 <b>Your message</b>\nWrite it and send. You can also send 📎 files or photos to attach them.',
  };
  const meta = [
    draft.to ? `📮 ${esc(draft.to)}` : '',
    draft.subject ? `🏷 ${esc(truncate(draft.subject, 70))}` : '',
    draft.attachments?.length ? `📎 ${draft.attachments.map((a) => esc(a.filename)).join(', ')}` : '',
  ].filter(Boolean);
  return [`✉️ <b>New mail</b>`, '', fromBlock(ib, sender), ...meta, ...(meta.length ? [''] : []), prompts[step]].join('\n');
}

export function composePreview(draft, ib, sender, { sentToday, limit }) {
  const size = (draft.attachments || []).reduce((s, a) => s + a.size, 0);
  return [
    `✉️ <b>Ready to send</b>`,
    '',
    fromBlock(ib, sender),
    `📮 <b>To</b>  ${esc(draft.to)}`,
    `🏷 <b>Subject</b>  ${esc(draft.subject || '(no subject)')}`,
    draft.attachments?.length ? `📎 ${draft.attachments.map((a) => esc(a.filename)).join(', ')}  <i>${fmtSize(size)}</i>` : '',
    '',
    `<blockquote expandable>${esc(truncate(draft.text || '', 3000))}</blockquote>`,
    `<i>Sent today: ${sentToday}${limit ? ` of ${limit}` : ' · no daily limit'}</i>`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export const sent = (draft, sender) =>
  `🚀 <b>Sent!</b>\n\n${card(`${addr(sender.email)}  →  ${esc(draft.to)}\n<i>${esc(draft.subject || '(no subject)')}</i>`)}${sender.replyTo ? `\n<i>Replies will arrive in ${addr(sender.replyTo)}.</i>` : ''}`;

export const composeUnavailable = (isAdmin) =>
  [
    `✉️ <b>Sending isn’t switched on yet</b>`,
    '',
    isAdmin
      ? 'As admin: add your domain in 🌐 Domains, finish the setup including step 6 (sending), then tap 💎 Share with everyone. It becomes the send relay, and <b>every user</b> can send from any of their addresses.'
      : 'The bot owner hasn’t enabled sending yet. You can still add your own domain in 🌐 Domains and send from it directly.',
  ].join('\n');

// ── errors ───────────────────────────────────────────────────────────────
export function problem(kind, extra = '') {
  const map = {
    down: '🛠 <b>Mail servers are busy</b>\nCouldn’t reach them just now. Try again, or pick another domain.',
    slow: '⏳ <b>Easy there</b>\nToo many requests in a row. Give it a few seconds.',
    taken: '🙅 <b>That name is taken</b>\nTry another one. Adding a number or a dash usually works.',
    gone: '🫥 <b>Not found</b>\nThat mail or address no longer exists.',
    nodomain: '🌐 <b>Domain unavailable</b>\nPick another one.',
    invalid: '✍️ <b>That name won’t work</b>\nUse 3–30 characters: a–z, 0–9, dash or underscore.',
    baddomain: '🌐 <b>That doesn’t look like a domain</b>\nSend it like <code>example.com</code>.',
    domaintaken: '🔒 <b>Already registered</b>\nThat domain is set up by someone else.',
    domainoff: '🔒 <b>Custom domains are disabled</b> on this bot.',
    nosend: '✉️ <b>Sending isn’t available</b> for this address right now.',
    sendlimit: `⏳ <b>Daily send limit reached</b>\nYou can send ${config.sendLimitShared} mails a day through the shared relay. Add your own domain for no limit.`,
    sendfail: `⚠️ <b>The mail couldn’t be sent</b>\n<code>${esc(extra)}</code>\n<i>E_SENDER_NOT_VERIFIED → the domain isn’t onboarded in Email Service.\nE_RECIPIENT_NOT_ALLOWED → Cloudflare’s free plan only sends to verified addresses.</i>`,
    banned: '⛔ <b>Sending is disabled for your account.</b>',
    noatt: '📎 This provider doesn’t allow attachment downloads.',
    badurl: '🔗 <b>That URL won’t work</b>\nSend the full https:// address of your worker.',
    badto: '📮 <b>That’s not an email address</b>\nSend it like <code>name@example.com</code>.',
    toobig: '📎 <b>Too large</b>\nAttachments are limited to 15 MB in total.',
    limit: `🗂 <b>All ${config.maxInboxes} slots are in use</b>\nDelete an address in 🗂 Addresses to make room.`,
  };
  return map[kind] || map.down;
}
