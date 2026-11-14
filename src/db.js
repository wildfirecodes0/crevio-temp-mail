// Turso (libSQL) storage. Falls back to a local SQLite file when TURSO_DATABASE_URL is not set.
import { createClient } from '@libsql/client';
import { config } from './config.js';

export const db = createClient({ url: config.dbUrl, authToken: config.dbToken });

const now = () => Date.now();
const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0] ?? null;
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const run = (sql, args = []) => db.execute({ sql, args });

export async function migrate() {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        first_name TEXT,
        username TEXT,
        active_inbox INTEGER,
        notify INTEGER NOT NULL DEFAULT 1,
        default_ttl INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS inboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        address TEXT NOT NULL,
        password TEXT NOT NULL,
        account_id TEXT,
        token TEXT,
        expires_at INTEGER,
        received INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_inboxes_user ON inboxes(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_inboxes_exp ON inboxes(expires_at)`,
      `CREATE TABLE IF NOT EXISTS seen (
        inbox_id INTEGER NOT NULL,
        msg_id TEXT NOT NULL,
        PRIMARY KEY (inbox_id, msg_id)
      )`,
    ],
    'write',
  );
}

// ── users ────────────────────────────────────────────────────────────────
const touched = new Map();
export async function touchUser(u) {
  const last = touched.get(u.id);
  if (last && now() - last < 5 * 60_000) return;
  touched.set(u.id, now());
  await run(
    `INSERT INTO users (id, first_name, username, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username,
       last_seen = excluded.last_seen, blocked = 0`,
    [u.id, u.first_name ?? '', u.username ?? null, now(), now()],
  );
}

export const getUser = (id) => one(`SELECT * FROM users WHERE id = ?`, [id]);
export const setActive = (uid, inboxId) => run(`UPDATE users SET active_inbox = ? WHERE id = ?`, [inboxId, uid]);
export const setNotify = (uid, v) => run(`UPDATE users SET notify = ? WHERE id = ?`, [v ? 1 : 0, uid]);
export const setDefaultTtl = (uid, sec) => run(`UPDATE users SET default_ttl = ? WHERE id = ?`, [sec, uid]);
export const markBlocked = (uid) => run(`UPDATE users SET blocked = 1 WHERE id = ?`, [uid]);
export async function deleteUser(uid) {
  touched.delete(uid);
  await db.batch(
    [
      { sql: `DELETE FROM seen WHERE inbox_id IN (SELECT id FROM inboxes WHERE user_id = ?)`, args: [uid] },
      { sql: `DELETE FROM inboxes WHERE user_id = ?`, args: [uid] },
      { sql: `DELETE FROM users WHERE id = ?`, args: [uid] },
    ],
    'write',
  );
}

// ── inboxes ──────────────────────────────────────────────────────────────
export const listInboxes = (uid) => all(`SELECT * FROM inboxes WHERE user_id = ? ORDER BY id ASC`, [uid]);
export const countInboxes = async (uid) => Number((await one(`SELECT COUNT(*) AS n FROM inboxes WHERE user_id = ?`, [uid])).n);
export const getInbox = (id) => one(`SELECT * FROM inboxes WHERE id = ?`, [id]);

export async function getOwnedInbox(uid, id) {
  const ib = await getInbox(id);
  return ib && Number(ib.user_id) === Number(uid) ? ib : null;
}

/** Active inbox for a user, repairing the pointer if it went stale. */
export async function getActiveInbox(user) {
  if (user?.active_inbox) {
    const ib = await getOwnedInbox(user.id, user.active_inbox);
    if (ib) return ib;
  }
  const first = await one(`SELECT * FROM inboxes WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [user.id]);
  await setActive(user.id, first ? first.id : null);
  return first;
}

export async function createInbox({ userId, provider, address, password, accountId, token, expiresAt }) {
  const r = await run(
    `INSERT INTO inboxes (user_id, provider, address, password, account_id, token, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, provider, address, password, accountId, token, expiresAt ?? null, now()],
  );
  const id = Number(r.lastInsertRowid);
  await setActive(userId, id);
  return id;
}

export const updateToken = (id, token) => run(`UPDATE inboxes SET token = ?, fail_count = 0 WHERE id = ?`, [token, id]);
export const setExpiry = (id, ts) => run(`UPDATE inboxes SET expires_at = ? WHERE id = ?`, [ts, id]);
export const bumpFail = (id) => run(`UPDATE inboxes SET fail_count = fail_count + 1 WHERE id = ?`, [id]);
export const resetFail = (id) => run(`UPDATE inboxes SET fail_count = 0 WHERE id = ? AND fail_count > 0`, [id]);

export async function deleteInbox(id) {
  await db.batch(
    [
      { sql: `DELETE FROM seen WHERE inbox_id = ?`, args: [id] },
      { sql: `DELETE FROM inboxes WHERE id = ?`, args: [id] },
    ],
    'write',
  );
}

export const expiredInboxes = () =>
  all(`SELECT * FROM inboxes WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now()]);

export const pollableInboxes = () =>
  all(
    `SELECT i.* FROM inboxes i JOIN users u ON u.id = i.user_id
     WHERE u.notify = 1 AND u.blocked = 0 AND i.fail_count < 20
     ORDER BY i.id ASC`,
  );

// ── seen ─────────────────────────────────────────────────────────────────
export async function seenSet(inboxId) {
  const rows = await all(`SELECT msg_id FROM seen WHERE inbox_id = ?`, [inboxId]);
  return new Set(rows.map((r) => r.msg_id));
}

export async function markSeen(inboxId, ids) {
  if (!ids.length) return;
  await db.batch(
    ids.map((id) => ({ sql: `INSERT OR IGNORE INTO seen (inbox_id, msg_id) VALUES (?, ?)`, args: [inboxId, id] })),
    'write',
  );
}

export const bumpReceived = (id, n) => run(`UPDATE inboxes SET received = received + ? WHERE id = ?`, [n, id]);

// ── admin ────────────────────────────────────────────────────────────────
export async function stats() {
  const r = await one(`SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM users WHERE last_seen > ?) AS active24,
    (SELECT COUNT(*) FROM inboxes) AS inboxes,
    (SELECT COALESCE(SUM(received), 0) FROM inboxes) AS received`, [now() - 86_400_000]);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

export const allUserIds = async () => (await all(`SELECT id FROM users WHERE blocked = 0`)).map((r) => Number(r.id));
