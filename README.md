# Telegram RSS Feed Reader Bot

A serverless RSS/Atom reader that posts new articles to Telegram as card-style
messages (photo + caption + “Read More” button).

The project runs on **two** platforms, on purpose:

| Layer | Runtime | What it does |
|-------|---------|--------------|
| State + commands | **Telegram Serverless** (`tgcloud/`) | Receives Telegram updates, authorizes the sender, handles `/add`, `/remove`, `/list`, `/check`, `/admin`, `/unadmin`, and owns SQLite state (feeds, seen ids, admins). |
| Feed engine | **Cloudflare Worker** (`src/`) | Stateless: fetches and parses feeds, extracts images, sends article cards, and exposes the authenticated `/api/feed/preview` and `/api/poll` routes. |

Telegram Serverless has **no cron trigger**, **no public HTTP endpoint** and no
secret store: code only runs on a Telegram update, and its endpoints are only
callable by a real Telegram user inside the bot's Mini App. That is why state
lives there while the Worker stays stateless, and why polling is scheduled by a
small **userbot** that sends `/check`. The schedule runs in **GitHub Actions**
(`.github/workflows/poll.yml`), so no local machine needs to stay on (see
[`userbot/`](userbot/)).

---

## How it works

1. **Command** — Telegram delivers an update to the Serverless handler
   (`tgcloud/handlers/message.js`). It checks the sender against the SQLite admin
   list and calls the stateless Worker with a shared secret.
2. **Schedule** — a GitHub Actions workflow runs the Telethon userbot, which
   sends `/check` to the bot every 15 minutes. Because GitHub's cron is best
   effort (it can delay a scheduled run for hours), the job is a long-lived
   loop that covers ~5.5 hours per invocation and queues its own successor with
   `workflow_dispatch` before exiting. The cron is only a fallback if that
   hand-off fails. There is no Cloudflare cron and no local scheduler.
3. **Poll** — the Serverless `/check` handler loads feeds and seen ids from
   SQLite, then calls the Worker's `POST /api/poll`. The Worker parses each feed,
   diffs new articles against the seen set (SHA-256 of the article GUID/link,
   30-day TTL), sends cards, and returns the delivered ids plus per-feed
   metadata. The handler writes those ids and metadata back to SQLite.
4. **Images** — `media:content`, `media:thumbnail`, `enclosure`, the first
   `<img>` in the body, then the article page's `og:image`. Telegram fetches the
   URL; if its fetcher is blocked, the Worker downloads and uploads the bytes.
5. **State** — everything lives in Telegram Serverless SQLite, managed by
   `tgcloud/lib/store.js`:
   - `feeds` — `{ url, title, chatId, addedAt, lastChecked, lastError, itemCount }`
   - `seen` — `{ itemId, seenAt }` (SHA-256, 30-day TTL)
   - `admins` — `{ userId, addedAt }`
   Bootstrap admins from `BOOTSTRAP_ADMIN_ID` are always authorized.

---

## Setup

### 1. Cloudflare

Create an API token (**My Profile → API Tokens → Create Custom Token**, account
scope) with **Workers Scripts: Edit** (and **Account Settings: Read** so
`deploy.sh` can resolve the `workers.dev` subdomain). Note your **Account ID**
(dashboard sidebar or `npx wrangler whoami`).

The Worker no longer uses KV, so no KV permission or namespace is needed.

### 2. Telegram bot + userbot

1. Create the bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. In BotFather: **your bot → Serverless → turn it on**. This unlocks the
   Serverless runtime, database and CLI access.
3. In BotFather: **your bot → Serverless → CLI Access → Access token**. It looks
   like `app<id>:<secret>` — this is **not** the bot API token.
4. Get your numeric user ID from [@userinfobot](https://t.me/userinfobot).
5. For the scheduler, log in a Telegram account as a userbot once and add its
   numeric id to `ADMIN_USER_ID`. The resulting session string goes into the
   GitHub secrets, not a local file. See [`userbot/README.md`](userbot/README.md).

You do **not** need to create a second bot: commands arrive through the webhook
that Telegram Serverless manages for you.

### 3. Deploy

```bash
export CLOUDFLARE_API_TOKEN="<cloudflare-token>"
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
export TELEGRAM_BOT_TOKEN="<bot-token>"
export ADMIN_USER_ID="<your-user-id>,<userbot-user-id>"
export DEFAULT_CHAT_ID="<your-user-id>"
export TGCLOUD_TOKEN="app<id>:<secret>"

./deploy.sh
```

`deploy.sh` is idempotent. It:

1. refuses to deploy if `wrangler.toml` still has leftover KV bindings,
2. creates/loads `COMMAND_API_SECRET` into the git-ignored
   `tgcloud/lib/config.js` and syncs `WORKER_URL` / admin ids into it,
3. deploys the Worker, then uploads its secrets,
4. pushes `tgcloud/` and applies the (safe) schema migration, which also
   re-points the Telegram webhook at Telegram Serverless.

Deploy order matters: the Worker must expose `/api/*` before the Serverless
handlers start receiving commands.

The GitHub Actions workflow in `.github/workflows/deploy.yml` runs the typecheck
and tests on every push, then deploys to Cloudflare and Telegram Serverless when
they pass (and on a manual **Run workflow**). Configure `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `TGCLOUD_TOKEN` and
`ADMIN_USER_ID` as repository secrets; add `COMMAND_API_SECRET` and
`DEFAULT_CHAT_ID` too, otherwise each CI run generates a fresh command secret
(`deploy.sh` still keeps both sides in sync, but a stable value is easier to
debug). The deploy job stops early and names the missing secrets when one is
absent, instead of failing inside `deploy.sh` with a bare `set -u` error.

### Manual deployment

```bash
# tgcloud/lib/config.js is generated and git-ignored. Create it from the
# template and fill in WORKER_URL, COMMAND_API_SECRET, DEFAULT_CHAT_ID and
# BOOTSTRAP_ADMIN_ID before pushing the Serverless project.
cp tgcloud/lib/config.example tgcloud/lib/config.js

npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_USER_ID
npx wrangler secret put COMMAND_API_SECRET   # same value as config.js
npx wrangler secret put DEFAULT_CHAT_ID
npm run deploy:worker
npm run deploy:tgcloud
```

`COMMAND_API_SECRET` must be identical in the Worker secret and in
`tgcloud/lib/config.js` (the platform has no secret store, so the Serverless
copy lives in deployed code, but it must never be committed). `deploy.sh` keeps
both in sync automatically.

Finally, create the userbot session and add it to GitHub so the scheduled
workflow can send `/check` (see [`userbot/README.md`](userbot/README.md)):

```bash
cd userbot && python login.py
# convert the session to a StringSession and store it as a repo secret
# (TG_API_ID, TG_API_HASH, TG_SESSION_STRING)
```

The workflow `.github/workflows/poll.yml` polls every 15 minutes. You can also
start it manually from **Actions → Poll RSS Feeds → Run workflow**.

`trigger.py --once` waits for the bot's reply and fails when the bot refuses the
command, reports an error, or does not answer at all (a webhook that no longer
reaches Telegram Serverless looks exactly like that). The workflow uses
`--loop`, which runs the same verified poll every 15 minutes for up to
`MAX_RUNTIME_SECONDS` (5h45m in CI) and then exits. The last step dispatches the
next run via the Actions API, so the chain continues immediately instead of
waiting for GitHub's best-effort cron; the schedule is only a fallback. That
keeps articles flowing when GitHub delays its cron for hours. A green run
therefore means polls actually ran, not just that `/check` was sent.
Each poll also deletes the `/check` message and the bot's acknowledgement/summary
afterwards, and clears the ones earlier runs left behind, so the DM only shows
article cards (`--keep-messages` keeps them for debugging; error replies are
never deleted).

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

The GitHub Actions workflow polls every **15 minutes**, but GitHub only runs
scheduled jobs on a best-effort basis: in practice they can be delayed for
hours or dropped, which looks like "no new articles". The workflow therefore
runs a 5h45m loop per job and, in a final step, dispatches its own successor
with `workflow_dispatch` (allowed for `GITHUB_TOKEN` even though `push` events
are not). The 15-minute schedule is only a fallback if that hand-off fails;
queued runs wait behind the loop and the newest one starts when it exits.
GitHub also disables schedules after ~60 days without repo activity and can
stop the chain in other ways; re-run the workflow from the Actions tab if that
happens. A manually dispatched run starts as soon as the loop's group is free.

### Write budget

SQLite on Telegram Serverless has no documented write quota, unlike the
Cloudflare KV free plan this project moved off (1,000 writes/day). A poll still
batches its writes: managed `seen` inserts in chunks of 200, one update per
feed, and a single TTL cleanup.

---

## Configuration

Worker secrets (`wrangler secret put …`):

| Name | Purpose |
|------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot API token (article cards) |
| `ADMIN_USER_ID` | Comma-separated bootstrap admin IDs |
| `COMMAND_API_SECRET` | Shared secret for `/api/*` |
| `DEFAULT_CHAT_ID` | Optional fixed channel/group target |

Public Worker vars (`wrangler.toml` → `[vars]`): `WORKER_URL`, and optionally
`FETCH_OG_IMAGE = "false"` to skip the page-image fallback.

Serverless config: `tgcloud/lib/config.js` (`WORKER_URL`,
`COMMAND_API_SECRET`, `DEFAULT_CHAT_ID`, `BOOTSTRAP_ADMIN_ID`). It is generated
by `deploy.sh` from the committed `tgcloud/lib/config.example` and is
git-ignored — do not commit the generated file.

---

## Local development

```bash
npm install
npm test            # parser, images, stateless Worker API, commands
npm run typecheck   # strict TS for src/ + tests/

npm run dev         # wrangler dev (Worker only)

# Serverless handlers use the platform DB; run them without deploying:
npx tgcloud run handlers/message \
  '{ chat: { id: 1 }, from: { id: 111 }, text: "/list" }'

# Simulate the userbot scheduler (no Telethon needed):
npx tgcloud run handlers/message \
  '{ chat: { id: 1 }, from: { id: 779298050 }, text: "/check" }'
```

The Worker must be deployed (or running under `wrangler dev`) for `/add` and
`/check`, because the handlers call it.

---

## Limits & notes

- `MAX_SEND_PER_RUN` (20) and `MAX_ITEMS_PER_FEED` (30) keep each poll inside
  Workers limits. The send cap is shared between the feeds, and every feed is
  still fetched and reported (so `lastChecked`/`lastError`/`itemCount` are
  written for all of them) even after the cap is spent — otherwise a poll with a
  long backlog spends the cap on the oldest feeds and the newest ones are never
  checked. Unsent items stay unseen and go out on a later poll.
- `/check` drives the Worker in batches of 12 feeds and writes the returned ids
  after each batch. Parsing every feed in one request ran the Serverless
  invocation long enough to be killed after the cards had been sent, so the ids
  were never persisted and the next poll repeated them.
- `/api/poll` runs to completion under the Serverless handler and returns the
  final summary, so `/check` waits for the result instead of fire-and-forget.
- Seen dedupe is check-then-set; the race window is negligible for one poller.
  The Actions workflow's `concurrency` group avoids overlapping runs, and the
  long-lived loop means a delayed GitHub schedule does not stop polling.
- Telegram Serverless has no cron and no public HTTP endpoint; keep the schedule
  in GitHub Actions and the feed engine on Cloudflare.
- Rotate `CLOUDFLARE_API_TOKEN`, the bot token, and `TGCLOUD_TOKEN` if they have
  ever been pasted into a chat or committed. Never commit
  `tgcloud/lib/config.js`, `userbot/.env`, userbot `.session` files, or
  `TG_SESSION_STRING`.
