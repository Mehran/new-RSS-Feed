# Userbot `/check` scheduler

Telegram Serverless has **no timer**, and its endpoints can only be called by a
real Telegram user inside the Mini App — there is no server-to-server API. So
this directory holds a tiny Telethon userbot that sends `/check` to the bot on a
schedule. The Serverless `/check` handler does the real work:

1. loads feeds, seen ids and admins from SQLite;
2. calls the Cloudflare Worker's stateless `POST /api/poll` with that state;
3. the Worker fetches/parses the feeds and sends article cards;
4. the handler writes the returned seen ids and feed metadata back to SQLite.

The Worker has no cron and no access to Serverless state.

## Setup

Use the Python environment that already has Telethon (for example
`/home/mehran/tele-bot/.venv`), or install the two dependencies:

```bash
python -m pip install telethon python-dotenv
```

Then configure and log in once:

```bash
cd userbot
cp .env.example .env      # set TG_API_ID / TG_API_HASH
python login.py           # phone + login code (+ 2FA password if set)
```

`login.py` writes `rss_trigger.session` next to this file. The session is
git-ignored; never commit it.

The account you log in as must be an administrator of the RSS bot. `deploy.sh`
sets `BOOTSTRAP_ADMIN_ID` from `ADMIN_USER_ID`, so include the account's numeric
id there (the default config includes `779298050`), or add it in Telegram with
`/admin <user_id>`.

## Run

One-shot (for a systemd timer or manual testing):

```bash
python trigger.py --once
```

Foreground loop (every `INTERVAL_SECONDS`, default 15 min, with jitter):

```bash
python trigger.py --loop
```

Keep it running with tmux, or a systemd service:

```ini
# ~/.config/systemd/user/rss-trigger.service
[Unit]
Description=RSS Feed Reader /check userbot trigger

[Service]
WorkingDirectory=%h/rss-feed/serverless/userbot
ExecStart=%h/tele-bot/.venv/bin/python %h/rss-feed/serverless/userbot/trigger.py --loop
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now rss-trigger.service
journalctl --user -u rss-trigger.service -f
```

## Notes

- The userbot only sends `/check`; the bot replies with “🔍 Checking all feeds…”
  and then the article cards in the destination chat (`DEFAULT_CHAT_ID`).
- Do not run two userbot sessions for the same account from different IPs at
  once; Telegram invalidates the auth key (`AuthKeyDuplicatedError`).
- If the session is invalidated, run `login.py` again.
