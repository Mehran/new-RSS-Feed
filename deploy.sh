#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# deploy.sh — one-command deployment for the Telegram RSS Feed Reader Bot.
#
# Two deployments, in this order:
#   1. Cloudflare Worker  — KV, feed polling, cron, image/card sending, and the
#                           authenticated /api/* routes the command layer uses.
#   2. Telegram Serverless — the stateless command handlers in tgcloud/.
#                           Pushing them also points the Telegram webhook at
#                           the platform (the Worker no longer receives updates).
#
# Required environment variables:
#   CLOUDFLARE_API_TOKEN   Cloudflare API token (see README for permissions)
#   CLOUDFLARE_ACCOUNT_ID  Your Cloudflare account ID
#   TELEGRAM_BOT_TOKEN     Bot token from @BotFather
#   TGCLOUD_TOKEN          Telegram Serverless CLI access token (app<id>:<secret>)
#
# Optional:
#   ADMIN_USER_ID          Numeric Telegram user ID (comma-separated for many).
#                          Required on a first deploy; omit on a re-deploy to
#                          keep the secret that is already on the Worker.
#   COMMAND_API_SECRET     Shared secret for /api/* (generated + saved in
#                          tgcloud/lib/config.js if omitted)
#   INTERNAL_POLL_SECRET   Shared secret for the cron relay (auto-generated)
#   DEFAULT_CHAT_ID        Fixed chat/channel to post articles to
#   FETCH_OG_IMAGE         "true" to enable og:image page fetching
#   WORKER_NAME            Worker name (defaults to `name` in wrangler.toml)
#   WORKER_URL             Override the deployed Worker URL (custom domain)
#   DISPATCHER_NAME        Dispatcher Worker name (defaults to "rss-dispatcher")
#   DISPATCHER_URL         Override the dispatcher Worker URL (custom domain)
#
# Usage:
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
#   TELEGRAM_BOT_TOKEN=… ADMIN_USER_ID=… TGCLOUD_TOKEN=… ./deploy.sh
# =============================================================================

CF_API="https://api.cloudflare.com/client/v4"

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
: "${TGCLOUD_TOKEN:?set TGCLOUD_TOKEN (BotFather -> your bot -> Serverless -> CLI Access)}"

if [ -z "${ADMIN_USER_ID:-}" ]; then
  warn "ADMIN_USER_ID not set — keeping the existing Worker secret (required on a first deploy)."
fi

# Run from the project directory (where wrangler.toml lives).
cd "$(dirname "$0")"

export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TGCLOUD_TOKEN

WORKER_NAME="${WORKER_NAME:-$(sed -n 's/^name = "\(.*\)"/\1/p' wrangler.toml | head -n1)}"
WORKER_NAME="${WORKER_NAME:-telegram-rss-bot}"
log "Worker name: ${WORKER_NAME}"

STATE_DIR=".tgcloud"
if [ -z "${INTERNAL_POLL_SECRET:-}" ]; then
  if [ -f "${STATE_DIR}/internal_poll_secret" ]; then
    INTERNAL_POLL_SECRET="$(cat "${STATE_DIR}/internal_poll_secret")"
    log "Reusing saved INTERNAL_POLL_SECRET."
  else
    INTERNAL_POLL_SECRET="$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    mkdir -p "$STATE_DIR"
    (umask 077 && printf '%s' "$INTERNAL_POLL_SECRET" > "${STATE_DIR}/internal_poll_secret")
    warn "INTERNAL_POLL_SECRET not set; generated and saved to ${STATE_DIR}/internal_poll_secret"
  fi
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
sed_inplace() {
  local expr="$1" file="$2"
  if [ "$(uname -s)" = "Darwin" ]; then
    sed -i '' "$expr" "$file"
  else
    sed -i "$expr" "$file"
  fi
}

log "Fetching existing KV namespaces…"
if NAMESPACES_JSON="$(cf_api GET "accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces?per_page=100" 2>/dev/null)"; then
  kv_id_by_title() {
    echo "$NAMESPACES_JSON" | jq -r --arg t "$1" '.result[] | select(.title == $t) | .id' | head -n1
  }

  create_kv() {
    cf_api POST "accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces" "{\"title\":\"$1\"}" \
      | jq -r '.result.id'
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
else
  # A token without Workers KV Storage can still deploy an existing bot: the
  # namespace IDs are already in wrangler.toml and deploying does not need to
  # list them. Only a first-time setup requires KV access.
  warn "Cannot list KV namespaces (the token may lack Workers KV Storage)."
  for BINDING in RSS_FEEDS RSS_SEEN RSS_SETTINGS; do
    if grep -q "REPLACE_WITH_${BINDING}_KV_ID" wrangler.toml; then
      die "${BINDING} has no namespace ID in wrangler.toml; add Workers KV Storage:Edit to the token and re-run."
    fi
  done
  ok "Reusing the KV namespace IDs already configured in wrangler.toml."
fi

# ---- secrets ----------------------------------------------------------------------
put_secret() {
  local name="$1" value="${2:-}"
  [ -z "$value" ] && return 0
  log "Setting secret ${name}…"
  printf '%s\n' "$value" | npx wrangler secret put "$name" --name "$WORKER_NAME" >/dev/null
}

# The command API secret is shared with the Serverless project. Keep the two in
# sync: read it from tgcloud/lib/config.js unless one was passed in. That file
# is generated (and git-ignored) because it must never be published.
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
  COMMAND_API_SECRET="$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  warn "COMMAND_API_SECRET not set; generated and saved to ${CONFIG_FILE}"
fi
sed_inplace "s|^export const COMMAND_API_SECRET = .*|export const COMMAND_API_SECRET = \"${COMMAND_API_SECRET}\";|" "$CONFIG_FILE"

# ---- resolve the Worker URL (before deploy, so it can be injected as a var) -------
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
log "Injecting WORKER_URL into wrangler.toml, the dispatcher and the Serverless config…"
sed_inplace "s|^WORKER_URL = .*|WORKER_URL = \"${WORKER_URL}\"|g" wrangler.toml
sed_inplace "s|^TARGET_URL = .*|TARGET_URL = \"${WORKER_URL}\"|g" wrangler-dispatcher.toml
sed_inplace "s|^export const WORKER_URL = .*|export const WORKER_URL = \"${WORKER_URL}\";|" "$CONFIG_FILE"
if [ -n "${FETCH_OG_IMAGE:-}" ]; then
  sed_inplace "s|^# FETCH_OG_IMAGE = .*|FETCH_OG_IMAGE = \"${FETCH_OG_IMAGE}\"|" wrangler.toml
  sed_inplace "s|^FETCH_OG_IMAGE = .*|FETCH_OG_IMAGE = \"${FETCH_OG_IMAGE}\"|" wrangler.toml
fi

# ---- dispatcher relay worker ----------------------------------------------------
# The cron trigger relays through this Worker because a Worker cannot fetch its
# own URL (error 1042) and a free-plan cron is capped at 10ms CPU.
DISPATCHER_NAME="${DISPATCHER_NAME:-rss-dispatcher}"
if [ -n "${DISPATCHER_URL:-}" ]; then
  DISPATCHER_URL="${DISPATCHER_URL%/}"
else
  SUBDOMAIN="$(cf_api GET "accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain" | jq -r '.result.subdomain')"
  DISPATCHER_URL="https://${DISPATCHER_NAME}.${SUBDOMAIN}.workers.dev"
fi
log "Dispatcher Worker: ${DISPATCHER_NAME} @ ${DISPATCHER_URL}"
sed_inplace "s|^DISPATCHER_URL = .*|DISPATCHER_URL = \"${DISPATCHER_URL}\"|g" wrangler.toml

# ---- deploy the Worker (must exist before the Serverless layer calls /api/*) ------
log "Deploying Worker '${WORKER_NAME}'…"
npx wrangler deploy --name "$WORKER_NAME"

# Secrets are written after the first deploy so a fresh account (where the
# script does not exist yet) can bootstrap without "worker not found" errors.
put_secret TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
put_secret ADMIN_USER_ID "${ADMIN_USER_ID:-}"
put_secret INTERNAL_POLL_SECRET "$INTERNAL_POLL_SECRET"
put_secret COMMAND_API_SECRET "$COMMAND_API_SECRET"
put_secret DEFAULT_CHAT_ID "${DEFAULT_CHAT_ID:-}"

# ---- deploy the dispatcher relay worker -------------------------------------------
# Deploy first, then attach the secret: `wrangler secret put` needs an existing
# script on a first-time setup, and creates a new version when it succeeds.
log "Deploying dispatcher Worker '${DISPATCHER_NAME}'…"
npx wrangler deploy --config wrangler-dispatcher.toml --name "$DISPATCHER_NAME"
printf '%s\n' "$INTERNAL_POLL_SECRET" | npx wrangler secret put INTERNAL_POLL_SECRET --config wrangler-dispatcher.toml --name "$DISPATCHER_NAME" >/dev/null

# ---- deploy Telegram Serverless (commands + webhook) -------------------------------
# push uploads tgcloud/ and re-points the Telegram webhook at the platform, so
# updates now reach handlers/message.js instead of the Worker.
log "Deploying Telegram Serverless command layer…"
npx tgcloud push
npx tgcloud migrate --safe

# ---- summary --------------------------------------------------------------------------
ok "Deployment complete!"
echo
echo "Worker:      ${WORKER_URL}  (cron + KV + /api/*)"
echo "Relay:       ${DISPATCHER_URL}  (rss-dispatcher)"
echo "Serverless:  tgcloud/handlers/message.js  (commands)"
echo "KV:          RSS_FEEDS / RSS_SEEN / RSS_SETTINGS"
echo "Admin ID:    ${ADMIN_USER_ID:-<unchanged>}"
echo
echo "Next: open Telegram, send the bot /start, then try:"
echo "  /add https://digiato.com/feed"
echo "  /add https://zoomit.ir/feed"
echo "  /check"
