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
  pollIntervalSec: Math.max(5, Number(env.POLL_INTERVAL_SEC) || 12),
  keepAlive: env.KEEP_ALIVE ? env.KEEP_ALIVE === '1' : Boolean(env.RENDER_EXTERNAL_URL),
  providers: (env.MAIL_PROVIDERS || 'tm,gw').split(',').map((s) => s.trim()).filter(Boolean),
};
