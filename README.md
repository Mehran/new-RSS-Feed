# Telegram RSS Feed Reader Bot

A serverless RSS/Atom reader that posts new articles to Telegram as card-style
messages (photo + caption + “Read More” button).

The project runs on **two** platforms, on purpose:

| Layer | Runtime | What it does |
|-------|---------|--------------|
| Commands | **Telegram Serverless** (`tgcloud/`) | Receives Telegram updates, authorizes the sender, handles `/add`, `/remove`, `/list`, `/check`, `/admin`, `/unadmin`. Stateless. |
| Engine | **Cloudflare Worker** (`src/`) | Owns Cloudflare KV, fetches and parses feeds, extracts images, sends article cards, runs the cron poll, and exposes the authenticated `/api/*` routes the command layer calls. |

Telegram Serverless has **no cron trigger** and **no public HTTP endpoint** — code
only runs on a Telegram update or a Mini App endpoint. That is why polling and
storage stay on Cloudflare; the cron cannot live on Telegram.

---

## How it works

1. **Command** — Telegram delivers an update to the Serverless handler
   (`tgcloud/handlers/message.js`). It checks the sender against the admin list
   and calls the Worker's `/api/*` routes with a shared secret.
2. **Cron** — every 15 minutes the Worker's `scheduled` handler pings the
   `rss-dispatcher` Worker, which calls back into `/internal/check`. (A Worker
   cannot fetch its own URL, and a free-plan cron is capped at 10 ms CPU.)
3. **Poll** — `/internal/check` (or `/api/check` from `/check`) iterates the
   saved feeds, parses them, diffs new articles against `RSS_SEEN` (SHA-256 of
   the article GUID/link, 30-day TTL), and sends cards.
4. **Images** — `media:content`, `media:thumbnail`, `enclosure`, the first
   `<img>` in the body, then the article page's `og:image`. Telegram fetches the
   URL; if its fetcher is blocked, the Worker downloads and uploads the bytes.
5. **State** — everything lives in Cloudflare KV:
   - `RSS_FEEDS` — `feed:<url>` → `{ url, title, addedAt, lastChecked, lastError, itemCount }`
   - `RSS_SEEN` — `seen:<sha256>` → timestamp (TTL 30 days)
   - `RSS_SETTINGS` — `admins` → JSON array of admin user IDs

---

## Setup

### 1. Cloudflare

Create an API token (**My Profile → API Tokens → Create Custom Token**, account
scope) with:

| Permission | Access |
|------------|--------|
| Workers Scripts | Edit |
| Workers KV Storage | Edit |
| Account Settings | Read |

> Updating an existing deployment only needs **Workers Scripts: Edit** — the KV
> namespace IDs are already in `wrangler.toml`. KV access is required only to
> create the namespaces on a first install.

Note your **Account ID** (dashboard sidebar or `npx wrangler whoami`).

### 2. Telegram bot

1. Create the bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. In BotFather: **your bot → Serverless → turn it on**. This unlocks the
   Serverless runtime, database and CLI access.
3. In BotFather: **your bot → Serverless → CLI Access → Access token**. It looks
   like `app<id>:<secret>` — this is **not** the bot API token.
4. Get your numeric user ID from [@userinfobot](https://t.me/userinfobot).

You do **not** need to create a second bot: commands arrive through the webhook
that Telegram Serverless manages for you.

### 3. Deploy

```bash
export CLOUDFLARE_API_TOKEN="<cloudflare-token>"
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
export TELEGRAM_BOT_TOKEN="<bot-token>"
export ADMIN_USER_ID="<your-user-id>"
export TGCLOUD_TOKEN="app<id>:<secret>"

./deploy.sh
```

`deploy.sh` is idempotent. It:

1. creates or reuses the three KV namespaces,
2. generates/loads `COMMAND_API_SECRET` (into the git-ignored
   `tgcloud/lib/config.js`) and `INTERNAL_POLL_SECRET` (into `.tgcloud/`),
3. deploys the Worker, then uploads its secrets,
4. deploys the `rss-dispatcher` relay and attaches its secret,
5. pushes `tgcloud/` and applies the (safe) schema migration — which also
   re-points the Telegram webhook at Telegram Serverless.

Deploy order matters: the Worker must expose `/api/*` before the Serverless
handlers start receiving commands.

The GitHub Actions workflow in `.github/workflows/deploy.yml` runs the tests on
every push and only deploys on a manual **Run workflow** (because deploying also
re-points the Telegram webhook). Configure `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `ADMIN_USER_ID`, `TGCLOUD_TOKEN`
and, optionally, `COMMAND_API_SECRET`, `INTERNAL_POLL_SECRET` and
`DEFAULT_CHAT_ID` as repository secrets before running it.

### Manual deployment

```bash
# tgcloud/lib/config.js is generated and git-ignored. Create it from the
# template and fill in both values before pushing the Serverless project.
cp tgcloud/lib/config.example tgcloud/lib/config.js
# edit tgcloud/lib/config.js: WORKER_URL + COMMAND_API_SECRET

npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_USER_ID
npx wrangler secret put COMMAND_API_SECRET   # same value as config.js
npx wrangler secret put INTERNAL_POLL_SECRET
npm run deploy:worker
npx wrangler deploy --config wrangler-dispatcher.toml
npx wrangler secret put INTERNAL_POLL_SECRET --config wrangler-dispatcher.toml
npm run deploy:tgcloud
```

`COMMAND_API_SECRET` must be identical in the Worker secret and in
`tgcloud/lib/config.js` (the platform has no secret store, so the Serverless
copy lives in deployed code, but it must never be committed). `deploy.sh` keeps
both in sync automatically.

---

## Commands

| Command | Action | Access |
|---------|--------|--------|
| `/start`, `/help` | Show usage | anyone |
| `/add <url>` | Add a feed (existing items are marked read) | admin |
| `/remove <url>` or `/remove <index>` | Remove a feed | admin |
| `/list` | List feeds and their last error | admin |
| `/check` | Poll every feed now | admin |
| `/admin <id>` | Grant admin | admin |
| `/unadmin <id>` | Revoke admin | admin |

The cron polls every **15 minutes** (`wrangler.toml` → `[triggers] crons`).

### KV write budget

The Workers **free plan allows 1,000 KV writes per day**. Poll status for all
feeds is stored in one `feedMeta` key, so a poll costs **one write** (plus one
write per newly seen article), not one write per feed. Adding a feed writes the
feed record plus up to 30 "already seen" markers. Avoid reintroducing per-feed
writes in the poll loop, or the daily limit will be exhausted before the day
ends and `/add`, deduplication and metadata updates will fail until 00:00 UTC.

---

## Configuration

Worker secrets (`wrangler secret put …`):

| Name | Purpose |
|------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot API token (article cards) |
| `ADMIN_USER_ID` | Comma-separated bootstrap admin IDs |
| `COMMAND_API_SECRET` | Shared secret for `/api/*` |
| `INTERNAL_POLL_SECRET` | Shared secret for the cron relay |
| `DEFAULT_CHAT_ID` | Optional fixed channel/group target |

Public Worker vars (`wrangler.toml` → `[vars]`): `WORKER_URL`, `DISPATCHER_URL`,
and optionally `FETCH_OG_IMAGE = "false"` to skip the page-image fallback.

Serverless config: `tgcloud/lib/config.js` (`WORKER_URL`, `COMMAND_API_SECRET`).
It is generated by `deploy.sh` from the committed `tgcloud/lib/config.example`
and is git-ignored — do not commit the generated file.

---

## Local development

```bash
npm install
npm test            # 111 unit tests: parser, images, Worker API, commands
npm run typecheck   # strict TS for src/ + tests/

npm run dev         # wrangler dev (Worker only)
npx tgcloud run handlers/message '{ chat: { id: 1 }, from: { id: 111 }, text: "/list" }'
```

`tgcloud run` executes the handler on the platform with your local files, so the
Worker must be reachable for anything that touches feeds.

---

## Limits & notes

- `MAX_SEND_PER_RUN` (20) and `MAX_ITEMS_PER_FEED` (30) keep each poll inside
  Workers limits.
- `/api/check` keeps a full poll alive with `waitUntil`, but only waits ~20 s for
  a summary. If the poll is still running, the command replies “Check started”
  and the cards arrive on their own.
- KV dedupe is check-then-set; the race window is negligible for a single cron.
- Telegram Serverless has no documented execution-time or storage quotas and no
  secret store. The command layer is deliberately stateless so that a platform
  limit cannot take feed data with it.
- Rotate `CLOUDFLARE_API_TOKEN`, the bot token, and `TGCLOUD_TOKEN` if they have
  ever been pasted into a chat or committed.
