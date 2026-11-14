// Shared fetch helper for provider APIs: timeouts, retries on 429/5xx, typed errors.
import { sleep } from '../utils.js';

export class ProviderError extends Error {
  constructor(message, status = 0, body = '') {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function request(url, { method = 'GET', headers = {}, body, as = 'json', retries = 2, timeout = 12_000, label = '' } = {}) {
  const h = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (CrevioBot)', ...headers };
  let payload = body;
  if (body && typeof body === 'object' && !(body instanceof URLSearchParams) && !Buffer.isBuffer(body)) {
    payload = JSON.stringify(body);
    h['Content-Type'] ||= 'application/json';
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new ProviderError(`${label || new URL(url).host} unreachable: ${e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(900 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`${label || new URL(url).host} ${method} → ${res.status}`, res.status, text.slice(0, 300));
    }
    if (res.status === 204) return null;
    if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    if (as === 'text') return text;
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new ProviderError(`${label} bad JSON`, res.status, text.slice(0, 200));
    }
  }
}

/** "Name <a@b.c>" | "a@b.c" → { name, address } */
export function parseAddress(s) {
  if (!s) return { name: '', address: '' };
  if (typeof s === 'object') return { name: s.name || '', address: s.address || s.email || '' };
  const m = String(s).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: String(s).trim() };
}
