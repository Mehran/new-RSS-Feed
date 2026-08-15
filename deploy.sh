#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# deploy.sh — one-command deployment for the Telegram RSS Feed Reader Bot.
#
# Driven entirely by CLOUDFLARE_API_TOKEN, it will:
#   1. Authenticate with the Cloudflare API (wrangler reads the token env vars).
#   2. Create the three KV namespaces (or reuse existing ones) and inject their
#      IDs into wrangler.toml.
#   3. Upload the encrypted secrets (TELEGRAM_BOT_TOKEN, ADMIN_USER_ID, …).
#   4. Deploy the Worker with `wrangler deploy`.
#   5. Register the Telegram webhook against the freshly deployed Worker URL.
#
# Required environment variables:
#   CLOUDFLARE_API_TOKEN   Cloudflare API token (see README for permissions)
#   CLOUDFLARE_ACCOUNT_ID  Your Cloudflare account ID
#   TELEGRAM_BOT_TOKEN     Bot token from @BotFather
#   ADMIN_USER_ID          Numeric Telegram user ID (comma-separated for many)
#
# Optional:
#   WEBHOOK_SECRET         Random webhook secret (auto-generated if omitted)
#   DEFAULT_CHAT_ID        Fixed chat/channel to post articles to
#   FETCH_OG_IMAGE         "true" to enable og:image page fetching
#   WORKER_NAME            Worker name (defaults to `name` in wrangler.toml)
#   WORKER_URL             Override the deployed Worker URL (custom domain)
#
# Usage:
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
#   TELEGRAM_BOT_TOKEN=… ADMIN_USER_ID=… ./deploy.sh
# =============================================================================

CF_API="https://api.cloudflare.com/client/v4"
TG_API="https://api.telegram.org/bot"

C_RESET='\033[0m'; C_RED='\033[0;31m'; C_GREEN='\033[0;32m'
C_YELLOW='\033[1;33m'; C_BLUE='\033[0;34m'

log()  { printf "${C_BLUE}[deploy]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_GREEN}[deploy]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_YELLOW}[deploy]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_RED}[deploy] ERROR:${C_RESET} %s\n" "$*" >&2; exit 1; }

# ---- prerequisites -----------------------------------------------------------
for cmd in curl jq node npm npx; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

# ---- required env vars ---------------------------------------------------------
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
: "${ADMIN_USER_ID:?set ADMIN_USER_ID}"

# Run from the project directory (where wrangler.toml lives).
cd "$(dirname "$0")"

export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

WORKER_NAME="${WORKER_NAME:-$(sed -n 's/^name = "\(.*\)"/\1/p' wrangler.toml | head -n1)}"
WORKER_NAME="${WORKER_NAME:-telegram-rss-bot}"
log "Worker name: ${WORKER_NAME}"

if [ -z "${WEBHOOK_SECRET:-}" ]; then
  WEBHOOK_SECRET="$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  warn "WEBHOOK_SECRET not set; generated: ${WEBHOOK_SECRET} (save it if you redeploy)"
fi

# ---- Cloudflare API helper ------------------------------------------------------
# Usage: cf_api <METHOD> <path> [json-body]  -> prints full JSON response
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

# ---- install dependencies --------------------------------------------------------
if [ ! -d node_modules ]; then
  log "Installing dependencies…"
  npm install --silent
fi

# ---- KV namespaces ---------------------------------------------------------------
log "Fetching existing KV namespaces…"
NAMESPACES_JSON="$(cf_api GET "accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces?per_page=100")"

kv_id_by_title() {
  echo "$NAMESPACES_JSON" | jq -r --arg t "$1" '.result[] | select(.title == $t) | .id' | head -n1
}

create_kv() {
  cf_api POST "accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces" "{\"title\":\"$1\"}" \
    | jq -r '.result.id'
}

sed_inplace() {
  local expr="$1" file="$2"
  if [ "$(uname -s)" = "Darwin" ]; then
    sed -i '' "$expr" "$file"
  else
    sed -i "$expr" "$file"
  fi
}

for BINDING in RSS_FEEDS RSS_SEEN RSS_SETTINGS; do
  TITLE="${WORKER_NAME}-${BINDING}"
  ID="$(kv_id_by_title "$TITLE")"
  [ -z "$ID" ] && ID="$(kv_id_by_title "$BINDING")"

  if [ -z "$ID" ]; then
    log "Creating KV namespace ${TITLE}…"
    ID="$(create_kv "$TITLE")"
    [ -z "$ID" ] && die "failed to create KV namespace ${TITLE}"
  else
    log "Reusing KV namespace ${TITLE} (${ID})"
  fi

  sed_inplace "s|REPLACE_WITH_${BINDING}_KV_ID|${ID}|g" wrangler.toml
done

# ---- secrets ----------------------------------------------------------------------
put_secret() {
  local name="$1" value="${2:-}"
  [ -z "$value" ] && return 0
  log "Setting secret ${name}…"
  printf '%s\n' "$value" | npx wrangler secret put "$name" >/dev/null
}

put_secret TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
put_secret ADMIN_USER_ID "$ADMIN_USER_ID"
put_secret WEBHOOK_SECRET "$WEBHOOK_SECRET"
put_secret DEFAULT_CHAT_ID "${DEFAULT_CHAT_ID:-}"

# ---- deploy -----------------------------------------------------------------------
log "Deploying Worker '${WORKER_NAME}'…"
npx wrangler deploy

# ---- resolve the Worker URL ---------------------------------------------------------
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

# ---- register the Telegram webhook --------------------------------------------------
log "Registering Telegram webhook at ${WORKER_URL}/webhook…"
TG_RESP="$(curl -sS -G "${TG_API}${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/webhook" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]')"

if echo "$TG_RESP" | jq -e '.ok == true' >/dev/null 2>&1; then
  ok "Webhook registered: ${WORKER_URL}/webhook"
else
  die "Telegram setWebhook failed: $(echo "$TG_RESP" | jq -r '.description // .' 2>/dev/null)"
fi

# ---- summary --------------------------------------------------------------------------
ok "Deployment complete!"
echo
echo "Worker:   ${WORKER_URL}"
echo "KV:       RSS_FEEDS / RSS_SEEN / RSS_SETTINGS"
echo "Admin ID: ${ADMIN_USER_ID}"
echo
echo "Next: open Telegram, send the bot /start, then try:"
echo "  /add https://digiato.com/feed"
echo "  /add https://zoomit.ir/feed"
echo "  /check"
