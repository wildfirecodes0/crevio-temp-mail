// Hero image cards (welcome, new address, profile) rendered SVG → PNG with satori + resvg.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const require = createRequire(import.meta.url);
const font = (pkg, file) => fs.readFileSync(require.resolve(`${pkg}/files/${file}`));

const FONTS = [
  { name: 'Grotesk', data: font('@fontsource/space-grotesk', 'space-grotesk-latin-700-normal.woff'), weight: 700 },
  { name: 'Grotesk', data: font('@fontsource/space-grotesk', 'space-grotesk-latin-500-normal.woff'), weight: 500 },
  { name: 'Inter', data: font('@fontsource/inter', 'inter-latin-400-normal.woff'), weight: 400 },
  { name: 'Inter', data: font('@fontsource/inter', 'inter-latin-600-normal.woff'), weight: 600 },
  { name: 'Deva', data: font('@fontsource/noto-sans-devanagari', 'noto-sans-devanagari-devanagari-400-normal.woff'), weight: 400 },
  { name: 'Deva', data: font('@fontsource/noto-sans-devanagari', 'noto-sans-devanagari-devanagari-700-normal.woff'), weight: 700 },
];

const W = 1200;
const H = 630;
const C = {
  bg: '#0b0c14',
  panel: '#141626',
  line: 'rgba(255,255,255,0.09)',
  text: '#f2f3fb',
  muted: '#8c90ad',
  violet: '#8b6cff',
  cyan: '#3ee6d2',
  lime: '#c8ff5a',
};

// tiny hyperscript for satori
const h = (type, style = {}, ...children) => ({
  type,
  props: { style: { display: 'flex', ...style }, children: children.flat().filter((c) => c !== null && c !== false && c !== undefined) },
});

/** Keep characters our fonts can draw (Latin + Devanagari); drop emoji etc. */
const clean = (s, fallback = '') => {
  const t = String(s ?? '').replace(/[^\p{Script=Latin}\p{Script=Devanagari}\p{N}\p{P}\p{Zs}@._+-]/gu, '').trim();
  return t || fallback;
};

const brand = () =>
  h('div', { alignItems: 'center', gap: 14 },
    h('div', { width: 22, height: 22, transform: 'rotate(45deg)', borderRadius: 5, backgroundImage: `linear-gradient(135deg, ${C.violet}, ${C.cyan})` }),
    h('div', { fontFamily: 'Grotesk', fontWeight: 700, fontSize: 26, letterSpacing: 6, color: C.text }, 'CREVIO MAIL'),
  );

const frame = (...children) =>
  h('div', {
    width: W, height: H, position: 'relative', flexDirection: 'column', padding: '56px 64px',
    backgroundColor: C.bg, color: C.text, fontFamily: 'Inter, Deva', overflow: 'hidden',
    backgroundImage: `radial-gradient(circle at 92% 8%, rgba(139,108,255,0.35), transparent 42%), radial-gradient(circle at 8% 100%, rgba(62,230,210,0.20), transparent 45%)`,
  }, ...children);

const chip = (label, color = C.muted, dot) =>
  h('div', { alignItems: 'center', gap: 10, padding: '10px 18px', borderRadius: 999, border: `1px solid ${C.line}`, backgroundColor: 'rgba(255,255,255,0.04)', fontSize: 22, color },
    dot ? h('div', { width: 10, height: 10, borderRadius: 10, backgroundColor: dot }) : null,
    label,
  );

const envelope = (x, y, rot, opacity, accent) =>
  h('div', {
    position: 'absolute', left: x, top: y, width: 300, height: 196, borderRadius: 26, transform: `rotate(${rot}deg)`, opacity,
    backgroundColor: C.panel, border: `1px solid ${C.line}`, flexDirection: 'column', padding: 26, gap: 14,
    boxShadow: '0 30px 60px rgba(0,0,0,0.45)',
  },
    h('div', { width: 46, height: 46, borderRadius: 14, backgroundImage: `linear-gradient(135deg, ${accent}, ${C.violet})` }),
    h('div', { width: 210, height: 12, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.16)' }),
    h('div', { width: 150, height: 12, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.08)' }),
    h('div', { width: 96, height: 22, borderRadius: 8, backgroundColor: 'rgba(200,255,90,0.18)', border: `1px solid rgba(200,255,90,0.5)` }),
  );

async function png(tree) {
  const svg = await satori(tree, { width: W, height: H, fonts: FONTS });
  return new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
}

const memo = new Map();
async function cached(key, make) {
  if (memo.has(key)) return memo.get(key);
  const buf = await make();
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  memo.set(key, buf);
  return buf;
}

// ── cards ────────────────────────────────────────────────────────────────
export const welcomeCard = (domainCount) =>
  cached(`welcome:${domainCount}`, () =>
    png(
      frame(
        brand(),
        envelope(760, 70, 8, 0.55, C.cyan),
        envelope(700, 250, -6, 1, C.lime),
        h('div', { flexDirection: 'column', marginTop: 70, gap: 6, width: 640 },
          h('div', { fontFamily: 'Grotesk', fontWeight: 700, fontSize: 78, lineHeight: 1.02, letterSpacing: -2 }, 'Disposable mail,'),
          h('div', { fontFamily: 'Grotesk', fontWeight: 700, fontSize: 78, lineHeight: 1.02, letterSpacing: -2, color: C.cyan }, 'inside Telegram.'),
        ),
        h('div', { marginTop: 28, fontSize: 26, color: C.muted, width: 620 }, 'Burner inboxes in one tap. Codes copied for you. Your own domain, if you want it.'),
        h('div', { marginTop: 'auto', gap: 14 },
          chip(`${domainCount}+ domains`, C.text, C.lime),
          chip('Live push', C.text, C.cyan),
          chip('Send mail', C.text, C.violet),
        ),
      ),
    ),
  );

export function addressCard({ address, provider, timer, note = 'Created just now' }) {
  const [local, domain] = address.split('@');
  const size = address.length > 34 ? 46 : address.length > 26 ? 56 : 66;
  return cached(`addr:${address}:${timer}:${note}`, () =>
    png(
      frame(
        h('div', { justifyContent: 'space-between', alignItems: 'center' }, brand(), chip('LIVE', C.lime, C.lime)),
        h('div', { flexDirection: 'column', marginTop: 'auto', gap: 18 },
          h('div', { fontSize: 22, letterSpacing: 5, color: C.muted, fontWeight: 600 }, 'YOUR NEW ADDRESS'),
          h('div', { fontFamily: 'Grotesk', fontWeight: 700, fontSize: size, letterSpacing: -1, flexWrap: 'wrap' },
            h('span', { color: C.text }, local),
            h('span', { color: C.cyan, marginLeft: -Math.round(size * 0.13) }, `@${domain}`), // satori adds a word gap between spans
          ),
        ),
        h('div', { marginTop: 'auto', justifyContent: 'space-between', alignItems: 'flex-end' },
          h('div', { gap: 14 }, chip(provider, C.text, C.violet), chip(timer, C.text, C.cyan), chip(note, C.muted)),
          h('div', { fontSize: 20, color: C.muted }, 'Tap the address in chat to copy'),
        ),
      ),
    ),
  );
}

export function profileCard({ name, username, id, joined, stats, domains }) {
  const display = clean(name, 'Crevio user');
  const initial = [...display][0]?.toUpperCase() || 'C';
  const tile = (label, value, accent) =>
    h('div', { flexDirection: 'column', flex: 1, padding: '22px 24px', borderRadius: 24, backgroundColor: C.panel, border: `1px solid ${C.line}`, gap: 6 },
      h('div', { fontFamily: 'Grotesk', fontWeight: 700, fontSize: 52, color: accent }, String(value)),
      h('div', { fontSize: 19, letterSpacing: 2, color: C.muted, fontWeight: 600 }, label),
    );
  const key = `prof:${id}:${display}:${username}:${JSON.stringify(stats)}:${domains}`;
  return cached(key, () =>
    png(
      frame(
        h('div', { justifyContent: 'space-between', alignItems: 'center' }, brand(), chip(`Member since ${joined}`, C.muted)),
        h('div', { marginTop: 44, alignItems: 'center', gap: 28 },
          h('div', {
            width: 116, height: 116, borderRadius: 116, alignItems: 'center', justifyContent: 'center',
            backgroundImage: `linear-gradient(135deg, ${C.violet}, ${C.cyan})`, fontFamily: 'Grotesk, Deva', fontWeight: 700, fontSize: 56, color: '#0b0c14',
          }, initial),
          h('div', { flexDirection: 'column', gap: 6 },
            h('div', { fontFamily: 'Grotesk, Deva', fontWeight: 700, fontSize: 52, letterSpacing: -1 }, display.slice(0, 22)),
            h('div', { fontSize: 24, color: C.muted, gap: 18 },
              username ? h('span', {}, `@${clean(username)}`) : null,
              h('span', {}, `ID ${id}`),
            ),
          ),
        ),
        h('div', { marginTop: 'auto', gap: 16 },
          tile('GENERATED', stats.generated, C.text),
          tile('LIVE', stats.live, C.lime),
          tile('RECEIVED', stats.received, C.cyan),
          tile('SENT', stats.sent, C.violet),
          tile('DISPOSED', stats.disposed, C.muted),
        ),
        h('div', { marginTop: 18, fontSize: 19, color: C.muted }, `${domains} domain${domains === 1 ? '' : 's'} available to you`),
      ),
    ),
  );
}

/** Pay satori/yoga's first-render cost at boot instead of on a user's tap. */
export const warmCards = (domainCount) => welcomeCard(domainCount).catch((e) => console.warn('[cards]', e.message));
