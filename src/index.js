import http from 'node:http';
import { webhookCallback } from 'grammy';
import { config } from './config.js';
import { migrate } from './db.js';
import { createBot, COMMANDS } from './bot.js';
import { startPoller, pushMail } from './poller.js';
import { handleInbound, setInboundHandler } from './inbound.js';
import { warmDomains } from './providers/index.js';
import { handleViewer } from './viewer.js';

await migrate();
warmDomains();
const bot = createBot();
await bot.init();
console.log(`✦ Crevio up as @${bot.botInfo.username}`);
setInboundHandler((ib, msgId) => pushMail(bot, ib, msgId));

await bot.api.setMyCommands(COMMANDS).catch((e) => console.warn('setMyCommands:', e.message));
await bot.api
  .setMyDescription(
    'Crevio — disposable email inside Telegram.\n\n⚡ 15+ domains, address in one tap\n🔑 OTP codes detected & copyable\n🛰 New mail pushed live\n🏷 Bring your own domain: receive & send\n💣 Self-destruct timers',
  )
  .catch(() => {});
await bot.api.setMyShortDescription('Burner email in one tap — live inbox, OTP copy, self-destruct.').catch(() => {});

const useWebhook = config.publicUrl.startsWith('https://');
const onUpdate = useWebhook ? webhookCallback(bot, 'http', { secretToken: config.webhookSecret, timeoutMilliseconds: 25_000 }) : null;

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://local');
  try {
    if (pathname === '/' || pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, bot: bot.botInfo.username, uptime: Math.round(process.uptime()) }));
    }
    if (onUpdate && req.method === 'POST' && pathname === config.webhookPath) return await onUpdate(req, res);
    if (req.method === 'POST' && pathname === '/inbound') return await handleInbound(req, res);
    if (req.method === 'GET' && pathname.startsWith('/v/')) return await handleViewer(req, res, decodeURIComponent(pathname.slice(3)));
    res.writeHead(404).end('not found');
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) res.writeHead(500).end('error');
  }
});

server.listen(config.port, async () => {
  console.log(`  http listening on :${config.port}`);
  if (useWebhook) {
    await bot.api.setWebhook(config.publicUrl + config.webhookPath, {
      secret_token: config.webhookSecret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
      max_connections: 80,
    });
    console.log(`  webhook → ${config.publicUrl}/tg/…`);
  } else {
    await bot.api.deleteWebhook();
    bot.start({ allowed_updates: ['message', 'callback_query'], onStart: () => console.log('  long polling (local mode)') });
  }
});

const stopPoller = startPoller(bot);

// Render's free plan sleeps after ~15 min without inbound traffic; a self-ping keeps the poller alive.
let keepAlive;
if (config.keepAlive && config.publicUrl) {
  keepAlive = setInterval(() => fetch(`${config.publicUrl}/health`).catch(() => {}), 10 * 60_000);
}

async function shutdown(sig) {
  console.log(`${sig} — shutting down`);
  stopPoller();
  clearInterval(keepAlive);
  if (!useWebhook) await bot.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
