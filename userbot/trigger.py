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

Environment (see .env.example):
  TG_API_ID          Telegram API ID (from my.telegram.org)
  TG_API_HASH        Telegram API hash
  TG_SESSION         Telethon session name/path (default: ./rss_trigger)
  BOT_USERNAME       Bot to message (default: MehranRSSReader_bot)
  INTERVAL_SECONDS   Delay between polls in --loop mode (default: 900)

Usage:
  python trigger.py --once      # send /check once
  python trigger.py --loop      # send /check every INTERVAL_SECONDS (jittered)
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import random
import sys

from dotenv import load_dotenv
from telethon import TelegramClient

log = logging.getLogger("rss-trigger")

DEFAULT_SESSION = os.path.join(os.path.dirname(__file__), "rss_trigger")
DEFAULT_BOT = "MehranRSSReader_bot"


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


async def send_check(client: TelegramClient, bot_username: str) -> None:
    bot = await client.get_entity(bot_username)
    await client.send_message(bot, "/check")


async def run_once(client: TelegramClient, bot_username: str) -> None:
    await send_check(client, bot_username)
    log.info("sent /check to @%s", bot_username)


async def run_loop(client: TelegramClient, bot_username: str, interval: int) -> None:
    while True:
        try:
            await send_check(client, bot_username)
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
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    api_id, api_hash, session, bot, interval = load_config()
    client = TelegramClient(session, api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        sys.exit(
            f"Session '{session}' is not authorized. Run "
            f"'python {os.path.join(os.path.dirname(__file__), 'login.py')}' "
            "once to log in."
        )

    try:
        if args.once:
            await run_once(client, bot)
        else:
            await run_loop(client, bot, interval)
    finally:
        await client.disconnect()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        log.info("stopped")
