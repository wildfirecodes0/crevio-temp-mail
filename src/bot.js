import { Bot, InputFile, GrammyError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { config } from './config.js';
import * as store from './db.js';
import * as mail from './mail.js';
import * as ui from './ui.js';
import { authed, createInbox, destroyInbox, UserFacingError } from './service.js';
import { bodyText, extractCodes, extractActionLinks } from './extract.js';
import { viewerUrl } from './viewer.js';
import { LOCAL_RE, normalizeLocal } from './names.js';
import { isNotModified, sleep, esc } from './utils.js';

const awaiting = new Map(); // userId -> { kind: 'local' | 'local-domain', local?, at }
const AWAIT_TTL = 10 * 60_000;

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

/** Edit the current panel in place when coming from a button, otherwise send a new one. */
async function show(ctx, view) {
  const opts = { ...HTML, reply_markup: view.kb };
  if (ctx.callbackQuery?.message) {
    try {
      return await ctx.editMessageText(view.text, opts);
    } catch (e) {
      if (isNotModified(e)) return;
      if (!(e instanceof GrammyError) || e.error_code !== 400) throw e;
    }
  }
  return ctx.reply(view.text, opts);
}

const toast = (ctx, text, alert = false) => ctx.answerCallbackQuery({ text, show_alert: alert }).catch(() => {});

async function loadUser(ctx) {
  await store.touchUser(ctx.from);
  return store.getUser(ctx.from.id);
}

async function home(ctx, user) {
  user ??= await loadUser(ctx);
  const ib = await store.getActiveInbox(user);
  if (!ib) return show(ctx, ui.welcome(ctx.from.first_name));
  const list = await store.listInboxes(user.id);
  let total = null;
  let unread = 0;
  try {
    const msgs = await authed(ib, (t) => mail.listMessages(ib.provider, t));
    total = msgs.length;
    unread = msgs.filter((m) => !m.seen).length;
  } catch (e) {
    console.warn(`[home] ${ib.address}: ${e.message}`);
  }
  const index = list.findIndex((x) => Number(x.id) === Number(ib.id)) + 1;
  return show(ctx, ui.dashboard(ib, { total, unread, index, count: list.length }));
}

async function doCreate(ctx, opts = {}) {
  const user = await loadUser(ctx);
  if (ctx.callbackQuery) toast(ctx, '✨ Minting your address…');
  try {
    const ib = await createInbox(user, opts);
    return show(ctx, ui.created(ib));
  } catch (e) {
    if (e instanceof UserFacingError) return show(ctx, e.message === 'limit' ? ui.limitReached() : ui.problem(e.message));
    console.error('[create]', e);
    return show(ctx, ui.problem('down'));
  }
}

async function openInbox(ctx, inboxId, page = 0, refresh = false) {
  const ib = await store.getOwnedInbox(ctx.from.id, inboxId);
  if (!ib) return show(ctx, ui.problem('gone'));
  let msgs;
  try {
    msgs = await authed(ib, (t) => mail.listMessages(ib.provider, t));
  } catch (e) {
    console.warn(`[inbox] ${ib.address}: ${e.message}`);
    return show(ctx, ui.problem('down'));
  }
  // Anything the user has looked at here shouldn't be pushed again by the poller.
  store.markSeen(ib.id, msgs.map((m) => m.id)).catch(() => {});
  if (refresh) toast(ctx, msgs.length ? `↻ ${msgs.length} mail${msgs.length === 1 ? '' : 's'}` : '↻ Still empty');
  return show(ctx, ui.inbox(ib, msgs, page));
}

async function fetchMessage(ctx, inboxId, msgId) {
  const ib = await store.getOwnedInbox(ctx.from.id, inboxId);
  if (!ib) return {};
  try {
    const msg = await authed(ib, (t) => mail.getMessage(ib.provider, t, msgId));
    return { ib, msg };
  } catch (e) {
    if (e.status !== 404) console.warn(`[msg] ${e.message}`);
    return { ib };
  }
}

export function analyse(msg) {
  const body = bodyText(msg);
  return { body, codes: extractCodes(msg.subject, body), links: extractActionLinks(msg) };
}

async function openMessage(ctx, inboxId, msgId) {
  const { ib, msg } = await fetchMessage(ctx, inboxId, msgId);
  if (!msg) return show(ctx, ui.problem('gone'));
  if (!msg.seen) authed(ib, (t) => mail.markRead(ib.provider, t, msg.id)).catch(() => {});
  const a = analyse(msg);
  return show(ctx, ui.message(ib, msg, { ...a, viewerUrl: viewerUrl(ib.id, msg.id) }));
}

export function createBot() {
  const bot = new Bot(config.botToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 10 }));

  const pm = bot.chatType('private');

  // ── commands ───────────────────────────────────────────────────────────
  pm.command('start', async (ctx) => {
    awaiting.delete(ctx.from.id);
    await home(ctx);
  });
  pm.command('help', (ctx) => show(ctx, ui.help()));
  pm.command('new', (ctx) => doCreate(ctx));
  pm.command('inbox', async (ctx) => {
    const user = await loadUser(ctx);
    const ib = await store.getActiveInbox(user);
    return ib ? openInbox(ctx, ib.id) : show(ctx, ui.welcome(ctx.from.first_name));
  });
  pm.command('addresses', async (ctx) => {
    const user = await loadUser(ctx);
    const active = await store.getActiveInbox(user);
    return show(ctx, ui.addresses(await store.listInboxes(user.id), active?.id));
  });
  pm.command('settings', async (ctx) => show(ctx, ui.settings(await loadUser(ctx))));

  pm.command('stats', async (ctx) => {
    if (!config.adminIds.includes(ctx.from.id)) return;
    const s = await store.stats();
    await ctx.reply(
      `📊 <b>Crevio stats</b>\n\n├ users  <b>${s.users}</b>\n├ active 24h  <b>${s.active24}</b>\n├ addresses  <b>${s.inboxes}</b>\n└ mails delivered  <b>${s.received}</b>`,
      HTML,
    );
  });

  pm.command('broadcast', async (ctx) => {
    if (!config.adminIds.includes(ctx.from.id)) return;
    const src = ctx.message.reply_to_message;
    if (!src) return ctx.reply('Reply to the message you want to broadcast with /broadcast');
    const ids = await store.allUserIds();
    const status = await ctx.reply(`📣 Sending to ${ids.length} users…`);
    let ok = 0;
    for (const id of ids) {
      try {
        await ctx.api.copyMessage(id, ctx.chat.id, src.message_id);
        ok++;
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 403) await store.markBlocked(id);
      }
      await sleep(45);
    }
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `📣 Delivered to ${ok}/${ids.length}`);
  });

  // ── buttons ────────────────────────────────────────────────────────────
  bot.callbackQuery('noop', (ctx) => toast(ctx, ''));
  bot.callbackQuery(/^home(:r)?$/, async (ctx) => {
    awaiting.delete(ctx.from.id);
    if (ctx.match[1]) toast(ctx, '↻ Refreshed');
    await home(ctx);
    toast(ctx, '');
  });
  bot.callbackQuery('help', async (ctx) => {
    await show(ctx, ui.help());
    toast(ctx, '');
  });

  bot.callbackQuery('new', async (ctx) => {
    const user = await loadUser(ctx);
    if ((await store.countInboxes(user.id)) >= config.maxInboxes) return show(ctx, ui.limitReached());
    const domains = await mail.getDomains();
    if (!domains.length) return show(ctx, ui.problem('down'));
    await show(ctx, ui.newAddress(domains));
    toast(ctx, '');
  });

  bot.callbackQuery(/^nr(?::(\w+):(.+))?$/, (ctx) =>
    doCreate(ctx, ctx.match[1] ? { provider: ctx.match[1], domain: ctx.match[2] } : {}),
  );

  bot.callbackQuery('nc', async (ctx) => {
    const user = await loadUser(ctx);
    if ((await store.countInboxes(user.id)) >= config.maxInboxes) return show(ctx, ui.limitReached());
    awaiting.set(ctx.from.id, { kind: 'local', at: Date.now() });
    await show(ctx, ui.askCustom());
    toast(ctx, '✍️ Send me a name');
  });

  bot.callbackQuery(/^ncd:(\w+):(.+)$/, async (ctx) => {
    const st = awaiting.get(ctx.from.id);
    if (!st?.local) return toast(ctx, 'That request expired — start again', true);
    awaiting.delete(ctx.from.id);
    await doCreate(ctx, { local: st.local, provider: ctx.match[1], domain: ctx.match[2] });
  });

  bot.callbackQuery(/^inb:(\d+):(\d+)(:r)?$/, async (ctx) => {
    await openInbox(ctx, Number(ctx.match[1]), Number(ctx.match[2]), Boolean(ctx.match[3]));
    toast(ctx, '');
  });

  bot.callbackQuery(/^msg:(\d+):([\w-]+)$/, async (ctx) => {
    await openMessage(ctx, Number(ctx.match[1]), ctx.match[2]);
    toast(ctx, '');
  });

  bot.callbackQuery(/^del:(\d+):([\w-]+)$/, async (ctx) => {
    const ib = await store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (!ib) return show(ctx, ui.problem('gone'));
    try {
      await authed(ib, (t) => mail.deleteMessage(ib.provider, t, ctx.match[2]));
      toast(ctx, '🗑 Deleted');
    } catch (e) {
      if (e.status !== 404) return toast(ctx, 'Couldn’t delete — try again', true);
    }
    await openInbox(ctx, ib.id);
  });

  bot.callbackQuery(/^att:(\d+):([\w-]+)$/, async (ctx) => {
    const { ib, msg } = await fetchMessage(ctx, Number(ctx.match[1]), ctx.match[2]);
    if (!msg) return show(ctx, ui.problem('gone'));
    await show(ctx, ui.attachments(ib, msg));
    toast(ctx, '');
  });

  bot.callbackQuery(/^atd:(\d+):([\w-]+):(\d+)$/, async (ctx) => {
    const { ib, msg } = await fetchMessage(ctx, Number(ctx.match[1]), ctx.match[2]);
    const a = msg?.attachments?.[Number(ctx.match[3])];
    if (!a) return toast(ctx, 'Attachment not found', true);
    if (a.size > 20 * 1024 * 1024) return toast(ctx, 'Too large for Telegram (20 MB max)', true);
    toast(ctx, '⬇ Fetching…');
    try {
      const path = a.downloadUrl.startsWith('http') ? new URL(a.downloadUrl).pathname : a.downloadUrl;
      const buf = await authed(ib, (t) => mail.download(ib.provider, t, path));
      await ctx.replyWithDocument(new InputFile(buf, a.filename || 'attachment'), {
        caption: `📎 from <i>${esc(msg.subject || 'mail')}</i>`,
        parse_mode: 'HTML',
      });
    } catch (e) {
      console.warn('[attachment]', e.message);
      await ctx.reply('Couldn’t download that attachment. Try again in a moment.');
    }
  });

  bot.callbackQuery('adr', async (ctx) => {
    const user = await loadUser(ctx);
    const active = await store.getActiveInbox(user);
    await show(ctx, ui.addresses(await store.listInboxes(user.id), active?.id));
    toast(ctx, '');
  });

  bot.callbackQuery(/^sw:(\d+)$/, async (ctx) => {
    const ib = await store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (!ib) return show(ctx, ui.problem('gone'));
    await store.setActive(ctx.from.id, ib.id);
    toast(ctx, `◉ ${ib.address}`);
    await home(ctx);
  });

  bot.callbackQuery(/^rm:(\d+)$/, async (ctx) => {
    const ib = await store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (!ib) return show(ctx, ui.problem('gone'));
    await show(ctx, ui.confirmDelete(ib));
    toast(ctx, '');
  });

  bot.callbackQuery(/^rmy:(\d+)$/, async (ctx) => {
    const ib = await store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (ib) await destroyInbox(ib);
    toast(ctx, '🗑 Address deleted');
    const user = await loadUser(ctx);
    const list = await store.listInboxes(user.id);
    if (!list.length) return home(ctx, user);
    const active = await store.getActiveInbox(user);
    await show(ctx, ui.addresses(list, active?.id));
  });

  bot.callbackQuery('tmr', async (ctx) => {
    const user = await loadUser(ctx);
    const ib = await store.getActiveInbox(user);
    if (!ib) return home(ctx, user);
    await show(ctx, ui.timer(ib));
    toast(ctx, '');
  });

  bot.callbackQuery(/^tm:(\d+):(\d+)$/, async (ctx) => {
    const ib = await store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (!ib) return show(ctx, ui.problem('gone'));
    const sec = Number(ctx.match[2]);
    await store.setExpiry(ib.id, sec ? Date.now() + sec * 1000 : null);
    toast(ctx, sec ? `💣 Armed — ${ui.TIMERS.find(([s]) => s === sec)?.[1]}` : '♾ Timer off');
    await home(ctx);
  });

  bot.callbackQuery('set', async (ctx) => {
    await show(ctx, ui.settings(await loadUser(ctx)));
    toast(ctx, '');
  });

  bot.callbackQuery('set:n', async (ctx) => {
    const user = await loadUser(ctx);
    await store.setNotify(user.id, !user.notify);
    toast(ctx, user.notify ? '🔕 Muted' : '🔔 Notifications on');
    await show(ctx, ui.settings(await store.getUser(user.id)));
  });

  bot.callbackQuery('set:t', async (ctx) => {
    const user = await loadUser(ctx);
    const i = ui.TIMERS.findIndex(([s]) => s === Number(user.default_ttl));
    const next = ui.TIMERS[(i + 1) % ui.TIMERS.length][0];
    await store.setDefaultTtl(user.id, next);
    toast(ctx, '');
    await show(ctx, ui.settings(await store.getUser(user.id)));
  });

  bot.callbackQuery('wipe', async (ctx) => {
    await show(ctx, ui.confirmWipe());
    toast(ctx, '');
  });

  bot.callbackQuery('wipey', async (ctx) => {
    toast(ctx, '🧹 Erasing…');
    for (const ib of await store.listInboxes(ctx.from.id)) await destroyInbox(ib);
    await store.deleteUser(ctx.from.id);
    await show(ctx, ui.wiped());
  });

  // ── free text (custom name entry) ──────────────────────────────────────
  pm.on('message:text', async (ctx) => {
    const st = awaiting.get(ctx.from.id);
    if (st && Date.now() - st.at < AWAIT_TTL && st.kind.startsWith('local')) {
      const local = normalizeLocal(ctx.message.text);
      if (!LOCAL_RE.test(local) || local.length < 3) return show(ctx, { ...ui.problem('invalid'), kb: ui.askCustom().kb });
      const domains = await mail.getDomains();
      if (!domains.length) return show(ctx, ui.problem('down'));
      awaiting.set(ctx.from.id, { kind: 'local-domain', local, at: Date.now() });
      return show(ctx, ui.newAddress(domains, { pendingLocal: local }));
    }
    return home(ctx);
  });

  bot.on('callback_query', (ctx) => toast(ctx, 'This button is outdated — send /start'));

  bot.catch((err) => {
    console.error(`[bot] update ${err.ctx?.update?.update_id}:`, err.error);
    err.ctx?.callbackQuery && toast(err.ctx, 'Something went wrong — try again', true);
  });

  return bot;
}

export const COMMANDS = [
  { command: 'start', description: 'Home — your active address' },
  { command: 'new', description: 'Instant fresh address' },
  { command: 'inbox', description: 'Open the inbox' },
  { command: 'addresses', description: 'Switch or delete addresses' },
  { command: 'settings', description: 'Notifications & default timer' },
  { command: 'help', description: 'How Crevio works' },
];
