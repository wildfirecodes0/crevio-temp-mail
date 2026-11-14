export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : s;
}

/** "2m", "3h", "5d" style compact duration from seconds */
export function shortDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 && h < 6 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 && d < 3 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function ago(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 45) return 'just now';
  return `${shortDur(diff)} ago`;
}

export function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC';
}

export const isNotModified = (e) => String(e?.description || e?.message || '').includes('message is not modified');
