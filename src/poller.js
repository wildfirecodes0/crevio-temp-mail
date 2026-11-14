// Background loop: pushes new mail to users and enforces self-destruct timers.
import { GrammyError } from 'grammy';
import { config } from './config.js';
import * as store from './db.js';
import * as mail from './mail.js';
import * as ui from './ui.js';
import { authed, destroyInbox } from './service.js';
import { analyse } from './bot.js';
import { sleep, esc } from './utils.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

async function deliver(bot, userId, view) {
  try {
    await bot.api.sendMessage(userId, view.text, { ...HTML, reply_markup: view.kb });
    return true;
  } catch (e) {
    if (e instanceof GrammyError && (e.error_code === 403 || /chat not found/i.test(e.description))) {
      await store.markBlocked(userId);
    } else {
      console.warn(`[push] ${userId}: ${e.message}`);
    }
    return false;
  }
}

async function sweepExpired(bot) {
  for (const ib of await store.expiredInboxes()) {
    await destroyInbox(ib);
    const user = await store.getUser(ib.user_id);
    if (user && Number(user.active_inbox) === Number(ib.id)) await store.getActiveInbox(user); // repoint
    if (user && !user.blocked) await deliver(bot, Number(ib.user_id), ui.expired(ib.address));
  }
}

async function pollOne(bot, ib) {
  let msgs;
  try {
    msgs = await authed(ib, (t) => mail.listMessages(ib.provider, t));
  } catch (e) {
    if (e.status === 401 || e.status === 404) await store.bumpFail(ib.id);
    throw e;
  }
  if (Number(ib.fail_count)) store.resetFail(ib.id).catch(() => {});
  if (!msgs.length) return;

  const seen = await store.seenSet(ib.id);
  const fresh = msgs.filter((m) => !seen.has(m.id));
  if (!fresh.length) return;
  await store.markSeen(ib.id, fresh.map((m) => m.id));
  await store.bumpReceived(ib.id, fresh.length);

  // Oldest first so the chat reads in order; cap so a flood can't spam the user.
  for (const summary of fresh.slice(0, 5).reverse()) {
    let full = summary;
    try {
      full = await authed(ib, (t) => mail.getMessage(ib.provider, t, summary.id));
    } catch {}
    const a = full.text || full.html ? analyse(full) : { codes: [], links: [] };
    await deliver(bot, Number(ib.user_id), ui.notification(ib, full, a));
    await sleep(120);
  }
  if (fresh.length > 5) {
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
      const list = await store.pollableInboxes();
      for (const ib of list) {
        if (stopped) break;
        try {
          await pollOne(bot, ib);
        } catch (e) {
          console.warn(`[poll] ${ib.address}: ${e.message}`);
        }
        await sleep(140); // stay well under provider rate limits (~8 req/s)
      }
      if (list.length > 50) console.log(`[poll] ${list.length} inboxes in ${Date.now() - t0}ms`);
    } catch (e) {
      console.error('[poll] cycle failed:', e);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, config.pollIntervalSec * 1000);
  setTimeout(tick, 3000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
