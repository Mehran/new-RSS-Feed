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
  MAX_RUNTIME_SECONDS
                     Stop --loop after this long; 0 means forever (default: 0).
                     CI sets it below GitHub Actions' 6-hour job limit.

The messages the trigger creates are noise in the bot DM, so after reporting the
result it deletes both its own `/check` and the bot's acknowledgement and
summary, and sweeps those left behind by earlier runs. Article cards are never
touched. Pass `--keep-messages` to keep them (debugging).

Usage:
  python trigger.py --once      # send /check once and report the reply
  python trigger.py --once --no-wait
  python trigger.py --once --keep-messages
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
ACK_PREFIX = "🔍 Checking all feeds"
SUMMARY_PREFIX = "✅ Check complete"
# Replies that mean the command did not do its job. The command handler sends
# these as a single line starting with the marker; article cards are multi-line,
# so a card that happens to contain "⚠️" is not mistaken for a failure.
ERROR_PREFIXES = ("⛔", "⚠️")


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


async def send_check(client: TelegramClient, bot):
    """Send /check and return the sent message (so it can be cleaned up)."""
    return await client.send_message(bot, "/check")


async def wait_for_replies(
    client: TelegramClient,
    bot,
    min_id: int,
    *,
    timeout: float,
    settle: float,
) -> tuple[list, bool]:
    """Collect the bot's replies to the /check message with id > min_id.

    Returns (messages, complete), where `messages` are Telethon Message objects
    (their ids are needed to remove them afterwards). `complete` is True once
    the summary line arrives. Without a summary the wait ends after `settle`
    seconds of silence so a slow poll is not reported as a failure.
    """
    replies: list = []
    last_id = min_id
    deadline = time.monotonic() + timeout
    quiet_since: float | None = None

    while time.monotonic() < deadline:
        messages = await client.get_messages(bot, limit=50, min_id=last_id)
        incoming = sorted((m for m in messages if not m.out), key=lambda m: m.id)
        if incoming:
            for message in incoming:
                if (message.message or "").strip():
                    replies.append(message)
                last_id = message.id
            quiet_since = time.monotonic()
            if any(
                (m.message or "").strip().startswith(SUMMARY_PREFIX) for m in replies
            ):
                return replies, True
        elif quiet_since is not None and time.monotonic() - quiet_since >= settle:
            return replies, False
        await asyncio.sleep(2)

    return replies, any(
        (m.message or "").strip().startswith(SUMMARY_PREFIX) for m in replies
    )


def is_trigger_message(message) -> bool:
    """True for the noise this script creates, never for an article card."""
    text = (message.message or "").strip()
    if message.out:
        return text == "/check"
    return text.startswith(ACK_PREFIX) or text.startswith(SUMMARY_PREFIX)


async def delete_messages(client: TelegramClient, bot, message_ids: list) -> None:
    """Delete the trigger's own messages from the chat (best effort).

    The run should leave only article cards behind: the /check it sends and the
    bot's acknowledgement and summary are noise in the DM. Either side may
    delete a message in a private chat, but revocation can still be refused, so
    fall back to deleting it for this account only. Cleanup must never fail the
    run — the check itself already succeeded by then.
    """
    ids = [int(m) for m in message_ids if m]
    if not ids:
        return

    for start in range(0, len(ids), 100):
        chunk = ids[start : start + 100]
        try:
            await client.delete_messages(bot, chunk, revoke=True)
        except Exception as exc:  # noqa: BLE001 - keep the run green
            log.debug("revoke delete refused (%s); deleting for this account only", exc)
            try:
                await client.delete_messages(bot, chunk, revoke=False)
            except Exception as exc2:  # noqa: BLE001
                log.warning("could not delete trigger messages: %s", exc2)
                return
    log.info("deleted %s trigger message(s) from the chat", len(ids))


async def cleanup_previous(client: TelegramClient, bot) -> None:
    """Remove /check + acknowledgement/summary messages left by earlier runs.

    Only those exact shapes are touched, so every article card stays.
    """
    stale: list = []
    try:
        async for message in client.iter_messages(bot, limit=200):
            if is_trigger_message(message):
                stale.append(message.id)
    except Exception as exc:  # noqa: BLE001
        log.debug("could not scan earlier messages: %s", exc)
        return
    if stale:
        await delete_messages(client, bot, stale)


def report(replies: list, bot_username: str, complete: bool) -> int:
    """Log the bot's replies and map them to a process exit code."""
    texts = [(m.message or "").strip() for m in replies]

    if not texts:
        log.error(
            "no reply from @%s within the timeout. The bot received /check but "
            "did not process it: its webhook is probably not pointed at the "
            "Telegram Serverless project. Check with `npx tgcloud webhook` and "
            "re-deploy with ./deploy.sh.",
            bot_username,
        )
        return 2

    for text in texts:
        log.info("bot reply: %s", " / ".join(text.splitlines()))

    failures = [
        t for t in texts if "\n" not in t and t.startswith(ERROR_PREFIXES)
    ]
    if failures:
        log.error("the bot reported a failure: %s", " / ".join(failures[0].splitlines()))
        return 1

    if not complete:
        # Acknowledged but never finished: the Serverless invocation was killed
        # (or the Worker errored silently) before it could persist the poll.
        log.error(
            "@%s acknowledged /check but never reported a completed check. The "
            "poll did not finish — cards may have been sent without being "
            "recorded, and the next poll can send them again.",
            bot_username,
        )
        return 1

    return 0


async def run_once(
    client: TelegramClient,
    bot_username: str,
    *,
    wait: bool,
    timeout: float,
    settle: float,
    keep_messages: bool = False,
) -> int:
    bot = await get_bot(client, bot_username)

    # Earlier runs may have left /check and summary messages behind; clear them
    # so the chat only shows article cards.
    if not keep_messages:
        await cleanup_previous(client, bot)

    # Baseline: ignore anything the bot sent earlier, so only this run's
    # replies are reported.
    baseline = await client.get_messages(bot, limit=1)
    min_id = baseline[0].id if baseline else 0

    sent = await send_check(client, bot)
    log.info("sent /check to @%s", bot_username)

    replies: list = []
    code = 0
    if wait:
        replies, complete = await wait_for_replies(
            client, bot, min_id, timeout=timeout, settle=settle
        )
        code = report(replies, bot_username, complete)

    # Report first (the workflow log keeps the summary), then tidy the chat.
    # Only the trigger's own messages are removed: when the bot posts to the
    # same chat the trigger talks to, the replies include the article cards, and
    # those must never be deleted.
    if not keep_messages:
        noise = [sent.id, *(m.id for m in replies if is_trigger_message(m))]
        await delete_messages(client, bot, noise)

    return code


async def run_loop(
    client: TelegramClient,
    bot_username: str,
    interval: int,
    *,
    timeout: float,
    settle: float,
    max_runtime: float,
) -> None:
    """Poll every `interval` seconds, verifying each poll like `--once`.

    GitHub's scheduled workflows are best effort and are sometimes delayed for
    hours, so CI runs this loop instead of relying on a job every 15 minutes:
    one invocation covers a long stretch, and the workflow restarts it.
    `max_runtime` stops before GitHub's 6-hour job limit so Telethon can
    disconnect cleanly and the next run can take over.
    """
    started = time.monotonic()
    while True:
        remaining_before = max_runtime - (time.monotonic() - started)
        # Do not start a poll that could outlive the runtime budget: waiting for
        # the reply can take minutes, and GitHub kills the job at 6 hours.
        if max_runtime > 0 and remaining_before < 10 * 60:
            log.info("reached max runtime (%ss); stopping", int(max_runtime))
            return

        iteration_started = time.monotonic()
        try:
            code = await run_once(
                client,
                bot_username,
                wait=True,
                timeout=timeout,
                settle=settle,
                keep_messages=False,
            )
            if code:
                log.warning("the check finished with exit code %s", code)
        except Exception as exc:  # noqa: BLE001 - keep the scheduler alive
            log.warning("check failed: %s", exc)

        # Keep a stable cadence: sleep out the rest of the interval, minus the
        # time the poll itself took. Jitter avoids a fixed beat.
        elapsed = time.monotonic() - iteration_started
        delay = max(60.0, interval - elapsed + random.randint(-30, 30))
        if max_runtime > 0:
            remaining = max_runtime - (time.monotonic() - started)
            delay = min(delay, max(0.0, remaining))
        log.info("next check in %s seconds", int(delay))
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
    parser.add_argument(
        "--keep-messages",
        action="store_true",
        help="leave /check and the bot's replies in the chat (debugging)",
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
    max_runtime = float(env("MAX_RUNTIME_SECONDS", "0") or "0")

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
                client,
                bot,
                wait=wait,
                timeout=timeout,
                settle=settle,
                keep_messages=args.keep_messages,
            )
        else:
            await run_loop(
                client,
                bot,
                interval,
                timeout=timeout,
                settle=settle,
                max_runtime=max_runtime,
            )
    finally:
        await client.disconnect()
    return code


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        log.info("stopped")
