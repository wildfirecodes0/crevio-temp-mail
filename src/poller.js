// Background loop: pushes new mail to users and enforces self-destruct timers.
// Providers are polled in parallel (each at a polite pace), so one slow API never delays the others.
import { GrammyError } from 'grammy';
import { config } from './config.js';
import * as store from './db.js';
import * as ui from './ui.js';
import * as svc from './service.js';
import { analyse } from './bot.js';
import { sleep, esc } from './utils.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const PACE = { tm: 140, gw: 140, tio: 120, gm: 150 }; // ms between requests per provider

async function deliver(bot, userId, view) {
  try {
    await bot.api.sendMessage(userId, view.text, { ...HTML, reply_markup: view.kb });
    return true;
  } catch (e) {
    if (e instanceof GrammyError && (e.error_code === 403 || /chat not found/i.test(e.description))) {
      store.setUser(userId, { blocked: 1 });
    } else {
      console.warn(`[push] ${userId}: ${e.message}`);
    }
    return false;
  }
}

/** Push one new message to its owner. Used by the poller and by inbound custom-domain mail. */
export async function pushMail(bot, ib, msgId) {
  store.bumpUser(ib.user_id, 'received');
  store.bumpInbox(ib.id, 'received');
  const user = store.getUser(ib.user_id);
  if (!user?.notify || user.blocked) return;
  let full;
  try {
    full = await svc.getMessage(ib, msgId);
  } catch {
    full = svc.cachedList(ib.id)?.list.find((m) => m.id === msgId);
  }
  if (!full) return;
  const a = full.text || full.html ? analyse(full) : { codes: [], links: [] };
  await deliver(bot, Number(ib.user_id), ui.notification(ib, full, a));
}

async function sweepExpired(bot) {
  for (const ib of store.expiredInboxes()) {
    await svc.destroyInbox(ib, { reason: 'expired' });
    const user = store.getUser(ib.user_id);
    if (user) store.getActiveInbox(user); // repoint active address
    if (user && !user.blocked) await deliver(bot, Number(ib.user_id), ui.expired(ib.address));
  }
}

async function pollOne(bot, ib) {
  let msgs;
  try {
    msgs = await svc.fetchList(ib);
  } catch (e) {
    if (e.status === 401 || e.status === 404) store.setFail(ib.id, (ib.fail_count || 0) + 1);
    throw e;
  }
  if (ib.fail_count) store.setFail(ib.id, 0);
  if (!msgs.length) return;

  const seen = await store.seenSet(ib.id);
  const fresh = msgs.filter((m) => !seen.has(m.id));
  if (!fresh.length) return;
  await store.markSeen(ib.id, fresh.map((m) => m.id));

  // Oldest first so the chat reads in order; cap so a flood can't spam the user.
  for (const m of fresh.slice(0, 5).reverse()) {
    await pushMail(bot, ib, m.id);
    await sleep(80);
  }
  if (fresh.length > 5) {
    store.bumpUser(ib.user_id, 'received', fresh.length - 5);
    await deliver(bot, Number(ib.user_id), {
      text: `📬 <b>+${fresh.length - 5} more</b> in <code>${esc(ib.address)}</code>`,
      kb: { inline_keyboard: [[{ text: '📥  Open inbox', callback_data: `inb:${ib.id}:0` }]] },
    });
  }
}

export function startPoller(bot) {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    const t0 = Date.now();
    try {
      await sweepExpired(bot);
      const groups = new Map();
      for (const ib of store.pollableInboxes()) {
        if (!groups.has(ib.provider)) groups.set(ib.provider, []);
        groups.get(ib.provider).push(ib);
      }
      await Promise.all(
        [...groups].map(async ([pid, list]) => {
          for (const ib of list) {
            if (stopped) return;
            try {
              await pollOne(bot, ib);
            } catch (e) {
              console.warn(`[poll] ${ib.address}: ${e.message}`);
            }
            await sleep(PACE[pid] ?? 150);
          }
        }),
      );
      const n = [...groups.values()].reduce((s, l) => s + l.length, 0);
      if (n > 50) console.log(`[poll] ${n} inboxes in ${Date.now() - t0}ms`);
    } catch (e) {
      console.error('[poll] cycle failed:', e);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, config.pollIntervalSec * 1000);
  setTimeout(tick, 2000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
