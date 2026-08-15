# Telegram RSS Feed Reader Bot (Cloudflare Workers)

A production-ready, serverless RSS/Atom feed reader that posts new articles to
Telegram as card-style messages (photo + caption + "Read More" button), driven
by a Cloudflare Workers cron trigger.

- **Runtime:** Cloudflare Workers (TypeScript)
- **Storage:** Cloudflare KV (feeds, seen-article dedupe, admin list)
- **Parsing:** `fast-xml-parser` (pure JS, Workers-compatible)
- **Transport:** Telegram Bot API over Webhook (commands) + Cron (polling)

---

## Quick start — automated (`deploy.sh`)

One command sets up KV namespaces, uploads secrets, deploys the Worker, and
registers the Telegram webhook. It only needs a Cloudflare API token scoped to
your account.

### 1. Create a Cloudflare API token

Go to **My Profile → API Tokens → Create Token → Create Custom Token** with
these permissions (scope: **Account**, not a Zone):

| Permission          | Scope   | Access |
| ------------------- | ------- | ------ |
| Workers Scripts     | Account | Edit   |
| Workers KV Storage  | Account | Edit   |
| Account Settings    | Account | Read   |

Your **Account ID** is shown in the dashboard right sidebar, or via
`npx wrangler whoami`.

### 2. Run it

```bash
export CLOUDFLARE_API_TOKEN="<token>"
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
export TELEGRAM_BOT_TOKEN="<bot-token>"
export ADMIN_USER_ID="<your-user-id>"     # comma-separated for several admins
# optional:
# export WEBHOOK_SECRET="$(openssl rand -hex 32)"
# export DEFAULT_CHAT_ID="<chat-or-channel-id>"
# export WORKER_URL="https://bot.example.com"   # custom domain override

./deploy.sh
```

The script: **(1)** creates or reuses the `RSS_FEEDS`, `RSS_SEEN`, and
`RSS_SETTINGS` KV namespaces and injects their IDs into `wrangler.toml`,
**(2)** uploads the encrypted secrets, **(3)** runs `wrangler deploy`, and
**(4)** registers the webhook at `https://<name>.<subdomain>.workers.dev/webhook`.
It is idempotent — safe to re-run.

### 3. GitHub Actions (alternative)

A workflow ships at `.github/workflows/deploy.yml`. Add the same values as
repository secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`TELEGRAM_BOT_TOKEN`, `ADMIN_USER_ID`, `WEBHOOK_SECRET`, optional
`DEFAULT_CHAT_ID`), then push to `main` or trigger it manually from the
**Actions** tab. It runs `npm ci`, `typecheck`, and `vitest` before deploying.

---

## Manual deployment (step-by-step)

## 1. Prerequisites

- [Node.js](https://nodejs.org) 18+ and npm
- A free [Cloudflare account](https://dash.cloudflare.com/)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram **user ID** (message [@userinfobot](https://t.me/userinfobot))

> The bot can only message a user **after they press `/start`** on it. Make sure
> you `/start` the bot before the first scheduled check.

---

## 2. Get your credentials

1. Create a bot with BotFather (`/newbot`) and copy the **bot token**.
2. Get your user ID from @userinfobot (a number like `123456789`).
3. Generate a random webhook secret, e.g.:
   ```bash
   openssl rand -hex 32
   ```

---

## 3. Create the KV namespaces

KV namespaces must be created **before** deploy, and their IDs pasted into
`wrangler.toml`.

```bash
npx wrangler kv namespace create RSS_FEEDS
npx wrangler kv namespace create RSS_SEEN
npx wrangler kv namespace create RSS_SETTINGS
```

Each command prints a block like:

```
🌀 Creating namespace with title "telegram-rss-bot-RSS_FEEDS"
✨ Success! ... 
{ binding = "RSS_FEEDS", id = "abc123..." }
```

Copy the three `id` values into `wrangler.toml`, replacing
`REPLACE_WITH_RSS_FEEDS_KV_ID`, `REPLACE_WITH_RSS_SEEN_KV_ID`, and
`REPLACE_WITH_RSS_SETTINGS_KV_ID`.

---

## 4. Install dependencies

```bash
npm install
```

---

## 5. Set secrets (never hardcode these)

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN   # paste your bot token
npx wrangler secret put ADMIN_USER_ID        # paste your user id (comma-separated for several)
npx wrangler secret put WEBHOOK_SECRET       # paste the random string from step 2
```

Optional — post articles to a fixed chat/channel instead of the admin's DM:

```bash
npx wrangler secret put DEFAULT_CHAT_ID      # channel/group/chat numeric id
```

Optional — the webpage `og:image` fallback is **on by default** (it fetches the
article page only when the feed itself has no image). Disable it to save a
fetch per image-less article:

```toml
[vars]
FETCH_OG_IMAGE = "false"
```

---

## 6. Deploy

```bash
npm run deploy
```

Note the Workers URL printed at the end, e.g.
`https://telegram-rss-bot.<your-subdomain>.workers.dev`.

---

## 7. Register the Telegram webhook

Either visit the auto-registration endpoint in a browser:

```
https://telegram-rss-bot.<your-subdomain>.workers.dev/?register=1
```

…or call the Bot API directly (replace placeholders):

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://telegram-rss-bot.<subdomain>.workers.dev/webhook&secret_token=<WEBHOOK_SECRET>&allowed_updates=[\"message\"]"
```

Verify it worked:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

---

## 8. Use the bot

Open Telegram and send the bot:

| Command            | Action                                       | Access |
| ------------------ | -------------------------------------------- | ------ |
| `/start`, `/help`  | Show usage                                   | anyone |
| `/add <url>`       | Add an RSS/Atom feed                         | admin  |
| `/remove <url>` or `/remove <index>` | Remove a feed            | admin  |
| `/list`            | List active feeds (with errors)              | admin  |
| `/check`           | Poll all feeds immediately                   | admin  |
| `/admin <id>`      | Grant admin to another user id               | admin  |
| `/unadmin <id>`    | Revoke admin                                 | admin  |

Example:

```
/add https://digiato.com/feed
/add https://zoomit.ir/feed
/list
/check
```

The cron trigger polls every **15 minutes** by default; change the schedule in
`wrangler.toml` under `[triggers] crons`.

---

## 9. Local development (optional)

```bash
cp .dev.vars.example .dev.vars   # then fill in real values
npm run dev
```

For local webhook testing you can tunnel the Worker with a tool like
`cloudflared`, or temporarily test commands by POSTing updates to
`/webhook` directly.

---

## 10. Running tests

```bash
npm test            # run the Vitest suite once
npm run test:watch  # watch mode
npm run typecheck   # strict TS check
```

Coverage lives in `tests/`: RSS/Atom parsing (`extractItems`), image
extraction (`media:content`, `enclosure`, `<img>`, `og:image`), and HTML/text
cleanup (`stripHtml`, entity decoding, truncation).

---

## How it works

1. **Webhook** (`POST /webhook`) — Telegram forwards each message. The request
   is authenticated via the `X-Telegram-Bot-Api-Secret-Token` header; commands
   are authorized against `ADMIN_USER_ID` / the `RSS_SETTINGS` admin list.
2. **Cron** (`scheduled`) — iterates saved feeds, parses each, diffs new
   articles against the `RSS_SEEN` KV store (SHA-256 of the article GUID/link),
   and sends card messages.
3. **Dedupe** — seen entries are stored with a 30-day TTL and auto-expire, so
   the KV store doesn't grow unbounded and old items can be re-detected later.
4. **Image extraction** — multi-stage: (1) feed XML — `<media:content>`,
   `<media:thumbnail>`, `<enclosure type="image/*">`, then the first `<img>` in
   `content:encoded`/`description`; (2) if none found, the article page `<head>`
   is fetched for `og:image` / `twitter:image` / `image_src`. URLs are decoded,
   absolutized, and tracking pixels are skipped. `sendPhoto` falls back to
   `sendMessage` on any error.
5. **Text cleaning** — HTML is stripped to plain text, WordPress "first appeared
   on" watermarks are removed, summaries are truncated to ~300 chars, and
   captions are capped at 950 chars (under Telegram's 1024 limit).

### Limits & notes

- Cloudflare Workers have subrequest/time limits. The bot caps new sends to
  `MAX_SEND_PER_RUN` (20) and inspects at most `MAX_ITEMS_PER_FEED` (30) items
  per feed to stay within limits. For very large feed counts, increase the cron
  interval or split workloads.
- On `/add`, existing feed items are marked as read (not posted) so history
  isn't spammed; only genuinely new items are sent afterwards.
- KV dedupe is "check-then-set"; the tiny race window is negligible for a
  single-cron deployment. If you need strict atomicity, D1 with a unique
  constraint is the natural upgrade path.
