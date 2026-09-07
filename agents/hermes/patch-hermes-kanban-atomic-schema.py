#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Make Hermes' initial Kanban schema creation one atomic transaction.

Hermes v0.20.6 opens Kanban connections in autocommit mode and passes a schema
script without transaction statements to ``sqlite3.Connection.executescript``.
When Hermes rejects its linked SQLite version for WAL use, every CREATE in the
script becomes a separate synchronous DELETE-journal transaction. Slow
container overlay storage can therefore keep the gateway from listening for
minutes while it creates a fresh board.

The patch brackets only the idempotent base schema script with BEGIN IMMEDIATE
and COMMIT. Additive legacy migrations keep their existing transaction policy.
Besides reducing the fresh-board fsync count, an interrupted base-schema setup
now rolls back instead of leaving a partial schema.

Remove this patch when the pinned Hermes release creates ``SCHEMA_SQL`` in one
explicit transaction or provides an equivalent bounded fresh-board path.
"""

from __future__ import annotations

import argparse
from pathlib import Path

SCHEMA_OPEN_OLD = '''SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tasks ('''
SCHEMA_OPEN_NEW = '''SCHEMA_SQL = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS tasks ('''
SCHEMA_CLOSE_OLD = '''CREATE INDEX IF NOT EXISTS idx_notify_task           ON kanban_notify_subs(task_id);
"""'''
SCHEMA_CLOSE_NEW = '''CREATE INDEX IF NOT EXISTS idx_notify_task           ON kanban_notify_subs(task_id);
COMMIT;
"""'''


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    old_open_count = source.count(SCHEMA_OPEN_OLD)
    old_close_count = source.count(SCHEMA_CLOSE_OLD)
    new_open_count = source.count(SCHEMA_OPEN_NEW)
    new_close_count = source.count(SCHEMA_CLOSE_NEW)

    if (
        old_open_count == 0
        and old_close_count == 0
        and new_open_count == 1
        and new_close_count == 1
    ):
        return
    if (
        old_open_count != 1
        or old_close_count != 1
        or new_open_count != 0
        or new_close_count != 0
    ):
        raise SystemExit(
            "ERROR: Hermes Kanban SCHEMA_SQL shape changed; expected exactly one "
            "unpatched or patched schema boundary; found "
            f"old-open={old_open_count}, old-close={old_close_count}, "
            f"new-open={new_open_count}, new-close={new_close_count}"
        )

    patched = source.replace(SCHEMA_OPEN_OLD, SCHEMA_OPEN_NEW, 1)
    patched = patched.replace(SCHEMA_CLOSE_OLD, SCHEMA_CLOSE_NEW, 1)
    path.write_text(patched, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/hermes_cli/kanban_db.py",
        help="Hermes Kanban database module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
