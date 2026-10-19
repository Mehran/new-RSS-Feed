#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# deploy.sh — one-command deployment for the Telegram RSS Feed Reader Bot.
#
# Two deployments:
#   1. Cloudflare Worker  — stateless feed engine: /api/feed/preview + /api/poll.
#   2. Telegram Serverless — SQLite state (feeds/seen/admins), command handlers,
#                           and the /check handler that drives the poll.
#
# Polling is scheduled by the Telethon userbot trigger (see userbot/), which
# sends /check to the bot on an interval. There is no Cloudflare cron and no
# Worker-to-Serverless state bridge.
#
# Required environment variables:
#   CLOUDFLARE_API_TOKEN   Cloudflare API token (see README for permissions)
#   CLOUDFLARE_ACCOUNT_ID  Your Cloudflare account ID
#   TELEGRAM_BOT_TOKEN     Bot token from @BotFather
#   TGCLOUD_TOKEN          Telegram Serverless CLI access token (app<id>:<secret>)
#
# Optional:
#   ADMIN_USER_ID          Comma-separated numeric Telegram user IDs that are
#                          always administrators. Include the userbot account.
#   DEFAULT_CHAT_ID        Chat/channel that receives article cards. Defaults to
#                          the first ADMIN_USER_ID.
#   COMMAND_API_SECRET     Shared secret for /api/* (saved in config.js if omitted)
#   WORKER_NAME            Worker name (defaults to `name` in wrangler.toml)
#   WORKER_URL             Override the deployed Worker URL (custom domain)
#   FETCH_OG_IMAGE         "true" to enable the webpage og:image fallback
#
# Usage:
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
#   TELEGRAM_BOT_TOKEN=… ADMIN_USER_ID=8766696683,779298050 \
#   DEFAULT_CHAT_ID=8766696683 TGCLOUD_TOKEN=… ./deploy.sh
# =============================================================================

CF_API="https://api.cloudflare.com/client/v4"

C_RESET='\033[0m'; C_RED='\033[0;31m'; C_GREEN='\033[0;32m'
C_YELLOW='\033[1;33m'; C_BLUE='\033[0;34m'

log()  { printf "${C_BLUE}[deploy]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_GREEN}[deploy]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_YELLOW}[deploy]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_RED}[deploy] ERROR:${C_RESET} %s\n" "$*" >&2; exit 1; }

for cmd in curl jq node npm npx; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
: "${TGCLOUD_TOKEN:?set TGCLOUD_TOKEN (BotFather -> your bot -> Serverless -> CLI Access)}"

cd "$(dirname "$0")"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TGCLOUD_TOKEN

WORKER_NAME="${WORKER_NAME:-$(sed -n 's/^name = "\(.*\)"/\1/p' wrangler.toml | head -n1)}"
WORKER_NAME="${WORKER_NAME:-telegram-rss-bot}"
log "Worker name: ${WORKER_NAME}"

sed_inplace() {
  local expr="$1" file="$2"
  if [ "$(uname -s)" = "Darwin" ]; then
    sed -i '' "$expr" "$file"
  else
    sed -i "$expr" "$file"
  fi
}

rand_hex() {
  openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
}

# ---- Cloudflare API helper (used only to resolve the workers.dev subdomain) ----
cf_api() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-sS -X "$method"
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    -H "Content-Type: application/json")
  [ -n "$data" ] && args+=(-d "$data")

  local resp
  resp="$(curl "${args[@]}" "${CF_API}/${path}")" || die "Cloudflare API request failed: $method $path"

  if ! echo "$resp" | jq -e '.success == true' >/dev/null 2>&1; then
    local err
    err="$(echo "$resp" | jq -r '.errors[]?.message // (.errors | tostring) // "unknown"' 2>/dev/null | head -n1)"
    die "Cloudflare API error ($method $path): $err"
  fi
  echo "$resp"
}

if [ ! -d node_modules ]; then
  log "Installing dependencies…"
  npm install --silent
fi

# ---- legacy KV bindings ------------------------------------------------------
# State lives in Telegram Serverless SQLite now. Keep this guard so an old
# checkout cannot silently redeploy a Worker that still expects KV.
if grep -q '^\[\[kv_namespaces\]\]' wrangler.toml; then
  die "wrangler.toml still contains KV bindings; remove the [[kv_namespaces]] block and re-run."
fi

# ---- Serverless config (shared secret + recipients) ---------------------------
CONFIG_FILE="tgcloud/lib/config.js"
if [ ! -f "$CONFIG_FILE" ]; then
  log "Creating ${CONFIG_FILE} from the committed template…"
  mkdir -p "$(dirname "$CONFIG_FILE")"
  cp tgcloud/lib/config.example "$CONFIG_FILE"
fi

SAVED_SECRET="$(sed -n 's/^export const COMMAND_API_SECRET = "\(.*\)";$/\1/p' "$CONFIG_FILE" | head -n1)"
if [ -n "${COMMAND_API_SECRET:-}" ]; then
  log "Using provided COMMAND_API_SECRET"
elif [ -n "$SAVED_SECRET" ] && [ "$SAVED_SECRET" != "REPLACE_WITH_COMMAND_API_SECRET" ]; then
  COMMAND_API_SECRET="$SAVED_SECRET"
else
  COMMAND_API_SECRET="$(rand_hex)"
  warn "COMMAND_API_SECRET not set; generated and saved to ${CONFIG_FILE}"
fi
sed_inplace "s|^export const COMMAND_API_SECRET = .*|export const COMMAND_API_SECRET = \"${COMMAND_API_SECRET}\";|" "$CONFIG_FILE"

if [ -n "${ADMIN_USER_ID:-}" ]; then
  sed_inplace "s|^export const BOOTSTRAP_ADMIN_ID = .*|export const BOOTSTRAP_ADMIN_ID = \"${ADMIN_USER_ID}\";|" "$CONFIG_FILE"
fi

SAVED_DEFAULT_CHAT="$(sed -n 's/^export const DEFAULT_CHAT_ID = "\(.*\)";$/\1/p' "$CONFIG_FILE" | head -n1)"
if [ -n "${DEFAULT_CHAT_ID:-}" ]; then
  sed_inplace "s|^export const DEFAULT_CHAT_ID = .*|export const DEFAULT_CHAT_ID = \"${DEFAULT_CHAT_ID}\";|" "$CONFIG_FILE"
elif [ -n "$SAVED_DEFAULT_CHAT" ] && [ "$SAVED_DEFAULT_CHAT" != "REPLACE_WITH_DEFAULT_CHAT_ID" ]; then
  DEFAULT_CHAT_ID="$SAVED_DEFAULT_CHAT"
elif [ -n "${ADMIN_USER_ID:-}" ]; then
  DEFAULT_CHAT_ID="${ADMIN_USER_ID%%,*}"
  sed_inplace "s|^export const DEFAULT_CHAT_ID = .*|export const DEFAULT_CHAT_ID = \"${DEFAULT_CHAT_ID}\";|" "$CONFIG_FILE"
fi

# ---- resolve the Worker URL (before deploy, so it can be injected as a var) ---
if [ -n "${WORKER_URL:-}" ]; then
  WORKER_URL="${WORKER_URL%/}"
  log "Using provided WORKER_URL: ${WORKER_URL}"
else
  log "Resolving workers.dev subdomain…"
  SUBDOMAIN="$(cf_api GET "accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain" | jq -r '.result.subdomain')"
  if [ -z "$SUBDOMAIN" ] || [ "$SUBDOMAIN" = "null" ]; then
    die "could not resolve workers.dev subdomain — set WORKER_URL manually"
  fi
  WORKER_URL="https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev"
  log "Worker URL: ${WORKER_URL}"
fi

log "Injecting WORKER_URL into wrangler.toml and the Serverless config…"
sed_inplace "s|^WORKER_URL = .*|WORKER_URL = \"${WORKER_URL}\"|g" wrangler.toml
sed_inplace "s|^export const WORKER_URL = .*|export const WORKER_URL = \"${WORKER_URL}\";|" "$CONFIG_FILE"
if [ -n "${FETCH_OG_IMAGE:-}" ]; then
  sed_inplace "s|^# FETCH_OG_IMAGE = .*|FETCH_OG_IMAGE = \"${FETCH_OG_IMAGE}\"|" wrangler.toml
  sed_inplace "s|^FETCH_OG_IMAGE = .*|FETCH_OG_IMAGE = \"${FETCH_OG_IMAGE}\"|" wrangler.toml
fi

# ---- deploy the Worker --------------------------------------------------------
log "Deploying Worker '${WORKER_NAME}'…"
npx wrangler deploy --name "$WORKER_NAME"

put_secret() {
  local name="$1" value="${2:-}"
  [ -z "$value" ] && return 0
  log "Setting secret ${name}…"
  printf '%s\n' "$value" | npx wrangler secret put "$name" --name "$WORKER_NAME" >/dev/null
}

put_secret TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
put_secret ADMIN_USER_ID "${ADMIN_USER_ID:-}"
put_secret COMMAND_API_SECRET "$COMMAND_API_SECRET"
put_secret DEFAULT_CHAT_ID "${DEFAULT_CHAT_ID:-}"

# ---- deploy Telegram Serverless (commands + webhook) --------------------------
log "Deploying Telegram Serverless command layer…"
npx tgcloud push
npx tgcloud migrate --safe

ok "Deployment complete!"
echo
echo "Worker:      ${WORKER_URL}  (stateless feed engine + /api/*)"
echo "Serverless:  tgcloud/handlers/message.js  (commands + SQLite state)"
echo "Scheduler:   .github/workflows/poll.yml    (GitHub Actions sends /check; see userbot/README.md)"
