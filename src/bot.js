import { Bot, InputFile, GrammyError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { config } from './config.js';
import * as store from './db.js';
import * as ui from './ui.js';
import * as svc from './service.js';
import { UserFacingError } from './service.js';
import { domainsFor, publicDomains, provider } from './providers/index.js';
import { bodyText, extractCodes, extractActionLinks } from './extract.js';
import { viewerUrl } from './viewer.js';
import { LOCAL_RE, normalizeLocal } from './names.js';
import { checkDomain, pingWorker, workerFiles } from './domains.js';
import { sendMail, sendLimitFor } from './send.js';
import { isNotModified, within, esc, isEmail, isDomain, fmtSize } from './utils.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const isAdmin = (id) => config.adminIds.includes(Number(id));

// ── per-user conversational state (custom name, domain, compose…) ────────
const states = new Map(); // userId → { kind, at, ... }
const STATE_TTL = 30 * 60_000;
const getState = (uid) => {
  const s = states.get(uid);
  if (s && Date.now() - s.at > STATE_TTL) states.delete(uid);
  return states.get(uid);
};
const setState = (uid, s) => states.set(uid, { ...s, at: Date.now() });
const clearState = (uid) => states.delete(uid);

export function analyse(msg) {
  const body = bodyText(msg);
  return { body, codes: extractCodes(msg.subject, body), links: extractActionLinks(msg) };
}

// ── rendering ────────────────────────────────────────────────────────────
/**
 * One living panel per chat. Button taps edit it in place. A menu tap or command sends a fresh panel
 * and deletes the previous one, so the chat never fills up with stale menus.
 */
async function show(ctx, view) {
  const opts = { ...HTML, reply_markup: view.kb };
  const target = ctx.panelId ?? ctx.callbackQuery?.message?.message_id;
  if (target) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, target, view.text, opts);
      ctx.panelId = target;
      return;
    } catch (e) {
      if (isNotModified(e)) {
        ctx.panelId = target;
        return;
      }
      if (!(e instanceof GrammyError) || e.error_code !== 400) throw e;
    }
  }
  const m = await ctx.api.sendMessage(ctx.chat.id, view.text, opts);
  const user = store.getUser(ctx.from.id);
  if (user?.panel_msg && user.panel_msg !== m.message_id && !ctx.callbackQuery) {
    ctx.api.deleteMessage(ctx.chat.id, user.panel_msg).catch(() => {});
  }
  ctx.panelId = m.message_id;
  if (user) store.setUser(user.id, { panel_msg: m.message_id });
}

/** Render a view that may take a moment: shows a loading frame only if it isn't ready in ~300 ms. */
async function render(ctx, what, produce) {
  const p = Promise.resolve().then(produce);
  p.catch(() => {});
  const quick = await within(p, 300, undefined);
  if (quick !== undefined) return quick && show(ctx, quick);
  await show(ctx, ui.loading(what)).catch(() => {});
  const view = await p;
  return view && show(ctx, view);
}

function failView(e) {
  if (e instanceof UserFacingError) {
    if (e.message === 'limit') return ui.limitReached();
    return ui.problem(e.message, e.code);
  }
  console.error('[action]', e);
  return ui.problem('down');
}

// ── screens ──────────────────────────────────────────────────────────────
async function homeView(ctx, { force = false } = {}) {
  const user = store.getUser(ctx.from.id);
  const ib = store.getActiveInbox(user);
  if (!ib) return ui.welcome(ctx.from.first_name, (await domainsFor(user.id)).length);
  const list = store.listInboxes(user.id);
  const meta = {
    index: list.findIndex((x) => x.id === ib.id) + 1,
    count: list.length,
    canSend: svc.canSendFrom(ib),
  };
  const cached = svc.cachedList(ib.id);
  let msgs = !force && cached && Date.now() - cached.at < 45_000 ? cached.list : null;
  if (!msgs) {
    const p = svc.fetchList(ib);
    p.catch((e) => console.warn(`[home] ${ib.address}: ${e.message}`));
    msgs = await within(p, 1500, null);
    if (!msgs) {
      // Too slow: show what we have now, then update the panel when fresh data arrives.
      const panel = () => ctx.panelId;
      p.then((fresh) => {
        if (!panel()) return;
        const v = ui.dashboard(ib, { ...meta, total: fresh.length, unread: fresh.filter((m) => !m.seen).length });
        ctx.api.editMessageText(ctx.chat.id, panel(), v.text, { ...HTML, reply_markup: v.kb }).catch(() => {});
      }).catch(() => {});
      msgs = cached?.list ?? null;
    }
  }
  return ui.dashboard(ib, { ...meta, total: msgs ? msgs.length : null, unread: msgs ? msgs.filter((m) => !m.seen).length : 0 });
}

const home = (ctx, opts) => render(ctx, 'Syncing', () => homeView(ctx, opts));

async function pickerView(ctx, page = 0, pendingLocal) {
  const user = store.getUser(ctx.from.id);
  if (store.countInboxes(user.id) >= config.maxInboxes) return ui.limitReached();
  const domains = await domainsFor(user.id);
  if (!domains.length) return ui.problem('down');
  return ui.domainPicker(domains, page, { pendingLocal });
}

async function doCreate(ctx, opts = {}) {
  ctx.toast?.('✨ Minting…');
  return render(ctx, 'Creating your address', async () => {
    try {
      return ui.created(await svc.createInbox(store.getUser(ctx.from.id), opts));
    } catch (e) {
      return failView(e);
    }
  });
}

async function openInbox(ctx, inboxId, page = 0, refresh = false) {
  const ib = store.getOwnedInbox(ctx.from.id, inboxId);
  if (!ib) return show(ctx, ui.problem('gone'));
  return render(ctx, 'Opening inbox', async () => {
    try {
      const msgs = refresh ? await svc.fetchList(ib) : await svc.getList(ib, 5000);
      store.markSeen(ib.id, msgs.map((m) => m.id)).catch(() => {});
      if (refresh) ctx.toast?.(msgs.length ? `↻ ${msgs.length} mail${msgs.length === 1 ? '' : 's'}` : '↻ Still empty');
      return ui.inbox(ib, msgs, page);
    } catch (e) {
      console.warn(`[inbox] ${ib.address}: ${e.message}`);
      return ui.problem('down');
    }
  });
}

async function openMessage(ctx, inboxId, msgId) {
  const ib = store.getOwnedInbox(ctx.from.id, inboxId);
  if (!ib) return show(ctx, ui.problem('gone'));
  return render(ctx, 'Opening mail', async () => {
    let msg;
    try {
      msg = await svc.getMessage(ib, msgId);
    } catch {
      return ui.problem('gone');
    }
    svc.markRead(ib, msg.id).catch(() => {});
    return ui.message(ib, msg, { ...analyse(msg), viewerUrl: viewerUrl(ib.id, msg.id), canReply: svc.canSendFrom(ib) });
  });
}

function profileView(ctx) {
  return (async () => {
    const user = store.getUser(ctx.from.id);
    const ib = store.getActiveInbox(user);
    const sentToday = await within(store.sentLast24h(user.id), 1500, 0);
    return ui.profile(user, {
      live: store.countInboxes(user.id),
      myDomains: store.userDomains(user.id),
      domainCount: (await domainsFor(user.id)).length,
      sentToday,
      sendLimit: ib && svc.canSendFrom(ib) ? sendLimitFor(user, ib) : config.sendLimitShared,
      isAdmin: isAdmin(user.id),
    });
  })();
}

async function domainsView(ctx) {
  const uid = ctx.from.id;
  return ui.domainsHub(await domainsFor(uid), store.userDomains(uid), { allowAdd: config.allowUserDomains || isAdmin(uid) });
}

async function domainView(ctx, domainId) {
  const d = store.getDomain(domainId);
  if (!d || (Number(d.owner_id) !== ctx.from.id && !isAdmin(ctx.from.id))) return ui.problem('gone');
  const check = await checkDomain(d).catch(() => null);
  return ui.domainManage(store.getDomain(domainId), check, { isAdmin: isAdmin(ctx.from.id), botUrl: config.publicUrl });
}

function senders(uid) {
  return store.listInboxes(uid).filter((ib) => svc.canSendFrom(ib));
}

async function composeStart(ctx, inboxId) {
  const uid = ctx.from.id;
  const list = senders(uid);
  const ib = inboxId ? store.getOwnedInbox(uid, inboxId) : list.length === 1 ? list[0] : null;
  if (ib && svc.canSendFrom(ib)) {
    setState(uid, { kind: 'compose', step: 'to', inboxId: ib.id, draft: { attachments: [] } });
    return show(ctx, ui.composeAsk('to', {}, ib));
  }
  if (list.length > 1) return show(ctx, ui.composePickFrom(list));
  return show(ctx, ui.composeNoSender(store.userDomains(uid).length > 0));
}

async function composePreview(ctx, st) {
  const ib = store.getOwnedInbox(ctx.from.id, st.inboxId);
  if (!ib) return show(ctx, ui.problem('gone'));
  const user = store.getUser(ctx.from.id);
  setState(ctx.from.id, { ...st, step: 'preview' });
  return show(ctx, ui.composePreview(st.draft, ib, { sentToday: await within(store.sentLast24h(user.id), 1500, 0), limit: sendLimitFor(user, ib) }));
}

// ── bot ──────────────────────────────────────────────────────────────────
export function createBot() {
  const bot = new Bot(config.botToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 8 }));

  // private chats only
  bot.use((ctx, next) => (ctx.chat?.type === 'private' || ctx.callbackQuery ? next() : undefined));

  // user bookkeeping is in-memory and instant
  bot.use((ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    store.touchUser(ctx.from);
    return next();
  });

  // Acknowledge every button tap right away so the spinner never hangs.
  bot.on('callback_query', async (ctx, next) => {
    let answered = false;
    ctx.toast = (text = '', alert = false) => {
      if (answered) return;
      answered = true;
      return ctx.answerCallbackQuery({ text, show_alert: alert }).catch(() => {});
    };
    const t = setTimeout(() => ctx.toast(), 120);
    try {
      await next();
    } finally {
      clearTimeout(t);
      ctx.toast();
    }
  });

  // ── commands ───────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    clearState(ctx.from.id);
    await ctx.reply(ui.menuReady(ctx.from.first_name), { ...HTML, reply_markup: ui.mainKeyboard() });
    await home(ctx);
  });
  bot.command('menu', (ctx) => ctx.reply(ui.menuReady(ctx.from.first_name), { ...HTML, reply_markup: ui.mainKeyboard() }));
  bot.command('help', (ctx) => show(ctx, ui.help()));
  bot.command('new', (ctx) => doCreate(ctx));
  bot.command('inbox', (ctx) => menu.inbox(ctx));
  bot.command('addresses', (ctx) => menu.addresses(ctx));
  bot.command('domains', (ctx) => menu.domains(ctx));
  bot.command('profile', (ctx) => menu.profile(ctx));
  bot.command('compose', (ctx) => menu.compose(ctx));
  bot.command('settings', (ctx) => menu.settings(ctx));

  // ── admin ──────────────────────────────────────────────────────────────
  bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const s = store.stats();
    await ctx.reply(
      [
        '📊 <b>Crevio stats</b>',
        '',
        `├ users  <b>${s.users}</b>  <i>(${s.active24} active 24h)</i>`,
        `├ live addresses  <b>${s.inboxes}</b>`,
        `├ generated  <b>${s.generated}</b>`,
        `├ mails received  <b>${s.received}</b>`,
        `├ mails sent  <b>${s.sent}</b>`,
        `└ custom domains  <b>${s.domains}</b>`,
      ].join('\n'),
      HTML,
    );
  });

  bot.command(['ban', 'unban'], async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const id = Number(ctx.match);
    if (!store.getUser(id)) return ctx.reply('Usage: /ban <user id>');
    store.setUser(id, { banned: ctx.message.text.startsWith('/ban') ? 1 : 0 });
    await ctx.reply(`Done. User ${id} is ${ctx.message.text.startsWith('/ban') ? 'banned from sending' : 'unbanned'}.`);
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

  // ── reply-keyboard menu ────────────────────────────────────────────────
  const menu = {
    inbox: (ctx) => {
      const ib = store.getActiveInbox(store.getUser(ctx.from.id));
      return ib ? openInbox(ctx, ib.id) : home(ctx);
    },
    new: (ctx) => render(ctx, 'Loading domains', () => pickerView(ctx)),
    addresses: (ctx) => {
      const user = store.getUser(ctx.from.id);
      return show(ctx, ui.addresses(store.listInboxes(user.id), store.getActiveInbox(user)?.id));
    },
    compose: (ctx) => composeStart(ctx),
    domains: (ctx) => render(ctx, 'Loading domains', () => domainsView(ctx)),
    profile: (ctx) => render(ctx, 'Loading profile', () => profileView(ctx)),
    settings: (ctx) => show(ctx, ui.settings(store.getUser(ctx.from.id))),
    help: (ctx) => show(ctx, ui.help()),
  };
  const MENU_BY_LABEL = new Map(Object.entries(ui.MENU).map(([k, label]) => [label, menu[k]]));

  // ── buttons: navigation ────────────────────────────────────────────────
  bot.callbackQuery('noop', () => {});
  bot.callbackQuery(/^home(:r)?$/, async (ctx) => {
    clearState(ctx.from.id);
    if (ctx.match[1]) ctx.toast('↻ Refreshed');
    await home(ctx, { force: Boolean(ctx.match[1]) });
  });
  bot.callbackQuery('help', (ctx) => show(ctx, ui.help()));
  bot.callbackQuery('prof', (ctx) => menu.profile(ctx));

  // ── buttons: create ────────────────────────────────────────────────────
  bot.callbackQuery(/^np:(\d+)$/, (ctx) => render(ctx, 'Loading domains', () => pickerView(ctx, Number(ctx.match[1]))));
  bot.callbackQuery(/^npc:(\d+)$/, (ctx) => {
    const st = getState(ctx.from.id);
    if (!st?.local) return ctx.toast('That request expired. Start again.', true);
    return render(ctx, 'Loading domains', () => pickerView(ctx, Number(ctx.match[1]), st.local));
  });
  bot.callbackQuery(/^nr(?::(\w+):(.+))?$/, (ctx) =>
    doCreate(ctx, ctx.match[1] ? { provider: ctx.match[1], domain: ctx.match[2] } : {}),
  );
  bot.callbackQuery('nc', (ctx) => {
    if (store.countInboxes(ctx.from.id) >= config.maxInboxes) return show(ctx, ui.limitReached());
    setState(ctx.from.id, { kind: 'local' });
    ctx.toast('✍️ Send me a name');
    return show(ctx, ui.askCustom());
  });
  bot.callbackQuery(/^ncd:(\w+):(.+)$/, (ctx) => {
    const st = getState(ctx.from.id);
    if (!st?.local) return ctx.toast('That request expired. Start again.', true);
    clearState(ctx.from.id);
    return doCreate(ctx, { local: st.local, provider: ctx.match[1], domain: ctx.match[2] });
  });
  bot.callbackQuery(/^ncx:(\d+)$/, (ctx) => {
    const d = store.getDomain(ctx.match[1]);
    if (!d?.verified) return ctx.toast('Verify the domain first', true);
    setState(ctx.from.id, { kind: 'local', preset: { provider: 'own', domain: d.domain } });
    return show(ctx, {
      text: `✨ <b>New address on ${esc(d.domain)}</b>\n\nSend the name you want (e.g. <code>hello</code>), or tap Random.`,
      kb: { inline_keyboard: [[{ text: '🎲  Random name', callback_data: `nr:own:${d.domain}` }], [{ text: '✕  Cancel', callback_data: `dm:${d.id}` }]] },
    });
  });

  // ── buttons: inbox & messages ──────────────────────────────────────────
  bot.callbackQuery(/^inb:(\d+):(\d+)(:r)?$/, (ctx) => openInbox(ctx, Number(ctx.match[1]), Number(ctx.match[2]), Boolean(ctx.match[3])));
  bot.callbackQuery(/^msg:(\d+):([\w-]+)$/, (ctx) => openMessage(ctx, Number(ctx.match[1]), ctx.match[2]));

  bot.callbackQuery(/^del:(\d+):([\w-]+)$/, async (ctx) => {
    const ib = store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (!ib) return show(ctx, ui.problem('gone'));
    ctx.toast('🗑 Deleted');
    await svc.deleteMessage(ib, ctx.match[2]);
    await openInbox(ctx, ib.id);
  });

  bot.callbackQuery(/^att:(\d+):([\w-]+)$/, async (ctx) => {
    const ib = store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (!ib) return show(ctx, ui.problem('gone'));
    return render(ctx, 'Loading', async () => {
      const msg = await svc.getMessage(ib, ctx.match[2]).catch(() => null);
      if (!msg) return ui.problem('gone');
      return ui.attachments(ib, msg, { downloadable: provider(ib.provider).caps.attachments });
    });
  });

  bot.callbackQuery(/^atd:(\d+):([\w-]+):(\d+)$/, async (ctx) => {
    const ib = store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    const msg = ib && (await svc.getMessage(ib, ctx.match[2]).catch(() => null));
    const a = msg?.attachments?.[Number(ctx.match[3])];
    if (!a) return ctx.toast('Attachment not found', true);
    if (a.size > 20 * 1024 * 1024) return ctx.toast('Too large for Telegram (20 MB max)', true);
    ctx.toast('⬇ Fetching…');
    await ctx.replyWithChatAction('upload_document').catch(() => {});
    try {
      const buf = await svc.downloadAttachment(ib, msg.id, a);
      await ctx.replyWithDocument(new InputFile(buf, a.filename || 'attachment'), {
        caption: `📎 from <i>${esc(msg.subject || 'mail')}</i>`,
        parse_mode: 'HTML',
      });
    } catch (e) {
      console.warn('[attachment]', e.message);
      await ctx.reply('Couldn’t download that attachment. Try again in a moment.');
    }
  });

  bot.callbackQuery(/^rpl:(\d+):([\w-]+)$/, async (ctx) => {
    const ib = store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (!ib || !svc.canSendFrom(ib)) return show(ctx, ui.problem('nosend'));
    const msg = await svc.getMessage(ib, ctx.match[2]).catch(() => null);
    if (!msg) return show(ctx, ui.problem('gone'));
    const subject = /^re:/i.test(msg.subject || '') ? msg.subject : `Re: ${msg.subject || ''}`.trim();
    const draft = { to: msg.from.address, subject, attachments: [] };
    setState(ctx.from.id, { kind: 'compose', step: 'body', inboxId: ib.id, draft });
    return show(ctx, ui.composeAsk('body', draft, ib));
  });

  // ── buttons: addresses / timer ─────────────────────────────────────────
  bot.callbackQuery('adr', (ctx) => menu.addresses(ctx));
  bot.callbackQuery(/^sw:(\d+)$/, async (ctx) => {
    const ib = store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (!ib) return show(ctx, ui.problem('gone'));
    store.setUser(ctx.from.id, { active_inbox: ib.id });
    ctx.toast(`◉ ${ib.address}`);
    await home(ctx);
  });
  bot.callbackQuery(/^rm:(\d+)$/, (ctx) => {
    const ib = store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    return show(ctx, ib ? ui.confirmDelete(ib) : ui.problem('gone'));
  });
  bot.callbackQuery(/^rmy:(\d+)$/, async (ctx) => {
    const ib = store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (ib) svc.destroyInbox(ib).catch(() => {});
    ctx.toast('🗑 Address deleted');
    const user = store.getUser(ctx.from.id);
    const list = store.listInboxes(user.id);
    if (!list.length) return home(ctx);
    return show(ctx, ui.addresses(list, store.getActiveInbox(user)?.id));
  });
  bot.callbackQuery('tmr', (ctx) => {
    const ib = store.getActiveInbox(store.getUser(ctx.from.id));
    return ib ? show(ctx, ui.timer(ib)) : home(ctx);
  });
  bot.callbackQuery(/^tm:(\d+):(\d+)$/, async (ctx) => {
    const ib = store.getOwnedInbox(ctx.from.id, Number(ctx.match[1]));
    if (!ib) return show(ctx, ui.problem('gone'));
    const sec = Number(ctx.match[2]);
    store.setExpiry(ib.id, sec ? Date.now() + sec * 1000 : null);
    ctx.toast(sec ? `💣 Armed: ${ui.TIMERS.find(([s]) => s === sec)?.[1]}` : '♾ Timer off');
    await home(ctx);
  });

  // ── buttons: settings ──────────────────────────────────────────────────
  bot.callbackQuery('set', (ctx) => menu.settings(ctx));
  bot.callbackQuery('set:n', (ctx) => {
    const user = store.getUser(ctx.from.id);
    store.setUser(user.id, { notify: user.notify ? 0 : 1 });
    ctx.toast(user.notify ? '🔔 Notifications on' : '🔕 Muted');
    return show(ctx, ui.settings(user));
  });
  bot.callbackQuery('set:t', (ctx) => {
    const user = store.getUser(ctx.from.id);
    const i = ui.TIMERS.findIndex(([s]) => s === Number(user.default_ttl));
    store.setUser(user.id, { default_ttl: ui.TIMERS[(i + 1) % ui.TIMERS.length][0] });
    return show(ctx, ui.settings(user));
  });
  bot.callbackQuery('wipe', (ctx) => show(ctx, ui.confirmWipe()));
  bot.callbackQuery('wipey', async (ctx) => {
    ctx.toast('🧹 Erasing…');
    const uid = ctx.from.id;
    const list = store.listInboxes(uid);
    for (const d of store.userDomains(uid)) store.removeDomain(d.id);
    store.deleteUser(uid);
    Promise.allSettled(list.map((ib) => provider(ib.provider).destroy(ib))).catch(() => {});
    await show(ctx, ui.wiped());
  });

  // ── buttons: domains ───────────────────────────────────────────────────
  bot.callbackQuery('dom', (ctx) => menu.domains(ctx));
  bot.callbackQuery('dom:add', (ctx) => {
    if (!config.allowUserDomains && !isAdmin(ctx.from.id)) return show(ctx, ui.problem('domainoff'));
    setState(ctx.from.id, { kind: 'domain' });
    return show(ctx, ui.askDomain());
  });
  bot.callbackQuery(/^dm:(\d+)$/, (ctx) => {
    clearState(ctx.from.id);
    return render(ctx, 'Checking DNS', () => domainView(ctx, Number(ctx.match[1])));
  });
  bot.callbackQuery(/^dmc:(\d+)$/, (ctx) => {
    ctx.toast('🔄 Checking…');
    return render(ctx, 'Checking DNS', () => domainView(ctx, Number(ctx.match[1])));
  });
  bot.callbackQuery(/^dmf:(\d+)$/, async (ctx) => {
    const d = store.getDomain(ctx.match[1]);
    if (!d || (Number(d.owner_id) !== ctx.from.id && !isAdmin(ctx.from.id))) return;
    ctx.toast('📄 Sending files');
    const { js, toml } = await workerFiles(d);
    await ctx.replyWithDocument(new InputFile(Buffer.from(js), 'crevio-worker.js'), {
      caption: [
        `📄 <b>Worker for ${esc(d.domain)}</b>`,
        '',
        '<b>Dashboard way</b>',
        '1. Workers &amp; Pages → Create → Hello World → Deploy',
        '2. Edit code → paste this file → Deploy',
        '3. Email Routing → Routing rules → Catch-all → <b>Send to a Worker</b> → pick it',
        '4. Copy the worker URL (…workers.dev) and paste it in the bot',
        '',
        '<i>This file contains your private key. Don’t share it.</i>',
      ].join('\n'),
      parse_mode: 'HTML',
    });
    await ctx.replyWithDocument(new InputFile(Buffer.from(toml), 'wrangler.toml'), {
      caption: '⚙️ <b>CLI way:</b> put both files in a folder and run <code>npx wrangler deploy</code>.\nThe <code>send_email</code> binding lets the bot send from your domain.',
      parse_mode: 'HTML',
    });
  });
  bot.callbackQuery(/^dmw:(\d+)$/, (ctx) => {
    const d = store.getDomain(ctx.match[1]);
    if (!d || (Number(d.owner_id) !== ctx.from.id && !isAdmin(ctx.from.id))) return;
    setState(ctx.from.id, { kind: 'worker', domainId: d.id });
    return show(ctx, ui.askWorkerUrl(d));
  });
  bot.callbackQuery(/^dmp:(\d+)$/, (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const d = store.getDomain(ctx.match[1]);
    if (!d) return;
    store.setDomain(d.id, { public: d.public ? 0 : 1 });
    ctx.toast(d.public ? '💎 Shared with all users' : '🔒 Private');
    return render(ctx, 'Updating', () => domainView(ctx, d.id));
  });
  bot.callbackQuery(/^dmr:(\d+)$/, (ctx) => {
    const d = store.getDomain(ctx.match[1]);
    if (!d || (Number(d.owner_id) !== ctx.from.id && !isAdmin(ctx.from.id))) return;
    const n = store.allInboxes().filter((ib) => ib.address.endsWith(`@${d.domain}`)).length;
    return show(ctx, ui.confirmRemoveDomain(d, n));
  });
  bot.callbackQuery(/^dmry:(\d+)$/, async (ctx) => {
    const d = store.getDomain(ctx.match[1]);
    if (!d || (Number(d.owner_id) !== ctx.from.id && !isAdmin(ctx.from.id))) return;
    for (const ib of store.allInboxes().filter((x) => x.address.endsWith(`@${d.domain}`))) await svc.destroyInbox(ib, { reason: 'domain removed' });
    store.removeDomain(d.id);
    ctx.toast('🗑 Domain removed');
    return menu.domains(ctx);
  });

  // ── buttons: compose ───────────────────────────────────────────────────
  bot.callbackQuery('cmp', (ctx) => composeStart(ctx));
  bot.callbackQuery(/^cmp:(\d+)$/, (ctx) => composeStart(ctx, Number(ctx.match[1])));
  bot.callbackQuery('cms:skip', (ctx) => {
    const st = getState(ctx.from.id);
    if (st?.kind !== 'compose') return ctx.toast('Draft expired', true);
    st.draft.subject = '';
    setState(ctx.from.id, { ...st, step: 'body' });
    return show(ctx, ui.composeAsk('body', st.draft, store.getInbox(st.inboxId)));
  });
  bot.callbackQuery('cmv', (ctx) => {
    const st = getState(ctx.from.id);
    if (st?.kind !== 'compose') return ctx.toast('Draft expired', true);
    return composePreview(ctx, st);
  });
  bot.callbackQuery(/^cme:(to|subject|body)$/, (ctx) => {
    const st = getState(ctx.from.id);
    if (st?.kind !== 'compose') return ctx.toast('Draft expired', true);
    setState(ctx.from.id, { ...st, step: ctx.match[1], editing: true });
    return show(ctx, ui.composeAsk(ctx.match[1], st.draft, store.getInbox(st.inboxId)));
  });
  bot.callbackQuery('cmx', (ctx) => {
    clearState(ctx.from.id);
    ctx.toast('Draft discarded');
    return home(ctx);
  });
  bot.callbackQuery('cmgo', async (ctx) => {
    const st = getState(ctx.from.id);
    if (st?.kind !== 'compose' || !st.draft.to || !st.draft.text) return ctx.toast('Draft incomplete', true);
    const ib = store.getOwnedInbox(ctx.from.id, st.inboxId);
    if (!ib) return show(ctx, ui.problem('gone'));
    ctx.toast('🚀 Sending…');
    return render(ctx, 'Sending', async () => {
      try {
        await sendMail(store.getUser(ctx.from.id), ib, st.draft);
        clearState(ctx.from.id);
        return ui.sent(st.draft, ib);
      } catch (e) {
        return failView(e);
      }
    });
  });

  // ── text input ─────────────────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const uid = ctx.from.id;

    const menuAction = MENU_BY_LABEL.get(text);
    if (menuAction) {
      ctx.deleteMessage().catch(() => {});
      if (getState(uid)?.kind !== 'compose') clearState(uid);
      return menuAction(ctx);
    }

    const st = getState(uid);
    if (!st) return home(ctx);
    ctx.deleteMessage().catch(() => {}); // keep the chat clean: input is reflected in the panel
    ctx.panelId = store.getUser(uid)?.panel_msg ?? undefined;

    if (st.kind === 'local') {
      const local = normalizeLocal(text);
      if (!LOCAL_RE.test(local) || local.length < 3) return show(ctx, { ...ui.problem('invalid'), kb: ui.askCustom().kb });
      if (st.preset) {
        clearState(uid);
        return doCreate(ctx, { local, ...st.preset });
      }
      setState(uid, { kind: 'local', local });
      return render(ctx, 'Loading domains', () => pickerView(ctx, 0, local));
    }

    if (st.kind === 'domain') {
      const name = text.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      if (!isDomain(name)) return show(ctx, { ...ui.problem('baddomain'), kb: ui.askDomain().kb });
      const pub = await publicDomains();
      const existing = store.findDomain(name);
      if (pub.some((d) => d.domain === name) || (existing?.verified && Number(existing.owner_id) !== uid)) {
        return show(ctx, ui.problem('domaintaken'));
      }
      clearState(uid);
      let d = existing && Number(existing.owner_id) === uid ? existing : null;
      if (!d) {
        if (existing) store.removeDomain(existing.id); // unverified claim by someone else: TXT proves ownership, so re-issue
        d = await store.addDomain(name, uid);
      }
      return render(ctx, 'Checking DNS', () => domainView(ctx, d.id));
    }

    if (st.kind === 'worker') {
      const d = store.getDomain(st.domainId);
      if (!d) return show(ctx, ui.problem('gone'));
      let url;
      try {
        url = new URL(text.startsWith('http') ? text : `https://${text}`);
      } catch {}
      if (!url || url.protocol !== 'https:') return show(ctx, { ...ui.problem('badurl'), kb: ui.askWorkerUrl(d).kb });
      clearState(uid);
      return render(ctx, 'Contacting worker', async () => {
        const origin = url.origin;
        const ping = await pingWorker(origin, d.key);
        if (ping.ok) store.setDomain(d.id, { worker_url: origin, can_send: ping.canSend ? 1 : 0 });
        return domainView(ctx, d.id);
      });
    }

    if (st.kind === 'compose') {
      const ib = store.getOwnedInbox(uid, st.inboxId);
      if (!ib) return show(ctx, ui.problem('gone'));
      const d = st.draft;
      if (st.step === 'to') {
        const list = text.split(/[,\s;]+/).filter(Boolean);
        if (!list.length || list.length > 10 || !list.every(isEmail)) return show(ctx, { ...ui.problem('badto'), kb: ui.composeAsk('to', d, ib).kb });
        d.to = list.join(', ');
        if (st.editing || d.text) return composePreview(ctx, { ...st, editing: false });
        setState(uid, { ...st, step: 'subject' });
        return show(ctx, ui.composeAsk('subject', d, ib));
      }
      if (st.step === 'subject') {
        d.subject = text.slice(0, 200);
        if (st.editing || d.text) return composePreview(ctx, { ...st, editing: false });
        setState(uid, { ...st, step: 'body' });
        return show(ctx, ui.composeAsk('body', d, ib));
      }
      if (st.step === 'body' || st.step === 'preview') {
        d.text = ctx.message.text.slice(0, 20_000);
        return composePreview(ctx, { ...st, editing: false });
      }
    }
    return home(ctx);
  });

  // attachments while composing
  bot.on(['message:document', 'message:photo'], async (ctx) => {
    const st = getState(ctx.from.id);
    if (st?.kind !== 'compose') return home(ctx);
    const doc = ctx.message.document;
    const photo = ctx.message.photo?.at(-1);
    const fileId = doc?.file_id || photo?.file_id;
    const size = doc?.file_size || photo?.file_size || 0;
    const total = st.draft.attachments.reduce((s, a) => s + a.size, 0);
    if (size > 10 * 1024 * 1024 || total + size > 15 * 1024 * 1024) return ctx.reply('📎 Too large. Attachments are limited to 15 MB in total.');
    const file = await ctx.api.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
    const buf = Buffer.from(await res.arrayBuffer());
    st.draft.attachments.push({
      filename: doc?.file_name || `photo-${st.draft.attachments.length + 1}.jpg`,
      type: doc?.mime_type || 'image/jpeg',
      size: buf.length,
      content: buf.toString('base64'),
    });
    ctx.deleteMessage().catch(() => {});
    ctx.panelId = store.getUser(ctx.from.id)?.panel_msg ?? undefined;
    if (ctx.message.caption && !st.draft.text) st.draft.text = ctx.message.caption;
    await ctx.reply(`📎 Attached <b>${esc(st.draft.attachments.at(-1).filename)}</b> · ${fmtSize(buf.length)}`, HTML).then((m) =>
      setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 4000),
    );
    if (st.draft.text && st.draft.to) return composePreview(ctx, st);
    return show(ctx, ui.composeAsk(st.step === 'preview' ? 'body' : st.step, st.draft, store.getInbox(st.inboxId)));
  });

  bot.on('callback_query', (ctx) => ctx.toast('This button is outdated. Send /start'));

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
  { command: 'compose', description: 'Send a mail from your domain' },
  { command: 'domains', description: 'Domains, including your own' },
  { command: 'profile', description: 'Your profile & stats' },
  { command: 'addresses', description: 'Switch or delete addresses' },
  { command: 'settings', description: 'Notifications & default timer' },
  { command: 'menu', description: 'Show the keyboard menu' },
  { command: 'help', description: 'How Crevio works' },
];
