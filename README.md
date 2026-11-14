# ✦ Crevio Mail Bot — Temp Mail for Telegram

Live at **[@CrevioMailBot](https://t.me/CrevioMailBot)**.

A disposable-email bot with a UI built around how people actually use temp mail: you need an address *now*, you need the code *now*, and then you want it gone. It also handles **your own domain**, for receiving and for sending.

## Features

| | |
|---|---|
| **⌨️ Menu + inline actions** | The bottom keyboard is a fixed main menu (Home · Inbox · New Mail · Compose · Addresses · Domains · Profile · Settings · Help). Each screen carries its own inline buttons: domain grid, timer options, settings toggles, domain setup (with ⧉ copy for DNS records), mail actions (⧉ copy code, verify link, full viewer, files, reply, delete). Taps edit the screen in place. |
| **🖼 Image cards** | Rendered welcome, new-address and profile cards (satori + resvg), including Hindi names. |
| **Clean chat** | Your taps and typed input are removed, and each screen replaces the previous one, so the chat never fills up. |
| **⚡ Fast** | Every tap is acknowledged instantly. Users, addresses and domains are served from memory, inbox lists are cached, and slow work shows a loading frame and then fills in. |
| **🌐 18+ domains** | mail.tm, temp-mail.io and Guerrilla Mail domains, all pickable (plus mail.gw when it's up). |
| **🏷 Bring your own domain** | Any user can add their domain and receive mail on *anything*@theirdomain through Cloudflare Email Routing (free). |
| **✉️ Send mail from any address** | Compose, reply and attach files. Addresses on a custom domain send directly. Every other address (mail.tm, guerrilla…) sends through the admin's **relay domain** as `name@relay-domain` with **Reply-To** set to the temp address, so replies land back in the same inbox. No SendGrid/Mailgun middleman. |
| **👤 Profile** | Name, username, Telegram ID, language, join date, generated / disposed / live / received / sent counts, domains and preferences. |
| **🔑 OTP detection** | Codes like `482913`, `731-204` and `K7Q2ZP` get a native ⧉ copy button. Verify, sign-in and reset links become buttons. |
| **🛰 Live push** | New mail shows up as a compact alert. Custom-domain mail is pushed the instant it arrives. |
| **🖥 Full viewer** | A Telegram Mini App renders the original HTML email in a sandboxed frame. |
| **💣 Self-destruct** | Per-address timers (10 min to 7 days) and a default timer. |
| **Admin** | `/stats`, `/broadcast` (reply to a message), `/ban <id>`, `/unban <id>`, and sharing a domain with all users (💎 premium). |

## Deploy (Render + Turso)

1. **Bot**: get a token from [@BotFather](https://t.me/BotFather) with `/newbot`.
2. **Database**:
   ```bash
   turso db create crevio
   turso db show crevio --url        # → TURSO_DATABASE_URL
   turso db tokens create crevio     # → TURSO_AUTH_TOKEN
   ```
3. **Render**: New → Blueprint → this repo (`render.yaml` is included). Set `BOT_TOKEN`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `ADMIN_IDS` (your Telegram ID, shown in 👤 Profile).
4. Deploy. The webhook, commands and Mini App viewer are configured automatically from `RENDER_EXTERNAL_URL`.

> On the Render free plan the service sleeps after about 15 min without traffic. The bot pings its own `/health` every 10 min so live push keeps working.

## 🔑 Developer API (send mail & OTPs from your app)

Every user can create API keys in the bot (🔑 API in the menu) and send mail and one-time codes from their own website or backend, through Crevio. Full docs are at `https://<your-app>.onrender.com/docs`.

| | |
|---|---|
| `POST /api/v1/send` | send an email: `to`, `subject`, `text`/`html`, optional `from`, `from_name`, `reply_to` |
| `POST /api/v1/otp/send` | generate a code and email it in a branded template: `to`, `app_name`, `length` (4–8), `ttl` (60–3600 s) → `otp_id` |
| `POST /api/v1/otp/verify` | `otp_id` + `code` → `{ valid: true }`; single-use, 5 attempts |
| `GET /api/v1/me` | account, addresses, today's usage |

```bash
curl -X POST https://<your-app>.onrender.com/api/v1/otp/send   -H "Authorization: Bearer crv_live_…" -H "Content-Type: application/json"   -d '{"to":"user@example.com","app_name":"MyApp"}'
```

- Keys are shown once and stored only as SHA-256 hashes. Users can revoke them anytime, and `/ban` blocks a user's API too.
- API mail uses the same sending route as the bot (the user's own domain, or the shared relay) and counts toward the same daily limit. Every API request is rate-limited per key.
- API mail goes out from **your** relay domain, so watch `/stats` and keep `SEND_LIMIT_SHARED` sensible to protect the domain's reputation.

## Turning on sending for everyone (one-time, admin)

1. Add your domain in 🌐 Domains and finish all steps, including **step 6** (Email Service sending + `send_email` binding).
2. Open it and tap **💎 Share with everyone**. It becomes the **send relay**, and every user can now ✉️ Compose from any of their addresses.
3. Optional: `SEND_RELAY_DOMAIN=yourdomain.com` picks which shared domain is the relay if you have several. `/stats` shows the current relay.

## Custom domains (receive + send)

Everything is guided inside the bot (🌐 Domains → ➕ Add my domain). The steps are:

1. Add the domain to a free Cloudflare account.
2. Add the **TXT** record `_crevio.<domain>` that the bot shows. This proves you own the domain.
3. Email → **Email Routing** → enable. Cloudflare adds the MX records.
4. Tap **📄 Worker files** in the bot and deploy `crevio-worker.js` (dashboard paste, or `npx wrangler deploy` with the included `wrangler.toml`).
5. Email Routing → Routing rules → **Catch-all → Send to a Worker** → the Crevio worker.
6. Paste the worker URL into the bot.
7. *Sending (optional):* in Cloudflare **Email Service**, onboard the domain for sending and keep the `send_email` binding named `EMAIL`.

The worker forwards each incoming mail to `POST /inbound` on the bot, signed with a per-domain key. The bot stores the mail in Turso and pushes it to the user immediately. For sending, the bot calls the worker's `/send`, and the worker calls `env.EMAIL.send()`.

### About "unlimited" sending: what's actually possible
- **Render can't send SMTP itself.** Free web services block outbound ports 25/465/587, and port 25 is blocked on paid plans too. That's why sending goes through Cloudflare's Worker binding over HTTPS.
- **Cloudflare free plan:** sends only to *verified* destination addresses. **Workers Paid ($5/mo)** sends to any recipient, with a monthly allowance and then a small per-1,000 charge. Check Cloudflare's current pricing.
- **Your own domain:** Crevio adds no daily cap there (`SEND_LIMIT_OWN=0`). Cloudflare's limits and your domain's reputation still apply. **Shared 💎 domains** are capped per user (`SEND_LIMIT_SHARED`, default 50/day) so one person can't burn the domain.
- Public temp domains (mail.tm, guerrilla, temp-mail.io) are **receive-only**. Nobody can send from domains they don't own.

## Env vars
| var | default | |
|---|---|---|
| `BOT_TOKEN` | — | required |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | `file:crevio.db` | required on Render |
| `ADMIN_IDS` | | comma-separated Telegram IDs |
| `MAX_INBOXES` | `20` | addresses per user |
| `POLL_INTERVAL_SEC` | `8` | inbox polling for public providers |
| `MAIL_PROVIDERS` | `tm,gw,tio,gm` | mail.tm, mail.gw, temp-mail.io, guerrillamail |
| `ALLOW_USER_DOMAINS` | `1` | `0` = only admins add domains |
| `SEND_LIMIT_OWN` | `0` | daily sends on the user's own domain (0 = unlimited) |
| `SEND_LIMIT_SHARED` | `50` | daily sends per user through the relay / shared domains (0 = unlimited) |
| `API_MAX_KEYS` | `5` | API keys per user |
| `API_RATE_PER_MIN` | `30` | API requests per minute per key |
| `SEND_RELAY_DOMAIN` | first shared sending domain | which domain relays mail for temp addresses |
| `INBOUND_MAX_MB` | `15` | max inbound mail size |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` | https URL → webhook mode |
| `KEEP_ALIVE` | on when on Render | self-ping |

## Local development
```bash
cp .env.example .env
npm install
npm run dev          # long polling
npm run check        # offline UI checks
npm run simulate     # end-to-end: fake Telegram, real providers, custom-domain inbound + send
```

## Layout
```
src/
  index.js        http server: webhook, /inbound, /v/ viewer, /health
  bot.js          every screen + its keyboard, commands, conversation flows
  router.js       reply-keyboard screen router (one panel per chat)
  ui.js           screen text, push notification (inline copy/open)
  cards.js        hero image cards (welcome, address, profile)
  service.js      inbox ops + caches
  poller.js       live push + self-destruct sweeper
  inbound.js      custom-domain mail receiver (MIME → Turso → push)
  send.js         outbound mail via the domain's worker
  domains.js      TXT/MX verification, worker health, worker file generator
  db.js           Turso schema + write-through memory cache
  providers/      mailtm, tempmailio, guerrilla, own (custom domain)
worker/
  crevio-worker.js   Cloudflare Email Worker template
```

Note: Guerrilla Mail keeps messages for about 1 hour. mail.tm and temp-mail.io keep them longer. Custom domains keep mail until the user deletes it.
