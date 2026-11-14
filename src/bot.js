import { Bot, InputFile, GrammyError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { config } from './config.js';
import * as store from './db.js';
import * as ui from './ui.js';
import * as svc from './service.js';
import { UserFacingError } from './service.js';
import { domainsFor, publicDomains, provider, providerLabel } from './providers/index.js';
import { bodyText, extractCodes, extractActionLinks } from './extract.js';
import { viewerUrl } from './viewer.js';
import { LOCAL_RE, normalizeLocal } from './names.js';
import { checkDomain, pingWorker, workerFiles, txtHost } from './domains.js';
import { sendMail, sendLimitFor, senderFor } from './send.js';
import { welcomeCard, addressCard, profileCard } from './cards.js';
import { present, act, url, webapp, copy, busy, screenOf, clearInput, resolveToken } from './router.js';
import { within, esc, isEmail, isDomain, truncate } from './utils.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const isAdmin = (id) => config.adminIds.includes(Number(id));

export function analyse(msg) {
  const body = bodyText(msg);
  return { body, codes: extractCodes(msg.subject, body), links: extractActionLinks(msg) };
}

// ── main menu (bottom reply keyboard, never changes) ─────────────────────
const KB_VER = 6;
const M = {
  home: '🏠 Home',
  inbox: '📥 Inbox',
  new: '✨ New Mail',
  compose: '✉️ Compose',
  addresses: '🗂 Addresses',
  domains: '🌐 Domains',
  profile: '👤 Profile',
  settings: '⚙️ Settings',
  help: '❔ Help',
};
const mainKeyboard = {
  keyboard: [
    [{ text: M.home }, { text: M.inbox }, { text: M.new }],
    [{ text: M.compose }, { text: M.addresses }, { text: M.domains }],
    [{ text: M.profile }, { text: M.settings }, { text: M.help }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'Crevio Mail Bot',
};

/**
 * Telegram shows a reply keyboard only while the message that carried it still exists; deleting that message
 * removes the menu. So the menu rides on one permanent "carrier": a single 📬 emoji, which Telegram renders
 * as a big animated emoji without a bubble. It is never deleted by panel navigation, and is replaced only on
 * /start, /menu, or when the menu layout version changes.
 */
async function ensureMenu(ctx, force = false) {
  const user = store.getUser(ctx.from.id);
  if (!user || (!force && user.kb_ver === KB_VER && user.anchor_msg)) return;
  const old = user.anchor_msg;
  const m = await ctx.api.sendMessage(ctx.chat.id, '📬', { reply_markup: mainKeyboard, disable_notification: true });
  store.setUser(user.id, { anchor_msg: m.message_id, kb_ver: KB_VER });
  if (old && old !== m.message_id) ctx.api.deleteMessage(ctx.chat.id, old).catch(() => {});
}

const drafts = new Map(); // userId → { inboxId, step, draft }
const userOf = (ctx) => store.getUser(ctx.from.id);
const activeOf = (ctx) => store.getActiveInbox(userOf(ctx));
const counts = (list) => (list ? { total: list.length, unread: list.filter((m) => !m.seen).length } : null);
const toast = (ctx, text, alert) => ctx.toast?.(text, alert);

// ── screens ──────────────────────────────────────────────────────────────
const S = {};
// Home lives in the bottom menu, so screens don't repeat it as an inline button.
// Rows that would hold only `homeBtn` simply disappear (falsy buttons and empty rows are dropped).
const homeBtn = null;
const backRow = (back) => [back].filter(Boolean);

S.problem = (ctx, kind, { extra, back } = {}) => present(ctx, { name: 'problem', text: ui.problem(kind, extra), kb: [backRow(back)] });

function fail(ctx, e, back) {
  if (e instanceof UserFacingError) return S.problem(ctx, e.message, { extra: e.code, back });
  console.error('[action]', e);
  return S.problem(ctx, 'down', { back });
}

function dashboardScreen(ib, meta, c) {
  const inboxLabel = c?.total ? `📥 Inbox · ${c.total}${c.unread ? `  (${c.unread} new)` : ''}` : '📥 Open inbox';
  return {
    name: 'home',
    text: ui.dashboard(ib, { ...meta, total: c ? c.total : null, unread: c?.unread ?? 0 }),
    kb: [
      [copy('⧉ Copy address', ib.address)],
      [act(inboxLabel, (x) => S.inbox(x, ib.id)), act('🔄', (x) => S.home(x, { force: true, toast: '🔄 Refreshed' }))],
      [act('💣 Timer', (x) => S.timer(x)), act('🔁 Switch', (x) => S.addresses(x)), meta.route ? act('✉️ Send', (x) => S.compose(x, ib.id)) : null],
    ],
  };
}

S.home = async (ctx, { force = false, fresh = false, toast: t } = {}) => {
  const user = userOf(ctx);
  const ib = store.getActiveInbox(user);
  if (!ib) {
    const n = (await domainsFor(user.id)).length;
    return present(ctx, {
      name: 'welcome',
      text: ui.welcome(ctx.from.first_name, n),
      photo: { key: `welcome:${n}`, buffer: () => welcomeCard(n) },
      kb: [
        [act('⚡ Instant address', (c) => S.create(c, {}))],
        [act('🌐 Choose domain', (c) => S.picker(c)), act('✍️ Custom name', (c) => S.custom(c))],
        [act('❔ How it works', (c) => S.help(c))],
      ],
    }, { fresh });
  }
  const list = store.listInboxes(user.id);
  const meta = { index: list.findIndex((x) => x.id === ib.id) + 1, count: list.length, route: svc.sendRoute(ib) };
  const cached = svc.cachedList(ib.id);
  let msgs = !force && cached && Date.now() - cached.at < 45_000 ? cached.list : null;
  let pending = null;
  if (!msgs) {
    busy(ctx);
    pending = svc.fetchList(ib);
    pending.catch((e) => console.warn(`[home] ${ib.address}: ${e.message}`));
    msgs = await within(pending, 1500, null);
    if (msgs) pending = null;
    else msgs = cached?.list ?? null;
  }
  if (t) toast(ctx, t);
  await present(ctx, dashboardScreen(ib, meta, counts(msgs)), { fresh });
  // Slow provider: fill the numbers in as soon as they arrive (if the user is still on this screen).
  pending
    ?.then((list2) => {
      if (screenOf(ctx.from.id)?.name !== 'home') return;
      ctx.editPanel = true;
      return present(ctx, dashboardScreen(ib, meta, counts(list2)));
    })
    .catch(() => {});
};

S.help = (ctx, opts) =>
  present(ctx, {
    name: 'help',
    text: ui.help(),
    kb: [[act('✨ New address', (c) => S.picker(c)), act('🌐 Domains', (c) => S.domains(c))], [homeBtn]],
  }, opts);

// ── create ───────────────────────────────────────────────────────────────
S.picker = async (ctx, { page = 0, pendingLocal, fresh } = {}) => {
  const user = userOf(ctx);
  if (!pendingLocal && store.countInboxes(user.id) >= config.maxInboxes) {
    return S.problem(ctx, 'limit', { back: act('🗂 Addresses', (c) => S.addresses(c)) });
  }
  busy(ctx);
  const domains = await domainsFor(user.id);
  if (!domains.length) return S.problem(ctx, 'down');
  const pages = Math.ceil(domains.length / ui.PAGE);
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = domains.slice(page * ui.PAGE, page * ui.PAGE + ui.PAGE);
  const kb = [
    pendingLocal ? null : [act('⚡ Instant', (c) => S.create(c, {})), act('✍️ Custom name', (c) => S.custom(c))],
    ...numberRows(slice, page * ui.PAGE, (c, d) => S.create(c, { provider: d.provider, domain: d.domain, local: pendingLocal })),
    pagerRow(page, pages, (c, p) => S.picker(c, { page: p, pendingLocal }), `${domains.length} domains`),
    pendingLocal ? [act('✖ Cancel', (c) => S.home(c))] : [act('➕ Add my domain', (c) => S.addDomain(c))],
  ];
  const text = ui.picker(slice, { total: domains.length, offset: page * ui.PAGE, page, pages, pendingLocal });
  return present(ctx, { name: 'picker', text, kb }, { fresh });
};

S.custom = (ctx, preset) => {
  if (store.countInboxes(ctx.from.id) >= config.maxInboxes) return S.problem(ctx, 'limit');
  return present(ctx, {
    name: 'custom',
    text: ui.askCustom(preset?.domain),
    kb: [preset ? [act('🎲 Random name', (c) => S.create(c, preset))] : null, [act('✖ Cancel', (c) => S.home(c))]],
    input: async (c, text) => {
      const local = normalizeLocal(text);
      if (!LOCAL_RE.test(local) || local.length < 3) return S.problem(c, 'invalid', { back: act('✍️ Try again', (x) => S.custom(x, preset)) });
      return preset ? S.create(c, { ...preset, local }) : S.picker(c, { pendingLocal: local });
    },
  });
};

S.create = async (ctx, opts) => {
  toast(ctx, '✨ Creating…');
  busy(ctx);
  let ib;
  try {
    ib = await svc.createInbox(userOf(ctx), opts);
  } catch (e) {
    return fail(ctx, e, act('✨ Pick another', (c) => S.picker(c)));
  }
  return present(ctx, {
    name: 'created',
    text: ui.created(ib),
    photo: {
      key: `addr:${ib.address}:${ib.expires_at || 0}`,
      buffer: () => addressCard({ address: ib.address, provider: ib.provider === 'own' ? 'custom domain' : providerLabel(ib.provider), timer: ui.timerShort(ib) }),
    },
    kb: [
      [copy('⧉ Copy address', ib.address)],
      [act('📥 Open inbox', (c) => S.inbox(c, ib.id)), act('💣 Set timer', (c) => S.timer(c))],
      [homeBtn],
    ],
  });
};

// ── inbox & mail ─────────────────────────────────────────────────────────
/** Rows of « n » buttons, 5 per row. */
function numberRows(items, offset, onTap) {
  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    rows.push(items.slice(i, i + 5).map((item, j) => act(`« ${offset + i + j + 1} »`, (c) => onTap(c, item))));
  }
  return rows;
}

/** ‹ Prev · n / N · Next › row (null when there is only one page). */
function pagerRow(page, pages, go, note) {
  if (pages <= 1) return null;
  return [
    page > 0 ? act('‹ Prev', (c) => go(c, page - 1)) : null,
    act(`${page + 1} / ${pages}`, (c) => toast(c, note)),
    page < pages - 1 ? act('Next ›', (c) => go(c, page + 1)) : null,
  ];
}

S.inbox = async (ctx, inboxId, { page = 0, refresh = false, fresh } = {}) => {
  const ib = inboxId ? store.getOwnedInbox(ctx.from.id, inboxId) : activeOf(ctx);
  if (!ib) return S.home(ctx, { fresh });
  busy(ctx);
  let msgs;
  try {
    msgs = refresh ? await svc.fetchList(ib) : await svc.getList(ib, 5000);
  } catch (e) {
    console.warn(`[inbox] ${ib.address}: ${e.message}`);
    return S.problem(ctx, 'down', { back: act('🔄 Retry', (c) => S.inbox(c, ib.id, { refresh: true })) });
  }
  if (refresh) toast(ctx, msgs.length ? `🔄 ${msgs.length} mail${msgs.length === 1 ? '' : 's'}` : '🔄 Still empty');
  store.markSeen(ib.id, msgs.map((m) => m.id)).catch(() => {});
  const pages = Math.max(1, Math.ceil(msgs.length / ui.PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = msgs.slice(page * ui.PAGE, page * ui.PAGE + ui.PAGE);
  const kb = [
    ...numberRows(slice, page * ui.PAGE, (c, m) => S.message(c, ib, m.id)),
    pagerRow(page, pages, (c, p) => S.inbox(c, ib.id, { page: p }), `${msgs.length} mails`),
    msgs.length ? null : [copy('⧉ Copy address', ib.address)],
    [act('🔄 Refresh', (c) => S.inbox(c, ib.id, { page, refresh: true })), svc.sendRoute(ib) ? act('✉️ Compose', (c) => S.compose(c, ib.id)) : null],
    store.countInboxes(ctx.from.id) > 1 ? [act('🔁 Switch address', (c) => S.addresses(c))] : null,
  ];
  return present(ctx, { name: 'inbox', text: ui.inbox(ib, msgs, page, pages), kb }, { fresh });
};

S.message = async (ctx, ib, msgId, opts) => {
  busy(ctx);
  let msg;
  try {
    msg = await svc.getMessage(ib, msgId);
  } catch {
    return S.problem(ctx, 'gone', { back: act('‹ Inbox', (c) => S.inbox(c, ib.id)) });
  }
  // Position in the inbox, for "Mail 2 of 5" and prev/next navigation.
  const list = (await within(svc.getList(ib, 30_000).catch(() => null), 1500, null)) ?? svc.cachedList(ib.id)?.list ?? [];
  const at = list.findIndex((m) => m.id === msg.id);
  const wasNew = at >= 0 ? !list[at].seen : !msg.seen;
  svc.markRead(ib, msg.id).catch(() => {});
  const a = analyse(msg);
  const view = viewerUrl(ib.id, msg.id);
  const att = msg.attachments || [];
  const canReply = svc.canSendFrom(ib) && msg.from?.address;
  const prev = at > 0 ? list[at - 1] : null;
  const next = at >= 0 && at < list.length - 1 ? list[at + 1] : null;
  return present(ctx, {
    name: 'message',
    text: ui.message(ib, msg, a, { index: at >= 0 ? at + 1 : 0, total: list.length, wasNew }),
    kb: [
      a.codes.map((code) => copy(`⧉ Copy ${code}`, code)),
      a.links.map((l) => url(l.label, l.url)),
      view ? [webapp('🖥 Open full email', view)] : null,
      [att.length ? act(`📎 Files · ${att.length}`, (c) => S.attachments(c, ib, msg)) : null, canReply ? act('↩️ Reply', (c) => S.reply(c, ib, msg)) : null],
      prev || next ? [prev ? act('‹ Newer', (c) => S.message(c, ib, prev.id)) : null, next ? act('Older ›', (c) => S.message(c, ib, next.id)) : null] : null,
      [act('🗑 Delete', async (c) => {
        await svc.deleteMessage(ib, msg.id);
        toast(c, '🗑 Deleted');
        return S.inbox(c, ib.id, { page: Math.floor(Math.max(0, at) / ui.PAGE) });
      }), act('‹ Inbox', (c) => S.inbox(c, ib.id, { page: Math.floor(Math.max(0, at) / ui.PAGE) }))],
    ],
  }, opts);
};

S.attachments = (ctx, ib, msg) => {
  const downloadable = provider(ib.provider).caps.attachments;
  const files = (msg.attachments || []).slice(0, 20);
  const kb = [
    ...(downloadable ? numberRows(files, 0, (c, a) => S.download(c, ib, msg, a)) : []),
    [act('‹ Back to mail', (c) => S.message(c, ib, msg.id))],
  ];
  return present(ctx, { name: 'attachments', text: ui.attachments(msg, downloadable), kb });
};

S.download = async (ctx, ib, msg, a) => {
  if (a.size > 20 * 1024 * 1024) return toast(ctx, 'Too large for Telegram (20 MB max)', true);
  toast(ctx, '⬇️ Fetching…');
  busy(ctx, 'upload_document');
  try {
    const buf = await svc.downloadAttachment(ib, msg.id, a);
    await ctx.replyWithDocument(new InputFile(buf, a.filename || 'attachment'), { caption: `📎 from <i>${esc(msg.subject || 'mail')}</i>`, parse_mode: 'HTML' });
  } catch (e) {
    console.warn('[attachment]', e.message);
    toast(ctx, 'Couldn’t download that attachment', true);
  }
};

// ── addresses / timer / settings ─────────────────────────────────────────
const ADDR_PAGE = 10;

/** Address list: numbered, ● for the active one; « n » buttons open each address. 10 per page. */
S.addresses = (ctx, opts = {}) => {
  const user = userOf(ctx);
  const list = store.listInboxes(user.id);
  const active = store.getActiveInbox(user);
  const pages = Math.max(1, Math.ceil(list.length / ADDR_PAGE));
  const page = Math.min(Math.max(0, opts.page ?? Math.floor(Math.max(0, list.findIndex((x) => x.id === active?.id)) / ADDR_PAGE)), pages - 1);
  const slice = list.slice(page * ADDR_PAGE, page * ADDR_PAGE + ADDR_PAGE);

  const kb = [...numberRows(slice, page * ADDR_PAGE, (c, ib) => S.address(c, ib.id))];
  const pager = pagerRow(page, pages, (c, p) => S.addresses(c, { page: p }), `${list.length} addresses`);
  if (pager) kb.push(pager);
  kb.push([list.length < config.maxInboxes ? act('✨ New address', (c) => S.picker(c)) : null]);
  return present(ctx, { name: 'addresses', text: ui.addresses(slice, active?.id, { offset: page * ADDR_PAGE, total: list.length, page, pages }), kb }, opts);
};

/** One address in full detail, with everything you can do to it. */
S.address = async (ctx, inboxId, { toast: t } = {}) => {
  const user = userOf(ctx);
  const ib = store.getOwnedInbox(user.id, inboxId);
  if (!ib) return S.addresses(ctx);
  const list = store.listInboxes(user.id);
  const isActive = store.getActiveInbox(user)?.id === ib.id;
  const cached = svc.cachedList(ib.id);
  let msgs = cached && Date.now() - cached.at < 60_000 ? cached.list : null;
  if (!msgs) {
    busy(ctx);
    msgs = await within(svc.fetchList(ib).catch(() => null), 2000, cached?.list ?? null);
  }
  if (t) toast(ctx, t);
  const c = counts(msgs);
  const route = svc.sendRoute(ib);
  return present(ctx, {
    name: 'address',
    text: ui.addressDetail(ib, { index: list.findIndex((x) => x.id === ib.id) + 1, count: list.length, isActive, counts: c, route }),
    kb: [
      [copy('⧉ Copy address', ib.address)],
      [
        isActive ? null : act('● Make active', (x) => {
          store.setUser(x.from.id, { active_inbox: ib.id });
          return S.address(x, ib.id, { toast: '● Now active' });
        }),
        act(c?.total ? `📥 Inbox · ${c.total}` : '📥 Inbox', (x) => S.inbox(x, ib.id)),
      ],
      [act('💣 Timer', (x) => S.timer(x, ib.id)), route ? act('✉️ Compose', (x) => S.compose(x, ib.id)) : null],
      [act('🗑 Delete', (x) => S.confirmDelete(x, ib)), act('‹ All addresses', (x) => S.addresses(x))],
    ],
  });
};

S.confirmDelete = (ctx, ib) =>
  present(ctx, {
    name: 'confirm-delete',
    text: ui.confirmDelete(ib),
    kb: [[act('🗑 Yes, delete', async (c) => {
      await svc.destroyInbox(ib);
      toast(c, '🗑 Address deleted');
      return store.countInboxes(c.from.id) ? S.addresses(c) : S.home(c);
    }), act('✖ Keep it', (c) => S.address(c, ib.id))]],
  });

/** Self-destruct timer for an address (the active one by default). */
S.timer = (ctx, inboxId) => {
  const ib = inboxId ? store.getOwnedInbox(ctx.from.id, inboxId) : activeOf(ctx);
  if (!ib) return S.home(ctx);
  const back = inboxId ? (c, t) => S.address(c, ib.id, { toast: t }) : (c, t) => S.home(c, { toast: t });
  const set = (sec, label) => (c) => {
    store.setExpiry(ib.id, sec ? Date.now() + sec * 1000 : null);
    return back(c, sec ? `💣 Armed: ${label}` : '♾ Timer off');
  };
  const opt = (sec, label) => act(`${!sec && !ib.expires_at ? '✓ ' : ''}${sec ? '⏱' : '♾'} ${label}`, set(sec, label));
  return present(ctx, {
    name: 'timer',
    text: ui.timer(ib),
    kb: [[opt(600, '10 min'), opt(3600, '1 hour')], [opt(86400, '24 hours'), opt(604800, '7 days')], [opt(0, 'Never')], [act('‹ Back', (c) => back(c))]],
  });
};

S.settings = (ctx, opts) => {
  const user = userOf(ctx);
  return present(ctx, {
    name: 'settings',
    text: ui.settings(user),
    kb: [
      [act(user.notify ? '🔔 Notifications: ON' : '🔕 Notifications: OFF', (c) => {
        store.setUser(user.id, { notify: user.notify ? 0 : 1 });
        toast(c, user.notify ? '🔔 On' : '🔕 Muted');
        return S.settings(c);
      })],
      [act(`💣 Default timer: ${ui.ttlLabel(user.default_ttl)}  ›`, (c) => {
        const i = ui.TIMERS.findIndex(([s]) => s === Number(user.default_ttl));
        store.setUser(user.id, { default_ttl: ui.TIMERS[(i + 1) % ui.TIMERS.length][0] });
        return S.settings(c);
      })],
      [act('🧨 Erase all my data', (c) => S.wipe(c))],
      [homeBtn],
    ],
  }, opts);
};

S.wipe = (ctx) =>
  present(ctx, {
    name: 'wipe',
    text: ui.confirmWipe(),
    kb: [[act('🧨 Yes, erase all', async (c) => {
      const uid = c.from.id;
      const list = store.listInboxes(uid);
      const panel = store.getUser(uid)?.panel_msg;
      const anchor = store.getUser(uid)?.anchor_msg;
      for (const d of store.userDomains(uid)) store.removeDomain(d.id);
      store.deleteUser(uid);
      Promise.allSettled(list.map((ib) => provider(ib.provider).destroy(ib))).catch(() => {});
      store.touchUser(c.from);
      store.setUser(uid, { panel_msg: panel, anchor_msg: anchor, kb_ver: KB_VER });
      return present(c, { name: 'wiped', text: `${ui.H()}\n\n🧹 All clean. Nothing of yours is left here.`, kb: [[act('⚡ Start fresh', (x) => S.create(x, {}))]] });
    }), act('✖ Cancel', (c) => S.settings(c))]],
  });

// ── profile ──────────────────────────────────────────────────────────────
const avatars = new Map(); // uid → { at, value: { id, src } | null }

/** The user's current Telegram profile photo as a data URI (cached 30 min). Null if hidden or not set. */
async function avatarOf(ctx) {
  const uid = ctx.from.id;
  const hit = avatars.get(uid);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
  let value = null;
  try {
    const r = await ctx.api.getUserProfilePhotos(uid, { limit: 1 });
    const sizes = r?.photos?.[0];
    if (sizes?.length) {
      const pick = sizes.find((s) => s.width >= 160) ?? sizes.at(-1);
      const file = await ctx.api.getFile(pick.file_id);
      const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) value = { id: pick.file_unique_id, src: `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` };
    }
  } catch (e) {
    console.warn('[avatar]', e.message);
  }
  avatars.set(uid, { at: Date.now(), value });
  return value;
}

S.profile = async (ctx, opts) => {
  busy(ctx, 'upload_photo');
  const user = userOf(ctx);
  const ib = store.getActiveInbox(user);
  const route = svc.sendRoute(ib);
  const domainCount = (await domainsFor(user.id)).length;
  const [sentToday, avatar] = await Promise.all([within(store.sentLast24h(user.id), 1500, 0), within(avatarOf(ctx), 6000, null)]);
  const stats = { generated: Math.max(user.generated || 0, store.countInboxes(user.id)), live: store.countInboxes(user.id), received: user.received || 0, sent: user.sent || 0, disposed: user.disposed || 0 };
  const joined = new Date(Number(user.created_at)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return present(ctx, {
    name: 'profile',
    text: ui.profile(user, { myDomains: store.userDomains(user.id), domainCount, sentToday, sendLimit: ib && route ? sendLimitFor(user, ib) : config.sendLimitShared, isAdmin: isAdmin(user.id), route }),
    photo: {
      key: `prof:${user.id}:${user.first_name}:${user.username}:${JSON.stringify(stats)}:${domainCount}:${avatar?.id ?? ''}`,
      buffer: () => profileCard({ name: user.first_name, username: user.username, id: user.id, joined, stats, domains: domainCount, avatar }),
    },
    kb: [
      [copy('⧉ Copy my ID', String(user.id))],
      [act('🌐 My domains', (c) => S.domains(c)), act('🗂 Addresses', (c) => S.addresses(c))],
      [act('⚙️ Settings', (c) => S.settings(c)), homeBtn],
    ],
  }, opts);
};

// ── domains ──────────────────────────────────────────────────────────────
const canManage = (ctx, d) => d && (Number(d.owner_id) === ctx.from.id || isAdmin(ctx.from.id));

S.domains = async (ctx, opts) => {
  busy(ctx);
  const uid = ctx.from.id;
  const mine = store.userDomains(uid);
  const allowAdd = config.allowUserDomains || isAdmin(uid);
  return present(ctx, {
    name: 'domains',
    text: ui.domainsHub(await domainsFor(uid), mine, { allowAdd }),
    kb: [
      ...numberRows(mine, 0, (c, d) => S.domain(c, d.id)),
      [act('✨ Create an address', (c) => S.picker(c)), allowAdd ? act('➕ Add my domain', (c) => S.addDomain(c)) : null],
    ],
  }, opts);
};

S.addDomain = (ctx) => {
  if (!config.allowUserDomains && !isAdmin(ctx.from.id)) return S.problem(ctx, 'domainoff');
  return present(ctx, {
    name: 'add-domain',
    text: ui.askDomain(),
    kb: [[act('✖ Cancel', (c) => S.domains(c))]],
    input: async (c, text) => {
      const uid = c.from.id;
      const name = text.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      if (!isDomain(name)) return S.problem(c, 'baddomain', { back: act('✍️ Try again', (x) => S.addDomain(x)) });
      const existing = store.findDomain(name);
      if ((await publicDomains()).some((d) => d.domain === name) || (existing?.verified && Number(existing.owner_id) !== uid)) {
        return S.problem(c, 'domaintaken', { back: act('🌐 Domains', (x) => S.domains(x)) });
      }
      let d = existing && Number(existing.owner_id) === uid ? existing : null;
      if (!d) {
        if (existing) store.removeDomain(existing.id); // unverified claim: the TXT record decides ownership
        d = await store.addDomain(name, uid);
      }
      return S.domain(c, d.id);
    },
  });
};

S.domain = async (ctx, id, { checked } = {}) => {
  const d = store.getDomain(id);
  if (!canManage(ctx, d)) return S.domains(ctx);
  busy(ctx);
  const check = await checkDomain(d).catch(() => null);
  if (checked) toast(ctx, check?.txtOk ? '✅ TXT record found' : '⏳ TXT record not found yet');
  const fresh = store.getDomain(id);
  const relay = svc.relayDomain()?.id === fresh.id;
  return present(ctx, {
    name: 'domain',
    text: ui.domainManage(fresh, check, { botUrl: config.publicUrl, relay }),
    kb: [
      fresh.verified ? null : [copy('⧉ TXT name', txtHost(fresh.domain)), copy('⧉ TXT value', config.verifyToken(fresh.domain))],
      [act('🔄 Check again', (c) => S.domain(c, id, { checked: true })), act('📄 Worker files', (c) => S.workerFiles(c, fresh))],
      [act(fresh.worker_url ? '🔗 Change worker URL' : '🔗 Set worker URL', (c) => S.workerUrl(c, fresh))],
      fresh.verified ? [act('✨ Create address here', (c) => S.custom(c, { provider: 'own', domain: fresh.domain }))] : null,
      isAdmin(ctx.from.id)
        ? [act(fresh.public ? '🔒 Make private' : '💎 Share with everyone', (c) => {
            store.setDomain(fresh.id, { public: fresh.public ? 0 : 1 });
            toast(c, fresh.public ? '💎 Shared with everyone' : '🔒 Private');
            return S.domain(c, id);
          })]
        : null,
      [act('🗑 Remove', (c) => S.removeDomain(c, fresh)), act('‹ Domains', (c) => S.domains(c))],
    ],
  });
};

S.workerFiles = async (ctx, d) => {
  toast(ctx, '📄 Sending files…');
  busy(ctx, 'upload_document');
  const { js, toml } = await workerFiles(d);
  await ctx.replyWithDocument(new InputFile(Buffer.from(js), 'crevio-worker.js'), {
    caption: [
      `📄 <b>Worker for ${esc(d.domain)}</b>`,
      '',
      '1. Workers &amp; Pages → Create → Hello World → Deploy',
      '2. Edit code → paste this file → Deploy',
      '3. Email Routing → Routing rules → Catch-all → <b>Send to a Worker</b>',
      '4. Copy the …workers.dev URL → 🔗 Set worker URL',
      '',
      '<i>Contains your private key. Don’t share it.</i>',
    ].join('\n'),
    parse_mode: 'HTML',
  });
  await ctx.replyWithDocument(new InputFile(Buffer.from(toml), 'wrangler.toml'), {
    caption: '⚙️ <b>CLI:</b> put both files in a folder and run <code>npx wrangler deploy</code>.',
    parse_mode: 'HTML',
  });
};

S.workerUrl = (ctx, d) =>
  present(ctx, {
    name: 'worker-url',
    text: ui.askWorkerUrl(d),
    kb: [[act('✖ Cancel', (c) => S.domain(c, d.id))]],
    input: async (c, text) => {
      let u;
      try {
        u = new URL(text.startsWith('http') ? text : `https://${text}`);
      } catch {}
      if (!u || u.protocol !== 'https:') return S.problem(c, 'badurl', { back: act('✍️ Try again', (x) => S.workerUrl(x, d)) });
      busy(c);
      const ping = await pingWorker(u.origin, d.key);
      if (ping.ok) store.setDomain(d.id, { worker_url: u.origin, can_send: ping.canSend ? 1 : 0 });
      return S.domain(c, d.id);
    },
  });

S.removeDomain = (ctx, d) => {
  const onIt = store.allInboxes().filter((x) => x.address.endsWith(`@${d.domain}`));
  return present(ctx, {
    name: 'remove-domain',
    text: ui.confirmRemoveDomain(d, onIt.length),
    kb: [[act('🗑 Yes, remove', async (c) => {
      for (const ib of onIt) await svc.destroyInbox(ib, { reason: 'domain removed' });
      store.removeDomain(d.id);
      toast(c, '🗑 Domain removed');
      return S.domains(c);
    }), act('✖ Keep it', (c) => S.domain(c, d.id))]],
  });
};

// ── compose ──────────────────────────────────────────────────────────────
const discardBtn = act('✖ Discard', (c) => {
  drafts.delete(c.from.id);
  toast(c, 'Draft discarded');
  return S.home(c);
});

S.compose = (ctx, inboxId, opts) => {
  const ib = inboxId ? store.getOwnedInbox(ctx.from.id, inboxId) : activeOf(ctx);
  if (!ib) return S.home(ctx, opts);
  if (!svc.sendRoute(ib)) {
    return present(ctx, { name: 'no-send', text: ui.composeUnavailable(isAdmin(ctx.from.id)), kb: [[act('🌐 Domains', (c) => S.domains(c)), homeBtn]] }, opts);
  }
  drafts.set(ctx.from.id, { inboxId: ib.id, draft: { attachments: [] } });
  return S.composeStep(ctx, 'to', opts);
};

S.pickSender = (ctx) => {
  const list = store.listInboxes(ctx.from.id).filter((ib) => svc.sendRoute(ib));
  return present(ctx, {
    name: 'pick-sender',
    text: '✉️ <b>Send from which address?</b>',
    kb: [
      ...list.map((ib) => [act(`✉ ${ib.address}`, (c) => {
        const st = drafts.get(c.from.id);
        if (!st) return S.compose(c, ib.id);
        st.inboxId = ib.id;
        return S.composeStep(c, st.draft.to && st.draft.text ? 'preview' : st.step || 'to');
      })]),
      [discardBtn],
    ],
  });
};

async function fileInput(ctx) {
  const st = drafts.get(ctx.from.id);
  if (!st) return S.home(ctx, { fresh: true });
  const doc = ctx.message.document;
  const photo = ctx.message.photo?.at(-1);
  const size = doc?.file_size || photo?.file_size || 0;
  const total = st.draft.attachments.reduce((s, a) => s + a.size, 0);
  ctx.deleteMessage().catch(() => {});
  if (size > 10 * 1024 * 1024 || total + size > 15 * 1024 * 1024) return S.problem(ctx, 'toobig', { back: act('‹ Back to draft', (c) => S.composeStep(c, st.step)) });
  busy(ctx);
  const file = await ctx.api.getFile(doc?.file_id || photo.file_id);
  const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  st.draft.attachments.push({ filename: doc?.file_name || `photo-${st.draft.attachments.length + 1}.jpg`, type: doc?.mime_type || 'image/jpeg', size: buf.length, content: buf.toString('base64') });
  if (ctx.message.caption && !st.draft.text) st.draft.text = ctx.message.caption;
  ctx.editPanel = true;
  return S.composeStep(ctx, st.draft.to && st.draft.text ? 'preview' : st.step);
}

S.composeStep = async (ctx, step, opts) => {
  const uid = ctx.from.id;
  const st = drafts.get(uid);
  const ib = st && store.getOwnedInbox(uid, st.inboxId);
  if (!ib) return S.home(ctx);
  const sender = senderFor(ib);
  st.step = step;
  const d = st.draft;
  const others = store.listInboxes(uid).some((x) => x.id !== ib.id && svc.sendRoute(x));

  if (step === 'preview') {
    return present(ctx, {
      name: 'compose-preview',
      text: ui.composePreview(d, ib, sender, { sentToday: await within(store.sentLast24h(uid), 1500, 0), limit: sendLimitFor(userOf(ctx), ib) }),
      kb: [
        [act('🚀 Send now', (c) => S.send(c))],
        [act('✏️ To', (c) => S.composeStep(c, 'to')), act('✏️ Subject', (c) => S.composeStep(c, 'subject')), act('✏️ Message', (c) => S.composeStep(c, 'body'))],
        [others ? act('🔁 Sender', (c) => S.pickSender(c)) : null, discardBtn],
      ],
      file: fileInput,
    }, opts);
  }

  return present(ctx, {
    name: `compose-${step}`,
    text: ui.composeAsk(step, d, ib, sender),
    kb: [
      step === 'subject' ? [act('⏭ No subject', (c) => {
        d.subject = '';
        return S.composeStep(c, d.text ? 'preview' : 'body');
      })] : null,
      step === 'body' && d.text ? [act('👀 Preview', (c) => S.composeStep(c, 'preview'))] : null,
      [step === 'to' && others ? act('🔁 Change sender', (c) => S.pickSender(c)) : null, discardBtn],
    ],
    file: step === 'body' ? fileInput : null,
    input: async (c, text) => {
      if (step === 'to') {
        const list = text.split(/[,\s;]+/).filter(Boolean);
        if (!list.length || list.length > 10 || !list.every(isEmail)) return S.problem(c, 'badto', { back: act('✍️ Try again', (x) => S.composeStep(x, 'to')) });
        d.to = list.join(', ');
        return S.composeStep(c, d.text ? 'preview' : 'subject');
      }
      if (step === 'subject') {
        d.subject = text.slice(0, 200);
        return S.composeStep(c, d.text ? 'preview' : 'body');
      }
      d.text = c.message.text.slice(0, 20_000);
      return S.composeStep(c, 'preview');
    },
  }, opts);
};

S.reply = (ctx, ib, msg) => {
  const subject = /^re:/i.test(msg.subject || '') ? msg.subject : `Re: ${msg.subject || ''}`.trim();
  drafts.set(ctx.from.id, { inboxId: ib.id, draft: { to: msg.from.address, subject, attachments: [] } });
  return S.composeStep(ctx, 'body');
};

S.send = async (ctx) => {
  const st = drafts.get(ctx.from.id);
  const ib = st && store.getOwnedInbox(ctx.from.id, st.inboxId);
  if (!ib || !st.draft.to || !st.draft.text) return S.home(ctx);
  toast(ctx, '🚀 Sending…');
  busy(ctx);
  try {
    await sendMail(userOf(ctx), ib, st.draft);
  } catch (e) {
    return fail(ctx, e, act('‹ Back to draft', (c) => S.composeStep(c, 'preview')));
  }
  drafts.delete(ctx.from.id);
  return present(ctx, {
    name: 'sent',
    text: ui.sent(st.draft, senderFor(ib)),
    kb: [[act('✉️ Write another', (c) => S.compose(c, ib.id)), homeBtn]],
  });
};

// ── main-menu taps (and legacy labels from older keyboards) ──────────────
const MENU = new Map([
  [M.home, (c) => S.home(c, { fresh: true })],
  [M.inbox, (c) => S.inbox(c, null, { fresh: true })],
  [M.new, (c) => S.picker(c, { fresh: true })],
  [M.compose, (c) => S.compose(c, null, { fresh: true })],
  [M.addresses, (c) => S.addresses(c, { fresh: true })],
  [M.domains, (c) => S.domains(c, { fresh: true })],
  [M.profile, (c) => S.profile(c, { fresh: true })],
  [M.settings, (c) => S.settings(c, { fresh: true })],
  [M.help, (c) => S.help(c, { fresh: true })],
]);
const menuAction = (text) => MENU.get(text) ?? (/^📥 Inbox/.test(text) ? MENU.get(M.inbox) : /^(🏠 Menu|🔄 Refresh|💣 Timer)$/.test(text) ? MENU.get(M.home) : null);

// ── bot ──────────────────────────────────────────────────────────────────
export function createBot() {
  const bot = new Bot(config.botToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 8 }));

  bot.use((ctx, next) => (ctx.chat?.type === 'private' ? next() : undefined));
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    store.touchUser(ctx.from);
    // /start and /menu always re-send the carrier themselves
    if (ctx.message && !/^\/(start|menu|home)\b/.test(ctx.message.text || '')) await ensureMenu(ctx).catch(() => {});
    return next();
  });

  // Every inline tap is acknowledged at once; handlers may show a toast.
  bot.on('callback_query', async (ctx, next) => {
    let answered = false;
    ctx.toast = (text = '', alert = false) => {
      if (answered) return;
      answered = true;
      return ctx.answerCallbackQuery({ text, show_alert: alert }).catch(() => {});
    };
    const t = setTimeout(() => ctx.toast(), 150);
    try {
      await next();
    } finally {
      clearTimeout(t);
      ctx.toast();
    }
  });

  // commands
  bot.command('start', async (ctx) => {
    ctx.deleteMessage().catch(() => {});
    await ensureMenu(ctx, true);
    return S.home(ctx, { fresh: true });
  });
  const cmd = (name, fn) =>
    bot.command(name, async (ctx) => {
      ctx.deleteMessage().catch(() => {});
      await ensureMenu(ctx).catch(() => {});
      return fn(ctx);
    });
  cmd(['menu', 'home'], async (c) => {
    await ensureMenu(c, true);
    return S.home(c, { fresh: true });
  });
  cmd('new', (c) => S.create(c, {}));
  cmd('inbox', MENU.get(M.inbox));
  cmd('compose', MENU.get(M.compose));
  cmd('domains', MENU.get(M.domains));
  cmd('profile', MENU.get(M.profile));
  cmd('addresses', MENU.get(M.addresses));
  cmd('settings', MENU.get(M.settings));
  cmd('help', MENU.get(M.help));

  // admin
  bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const s = store.stats();
    const relay = svc.relayDomain();
    await ctx.reply(
      [
        `📊 <b>${ui.BRAND} stats</b>`,
        '',
        `👥 users <b>${s.users}</b>  <i>(${s.active24} active 24h)</i>`,
        `📬 live addresses <b>${s.inboxes}</b>  ·  generated <b>${s.generated}</b>`,
        `📥 received <b>${s.received}</b>  ·  📤 sent <b>${s.sent}</b>`,
        `🏷 custom domains <b>${s.domains}</b>`,
        `🛰 send relay: ${relay ? `<b>${esc(relay.domain)}</b>` : '<i>none, so users can’t send yet</i>'}`,
      ].join('\n'),
      HTML,
    );
  });
  bot.command(['ban', 'unban'], async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const id = Number(ctx.match);
    if (!store.getUser(id)) return ctx.reply('Usage: /ban <user id>');
    const ban = ctx.message.text.startsWith('/ban');
    store.setUser(id, { banned: ban ? 1 : 0 });
    await ctx.reply(`Done. User ${id} is ${ban ? 'banned from sending' : 'unbanned'}.`);
  });
  bot.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const src = ctx.message.reply_to_message;
    if (!src) return ctx.reply('Reply to the message you want to broadcast with /broadcast');
    const ids = store.allUserIds();
    const status = await ctx.reply(`📣 Sending to ${ids.length} users…`);
    let ok = 0;
    for (const id of ids) {
      try {
        await ctx.api.copyMessage(id, ctx.chat.id, src.message_id);
        ok++;
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 403) store.setUser(id, { blocked: 1 });
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `📣 Delivered to ${ok}/${ids.length}`);
  });

  // inline buttons
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const fn = resolveToken(ctx.from.id, data);
    if (fn) return fn(ctx);
    // stable callbacks used by push notifications (survive restarts)
    let m;
    if ((m = data.match(/^msg:(\d+):([\w-]+)$/))) {
      const ib = store.getOwnedInbox(ctx.from.id, Number(m[1]));
      return ib ? S.message(ctx, ib, m[2], { fresh: true }) : S.problem(ctx, 'gone');
    }
    if ((m = data.match(/^inb:(\d+)/))) return S.inbox(ctx, Number(m[1]), { fresh: true });
    if (data === 'nr') return S.create(ctx, {});
    toast(ctx, 'This menu has expired, here’s a fresh one');
    return S.home(ctx, { fresh: true });
  });

  // menu taps & typed input
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    ctx.deleteMessage().catch(() => {}); // the panel reflects the input; keep the chat clean
    const menu = menuAction(text);
    if (menu) {
      clearInput(ctx.from.id);
      return menu(ctx);
    }
    const sc = screenOf(ctx.from.id);
    if (sc?.input) {
      ctx.editPanel = true;
      return sc.input(ctx, text);
    }
    return S.home(ctx, { fresh: true });
  });

  bot.on(['message:document', 'message:photo'], (ctx) => {
    const sc = screenOf(ctx.from.id);
    return sc?.file ? sc.file(ctx) : S.home(ctx, { fresh: true });
  });

  bot.catch((err) => {
    console.error(`[bot] update ${err.ctx?.update?.update_id}:`, err.error);
    err.ctx?.toast?.('Something went wrong. Try again.', true);
  });

  return bot;
}

export const COMMANDS = [
  { command: 'start', description: 'Home: your active address' },
  { command: 'new', description: 'Instant fresh address' },
  { command: 'inbox', description: 'Open the inbox' },
  { command: 'compose', description: 'Send a mail' },
  { command: 'domains', description: 'All domains, add your own' },
  { command: 'profile', description: 'Your profile & stats' },
  { command: 'addresses', description: 'Switch or delete addresses' },
  { command: 'settings', description: 'Notifications & default timer' },
  { command: 'help', description: 'How Crevio Mail Bot works' },
];
