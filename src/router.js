// Reply-keyboard screen router.
// A screen = { text, keys, input?, file?, photo? }. `keys` are rows of btn(label, handler) / web(label, url).
// present() sends the screen as one fresh "panel" message carrying its own bottom keyboard, deletes the previous
// panel, and remembers which label maps to which handler for this user.
import { InputFile } from 'grammy';
import * as store from './db.js';

export const btn = (label, fn) => ({ label, fn });
export const web = (label, url) => ({ label, web_app: { url } });

const screens = new Map(); // userId → { name, on: Map(label → fn), input, file, at }
const photoIds = new Map(); // photo cache key → Telegram file_id

export const screenOf = (uid) => screens.get(uid) ?? null;
export const forget = (uid) => screens.delete(uid);

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

export async function present(ctx, s) {
  const uid = ctx.from.id;
  const on = new Map();
  const keyboard = [];
  for (const row of s.keys || []) {
    const out = [];
    for (const b of row) {
      if (!b) continue;
      if (b.web_app) out.push({ text: b.label, web_app: b.web_app });
      else {
        out.push({ text: b.label });
        if (b.fn) on.set(b.label, b.fn);
      }
    }
    if (out.length) keyboard.push(out);
  }
  screens.set(uid, { name: s.name, on, input: s.input ?? null, file: s.file ?? null, at: Date.now() });

  const reply_markup = {
    keyboard,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: s.placeholder || 'Crevio · choose below',
  };
  const chatId = ctx.chat?.id ?? uid;
  let m;
  if (s.photo) {
    const key = s.photo.key;
    const cachedId = photoIds.get(key);
    const media = cachedId ?? new InputFile(await s.photo.buffer(), 'crevio.png');
    m = await ctx.api.sendPhoto(chatId, media, { ...HTML, caption: s.text, reply_markup });
    if (!cachedId && m.photo?.length) {
      if (photoIds.size > 500) photoIds.delete(photoIds.keys().next().value);
      photoIds.set(key, m.photo.at(-1).file_id);
    }
  } else {
    m = await ctx.api.sendMessage(chatId, s.text, { ...HTML, reply_markup });
  }

  const user = store.getUser(uid);
  if (user?.panel_msg && user.panel_msg !== m.message_id) ctx.api.deleteMessage(chatId, user.panel_msg).catch(() => {});
  if (user) store.setUser(uid, { panel_msg: m.message_id });
  return m;
}

/** Show "typing…" while slow work runs, so a tap always gets instant feedback. */
export function busy(ctx, action = 'typing') {
  ctx.api.sendChatAction(ctx.chat?.id ?? ctx.from.id, action).catch(() => {});
}
