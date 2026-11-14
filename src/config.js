import crypto from 'node:crypto';

const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) {
    console.error(`✗ Missing required env var ${name}. See .env.example`);
    process.exit(1);
  }
  return v;
}

const botToken = required('BOT_TOKEN');
const derive = (label) => crypto.createHmac('sha256', botToken).update(label).digest('hex');

export const config = {
  botToken,
  dbUrl: env.TURSO_DATABASE_URL || 'file:crevio.db',
  dbToken: env.TURSO_AUTH_TOKEN || undefined,

  // Render sets RENDER_EXTERNAL_URL automatically. If present we run in webhook mode.
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  port: Number(env.PORT) || 3000,

  webhookPath: `/tg/${derive('webhook-path').slice(0, 24)}`,
  webhookSecret: env.WEBHOOK_SECRET || derive('webhook-secret').slice(0, 48),
  signingKey: derive('viewer-signing'),

  adminIds: (env.ADMIN_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean),

  maxInboxes: Number(env.MAX_INBOXES) || 5,
  pollIntervalSec: Math.max(4, Number(env.POLL_INTERVAL_SEC) || 8),
  keepAlive: env.KEEP_ALIVE ? env.KEEP_ALIVE === '1' : Boolean(env.RENDER_EXTERNAL_URL),
  providers: (env.MAIL_PROVIDERS || 'tm,gw,tio,gm').split(',').map((s) => s.trim()).filter(Boolean),

  // Sending goes through the domain owner's own Cloudflare Worker. 0 = unlimited.
  sendLimitOwn: Number(env.SEND_LIMIT_OWN) || 0,
  sendLimitShared: env.SEND_LIMIT_SHARED === undefined ? 50 : Number(env.SEND_LIMIT_SHARED) || 0,
  allowUserDomains: env.ALLOW_USER_DOMAINS !== '0',
  relayDomain: (env.SEND_RELAY_DOMAIN || '').toLowerCase(),
  inboundMaxBytes: (Number(env.INBOUND_MAX_MB) || 15) * 1024 * 1024,
  verifyToken: (domain) => `crevio-verify=${derive(`verify:${domain}`).slice(0, 32)}`,
};
