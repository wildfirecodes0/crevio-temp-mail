# ✦ Crevio — Temp Mail for Telegram

A disposable-email bot with a UI built around how people actually use temp mail: you need an address *now*, you need the code *now*, and then you want it gone. It also handles **your own domain**, for receiving and for sending.

## Features

| | |
|---|---|
| **⌨️ Keyboard menu** | A persistent bottom menu: Inbox · New Mail · Addresses · Compose · Domains · Profile · Settings · Help. |
| **One living panel** | Taps edit a single message in place. Menu taps replace the old panel, so the chat never fills up. |
| **⚡ Fast** | Every tap is acknowledged instantly. Users, addresses and domains are served from memory, inbox lists are cached, and slow work shows a loading frame and then fills in. |
| **🌐 18+ domains** | mail.tm, temp-mail.io and Guerrilla Mail domains, all pickable (plus mail.gw when it's up). |
| **🏷 Bring your own domain** | Any user can add their domain and receive mail on *anything*@theirdomain through Cloudflare Email Routing (free). |
| **✉️ Send mail** | Compose, reply and attach files from a custom-domain address. Mail goes out through the domain owner's own Cloudflare Worker, with no SendGrid/Mailgun-style middleman. |
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
| `MAX_INBOXES` | `5` | addresses per user |
| `POLL_INTERVAL_SEC` | `8` | inbox polling for public providers |
| `MAIL_PROVIDERS` | `tm,gw,tio,gm` | mail.tm, mail.gw, temp-mail.io, guerrillamail |
| `ALLOW_USER_DOMAINS` | `1` | `0` = only admins add domains |
| `SEND_LIMIT_OWN` | `0` | daily sends on the user's own domain (0 = unlimited) |
| `SEND_LIMIT_SHARED` | `50` | daily sends on shared domains |
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
  bot.js          menu, commands, every button & conversation flow
  ui.js           every screen (text + keyboard)
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
