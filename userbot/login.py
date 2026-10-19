#!/usr/bin/env python3
"""Interactive Telethon login for the userbot /check trigger.

Creates/reuses the session named by TG_SESSION (see .env.example). Run once,
then use trigger.py --loop.
"""

from __future__ import annotations

import asyncio
import os
import sys

from dotenv import load_dotenv
from telethon import TelegramClient

DEFAULT_SESSION = os.path.join(os.path.dirname(__file__), "rss_trigger")


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def load_config() -> tuple[int, str, str]:
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
    api_id = env("TG_API_ID")
    api_hash = env("TG_API_HASH")
    if not api_id or not api_hash:
        sys.exit(
            "TG_API_ID and TG_API_HASH are required. Copy .env.example to .env "
            "and fill them in (see README.md)."
        )
    session = env("TG_SESSION", DEFAULT_SESSION) or DEFAULT_SESSION
    return int(api_id), api_hash, session


async def main() -> None:
    api_id, api_hash, session = load_config()
    client = TelegramClient(session, api_id, api_hash)
    await client.start()
    me = await client.get_me()
    print(f"Logged in as {me.id} (@{me.username or 'no username'}).")
    print(f"Session saved to {session}.session")
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
