# ✦ Crevio — Temp Mail for Telegram

A disposable-email bot with a UI built around how people actually use temp mail: you need an address *now*, you need the code *now*, and then you want it gone.

## What makes it different

| | |
|---|---|
| **One living panel** | Navigation edits a single message in place, so the chat doesn't fill up with menus. |
| **⧉ One-tap copy** | Address and OTP codes use Telegram's native copy buttons. No long-press, no selecting text. |
| **🔑 OTP detection** | Codes like `482913`, `731-204` or `K7Q2ZP` are found and shown at the top of the mail and in the push alert. |
| **✅ Action links** | "Verify email", "Sign in" and "Reset password" links become buttons. |
| **🛰 Live push** | New mail arrives as a compact alert with the code and buttons already attached. |
| **🖥 Full viewer** | A Telegram Mini App renders the original HTML email in a sandboxed frame that follows the user's Telegram theme. |
| **💣 Self-destruct** | Set an address to wipe itself after 10 min, 1 h, 24 h or 7 d. You can also set a default timer. |
| **🗂 Multiple addresses** | Up to 5 per user (configurable), with readable names like `lunar-otter47` or your own custom name. |
| **📎 Attachments** | Get any attachment as a Telegram document. |

Mail is provided by the free [mail.tm](https://mail.tm) / [mail.gw](https://mail.gw) APIs. Turso (libSQL) stores the data.

## Stack
Node 20+, [grammY](https://grammy.dev), `@libsql/client` (Turso) and `html-to-text`. There's no web framework: it uses a plain `node:http` server for the webhook, the health check and the viewer.

## 1. Create the bot
1. Open [@BotFather](https://t.me/BotFather) and send `/newbot`. Copy the token.
2. Optional: use `/setuserpic` to give it a logo.

## 2. Create the Turso database
```bash
turso db create crevio
turso db show crevio --url          # → TURSO_DATABASE_URL
turso db tokens create crevio       # → TURSO_AUTH_TOKEN
```
The tables are created automatically on first boot.

## 3. Deploy on Render
1. **New → Blueprint** and pick this repo (`render.yaml` is included). You can also use **New → Web Service** with build `npm install --omit=dev` and start `npm start`.
2. Set the env vars `BOT_TOKEN`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and optionally `ADMIN_IDS` (your Telegram user id).
3. Deploy. Render provides `RENDER_EXTERNAL_URL` automatically, so the bot sets up its own **webhook** and the Mini App viewer. There's nothing else to configure.

> **Free plan note:** Render free services sleep after about 15 min without traffic. On Render the bot pings its own `/health` every 10 min so the live mail push keeps working. For extra safety you can also add a free UptimeRobot monitor on `https://<your-app>.onrender.com/health`.

## Local development
```bash
cp .env.example .env     # set BOT_TOKEN (Turso optional locally, falls back to crevio.db)
npm install
npm run dev              # long-polling mode
npm run check            # offline smoke tests
```

## Env vars
| var | required | default | |
|---|---|---|---|
| `BOT_TOKEN` | ✅ | | from BotFather |
| `TURSO_DATABASE_URL` | ✅ on Render | `file:crevio.db` | |
| `TURSO_AUTH_TOKEN` | ✅ on Render | | |
| `ADMIN_IDS` | | | comma-separated ids for `/stats`, `/broadcast` |
| `MAX_INBOXES` | | `5` | addresses per user |
| `POLL_INTERVAL_SEC` | | `12` | how often inboxes are checked |
| `MAIL_PROVIDERS` | | `tm,gw` | `tm` = mail.tm, `gw` = mail.gw |
| `PUBLIC_URL` | | `RENDER_EXTERNAL_URL` | https URL → webhook mode |
| `KEEP_ALIVE` | | on when on Render | `1`/`0` |

## Admin
- `/stats` shows users, 24 h actives, addresses and mails delivered.
- `/broadcast` (sent as a reply to any message) copies that message to every user.

## Layout
```
src/
  index.js     http server, webhook/polling, boot
  bot.js       all commands & button handlers
  ui.js        every screen (text + keyboard)
  poller.js    live push + self-destruct sweeper
  mail.js      mail.tm / mail.gw API client
  service.js   create/destroy inbox, auto re-login
  extract.js   body text, OTP + action-link detection
  viewer.js    signed Mini App email viewer
  db.js        Turso schema & queries
```
