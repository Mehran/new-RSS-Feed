# Telegram RSS Feed Reader Bot (Cloudflare Workers)

[![Cloudflare Workers](https://img.shields.io/badge/Runtime-Cloudflare%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-Vitest-yellow?logo=vitest)](https://vitest.dev/)

A production-ready, serverless RSS/Atom feed reader that posts new articles to Telegram as card-style messages (photo + summary caption + inline "Read More" button), orchestrated via Cloudflare Workers Cron Triggers.

- **Runtime:** Cloudflare Workers (TypeScript)
- **Storage:** Cloudflare KV (`RSS_FEEDS`, `RSS_SEEN` deduplication, `RSS_SETTINGS`)
- **Parser:** `fast-xml-parser` (pure JS, Zero-Node-dependency, Workers-native)
- **Transport:** Telegram Bot API via Webhook (commands) & Scheduled Cron (polling)

---

## Architecture & How It Works

1. **Webhook (`POST /webhook`):** Telegram forwards incoming messages. Requests are validated using the `X-Telegram-Bot-Api-Secret-Token` header. Administrative commands are authorized against `ADMIN_USER_ID` and the dynamic `RSS_SETTINGS` list.
2. **Cron Scheduler (`scheduled`):** Evaluates active subscriptions periodically, extracts feeds, and compares incoming articles against the `RSS_SEEN` KV cache (SHA-256 hashed article GUID/Link).
3. **Deduplication Engine:** Seen hashes are cached with an auto-expiring 30-day TTL to prevent unbounded storage usage while avoiding repost regressions.
4. **Intelligent Image Extraction:**
   * **Stage 1 (XML Feed):** Inspects `<media:content>`, `<media:thumbnail>`, `<enclosure type="image/*">`, and embedded `<img>` tags inside `content:encoded` / `description`.
   * **Stage 2 (Open Graph Fallback):** If no image is declared in the feed, fetches the target `<head>` to resolve `og:image`, `twitter:image`, or `image_src`.
   * **Resilience:** Invalid formats, relative paths, and tracking pixels are filtered out; gracefully downgrades from `sendPhoto` to `sendMessage` on failure.
5. **Content Normalization:** Strips HTML payloads safely, purges CMS tracking footers (e.g., WordPress syndication tags), normalizes entities, and limits captions within Telegram's 1024-character boundary.

---

## Quick Start — Automated Setup (`deploy.sh`)

The deployment script automatically provisions KV namespaces, binds identifiers to `wrangler.toml`, registers encrypted production secrets, deploys the Worker script, and establishes the Telegram webhook.

### 1. Generate Cloudflare API Token

Navigate to **Cloudflare Dashboard → My Profile → API Tokens → Create Custom Token** with the following **Account**-level permissions:

| Permission | Scope | Access Level |
| :--- | :--- | :--- |
| **Workers Scripts** | Account | Edit |
| **Workers KV Storage** | Account | Edit |
| **Account Settings** | Account | Read |

Obtain your **Account ID** from the dashboard overview or run:
```bash
npx wrangler whoami
