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
import { checkDomain, pingWorker, workerFiles } from './domains.js';
import { sendMail, sendLimitFor, senderFor } from './send.js';
import { welcomeCard, addressCard, profileCard } from './cards.js';
import { present, btn, web, busy, screenOf, forget } from './router.js';
import { within, esc, isEmail, isDomain, fmtSize, truncate } from './utils.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const isAdmin = (id) => config.adminIds.includes(Number(id));

export function analyse(msg) {
  const body = bodyText(msg);
  return { body, codes: extractCodes(msg.subject, body), links: extractActionLinks(msg) };
}

// ── labels ───────────────────────────────────────────────────────────────
const L = {
  inbox: '📥 Inbox',
  refresh: '🔄 Refresh',
  new: '✨ New Mail',
  addresses: '🗂 Addresses',
  compose: '✉️ Compose',
  timer: '💣 Timer',
  domains: '🌐 Domains',
  profile: '👤 Profile',
  settings: '⚙️ Settings',
  help: '❔ Help',
  menu: '🏠 Menu',
  cancel: '✖ Cancel',
  instant: '⚡ Instant address',
  custom: '✍️ Custom name',
  discard: '✖ Discard',
};

const drafts = new Map(); // userId → { inboxId, step, draft }
const userOf = (ctx) => store.getUser(ctx.from.id);
const activeOf = (ctx) => store.getActiveInbox(userOf(ctx));

// ── screens ──────────────────────────────────────────────────────────────
const S = {};

function mainKeys(ib, counts) {
  const inboxLabel = counts?.total ? `📥 Inbox · ${counts.total}${counts.unread ? ` (${counts.unread} new)` : ''}` : L.inbox;
  return [
    [btn(inboxLabel, (ctx) => S.inbox(ctx)), btn(L.refresh, (ctx) => S.home(ctx, { force: true }))],
    [btn(L.new, (ctx) => S.picker(ctx)), btn(L.addresses, (ctx) => S.addresses(ctx))],
    [btn(L.compose, (ctx) => S.compose(ctx)), btn(L.timer, (ctx) => S.timer(ctx))],
    [btn(L.domains, (ctx) => S.domains(ctx)), btn(L.profile, (ctx) => S.profile(ctx))],
    [btn(L.settings, (ctx) => S.settings(ctx)), btn(L.help, (ctx) => S.help(ctx))],
  ];
}

const menuRow = (back) => [back, btn(L.menu, (ctx) => S.home(ctx))].filter(Boolean);

S.problem = (ctx, kind, { extra, back } = {}) =>
  present(ctx, { name: 'problem', text: ui.problem(kind, extra), keys: [menuRow(back)] });

function fail(ctx, e, back) {
  if (e instanceof UserFacingError) return S.problem(ctx, e.message, { extra: e.code, back });
  console.error('[action]', e);
  return S.problem(ctx, 'down', { back });
}

const counts = (list) => (list ? { total: list.length, unread: list.filter((m) => !m.seen).length } : null);

S.home = async (ctx, { force = false } = {}) => {
  forget(ctx.from.id);
  const user = userOf(ctx);
  const ib = store.getActiveInbox(user);
  if (!ib) {
    const n = (await domainsFor(user.id)).length;
    return present(ctx, {
      name: 'welcome',
      text: ui.welcome(ctx.from.first_name, n),
      photo: { key: `welcome:${n}`, buffer: () => welcomeCard(n) },
      keys: [
        [btn(L.instant, (c) => S.create(c, {}))],
        [btn('🌐 Choose domain', (c) => S.picker(c)), btn(L.custom, (c) => S.custom(c))],
        [btn(L.domains, (c) => S.domains(c)), btn(L.profile, (c) => S.profile(c)), btn(L.help, (c) => S.help(c))],
      ],
    });
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
  const c = counts(msgs);
  const m = await present(ctx, {
    name: 'home',
    text: ui.dashboard(ib, { ...meta, total: c ? c.total : null, unread: c?.unread ?? 0 }),
    keys: mainKeys(ib, c),
  });
  // Slow provider: fill the numbers in as soon as they arrive.
  pending?.then((fresh) => {
    const f = counts(fresh);
    ctx.api.editMessageText(m.chat.id, m.message_id, ui.dashboard(ib, { ...meta, ...f }), HTML).catch(() => {});
  }).catch(() => {});
};

S.help = (ctx) => present(ctx, { name: 'help', text: ui.help(), keys: [[btn(L.new, (c) => S.picker(c)), btn(L.compose, (c) => S.compose(c))], menuRow()] });

// ── create ───────────────────────────────────────────────────────────────
const badge = { mine: '⭐ ', premium: '💎 ', public: '' };

S.picker = async (ctx, pendingLocal) => {
  const user = userOf(ctx);
  if (!pendingLocal && store.countInboxes(user.id) >= config.maxInboxes) return S.problem(ctx, 'limit', { back: btn(L.addresses, (c) => S.addresses(c)) });
  busy(ctx);
  const domains = (await domainsFor(user.id)).slice(0, 60);
  if (!domains.length) return S.problem(ctx, 'down');
  const keys = [];
  if (!pendingLocal) keys.push([btn(L.instant, (c) => S.create(c, {})), btn(L.custom, (c) => S.custom(c))]);
  for (let i = 0; i < domains.length; i += 2) {
    keys.push(
      domains.slice(i, i + 2).map((d) =>
        btn(`${badge[d.kind]}@${d.domain}`, (c) => S.create(c, { provider: d.provider, domain: d.domain, local: pendingLocal })),
      ),
    );
  }
  keys.push(pendingLocal ? [btn(L.cancel, (c) => S.home(c))] : menuRow());
  return present(ctx, { name: 'picker', text: ui.picker(domains, { pendingLocal }), keys, placeholder: 'Pick a domain' });
};

S.custom = (ctx, preset) => {
  if (store.countInboxes(ctx.from.id) >= config.maxInboxes) return S.problem(ctx, 'limit');
  return present(ctx, {
    name: 'custom',
    text: ui.askCustom(preset?.domain),
    keys: [preset ? [btn('🎲 Random name', (c) => S.create(c, preset))] : null, [btn(L.cancel, (c) => S.home(c))]].filter(Boolean),
    placeholder: 'e.g. shop-alerts',
    input: async (c, text) => {
      const local = normalizeLocal(text);
      if (!LOCAL_RE.test(local) || local.length < 3) return S.problem(c, 'invalid', { back: btn('✍️ Try again', (x) => S.custom(x, preset)) });
      return preset ? S.create(c, { ...preset, local }) : S.picker(c, local);
    },
  });
};

S.create = async (ctx, opts) => {
  busy(ctx);
  let ib;
  try {
    ib = await svc.createInbox(userOf(ctx), opts);
  } catch (e) {
    return fail(ctx, e, btn(L.new, (c) => S.picker(c)));
  }
  return present(ctx, {
    name: 'created',
    text: ui.created(ib),
    photo: {
      key: `addr:${ib.address}:${ib.expires_at || 0}`,
      buffer: () => addressCard({ address: ib.address, provider: ib.provider === 'own' ? 'custom domain' : providerLabel(ib.provider), timer: ui.timerShort(ib) }),
    },
    keys: mainKeys(ib, { total: 0, unread: 0 }),
  });
};

// ── inbox & mail ─────────────────────────────────────────────────────────
S.inbox = async (ctx, inboxId, page = 0, { refresh = false } = {}) => {
  const ib = inboxId ? store.getOwnedInbox(ctx.from.id, inboxId) : activeOf(ctx);
  if (!ib) return S.home(ctx);
  busy(ctx);
  let msgs;
  try {
    msgs = refresh ? await svc.fetchList(ib) : await svc.getList(ib, 5000);
  } catch (e) {
    console.warn(`[inbox] ${ib.address}: ${e.message}`);
    return S.problem(ctx, 'down', { back: btn(L.refresh, (c) => S.inbox(c, ib.id, 0, { refresh: true })) });
  }
  store.markSeen(ib.id, msgs.map((m) => m.id)).catch(() => {});
  const pages = Math.max(1, Math.ceil(msgs.length / ui.PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const keys = msgs.slice(page * ui.PAGE, page * ui.PAGE + ui.PAGE).map((m, i) => [btn(ui.inboxKey(m, page * ui.PAGE + i + 1), (c) => S.message(c, ib, m.id))]);
  if (pages > 1) {
    keys.push([
      page > 0 ? btn('⬅️ Newer', (c) => S.inbox(c, ib.id, page - 1)) : null,
      page < pages - 1 ? btn('Older ➡️', (c) => S.inbox(c, ib.id, page + 1)) : null,
    ].filter(Boolean));
  }
  keys.push([btn(L.refresh, (c) => S.inbox(c, ib.id, page, { refresh: true })), btn(L.compose, (c) => S.compose(c, ib.id))], menuRow());
  return present(ctx, { name: 'inbox', text: ui.inbox(ib, msgs, page, pages), keys, placeholder: 'Open a mail' });
};

S.message = async (ctx, ib, msgId) => {
  busy(ctx);
  let msg;
  try {
    msg = await svc.getMessage(ib, msgId);
  } catch {
    return S.problem(ctx, 'gone', { back: btn('‹ Inbox', (c) => S.inbox(c, ib.id)) });
  }
  svc.markRead(ib, msg.id).catch(() => {});
  const url = viewerUrl(ib.id, msg.id);
  const att = msg.attachments || [];
  const canReply = svc.canSendFrom(ib) && msg.from?.address;
  return present(ctx, {
    name: 'message',
    text: ui.message(ib, msg, analyse(msg)),
    keys: [
      url ? [web('🖥 Open full email', url)] : null,
      [att.length ? btn(`📎 Attachments · ${att.length}`, (c) => S.attachments(c, ib, msg)) : null, canReply ? btn('↩️ Reply', (c) => S.reply(c, ib, msg)) : null].filter(Boolean),
      [btn('🗑 Delete mail', async (c) => {
        await svc.deleteMessage(ib, msg.id);
        return S.inbox(c, ib.id);
      }), btn('‹ Inbox', (c) => S.inbox(c, ib.id))],
      menuRow(),
    ].filter((r) => r && r.length),
  });
};

S.attachments = (ctx, ib, msg) => {
  const downloadable = provider(ib.provider).caps.attachments;
  const keys = downloadable
    ? (msg.attachments || []).slice(0, 10).map((a, i) => [btn(`📎 ${i + 1} · ${truncate(a.filename || 'file', 28)}`, (c) => S.download(c, ib, msg, a))])
    : [];
  keys.push([btn('‹ Back to mail', (c) => S.message(c, ib, msg.id)), btn(L.menu, (c) => S.home(c))]);
  return present(ctx, { name: 'attachments', text: ui.attachments(msg, downloadable), keys });
};

S.download = async (ctx, ib, msg, a) => {
  if (a.size > 20 * 1024 * 1024) return ctx.reply('📎 That file is larger than Telegram allows (20 MB).');
  busy(ctx, 'upload_document');
  try {
    const buf = await svc.downloadAttachment(ib, msg.id, a);
    await ctx.replyWithDocument(new InputFile(buf, a.filename || 'attachment'), { caption: `📎 from <i>${esc(msg.subject || 'mail')}</i>`, parse_mode: 'HTML' });
  } catch (e) {
    console.warn('[attachment]', e.message);
    await ctx.reply('Couldn’t download that attachment. Try again in a moment.');
  }
};

// ── addresses / timer / settings ─────────────────────────────────────────
S.addresses = (ctx) => {
  const user = userOf(ctx);
  const list = store.listInboxes(user.id);
  const active = store.getActiveInbox(user);
  const keys = list.map((ib) => [
    btn(`${ib.id === active?.id ? '◉' : '○'} ${ib.address}`, (c) => {
      store.setUser(c.from.id, { active_inbox: ib.id });
      return S.home(c);
    }),
  ]);
  keys.push([list.length < config.maxInboxes ? btn(L.new, (c) => S.picker(c)) : null, active ? btn('🗑 Delete active', (c) => S.confirmDelete(c, active)) : null].filter(Boolean));
  keys.push(menuRow());
  return present(ctx, { name: 'addresses', text: ui.addresses(list, active?.id), keys, placeholder: 'Switch address' });
};

S.confirmDelete = (ctx, ib) =>
  present(ctx, {
    name: 'confirm-delete',
    text: ui.confirmDelete(ib),
    keys: [[btn('🗑 Yes, delete it', async (c) => {
      await svc.destroyInbox(ib);
      return store.countInboxes(c.from.id) ? S.addresses(c) : S.home(c);
    }), btn('✖ Keep it', (c) => S.addresses(c))]],
  });

S.timer = (ctx) => {
  const ib = activeOf(ctx);
  if (!ib) return S.home(ctx);
  const current = ib.expires_at ? null : 0;
  const set = (sec) => (c) => {
    store.setExpiry(ib.id, sec ? Date.now() + sec * 1000 : null);
    return S.home(c);
  };
  const label = (sec, text) => `${sec === current ? '✓ ' : ''}${sec ? '⏱' : '♾'} ${text}`;
  return present(ctx, {
    name: 'timer',
    text: ui.timer(ib),
    keys: [
      [btn(label(600, '10 min'), set(600)), btn(label(3600, '1 hour'), set(3600))],
      [btn(label(86400, '24 hours'), set(86400)), btn(label(604800, '7 days'), set(604800))],
      [btn(label(0, 'Never'), set(0))],
      menuRow(),
    ],
  });
};

S.settings = (ctx) => {
  const user = userOf(ctx);
  return present(ctx, {
    name: 'settings',
    text: ui.settings(user),
    keys: [
      [btn(user.notify ? '🔔 Notifications: ON' : '🔕 Notifications: OFF', (c) => {
        store.setUser(user.id, { notify: user.notify ? 0 : 1 });
        return S.settings(c);
      })],
      [btn(`💣 Default timer: ${ui.ttlLabel(user.default_ttl)}`, (c) => {
        const i = ui.TIMERS.findIndex(([s]) => s === Number(user.default_ttl));
        store.setUser(user.id, { default_ttl: ui.TIMERS[(i + 1) % ui.TIMERS.length][0] });
        return S.settings(c);
      })],
      [btn('🧨 Erase all my data', (c) => S.wipe(c))],
      menuRow(),
    ],
  });
};

S.wipe = (ctx) =>
  present(ctx, {
    name: 'wipe',
    text: ui.confirmWipe(),
    keys: [[btn('🧨 Yes, erase everything', async (c) => {
      const uid = c.from.id;
      const list = store.listInboxes(uid);
      for (const d of store.userDomains(uid)) store.removeDomain(d.id);
      store.deleteUser(uid);
      Promise.allSettled(list.map((ib) => provider(ib.provider).destroy(ib))).catch(() => {});
      store.touchUser(c.from);
      return present(c, { name: 'wiped', text: `${ui.H()}\n\n🧹 All clean. Nothing of yours is left here.`, keys: [[btn(L.instant, (x) => S.create(x, {}))], [btn(L.menu, (x) => S.home(x))]] });
    }), btn('✖ Cancel', (c) => S.settings(c))]],
  });

// ── profile ──────────────────────────────────────────────────────────────
S.profile = async (ctx) => {
  busy(ctx, 'upload_photo');
  const user = userOf(ctx);
  const ib = store.getActiveInbox(user);
  const route = svc.sendRoute(ib);
  const domainCount = (await domainsFor(user.id)).length;
  const sentToday = await within(store.sentLast24h(user.id), 1500, 0);
  const stats = {
    generated: user.generated || 0,
    live: store.countInboxes(user.id),
    received: user.received || 0,
    sent: user.sent || 0,
    disposed: user.disposed || 0,
  };
  const joined = new Date(Number(user.created_at)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return present(ctx, {
    name: 'profile',
    text: ui.profile(user, { myDomains: store.userDomains(user.id), domainCount, sentToday, sendLimit: ib && route ? sendLimitFor(user, ib) : config.sendLimitShared, isAdmin: isAdmin(user.id), route }),
    photo: {
      key: `prof:${user.id}:${user.first_name}:${user.username}:${JSON.stringify(stats)}:${domainCount}`,
      buffer: () => profileCard({ name: user.first_name, username: user.username, id: user.id, joined, stats, domains: domainCount }),
    },
    keys: [[btn(L.domains, (c) => S.domains(c)), btn(L.addresses, (c) => S.addresses(c))], [btn(L.settings, (c) => S.settings(c)), btn(L.menu, (c) => S.home(c))]],
  });
};

// ── domains ──────────────────────────────────────────────────────────────
const canManage = (ctx, d) => d && (Number(d.owner_id) === ctx.from.id || isAdmin(ctx.from.id));

S.domains = async (ctx) => {
  busy(ctx);
  const uid = ctx.from.id;
  const mine = store.userDomains(uid);
  const allowAdd = config.allowUserDomains || isAdmin(uid);
  const keys = mine.map((d) => [btn(`${d.verified ? '✅' : '⏳'} ${d.domain}`, (c) => S.domain(c, d.id))]);
  keys.push([btn(L.new, (c) => S.picker(c)), allowAdd ? btn('➕ Add my domain', (c) => S.addDomain(c)) : null].filter(Boolean));
  keys.push(menuRow());
  return present(ctx, { name: 'domains', text: ui.domainsHub(await domainsFor(uid), mine, { allowAdd }), keys });
};

S.addDomain = (ctx) => {
  if (!config.allowUserDomains && !isAdmin(ctx.from.id)) return S.problem(ctx, 'domainoff');
  return present(ctx, {
    name: 'add-domain',
    text: ui.askDomain(),
    keys: [[btn(L.cancel, (c) => S.domains(c))]],
    placeholder: 'example.com',
    input: async (c, text) => {
      const uid = c.from.id;
      const name = text.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      if (!isDomain(name)) return S.problem(c, 'baddomain', { back: btn('✍️ Try again', (x) => S.addDomain(x)) });
      const existing = store.findDomain(name);
      if ((await publicDomains()).some((d) => d.domain === name) || (existing?.verified && Number(existing.owner_id) !== uid)) {
        return S.problem(c, 'domaintaken', { back: btn(L.domains, (x) => S.domains(x)) });
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

S.domain = async (ctx, id) => {
  const d = store.getDomain(id);
  if (!canManage(ctx, d)) return S.domains(ctx);
  busy(ctx);
  const check = await checkDomain(d).catch(() => null);
  const fresh = store.getDomain(id);
  const relay = svc.relayDomain()?.id === fresh.id;
  const keys = [
    [btn('🔄 Check again', (c) => S.domain(c, id)), btn('📄 Worker files', (c) => S.workerFiles(c, fresh))],
    [btn(fresh.worker_url ? '🔗 Change worker URL' : '🔗 Set worker URL', (c) => S.workerUrl(c, fresh))],
  ];
  if (fresh.verified) keys.push([btn('✨ Address on this domain', (c) => S.custom(c, { provider: 'own', domain: fresh.domain }))]);
  if (isAdmin(ctx.from.id)) {
    keys.push([btn(fresh.public ? '🔒 Make private' : '💎 Share with everyone', (c) => {
      store.setDomain(fresh.id, { public: fresh.public ? 0 : 1 });
      return S.domain(c, id);
    })]);
  }
  keys.push([btn('🗑 Remove domain', (c) => S.removeDomain(c, fresh)), btn('‹ Domains', (c) => S.domains(c))]);
  return present(ctx, { name: 'domain', text: ui.domainManage(fresh, check, { botUrl: config.publicUrl, relay }), keys });
};

S.workerFiles = async (ctx, d) => {
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
    keys: [[btn(L.cancel, (c) => S.domain(c, d.id))]],
    placeholder: 'https://….workers.dev',
    input: async (c, text) => {
      let url;
      try {
        url = new URL(text.startsWith('http') ? text : `https://${text}`);
      } catch {}
      if (!url || url.protocol !== 'https:') return S.problem(c, 'badurl', { back: btn('✍️ Try again', (x) => S.workerUrl(x, d)) });
      busy(c);
      const ping = await pingWorker(url.origin, d.key);
      if (ping.ok) store.setDomain(d.id, { worker_url: url.origin, can_send: ping.canSend ? 1 : 0 });
      return S.domain(c, d.id);
    },
  });

S.removeDomain = (ctx, d) => {
  const onIt = store.allInboxes().filter((x) => x.address.endsWith(`@${d.domain}`));
  return present(ctx, {
    name: 'remove-domain',
    text: ui.confirmRemoveDomain(d, onIt.length),
    keys: [[btn('🗑 Yes, remove it', async (c) => {
      for (const ib of onIt) await svc.destroyInbox(ib, { reason: 'domain removed' });
      store.removeDomain(d.id);
      return S.domains(c);
    }), btn('✖ Keep it', (c) => S.domain(c, d.id))]],
  });
};

// ── compose ──────────────────────────────────────────────────────────────
const discard = btn(L.discard, (c) => {
  drafts.delete(c.from.id);
  return S.home(c);
});

S.compose = (ctx, inboxId) => {
  const ib = inboxId ? store.getOwnedInbox(ctx.from.id, inboxId) : activeOf(ctx);
  if (!ib) return S.home(ctx);
  if (!svc.sendRoute(ib)) return present(ctx, { name: 'no-send', text: ui.composeUnavailable(isAdmin(ctx.from.id)), keys: [[btn(L.domains, (c) => S.domains(c))], menuRow()] });
  drafts.set(ctx.from.id, { inboxId: ib.id, draft: { attachments: [] } });
  return S.composeStep(ctx, 'to');
};

S.pickSender = (ctx) => {
  const list = store.listInboxes(ctx.from.id).filter((ib) => svc.sendRoute(ib));
  return present(ctx, {
    name: 'pick-sender',
    text: '✉️ <b>Send from which address?</b>',
    keys: [...list.map((ib) => [btn(`✉ ${ib.address}`, (c) => {
      const st = drafts.get(c.from.id);
      if (st) st.inboxId = ib.id;
      return st ? S.composeStep(c, st.draft.to ? 'preview' : 'to') : S.compose(c, ib.id);
    })]), [discard]],
  });
};

const fileInput = async (ctx) => {
  const st = drafts.get(ctx.from.id);
  if (!st) return S.home(ctx);
  const doc = ctx.message.document;
  const photo = ctx.message.photo?.at(-1);
  const size = doc?.file_size || photo?.file_size || 0;
  const total = st.draft.attachments.reduce((s, a) => s + a.size, 0);
  if (size > 10 * 1024 * 1024 || total + size > 15 * 1024 * 1024) return ctx.reply('📎 Too large. Attachments are limited to 15 MB in total.');
  busy(ctx);
  const file = await ctx.api.getFile(doc?.file_id || photo.file_id);
  const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  st.draft.attachments.push({
    filename: doc?.file_name || `photo-${st.draft.attachments.length + 1}.jpg`,
    type: doc?.mime_type || 'image/jpeg',
    size: buf.length,
    content: buf.toString('base64'),
  });
  if (ctx.message.caption && !st.draft.text) st.draft.text = ctx.message.caption;
  ctx.deleteMessage().catch(() => {});
  return S.composeStep(ctx, st.draft.to && st.draft.text ? 'preview' : st.step);
};

S.composeStep = async (ctx, step) => {
  const uid = ctx.from.id;
  const st = drafts.get(uid);
  const ib = st && store.getOwnedInbox(uid, st.inboxId);
  if (!ib) return S.home(ctx);
  const sender = senderFor(ib);
  st.step = step;
  const d = st.draft;
  const others = store.listInboxes(uid).filter((x) => x.id !== ib.id && svc.sendRoute(x)).length > 0;

  if (step === 'preview') {
    const user = userOf(ctx);
    return present(ctx, {
      name: 'compose-preview',
      text: ui.composePreview(d, ib, sender, { sentToday: await within(store.sentLast24h(uid), 1500, 0), limit: sendLimitFor(user, ib) }),
      keys: [
        [btn('🚀 Send now', (c) => S.send(c))],
        [btn('✏️ Recipient', (c) => S.composeStep(c, 'to')), btn('✏️ Subject', (c) => S.composeStep(c, 'subject')), btn('✏️ Message', (c) => S.composeStep(c, 'body'))],
        [others ? btn('🔁 Change sender', (c) => S.pickSender(c)) : null, discard].filter(Boolean),
      ],
      file: fileInput,
    });
  }

  const keys = [];
  if (step === 'subject') keys.push([btn('⏭ No subject', (c) => {
    d.subject = '';
    return S.composeStep(c, d.text ? 'preview' : 'body');
  })]);
  if (step === 'body' && d.text) keys.push([btn('👀 Preview', (c) => S.composeStep(c, 'preview'))]);
  keys.push([step === 'to' && others ? btn('🔁 Change sender', (c) => S.pickSender(c)) : null, discard].filter(Boolean));

  return present(ctx, {
    name: `compose-${step}`,
    text: ui.composeAsk(step, d, ib, sender),
    keys,
    placeholder: { to: 'name@example.com', subject: 'Subject', body: 'Write your message…' }[step],
    file: step === 'body' ? fileInput : null,
    input: async (c, text) => {
      if (step === 'to') {
        const list = text.split(/[,\s;]+/).filter(Boolean);
        if (!list.length || list.length > 10 || !list.every(isEmail)) return S.problem(c, 'badto', { back: btn('✍️ Try again', (x) => S.composeStep(x, 'to')) });
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
  });
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
  busy(ctx);
  try {
    await sendMail(userOf(ctx), ib, st.draft);
  } catch (e) {
    return fail(ctx, e, btn('‹ Back to draft', (c) => S.composeStep(c, 'preview')));
  }
  drafts.delete(ctx.from.id);
  return present(ctx, {
    name: 'sent',
    text: ui.sent(st.draft, senderFor(ib)),
    keys: [[btn('✉️ Write another', (c) => S.compose(c, ib.id))], ...mainKeys(ib, counts(svc.cachedList(ib.id)?.list))],
  });
};

// ── global fallbacks (work from any screen, and after a restart) ─────────
const GLOBAL = [
  [/^📥 Inbox/, (c) => S.inbox(c)],
  [L.refresh, (c) => S.home(c, { force: true })],
  [L.new, (c) => S.picker(c)],
  [L.addresses, (c) => S.addresses(c)],
  [L.compose, (c) => S.compose(c)],
  [L.timer, (c) => S.timer(c)],
  [L.domains, (c) => S.domains(c)],
  [L.profile, (c) => S.profile(c)],
  [L.settings, (c) => S.settings(c)],
  [L.help, (c) => S.help(c)],
  [L.instant, (c) => S.create(c, {})],
  [L.custom, (c) => S.custom(c)],
  [/^(?:⭐ |💎 )?@([a-z0-9.-]+\.[a-z]{2,})$/i, async (c, m) => {
    const d = (await domainsFor(c.from.id)).find((x) => x.domain === m[1].toLowerCase());
    return d ? S.create(c, { provider: d.provider, domain: d.domain }) : S.picker(c);
  }],
  [/^[◉○] (\S+@\S+)$/, (c, m) => {
    const ib = store.listInboxes(c.from.id).find((x) => x.address === m[1]);
    if (ib) store.setUser(c.from.id, { active_inbox: ib.id });
    return S.home(c);
  }],
];

function globalMatch(text) {
  for (const [pat, fn] of GLOBAL) {
    if (typeof pat === 'string' ? pat === text : pat.test(text)) {
      const m = typeof pat === 'string' ? null : text.match(pat);
      return (c) => fn(c, m);
    }
  }
  return null;
}

// ── bot ──────────────────────────────────────────────────────────────────
export function createBot() {
  const bot = new Bot(config.botToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 8 }));

  bot.use((ctx, next) => (ctx.chat?.type === 'private' ? next() : undefined));
  bot.use((ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    store.touchUser(ctx.from);
    return next();
  });

  // commands
  bot.command('start', (ctx) => {
    ctx.deleteMessage().catch(() => {});
    return S.home(ctx);
  });
  const cmd = (name, fn) =>
    bot.command(name, (ctx) => {
      ctx.deleteMessage().catch(() => {});
      return fn(ctx);
    });
  cmd(['menu', 'home'], (c) => S.home(c));
  cmd('new', (c) => S.create(c, {}));
  cmd('inbox', (c) => S.inbox(c));
  cmd('compose', (c) => S.compose(c));
  cmd('domains', (c) => S.domains(c));
  cmd('profile', (c) => S.profile(c));
  cmd('addresses', (c) => S.addresses(c));
  cmd('settings', (c) => S.settings(c));
  cmd('help', (c) => S.help(c));

  // admin
  bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const s = store.stats();
    const relay = svc.relayDomain();
    await ctx.reply(
      [
        '📊 <b>Crevio stats</b>',
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

  // inline buttons exist only on push notifications
  bot.on('callback_query:data', async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const data = ctx.callbackQuery.data;
    let m;
    if ((m = data.match(/^msg:(\d+):([\w-]+)$/))) {
      const ib = store.getOwnedInbox(ctx.from.id, Number(m[1]));
      return ib ? S.message(ctx, ib, m[2]) : S.problem(ctx, 'gone');
    }
    if ((m = data.match(/^inb:(\d+)/))) return S.inbox(ctx, Number(m[1]));
    if (data === 'nr') return S.create(ctx, {});
    return S.home(ctx); // buttons from older versions land on the new home screen
  });

  // keyboard taps & typed input
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    ctx.deleteMessage().catch(() => {}); // the panel reflects the input; keep the chat clean
    const sc = screenOf(ctx.from.id);
    const fn = sc?.on.get(text) ?? globalMatch(text);
    if (fn) return fn(ctx);
    if (sc?.input) return sc.input(ctx, text);
    return S.home(ctx);
  });

  bot.on(['message:document', 'message:photo'], (ctx) => {
    const sc = screenOf(ctx.from.id);
    return sc?.file ? sc.file(ctx) : S.home(ctx);
  });

  bot.catch((err) => {
    console.error(`[bot] update ${err.ctx?.update?.update_id}:`, err.error);
    err.ctx?.reply?.('⚠️ Something went wrong. Tap 🏠 Menu and try again.').catch(() => {});
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
  { command: 'help', description: 'How Crevio works' },
];
