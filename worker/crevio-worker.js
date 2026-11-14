// Crevio Email Worker. Deploy it on the Cloudflare account that owns your domain.
//  • Inbound: Email Routing → Catch-all → "Send to a Worker" → this worker. Each mail is forwarded to the bot.
//  • Outbound: with a `send_email` binding named EMAIL, the bot can send mail from your domain through it.
const BOT_URL = '__BOT_URL__';
const KEY = '__KEY__';

export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await fetch(`${BOT_URL}/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'X-Crevio-Key': KEY,
        'X-Crevio-To': message.to,
        'X-Crevio-From': message.from,
      },
      body: raw,
    });
    if (res.status === 404) return message.setReject('Mailbox does not exist');
    if (res.status === 413) return message.setReject('Message too large');
    if (!res.ok) throw new Error(`Crevio bot unavailable (${res.status})`); // sender's server will retry later
  },

  async fetch(request, env) {
    if (request.headers.get('X-Crevio-Key') !== KEY) return new Response('Crevio worker', { status: 403 });
    const { pathname } = new URL(request.url);

    if (pathname === '/ping') return Response.json({ ok: true, canSend: Boolean(env.EMAIL) });

    if (pathname === '/send' && request.method === 'POST') {
      if (!env.EMAIL) return Response.json({ ok: false, code: 'E_NO_BINDING', error: 'send_email binding "EMAIL" missing' }, { status: 501 });
      const mail = await request.json();
      try {
        const r = await env.EMAIL.send(mail);
        return Response.json({ ok: true, id: r?.messageId ?? null });
      } catch (e) {
        return Response.json({ ok: false, code: e.code || 'E_SEND', error: e.message }, { status: 400 });
      }
    }
    return new Response('not found', { status: 404 });
  },
};
