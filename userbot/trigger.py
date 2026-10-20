#!/usr/bin/env python3
"""
Userbot /check trigger for the Telegram RSS Feed Reader Bot.

Telegram Serverless has no timer and its endpoints cannot be called
server-to-server, so a real Telegram account (a userbot) sends the bot a
`/check` message. The Serverless handler then loads the SQLite state, calls the
Cloudflare Worker's stateless `/api/poll`, and writes the results back.

This script reuses a Telethon user session. Run it once interactively with
`login.py` first. The account it logs in as must be listed in the Serverless
config's BOOTSTRAP_ADMIN_ID (or added with /admin) or the bot will refuse the
command.

Because sending `/check` is fire-and-forget by itself, `--once` waits for the
bot's reply and turns a refusal or a failure into a non-zero exit code. That is
what makes a broken webhook, a missing admin entry or a Worker error show up as
a red GitHub Actions run instead of a green one.

Environment (see .env.example):
  TG_API_ID          Telegram API ID (from my.telegram.org)
  TG_API_HASH        Telegram API hash
  TG_SESSION         Telethon session name/path (default: ./rss_trigger)
  TG_SESSION_STRING  Telethon StringSession (takes precedence; used by CI)
  BOT_USERNAME       Bot to message (default: MehranRSSReader_bot)
  INTERVAL_SECONDS   Delay between polls in --loop mode (default: 900)
  REPLY_TIMEOUT      Seconds to wait for the bot's reply (default: 120)
  REPLY_SETTLE       Seconds of silence that ends the wait early (default: 45)

Usage:
  python trigger.py --once      # send /check once and report the reply
  python trigger.py --once --no-wait
  python trigger.py --loop      # send /check every INTERVAL_SECONDS (jittered)

Exit codes:
  0  the bot reported a completed check (no errors)
  1  the bot answered, but refused or failed the command
  2  the bot never answered (webhook not pointed at Telegram Serverless)
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import random
import sys
import time

from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.sessions import StringSession

log = logging.getLogger("rss-trigger")

DEFAULT_SESSION = os.path.join(os.path.dirname(__file__), "rss_trigger")
DEFAULT_BOT = "MehranRSSReader_bot"

# The Serverless command handler acknowledges immediately, then sends the
# summary once the Worker poll finishes (see tgcloud/lib/format.js).
SUMMARY_PREFIX = "✅ Check complete"
# Replies that mean the command did not do its job.
ERROR_MARKERS = ("⛔", "⚠️", "not authorized", "Something went wrong")


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def load_config() -> tuple[int, str, str, str, int]:
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
    api_id = env("TG_API_ID")
    api_hash = env("TG_API_HASH")
    if not api_id or not api_hash:
        sys.exit(
            "TG_API_ID and TG_API_HASH are required. Copy .env.example to .env "
            "and fill them in (see README.md)."
        )
    try:
        api_id_int = int(api_id)
    except ValueError:
        sys.exit("TG_API_ID must be a number.")
    session = env("TG_SESSION", DEFAULT_SESSION) or DEFAULT_SESSION
    bot = env("BOT_USERNAME", DEFAULT_BOT) or DEFAULT_BOT
    interval = int(env("INTERVAL_SECONDS", "900") or "900")
    return api_id_int, api_hash, session, bot, interval


async def get_bot(client: TelegramClient, bot_username: str):
    try:
        return await client.get_entity(bot_username)
    except Exception as exc:  # noqa: BLE001 - surface a readable hint
        sys.exit(
            f"Could not resolve @{bot_username}: {exc}\n"
            "Check BOT_USERNAME; a renamed bot must be resolvable by its "
            "current username."
        )


async def send_check(client: TelegramClient, bot) -> None:
    await client.send_message(bot, "/check")


async def wait_for_replies(
    client: TelegramClient,
    bot,
    min_id: int,
    *,
    timeout: float,
    settle: float,
) -> tuple[list[str], bool]:
    """Collect the bot's replies to the /check message with id > min_id.

    Returns (replies, complete). `complete` is True once the summary line
    arrives. Without a summary the wait ends after `settle` seconds of silence
    so a slow poll is not reported as a failure.
    """
    replies: list[str] = []
    last_id = min_id
    deadline = time.monotonic() + timeout
    quiet_since: float | None = None

    while time.monotonic() < deadline:
        messages = await client.get_messages(bot, limit=50, min_id=last_id)
        incoming = sorted((m for m in messages if not m.out), key=lambda m: m.id)
        if incoming:
            for message in incoming:
                text = (message.message or "").strip()
                if text:
                    replies.append(text)
                last_id = message.id
            quiet_since = time.monotonic()
            if any(text.startswith(SUMMARY_PREFIX) for text in replies):
                return replies, True
        elif quiet_since is not None and time.monotonic() - quiet_since >= settle:
            return replies, False
        await asyncio.sleep(2)

    return replies, any(text.startswith(SUMMARY_PREFIX) for text in replies)


def report(replies: list[str], bot_username: str) -> int:
    """Log the bot's replies and map them to a process exit code."""
    if not replies:
        log.error(
            "no reply from @%s within the timeout. The bot received /check but "
            "did not process it: its webhook is probably not pointed at the "
            "Telegram Serverless project. Check with `npx tgcloud webhook` and "
            "re-deploy with ./deploy.sh.",
            bot_username,
        )
        return 2

    for text in replies:
        log.info("bot reply: %s", " / ".join(text.splitlines()))

    failures = [t for t in replies if any(marker in t for marker in ERROR_MARKERS)]
    if failures:
        log.error("the bot reported a failure: %s", " / ".join(failures[0].splitlines()))
        return 1
    return 0


async def run_once(
    client: TelegramClient,
    bot_username: str,
    *,
    wait: bool,
    timeout: float,
    settle: float,
) -> int:
    bot = await get_bot(client, bot_username)
    # Baseline: ignore anything the bot sent earlier, so only this run's
    # replies are reported.
    baseline = await client.get_messages(bot, limit=1)
    min_id = baseline[0].id if baseline else 0

    await send_check(client, bot)
    log.info("sent /check to @%s", bot_username)
    if not wait:
        return 0

    replies, complete = await wait_for_replies(
        client, bot, min_id, timeout=timeout, settle=settle
    )
    if replies and not complete:
        log.warning("the bot did not send the summary line before the wait ended")
    return report(replies, bot_username)


async def run_loop(client: TelegramClient, bot_username: str, interval: int) -> None:
    while True:
        try:
            bot = await get_bot(client, bot_username)
            await send_check(client, bot)
            log.info("sent /check to @%s", bot_username)
        except Exception as exc:  # noqa: BLE001 - keep the scheduler alive
            log.warning("send failed: %s", exc)
        # Jitter avoids a thundering herd if several triggers are restarted
        # together and keeps the poll cadence from drifting into a fixed beat.
        delay = max(60, interval + random.randint(-30, 30))
        log.info("next check in %s seconds", delay)
        await asyncio.sleep(delay)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--once", action="store_true", help="send /check once")
    group.add_argument("--loop", action="store_true", help="send /check forever")
    parser.add_argument(
        "--no-wait",
        action="store_true",
        help="in --once mode, do not wait for the bot's reply",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    api_id, api_hash, session, bot, interval = load_config()
    wait = args.once and not args.no_wait
    timeout = float(env("REPLY_TIMEOUT", "120") or "120")
    settle = float(env("REPLY_SETTLE", "45") or "45")

    # A StringSession (e.g. from a GitHub Actions secret) takes precedence over
    # a local SQLite session file.
    session_string = env("TG_SESSION_STRING")
    client_session = StringSession(session_string) if session_string else session
    client = TelegramClient(client_session, api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        sys.exit(
            f"Session '{session}' is not authorized. Run "
            f"'python {os.path.join(os.path.dirname(__file__), 'login.py')}' "
            "once to log in."
        )

    code = 0
    try:
        if args.once:
            code = await run_once(
                client, bot, wait=wait, timeout=timeout, settle=settle
            )
        else:
            await run_loop(client, bot, interval)
    finally:
        await client.disconnect()
    return code


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        log.info("stopped")
