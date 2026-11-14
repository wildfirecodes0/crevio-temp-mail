// Turso (libSQL) storage with a write-through in-memory cache.
// The bot runs as a single instance, so users/inboxes/domains live in memory and every read is instant;
// writes go to Turso in the background. Mail bodies for custom domains are read from Turso on demand.
import { createClient } from '@libsql/client';
import crypto from 'node:crypto';
import { config } from './config.js';

export const db = createClient({ url: config.dbUrl, authToken: config.dbToken });

const now = () => Date.now();
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const one = async (sql, args = []) => (await all(sql, args))[0] ?? null;

/** Fire-and-forget write. Errors are logged, never thrown into the UI path. */
function bg(sql, args = []) {
  db.execute({ sql, args }).catch((e) => console.error('[db]', e.message, sql.slice(0, 60)));
}

const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));

// ── schema ───────────────────────────────────────────────────────────────
async function addColumns(table, cols) {
  const have = new Set((await all(`PRAGMA table_info(${table})`)).map((r) => r.name));
  for (const [name, def] of cols) if (!have.has(name)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

export async function migrate() {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, first_name TEXT, username TEXT, active_inbox INTEGER,
        notify INTEGER NOT NULL DEFAULT 1, default_ttl INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS inboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, provider TEXT NOT NULL, address TEXT NOT NULL,
        password TEXT NOT NULL DEFAULT '', account_id TEXT, token TEXT, expires_at INTEGER,
        received INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_inboxes_user ON inboxes(user_id)`,
      `CREATE TABLE IF NOT EXISTS seen (inbox_id INTEGER NOT NULL, msg_id TEXT NOT NULL, PRIMARY KEY (inbox_id, msg_id))`,
      `CREATE TABLE IF NOT EXISTS flags (inbox_id INTEGER NOT NULL, msg_id TEXT NOT NULL, flag TEXT NOT NULL,
        PRIMARY KEY (inbox_id, msg_id, flag))`,
      `CREATE TABLE IF NOT EXISTS domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL UNIQUE, owner_id INTEGER, key TEXT NOT NULL,
        public INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, worker_url TEXT,
        can_send INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS mails (
        id TEXT PRIMARY KEY, inbox_id INTEGER NOT NULL, from_name TEXT, from_addr TEXT, subject TEXT, intro TEXT,
        text TEXT, html TEXT, atts TEXT, created_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_mails_inbox ON mails(inbox_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS mail_atts (
        mail_id TEXT NOT NULL, idx INTEGER NOT NULL, filename TEXT, type TEXT, size INTEGER, data BLOB,
        PRIMARY KEY (mail_id, idx))`,
      `CREATE TABLE IF NOT EXISTS sent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, inbox_id INTEGER, to_addr TEXT, subject TEXT,
        created_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_sent_user ON sent_log(user_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT, prefix TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used INTEGER, uses INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS otps (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, key_id INTEGER, to_addr TEXT NOT NULL, code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
    ],
    'write',
  );
  await addColumns('users', [
    ['generated', 'INTEGER NOT NULL DEFAULT 0'],
    ['disposed', 'INTEGER NOT NULL DEFAULT 0'],
    ['received', 'INTEGER NOT NULL DEFAULT 0'],
    ['sent', 'INTEGER NOT NULL DEFAULT 0'],
    ['panel_msg', 'INTEGER'],
    ['lang', 'TEXT'],
    ['banned', 'INTEGER NOT NULL DEFAULT 0'],
    ['anchor_msg', 'INTEGER'],
    ['kb_ver', 'INTEGER NOT NULL DEFAULT 0'],
  ]);
  await addColumns('inboxes', [
    ['auth', 'TEXT'],
    ['sent', 'INTEGER NOT NULL DEFAULT 0'],
  ]);
  // Counters were added after v1: users who created addresses before that start from their live count.
  await db.execute(
    `UPDATE users SET generated = (SELECT COUNT(*) FROM inboxes WHERE inboxes.user_id = users.id)
     WHERE generated = 0 AND EXISTS (SELECT 1 FROM inboxes WHERE inboxes.user_id = users.id)`,
  );
  // v1 → v2: move mail.tm credentials into the generic auth blob.
  await db.execute(
    `UPDATE inboxes SET auth = json_object('password', password, 'token', token, 'accountId', account_id) WHERE auth IS NULL`,
  );
  await load();
}

// ── cache ────────────────────────────────────────────────────────────────
const users = new Map(); // id → user
const inboxes = new Map(); // id → inbox (auth parsed)
let domains = []; // custom domains

function hydrateInbox(r) {
  const ib = plain(r);
  try {
    ib.auth = JSON.parse(ib.auth || '{}');
  } catch {
    ib.auth = {};
  }
  return ib;
}

async function load() {
  for (const r of await all(`SELECT * FROM users`)) users.set(Number(r.id), plain(r));
  for (const r of await all(`SELECT * FROM inboxes`)) inboxes.set(Number(r.id), hydrateInbox(r));
  domains = (await all(`SELECT * FROM domains`)).map(plain);
  await loadApiKeys();
  console.log(`  cache: ${users.size} users · ${inboxes.size} inboxes · ${domains.length} custom domains`);
}

// ── users ────────────────────────────────────────────────────────────────
export function touchUser(u) {
  let user = users.get(u.id);
  const t = now();
  if (!user) {
    user = {
      id: u.id, first_name: u.first_name || '', username: u.username || null, lang: u.language_code || null,
      active_inbox: null, notify: 1, default_ttl: 0, blocked: 0, banned: 0, created_at: t, last_seen: t,
      generated: 0, disposed: 0, received: 0, sent: 0, panel_msg: null, anchor_msg: null, kb_ver: 0,
    };
    users.set(u.id, user);
    bg(
      `INSERT INTO users (id, first_name, username, lang, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username, last_seen = excluded.last_seen`,
      [u.id, user.first_name, user.username, user.lang, t, t],
    );
    return user;
  }
  const changed = user.first_name !== (u.first_name || '') || user.username !== (u.username || null) || user.blocked;
  user.first_name = u.first_name || '';
  user.username = u.username || null;
  user.blocked = 0;
  if (changed || t - user.last_seen > 10 * 60_000) {
    user.last_seen = t;
    bg(`UPDATE users SET first_name = ?, username = ?, blocked = 0, last_seen = ? WHERE id = ?`, [user.first_name, user.username, t, u.id]);
  }
  return user;
}

export const getUser = (id) => users.get(Number(id)) ?? null;

const USER_FIELDS = new Set(['active_inbox', 'notify', 'default_ttl', 'blocked', 'banned', 'panel_msg', 'anchor_msg', 'kb_ver']);
export function setUser(id, patch) {
  const u = users.get(Number(id));
  if (!u) return;
  for (const [k, v] of Object.entries(patch)) {
    if (!USER_FIELDS.has(k)) throw new Error(`bad user field ${k}`);
    u[k] = v;
    bg(`UPDATE users SET ${k} = ? WHERE id = ?`, [v, id]);
  }
}

export function bumpUser(id, field, n = 1) {
  if (!['generated', 'disposed', 'received', 'sent'].includes(field)) return;
  const u = users.get(Number(id));
  if (u) u[field] = (u[field] || 0) + n;
  bg(`UPDATE users SET ${field} = ${field} + ? WHERE id = ?`, [n, id]);
}

export function deleteUser(uid) {
  for (const ib of listInboxes(uid)) inboxes.delete(ib.id);
  apiKeys = apiKeys.filter((k) => Number(k.user_id) !== Number(uid));
  users.delete(Number(uid));
  db.batch(
    [
      { sql: `DELETE FROM mail_atts WHERE mail_id IN (SELECT id FROM mails WHERE inbox_id IN (SELECT id FROM inboxes WHERE user_id = ?))`, args: [uid] },
      { sql: `DELETE FROM mails WHERE inbox_id IN (SELECT id FROM inboxes WHERE user_id = ?)`, args: [uid] },
      { sql: `DELETE FROM seen WHERE inbox_id IN (SELECT id FROM inboxes WHERE user_id = ?)`, args: [uid] },
      { sql: `DELETE FROM flags WHERE inbox_id IN (SELECT id FROM inboxes WHERE user_id = ?)`, args: [uid] },
      { sql: `DELETE FROM inboxes WHERE user_id = ?`, args: [uid] },
      { sql: `DELETE FROM sent_log WHERE user_id = ?`, args: [uid] },
      { sql: `UPDATE api_keys SET revoked = 1 WHERE user_id = ?`, args: [uid] },
      { sql: `DELETE FROM otps WHERE user_id = ?`, args: [uid] },
      { sql: `UPDATE domains SET owner_id = NULL, public = 0, verified = 0 WHERE owner_id = ?`, args: [uid] },
      { sql: `DELETE FROM users WHERE id = ?`, args: [uid] },
    ],
    'write',
  ).catch((e) => console.error('[db] deleteUser', e.message));
  domains = domains.filter((d) => Number(d.owner_id) !== Number(uid));
}

// ── inboxes ──────────────────────────────────────────────────────────────
export const listInboxes = (uid) =>
  [...inboxes.values()].filter((ib) => Number(ib.user_id) === Number(uid)).sort((a, b) => a.id - b.id);
export const countInboxes = (uid) => listInboxes(uid).length;
export const getInbox = (id) => inboxes.get(Number(id)) ?? null;
export const allInboxes = () => [...inboxes.values()];
export const findInboxByAddress = (address) => {
  const a = String(address).toLowerCase();
  for (const ib of inboxes.values()) if (ib.address.toLowerCase() === a) return ib;
  return null;
};

export function getOwnedInbox(uid, id) {
  const ib = getInbox(id);
  return ib && Number(ib.user_id) === Number(uid) ? ib : null;
}

export function getActiveInbox(user) {
  if (!user) return null;
  const ib = user.active_inbox && getOwnedInbox(user.id, user.active_inbox);
  if (ib) return ib;
  const list = listInboxes(user.id);
  const next = list[list.length - 1] ?? null;
  if ((next?.id ?? null) !== (user.active_inbox ?? null)) setUser(user.id, { active_inbox: next?.id ?? null });
  return next;
}

export async function createInbox({ userId, provider, address, auth, expiresAt }) {
  const t = now();
  const r = await db.execute({
    // `password` is NOT NULL without a default in databases created by v1, so always fill it.
    sql: `INSERT INTO inboxes (user_id, provider, address, password, auth, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [userId, provider, address, auth?.password ?? '', JSON.stringify(auth), expiresAt ?? null, t],
  });
  const ib = {
    id: Number(r.lastInsertRowid), user_id: userId, provider, address, auth, expires_at: expiresAt ?? null,
    received: 0, sent: 0, fail_count: 0, created_at: t,
  };
  inboxes.set(ib.id, ib);
  seenCache.set(ib.id, new Set());
  setUser(userId, { active_inbox: ib.id });
  bumpUser(userId, 'generated');
  return ib;
}

export function saveAuth(ib) {
  if (!ib.auth?._dirty) return;
  delete ib.auth._dirty;
  bg(`UPDATE inboxes SET auth = ? WHERE id = ?`, [JSON.stringify(ib.auth), ib.id]);
}

export function setExpiry(id, ts) {
  const ib = getInbox(id);
  if (ib) ib.expires_at = ts;
  bg(`UPDATE inboxes SET expires_at = ? WHERE id = ?`, [ts, id]);
}

export function setFail(id, n) {
  const ib = getInbox(id);
  if (!ib || ib.fail_count === n) return;
  ib.fail_count = n;
  bg(`UPDATE inboxes SET fail_count = ? WHERE id = ?`, [n, id]);
}

export function bumpInbox(id, field, n = 1) {
  if (!['received', 'sent'].includes(field)) return;
  const ib = getInbox(id);
  if (ib) ib[field] = (ib[field] || 0) + n;
  bg(`UPDATE inboxes SET ${field} = ${field} + ? WHERE id = ?`, [n, id]);
}

export function deleteInbox(id) {
  inboxes.delete(Number(id));
  seenCache.delete(Number(id));
  flagCache.delete(Number(id));
  db.batch(
    [
      { sql: `DELETE FROM mail_atts WHERE mail_id IN (SELECT id FROM mails WHERE inbox_id = ?)`, args: [id] },
      { sql: `DELETE FROM mails WHERE inbox_id = ?`, args: [id] },
      { sql: `DELETE FROM seen WHERE inbox_id = ?`, args: [id] },
      { sql: `DELETE FROM flags WHERE inbox_id = ?`, args: [id] },
      { sql: `DELETE FROM inboxes WHERE id = ?`, args: [id] },
    ],
    'write',
  ).catch((e) => console.error('[db] deleteInbox', e.message));
}

export const expiredInboxes = () => allInboxes().filter((ib) => ib.expires_at && ib.expires_at <= now());

export const pollableInboxes = () =>
  allInboxes().filter((ib) => {
    if (ib.provider === 'own' || ib.fail_count >= 20) return false;
    const u = getUser(ib.user_id);
    return u && u.notify && !u.blocked && !u.banned;
  });

// ── seen (already notified) & flags (read / hidden) ─────────────────────
const seenCache = new Map();
export async function seenSet(inboxId) {
  let s = seenCache.get(inboxId);
  if (!s) {
    s = new Set((await all(`SELECT msg_id FROM seen WHERE inbox_id = ?`, [inboxId])).map((r) => r.msg_id));
    seenCache.set(inboxId, s);
  }
  return s;
}

export async function markSeen(inboxId, ids) {
  const s = await seenSet(inboxId);
  const fresh = ids.filter((id) => !s.has(id));
  if (!fresh.length) return;
  fresh.forEach((id) => s.add(id));
  db.batch(fresh.map((id) => ({ sql: `INSERT OR IGNORE INTO seen (inbox_id, msg_id) VALUES (?, ?)`, args: [inboxId, id] })), 'write')
    .catch((e) => console.error('[db] markSeen', e.message));
}

const flagCache = new Map(); // inboxId → { read:Set, hidden:Set }
export async function flags(inboxId) {
  let f = flagCache.get(inboxId);
  if (!f) {
    f = { read: new Set(), hidden: new Set() };
    for (const r of await all(`SELECT msg_id, flag FROM flags WHERE inbox_id = ?`, [inboxId])) f[r.flag]?.add(r.msg_id);
    flagCache.set(inboxId, f);
  }
  return f;
}

export async function setFlag(inboxId, msgId, flag) {
  const f = await flags(inboxId);
  if (f[flag].has(msgId)) return;
  f[flag].add(msgId);
  bg(`INSERT OR IGNORE INTO flags (inbox_id, msg_id, flag) VALUES (?, ?, ?)`, [inboxId, msgId, flag]);
}

// ── custom domains ───────────────────────────────────────────────────────
export const allDomains = () => domains;
export const getDomain = (id) => domains.find((d) => Number(d.id) === Number(id)) ?? null;
export const findDomain = (name) => domains.find((d) => d.domain === String(name).toLowerCase()) ?? null;
export const userDomains = (uid) => domains.filter((d) => Number(d.owner_id) === Number(uid));
export const usableDomains = (uid) =>
  domains.filter((d) => d.verified && (d.public || Number(d.owner_id) === Number(uid)));

export async function addDomain(domain, ownerId, { isPublic = false } = {}) {
  const key = crypto.randomBytes(24).toString('base64url');
  const t = now();
  const r = await db.execute({
    sql: `INSERT INTO domains (domain, owner_id, key, public, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: [domain, ownerId, key, isPublic ? 1 : 0, t],
  });
  const d = { id: Number(r.lastInsertRowid), domain, owner_id: ownerId, key, public: isPublic ? 1 : 0, verified: 0, worker_url: null, can_send: 0, created_at: t };
  domains.push(d);
  return d;
}

const DOMAIN_FIELDS = new Set(['public', 'verified', 'worker_url', 'can_send']);
export function setDomain(id, patch) {
  const d = getDomain(id);
  if (!d) return;
  for (const [k, v] of Object.entries(patch)) {
    if (!DOMAIN_FIELDS.has(k)) throw new Error(`bad domain field ${k}`);
    d[k] = v;
    bg(`UPDATE domains SET ${k} = ? WHERE id = ?`, [v, id]);
  }
}

export function removeDomain(id) {
  domains = domains.filter((d) => Number(d.id) !== Number(id));
  bg(`DELETE FROM domains WHERE id = ?`, [id]);
}

// ── stored mail (custom domains) ─────────────────────────────────────────
export async function saveMail(m) {
  const stmts = [
    {
      sql: `INSERT OR IGNORE INTO mails (id, inbox_id, from_name, from_addr, subject, intro, text, html, atts, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [m.id, m.inboxId, m.from.name, m.from.address, m.subject, m.intro, m.text, m.html,
        JSON.stringify(m.attachments.map(({ data, ...a }) => a)), m.createdAt],
    },
    ...m.attachments
      .filter((a) => a.data)
      .map((a, i) => ({
        sql: `INSERT OR IGNORE INTO mail_atts (mail_id, idx, filename, type, size, data) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [m.id, Number(a.id ?? i), a.filename, a.contentType, a.size, a.data],
      })),
  ];
  await db.batch(stmts, 'write');
}

const mailRow = (r) => ({
  id: r.id,
  from: { name: r.from_name || '', address: r.from_addr || '' },
  subject: r.subject || '',
  intro: r.intro || '',
  createdAt: Number(r.created_at),
  attachments: JSON.parse(r.atts || '[]'),
  get hasAttachments() {
    return this.attachments.length > 0;
  },
});

export async function listMails(inboxId) {
  return (await all(
    `SELECT id, from_name, from_addr, subject, intro, atts, created_at FROM mails WHERE inbox_id = ? ORDER BY created_at DESC LIMIT 50`,
    [inboxId],
  )).map(mailRow);
}

export async function getMail(inboxId, id) {
  const r = await one(`SELECT * FROM mails WHERE inbox_id = ? AND id = ?`, [inboxId, id]);
  return r ? { ...mailRow(r), text: r.text || '', html: r.html || '' } : null;
}

export async function deleteMail(inboxId, id) {
  await db.batch(
    [
      { sql: `DELETE FROM mail_atts WHERE mail_id = ?`, args: [id] },
      { sql: `DELETE FROM mails WHERE inbox_id = ? AND id = ?`, args: [inboxId, id] },
    ],
    'write',
  );
}

export async function getMailAttachment(mailId, idx) {
  const r = await one(`SELECT data FROM mail_atts WHERE mail_id = ? AND idx = ?`, [mailId, idx]);
  return r?.data ? Buffer.from(r.data) : null;
}

// ── sending ──────────────────────────────────────────────────────────────
export function logSent(userId, inboxId, to, subject) {
  bg(`INSERT INTO sent_log (user_id, inbox_id, to_addr, subject, created_at) VALUES (?, ?, ?, ?, ?)`, [userId, inboxId, to, subject, now()]);
  bumpUser(userId, 'sent');
  if (inboxId) bumpInbox(inboxId, 'sent');
}

const sentToday = new Map(); // userId → { day, n }
export async function sentLast24h(userId) {
  const c = sentToday.get(userId);
  if (c && now() - c.at < 60_000) return c.n;
  const r = await one(`SELECT COUNT(*) AS n FROM sent_log WHERE user_id = ? AND created_at > ?`, [userId, now() - 86_400_000]);
  const n = Number(r?.n || 0);
  sentToday.set(userId, { at: now(), n });
  return n;
}
export function noteSent(userId) {
  const c = sentToday.get(userId);
  if (c) c.n++;
}

// ── developer API keys (only a SHA-256 hash of each key is stored) ───────
let apiKeys = []; // cached rows

export async function loadApiKeys() {
  apiKeys = (await all(`SELECT * FROM api_keys WHERE revoked = 0`)).map(plain);
}
export const userApiKeys = (uid) => apiKeys.filter((k) => Number(k.user_id) === Number(uid)).sort((a, b) => a.id - b.id);
export const findApiKeyByHash = (hash) => apiKeys.find((k) => k.hash === hash) ?? null;
export const getApiKey = (id) => apiKeys.find((k) => Number(k.id) === Number(id)) ?? null;

export async function addApiKey({ userId, name, prefix, hash }) {
  const t = now();
  const r = await db.execute({
    sql: `INSERT INTO api_keys (user_id, name, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: [userId, name, prefix, hash, t],
  });
  const k = { id: Number(r.lastInsertRowid), user_id: userId, name, prefix, hash, created_at: t, last_used: null, uses: 0, revoked: 0 };
  apiKeys.push(k);
  return k;
}

export function touchApiKey(k) {
  k.last_used = now();
  k.uses = (k.uses || 0) + 1;
  bg(`UPDATE api_keys SET last_used = ?, uses = uses + 1 WHERE id = ?`, [k.last_used, k.id]);
}

export function revokeApiKey(id) {
  apiKeys = apiKeys.filter((k) => Number(k.id) !== Number(id));
  bg(`UPDATE api_keys SET revoked = 1 WHERE id = ?`, [id]);
}

export function revokeUserApiKeys(uid) {
  for (const k of userApiKeys(uid)) revokeApiKey(k.id);
}

// ── OTPs (code stored hashed, short-lived) ───────────────────────────────
export async function addOtp(o) {
  await db.execute({
    sql: `INSERT INTO otps (id, user_id, key_id, to_addr, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [o.id, o.userId, o.keyId, o.to, o.codeHash, o.expiresAt, now()],
  });
}
export const getOtp = (id) => one(`SELECT * FROM otps WHERE id = ?`, [id]).then((r) => (r ? plain(r) : null));
export const bumpOtpAttempts = (id) => db.execute({ sql: `UPDATE otps SET attempts = attempts + 1 WHERE id = ?`, args: [id] });
export const deleteOtp = (id) => db.execute({ sql: `DELETE FROM otps WHERE id = ?`, args: [id] });
export const purgeOtps = () => bg(`DELETE FROM otps WHERE expires_at < ?`, [now() - 3600_000]);

// ── admin ────────────────────────────────────────────────────────────────
export function stats() {
  const day = now() - 86_400_000;
  const us = [...users.values()];
  return {
    users: us.length,
    active24: us.filter((u) => u.last_seen > day).length,
    inboxes: inboxes.size,
    generated: us.reduce((s, u) => s + (u.generated || 0), 0),
    received: us.reduce((s, u) => s + (u.received || 0), 0),
    sent: us.reduce((s, u) => s + (u.sent || 0), 0),
    domains: domains.filter((d) => d.verified).length,
  };
}

export const allUserIds = () => [...users.values()].filter((u) => !u.blocked).map((u) => u.id);
