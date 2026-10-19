# AGENTS.md

Orientation for coding agents working in this repository. Read this before
changing anything; the project is deliberately split across two runtimes.

## What this project is

A Telegram RSS feed reader bot with two deployments:

| Part | Runtime | Responsibility |
|------|---------|----------------|
| `tgcloud/` | **Telegram Serverless** (V8 isolate, no npm) | Receives Telegram updates, parses `/add`, `/remove`, `/list`, `/check`, `/admin`, `/unadmin`, authorizes the sender, formats replies. **Stateless.** |
| `src/` | **Cloudflare Worker** | Owns Cloudflare KV, fetches/parses feeds, extracts images, sends article cards, and runs the cron poll. Also exposes the authenticated `/api/*` routes the Serverless layer calls. |

Telegram Serverless has **no cron and no public HTTP endpoint**. The cron must
stay on Cloudflare (see `wrangler.toml` and `src/dispatcher.ts`). Do not try to
move polling into `tgcloud/`.

There is no shared database: feeds, seen items and admins live only in
Cloudflare KV. `tgcloud/schema.js` exists for project validity and future state;
it is not used by the command handlers.

## Layout

- `tgcloud/handlers/message.js` — the only handler. Telegram routes `message`
  updates to it; it delegates to `lib/command.js`.
- `tgcloud/lib/command.js` — command routing. `api` and `worker` are injected,
  so it is testable with fakes.
- `tgcloud/lib/worker-api.js` — the only place that talks to the Worker.
- `tgcloud/lib/format.js` — pure formatting/parsing helpers.
- `tgcloud/lib/config.js` — generated, git-ignored: `WORKER_URL` and
  `COMMAND_API_SECRET`. The platform has no secret store, so the shared secret
  lives here and must match the Worker's `COMMAND_API_SECRET` secret. The
  committed template is `tgcloud/lib/config.example`; `deploy.sh` creates the
  real file. Never commit it (the repository is public).
- `src/index.ts` — Worker entry: `/api/*` routes, `/internal/check`, cron.
- `src/dispatcher.ts` — cron relay (a Worker cannot fetch its own URL; a
  free-plan cron is capped at 10 ms CPU).
- `tests/` — Vitest. Worker tests use a fake KV; command tests use fake
  `api`/`worker` objects.

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

## Commands

```bash
npm test                     # Worker + Serverless unit tests
npm run typecheck            # tsc --noEmit for src/ and tests/
npm run deploy:worker        # wrangler deploy (cron + API)
npm run deploy:tgcloud       # tgcloud push (+ migrate)
npm run deploy               # both, Worker first
```

Full SDK reference: [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).
