#!/usr/bin/env python3
"""Convert the local Telethon SQLite session into a StringSession.

GitHub Actions cannot read a local session file, so the workflow uses the
`TG_SESSION_STRING` repository secret instead. Run this after `login.py`, copy
the printed value into GitHub → Settings → Secrets and variables → Actions, and
do not paste it anywhere else.

    python export_session.py
"""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

from dotenv import load_dotenv
from telethon.crypto import AuthKey
from telethon.sessions import StringSession

DEFAULT_SESSION = os.path.join(os.path.dirname(__file__), "rss_trigger")


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def main() -> int:
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
    session = env("TG_SESSION", DEFAULT_SESSION) or DEFAULT_SESSION
    path = f"{session}.session" if not session.endswith(".session") else session

    if not Path(path).exists():
        print(f"Session file not found: {path}. Run login.py first.", file=sys.stderr)
        return 1

    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        row = con.execute(
            "select dc_id, server_address, port, auth_key from sessions limit 1"
        ).fetchone()
    finally:
        con.close()

    if not row:
        print("Session file has no auth key. Run login.py again.", file=sys.stderr)
        return 1

    dc_id, server, port, auth_key = row
    string = StringSession()
    string.set_dc(dc_id, server, port)
    string.auth_key = AuthKey(auth_key)

    print("Add this value as TG_SESSION_STRING in GitHub Actions secrets:")
    print()
    print(string.save())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
