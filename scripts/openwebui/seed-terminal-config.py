# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Seed the Open Terminal (OpenWebUI) connection and prune bad per-user entries.

Why this script exists
----------------------
OpenWebUI shows terminals in a dropdown with **two independent sections**, fed
by two different stores:

* **System** -> ``$terminalServers`` entries that carry an ``id``. Populated in
  ``(app)/+layout.svelte`` from the *admin* list
  (``config.terminal_server.connections``) via ``GET /api/v1/terminals/``, and
  rewritten to a same-origin proxy URL: ``{WEBUI_API_BASE_URL}/terminals/{id}``.
  Selecting one sets ``$selectedTerminalId`` to the **id**.

* **Direct** -> the *per-user* list, ``user.settings.ui.terminalServers``.
  Selecting one sets ``$selectedTerminalId`` to the **url**.

Only the admin list is needed. Seeding the per-user list as well is actively
harmful, because ``+layout.svelte`` *also* probes every enabled per-user entry
**from the browser** (``GET {url}{path}``, default ``/openapi.json``). Our relay
URL is a Docker-internal name (``http://browser-vm-relay:8787``) that resolves
only inside the compose network, so that probe always fails and raises a toast
on every page load::

    Failed to connect to http://browser-vm-relay:8787 terminal server

and it adds a second, identical "Browser VM (fresh)" row to the menu, because
the same connection is then listed under both Direct and System.

So: seed the admin connection, and actively **remove** per-user entries that
point at the relay. Idempotent, and safe to re-run.

Usage
-----
    python3 scripts/openwebui/seed-terminal-config.py            # dry run
    python3 scripts/openwebui/seed-terminal-config.py --apply    # write

Reads the DB from ``$WEBUI_DB`` or ``~/.nemoclaw/openwebui/data/webui.db`` and
the shared key from ``$BROWSER_VM_RELAY_KEY`` or ``scripts/openwebui/.env``.
Backs the database up before writing. Never prints the key.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path

SERVER_ID = "webvm"
SERVER_NAME = "Browser VM (fresh)"
RELAY_URL = "http://browser-vm-relay:8787"

DEFAULT_DB = Path.home() / ".nemoclaw" / "openwebui" / "data" / "webui.db"
# This script lives in scripts/openwebui/, next to the compose file and .env.
DEFAULT_ENV = Path(__file__).resolve().parent / ".env"


def load_relay_key() -> str:
    key = os.environ.get("BROWSER_VM_RELAY_KEY", "").strip()
    if key:
        return key
    if DEFAULT_ENV.exists():
        m = re.search(
            r"^BROWSER_VM_RELAY_KEY=(.*)$", DEFAULT_ENV.read_text(encoding="utf-8"), re.M
        )
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return ""


def backup(db: Path) -> Path:
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    dest = db.with_name(f"{db.name}.bak-seed-terminal-{stamp}")
    shutil.copy2(db, dest)
    return dest


def desired_connection(key: str) -> dict:
    """The admin-side connection, merged over whatever is already stored."""
    return {
        "id": SERVER_ID,
        "name": SERVER_NAME,
        "enabled": True,
        # orchestrator + the chat context mapping are what make OWUI send
        # X-Session-Id = chat_id, which is how the relay resolves which
        # browser pod a native terminal session belongs to.
        "server_type": "orchestrator",
        "url": RELAY_URL,
        "path": "/openapi.json",
        "auth_type": "bearer",
        "key": key,
        "forward_cookies": False,
        "config": {
            "contexts": {"chat": {"context_id": "chat_id"}},
            # chat_uploads is intentionally omitted: OpenWebUI's admin UI strips
            # it and terminal_chat_uploads() already defaults to "default", so
            # writing it here would just churn the row on every run.
            #
            # Public read: every signed-in operator can attach the terminal.
            # Without this, non-admin users see nothing at all.
            "access_grants": [
                {"permission": "read", "principal_type": "user", "principal_id": "*"}
            ],
        },
    }


def is_relay_entry(x: object) -> bool:
    """True for a per-user entry that points at our relay.

    Matched on the docker-internal host so entries created by any version of
    this script (or by hand in the admin UI) get cleaned up, not just the ones
    this script happens to write today.
    """
    if not isinstance(x, dict):
        return False
    if x.get("id") == SERVER_ID:
        return True
    url = str(x.get("url") or "")
    return "browser-vm-relay" in url


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--db", default=os.environ.get("WEBUI_DB", str(DEFAULT_DB)))
    args = ap.parse_args()

    db = Path(args.db).expanduser()
    if not db.exists():
        print(f"error: database not found: {db}", file=sys.stderr)
        return 1

    key = load_relay_key()
    if not key:
        print(
            "error: BROWSER_VM_RELAY_KEY not found in env or .env — the terminal\n"
            "       connection cannot authenticate. Refusing to seed an empty key.",
            file=sys.stderr,
        )
        return 1

    con = sqlite3.connect(db)
    cur = con.cursor()
    changes: list[str] = []

    # ── 1. admin connection list ────────────────────────────────────────
    row = cur.execute(
        "SELECT value FROM config WHERE key = 'terminal_server.connections'"
    ).fetchone()
    existing = json.loads(row[0]) if row and row[0] else []
    if not isinstance(existing, list):
        existing = []

    target = desired_connection(key)
    match = next((c for c in existing if isinstance(c, dict) and c.get("id") == SERVER_ID), None)
    if match is None:
        existing.append(target)
        changes.append(f"config: added connection {SERVER_ID!r}")
    else:
        merged = dict(match)
        for k, v in target.items():
            if merged.get(k) != v:
                changes.append(f"config: {SERVER_ID!r}.{k} updated")
                merged[k] = v
        if merged != match:
            existing[existing.index(match)] = merged
    cur.execute(
        "INSERT INTO config (\"key\", value, updated_at) VALUES (?,?,?) "
        "ON CONFLICT(\"key\") DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        ("terminal_server.connections", json.dumps(existing), int(time.time())),
    )

    # ── 2. per-user ui.terminalServers: prune, do not seed ───────────────
    # Any per-user entry pointing at the relay makes the browser probe a
    # Docker-internal URL it cannot resolve, which toasts on every page load
    # and duplicates the row in the terminal menu. Remove them.
    users = cur.execute("SELECT id, email, role, settings FROM user").fetchall()
    for uid, email, role, settings in users:
        s = json.loads(settings) if settings else {}
        if not isinstance(s, dict):
            s = {}
        ui = s.get("ui")
        if not isinstance(ui, dict):
            continue
        entries = ui.get("terminalServers")
        if not isinstance(entries, list):
            continue
        kept = [x for x in entries if not is_relay_entry(x)]
        if len(kept) == len(entries):
            print(f"  user {email} ({role}): no relay entry in ui.terminalServers")
            continue
        if kept:
            ui["terminalServers"] = kept
        else:
            # Leave no empty list behind: an empty array is indistinguishable
            # from "never configured" in the settings diff the SPA sends back.
            ui.pop("terminalServers", None)
        s["ui"] = ui
        cur.execute("UPDATE user SET settings = ? WHERE id = ?", (json.dumps(s), uid))
        changes.append(
            f"user {email} ({role}): removed {len(entries) - len(kept)} relay "
            f"entry/entries from ui.terminalServers"
        )

    if not changes:
        print("nothing to do — configuration already matches the desired state")
        con.close()
        return 0

    print("\nchanges:")
    for c in changes:
        print(f"  - {c}")

    if not args.apply:
        con.rollback()
        con.close()
        print("\ndry run (no writes). Re-run with --apply to apply.")
        return 0

    b = backup(db)
    con.commit()
    con.close()
    print(f"\napplied. backup: {b}")
    print("note: users must reload the page (or re-open the chat) to pick this up.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
