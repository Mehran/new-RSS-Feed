# Userbot `/check` scheduler

Telegram Serverless has **no timer**, and its endpoints can only be called by a
real Telegram user inside the Mini App — there is no server-to-server API. So a
tiny Telethon userbot sends `/check` to the bot on a schedule. The Serverless
`/check` handler does the real work:

1. loads feeds, seen ids and admins from SQLite;
2. calls the Cloudflare Worker's stateless `POST /api/poll` with that state;
3. the Worker fetches/parses the feeds and sends article cards;
4. the handler writes the returned seen ids and feed metadata back to SQLite.

The schedule runs in **GitHub Actions** (`.github/workflows/poll.yml`) every
15 minutes, so no local machine has to stay on.

## One-time setup

Use a Python environment with Telethon (for example
`/home/mehran/tele-bot/.venv`), or install the dependencies:

```bash
python -m pip install -r userbot/requirements.txt
```

### 1. Create the session locally

```bash
cd userbot
cp .env.example .env      # set TG_API_ID / TG_API_HASH
python login.py           # phone + login code (+ 2FA password if set)
```

The account you log in as must be an administrator of the RSS bot. `deploy.sh`
sets `BOOTSTRAP_ADMIN_ID` from `ADMIN_USER_ID`, so include the account's numeric
id there, or add it in Telegram with `/admin <user_id>`.

### 2. Export it as a StringSession

```bash
python export_session.py
```

Copy the printed value into the repository secret **`TG_SESSION_STRING`**
(GitHub → Settings → Secrets and variables → Actions). Also add:

| Secret | Value |
|--------|-------|
| `TG_API_ID` | API ID from my.telegram.org |
| `TG_API_HASH` | API hash from my.telegram.org |
| `TG_SESSION_STRING` | output of `export_session.py` |

Never commit the session string or the `.session` file.

### 3. Run it

The workflow runs automatically every 15 minutes. To run it immediately:
GitHub → **Actions → Poll RSS Feeds → Run workflow**.

## Manual run (optional)

For debugging only. Stop the Actions schedule first so two triggers do not use
the same session at once.

```bash
cd userbot
python trigger.py --once            # send one /check
python trigger.py --loop            # foreground loop (INTERVAL_SECONDS)
```

## Notes

- The userbot only sends `/check`; the bot replies with “🔍 Checking all feeds…”
  and then the article cards in the destination chat (`DEFAULT_CHAT_ID`).
- Run **one** scheduler at a time (either GitHub Actions or a local loop). Using
  the same session from two places concurrently can invalidate it.
- GitHub may delay scheduled jobs slightly, and disables schedules after ~60
  days without repository activity. Re-enable it from the Actions tab if needed.
- If the session is invalidated, run `login.py` and update
  `TG_SESSION_STRING`.
