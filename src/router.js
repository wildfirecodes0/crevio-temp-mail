// Hybrid screen router.
//  • The bottom reply keyboard is ONLY the main menu. It never changes, and is set by a small "anchor" message.
//  • Every screen is one "panel" message with its own inline buttons for that screen's actions.
//    Button taps edit the panel in place; menu taps / commands send a fresh panel and delete the previous one.
//  • Inline buttons carry short tokens mapped to closures (per user), so screens are plain functions.
import { InputFile } from 'grammy';
import * as store from './db.js';

// ── button helpers ───────────────────────────────────────────────────────
export const act = (text, fn) => ({ text, fn });
export const url = (text, href) => ({ text, url: href });
export const webapp = (text, href) => ({ text, web_app: { url: href } });
export const copy = (text, value) => ({ text, copy_text: { text: String(value).slice(0, 256) } });

// ── per-user state ───────────────────────────────────────────────────────
const tokens = new Map(); // uid → Map(token → fn)
const counters = new Map();
const screens = new Map(); // uid → { name, input, file }
const panelKind = new Map(); // uid → 'text' | 'photo'
const photoIds = new Map(); // card cache key → Telegram file_id
const TOKEN_CAP = 600;

export const screenOf = (uid) => screens.get(uid) ?? null;
export const clearInput = (uid) => {
  const s = screens.get(uid);
  if (s) s.input = s.file = null;
};

function register(uid, fn) {
  let m = tokens.get(uid);
  if (!m) tokens.set(uid, (m = new Map()));
  const n = (counters.get(uid) ?? 0) + 1;
  counters.set(uid, n);
  const t = `t:${n.toString(36)}`;
  m.set(t, fn);
  if (m.size > TOKEN_CAP) m.delete(m.keys().next().value);
  return t;
}
export const resolveToken = (uid, data) => tokens.get(uid)?.get(data) ?? null;

function inlineMarkup(uid, rows = []) {
  const inline_keyboard = [];
  for (const row of rows) {
    if (!row) continue;
    const out = row.filter(Boolean).map((b) => {
      if (b.fn) return { text: b.text, callback_data: register(uid, b.fn) };
      if (b.callback_data) return { text: b.text, callback_data: b.callback_data };
      const { fn: _f, ...rest } = b;
      return rest;
    });
    if (out.length) inline_keyboard.push(out);
  }
  return { inline_keyboard };
}

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const isBadRequest = (e) => e?.error_code === 400;
const notModified = (e) => /message is not modified/i.test(e?.description || '');

/**
 * Show a screen: { name, text, kb?: rows of buttons, photo?: { key, buffer() }, input?, file? }
 * opts.fresh forces a new message at the bottom (menu taps, commands).
 */
export async function present(ctx, s, { fresh = false } = {}) {
  const uid = ctx.from.id;
  const chatId = ctx.chat?.id ?? uid;
  const user = store.getUser(uid);
  const reply_markup = inlineMarkup(uid, s.kb);
  screens.set(uid, { name: s.name, input: s.input ?? null, file: s.file ?? null });

  // Which message can be edited? A tapped panel, or the current panel when the user typed into a prompt.
  const tapped = ctx.callbackQuery?.message;
  let target = null;
  if (!fresh) {
    if (tapped && tapped.message_id === user?.panel_msg) target = tapped.message_id;
    else if (!tapped && ctx.editPanel && user?.panel_msg) target = user.panel_msg;
  }
  const kind = target ? panelKind.get(uid) ?? (tapped?.photo ? 'photo' : 'text') : null;

  if (target) {
    try {
      if (!s.photo && kind === 'text') {
        await ctx.api.editMessageText(chatId, target, s.text, { ...HTML, reply_markup });
        return { message_id: target };
      }
      if (s.photo && kind === 'photo') {
        const media = photoIds.get(s.photo.key) ?? new InputFile(await s.photo.buffer(), 'crevio.png');
        const m = await ctx.api.editMessageMedia(chatId, target, { type: 'photo', media, caption: s.text, parse_mode: 'HTML' }, { reply_markup });
        rememberPhoto(s.photo.key, m);
        return { message_id: target };
      }
    } catch (e) {
      if (notModified(e)) return { message_id: target };
      if (!isBadRequest(e)) throw e;
    }
  }

  // New panel at the bottom; remove the previous one.
  let m;
  if (s.photo) {
    const cached = photoIds.get(s.photo.key);
    m = await ctx.api.sendPhoto(chatId, cached ?? new InputFile(await s.photo.buffer(), 'crevio.png'), { ...HTML, caption: s.text, reply_markup });
    rememberPhoto(s.photo.key, m);
  } else {
    m = await ctx.api.sendMessage(chatId, s.text, { ...HTML, reply_markup });
  }
  panelKind.set(uid, s.photo ? 'photo' : 'text');
  if (user?.panel_msg && user.panel_msg !== m.message_id) ctx.api.deleteMessage(chatId, user.panel_msg).catch(() => {});
  if (user) store.setUser(uid, { panel_msg: m.message_id });
  return m;
}

function rememberPhoto(key, m) {
  const id = m?.photo?.at?.(-1)?.file_id;
  if (!id || photoIds.has(key)) return;
  if (photoIds.size > 500) photoIds.delete(photoIds.keys().next().value);
  photoIds.set(key, id);
}

/** Instant feedback while slow work runs. */
export function busy(ctx, action = 'typing') {
  ctx.api.sendChatAction(ctx.chat?.id ?? ctx.from.id, action).catch(() => {});
}
