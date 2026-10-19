# AGENTS.md

Orientation for coding agents working in this repository. Read this before
changing anything; the project is deliberately split across two runtimes.

## What this project is

A Telegram RSS feed reader bot with two deployments:

| Part | Runtime | Responsibility |
|------|---------|----------------|
| `tgcloud/` | **Telegram Serverless** (V8 isolate, no npm) | Receives Telegram updates, parses `/add`, `/remove`, `/list`, `/check`, `/admin`, `/unadmin`, authorizes the sender, formats replies, and owns SQLite state (feeds, seen items, admins). |
| `src/` | **Cloudflare Worker** | **Stateless** feed engine: fetches/parses feeds, extracts images, sends article cards, and exposes the authenticated `/api/feed/preview` and `/api/poll` routes. No KV, no cron, no state. |

Telegram Serverless has **no cron and no public HTTP endpoint** — its endpoints
are only callable by a Telegram user inside the bot's Mini App, so there is no
server-to-server API. Polling is therefore scheduled by a Telethon **userbot**
(`userbot/`) that sends `/check`; the schedule runs in **GitHub Actions**
(`.github/workflows/poll.yml`), so no local machine needs to stay on. The
Serverless handler drives the poll and persists the results. Do not try to move
the feed-fetching/sending engine into `tgcloud/`, and do not try to make the
Worker call Serverless or own state.

Feeds, seen items and admins live only in Telegram Serverless SQLite. The Worker
never reads or writes them: every `/api/poll` request is fully parameterised.

## Layout

- `tgcloud/handlers/message.js` — the only handler. Telegram routes `message`
  updates to it; it delegates to `lib/command.js`.
- `tgcloud/lib/command.js` — command routing. `api` and `worker` are injected,
  so it is testable with fakes.
- `tgcloud/lib/store.js` — SQLite state and poll orchestration: reads feeds and
  seen ids, calls `pollFeeds()`, writes back delivered ids and feed metadata.
- `tgcloud/lib/worker-api.js` — the only place that talks to the Worker.
- `tgcloud/lib/format.js` — pure formatting/parsing helpers.
- `tgcloud/lib/config.js` — generated, git-ignored: `WORKER_URL`,
  `COMMAND_API_SECRET`, `DEFAULT_CHAT_ID`, `BOOTSTRAP_ADMIN_ID`. The platform has
  no secret store, so the shared secret lives here and must match the Worker's
  `COMMAND_API_SECRET` secret. The committed template is
  `tgcloud/lib/config.example`; `deploy.sh` creates the real file. Never commit
  it (the repository is public).
- `tgcloud/schema.js` — `feeds`, `seen`, `admins` tables (the source of truth).
- `src/index.ts` — Worker entry: `/api/*` routes only. Stateless.
- `userbot/trigger.py` — Telethon `/check` trigger run by GitHub Actions;
  `userbot/login.py` creates its session. The workflow reads
  `TG_API_ID`/`TG_API_HASH`/`TG_SESSION_STRING` from repo secrets. Never commit
  `userbot/*.session`, `userbot/.env`, or the session string.
- `tests/` — Vitest. Worker tests mock `fetch` (the Worker has no storage);
  command tests use fake `api`/`worker` objects.

## Rules that bite

- Telegram Serverless modules may import only `sdk`, `sdk/db`, `sdk/api`,
  `sdk/fetch`, and project modules by relative path **with `.js`**. No npm
  packages, no filesystem, no `node_modules`.
- A handler's default export receives the update payload (`Message`), not the
  full `Update`.
- Every DB call is async; there are no foreign keys.
- `src/` is TypeScript and is typechecked separately (`npm run typecheck`);
  `tgcloud/` is plain JS and is not in `tsconfig.json`.
- Deploying the Worker does **not** deploy the Serverless project, and vice
  versa. `./deploy.sh` does both.
- Deploy order matters: deploy the Worker first (it adds `/api/*`), then push
  the Serverless project (which moves the Telegram webhook to the platform).
- `/api/poll` is at-most-once by design: the Worker records an item as seen
  before sending. Failed sends are not returned in `seen`, so a retry can resend
  them; a crash after a successful send would drop them. Keep it that way.
- The `/check` sender must be an admin. Add the userbot's numeric id to
  `BOOTSTRAP_ADMIN_ID` (`deploy.sh` fills it from `ADMIN_USER_ID`) or via
  `/admin`.
- There is no Cloudflare KV anymore. If `wrangler.toml` regains a
  `[[kv_namespaces]]` block, `deploy.sh` refuses to run.
- The Worker must not grow state or a cron: the whole point of the split is that
  Telegram Serverless owns state and scheduling.

## Commands

```bash
npm test                     # Worker + Serverless unit tests
npm run typecheck            # tsc --noEmit for src/ and tests/
npm run deploy:worker        # wrangler deploy (API only)
npm run deploy:tgcloud       # tgcloud push (+ migrate)
npm run deploy               # both, Worker first
python userbot/trigger.py --once   # manual /check via the userbot session
```

Full SDK reference: [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).
