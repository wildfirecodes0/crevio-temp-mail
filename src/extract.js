// Pulls the useful bits out of an email: readable text, OTP codes, and action links.
import { convert } from 'html-to-text';

export function htmlToText(html) {
  if (!html) return '';
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'table', format: 'block' },
      { selector: 'tr', format: 'block' },
      { selector: 'td', format: 'inline' },
    ],
  });
}

/** Best readable body for a mail.tm message object. */
export function bodyText(msg) {
  const html = Array.isArray(msg.html) ? msg.html.join('\n') : msg.html || '';
  let text = (msg.text || '').trim();
  if (!text && html) text = htmlToText(html);
  return text
    .replace(/\r/g, '')
    .replace(/https?:\/\/[^\s)>\]]{48,}/g, (u) => {
      try {
        return `🔗 ${new URL(u).hostname}/…`;
      } catch {
        return '🔗 link';
      }
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const KEYWORDS =
  /(code|otp|pin|passcode|password|verif|confirm|one[- ]?time|security|login|log in|sign[- ]?in|2fa|auth|token|कोड|सत्यापन)/i;

/**
 * Find likely verification codes. Returns up to 2, most likely first.
 * Scores candidates by proximity to OTP-ish keywords and penalises things that look like years/prices/phones.
 */
export function extractCodes(subject, text) {
  const src = `${subject || ''}\n${text || ''}`.slice(0, 6000);
  const found = new Map();
  const re = /(?<![\w$€£₹.,:/-])(\d{3}[- ]\d{3}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8})(?![\w%:/-]|[.,]\d|\s?(?:%|USD|INR|EUR|px))/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1];
    const code = raw.replace(/[- ]/g, '');
    if (/^(19|20)\d{2}$/.test(code)) continue; // years
    if (/^(\d)\1+$/.test(code) && code.length > 4) continue; // 000000
    const around = src.slice(Math.max(0, m.index - 80), m.index + raw.length + 40);
    let score = 0;
    if (KEYWORDS.test(around)) score += 5;
    if (m.index < (subject || '').length + 1) score += 3;
    if (/^\d{6}$/.test(code)) score += 2;
    else if (/^\d+$/.test(code)) score += 1;
    if (/^[A-Z0-9]+$/.test(code) && /[A-Z]/.test(code) && !KEYWORDS.test(around)) score -= 4;
    if (score <= 2) continue;
    found.set(code, Math.max(found.get(code) ?? 0, score));
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([c]) => c);
}

const ACTIONS = [
  [/verif|confirm|activate|validate/i, '✅ Verify'],
  [/reset|password/i, '🔐 Reset password'],
  [/magic|login|log-in|signin|sign-in|auth/i, '🔓 Sign in'],
  [/unsubscribe/i, null],
];

/** Pick up to 2 "call-to-action" links (verify / sign-in / reset). */
export function extractActionLinks(msg) {
  const html = Array.isArray(msg.html) ? msg.html.join('\n') : msg.html || '';
  const urls = new Map();
  const hrefRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = hrefRe.exec(html))) {
    const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    urls.set(m[1].replace(/&amp;/g, '&'), label);
  }
  for (const u of (msg.text || '').match(/https?:\/\/[^\s)>\]]+/g) || []) if (!urls.has(u)) urls.set(u, '');

  const out = [];
  for (const [url, label] of urls) {
    if (!/^https:\/\//i.test(url) || url.length > 2000) continue;
    const hay = `${label} ${url}`;
    for (const [re, name] of ACTIONS) {
      if (re.test(hay)) {
        if (name && !out.some((o) => o.url === url || o.label === name)) out.push({ label: name, url });
        break;
      }
    }
    if (out.length >= 2) break;
  }
  return out;
}
