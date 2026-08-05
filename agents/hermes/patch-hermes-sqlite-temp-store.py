#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch SessionDB.__init__ to use in-memory temp store for SQLite FK processing.

Source-of-truth note for this localized Hermes runtime patch:
  - Invalid state: Hermes v0.19.0 SessionDB does not set PRAGMA temp_store=MEMORY,
    so SQLite falls back to file-based temp storage when processing FK constraints
    (e.g. the ON DELETE CASCADE on session_model_usage -> sessions). When
    `hermes sessions delete` is invoked via openshell exec — the code path used by
    `nemohermes <sb> sessions delete <id>` — the process runs in a restricted
    environment where SQLite's temp-file creation syscalls fail with
    SQLITE_CANTOPEN, causing every `DELETE FROM sessions` with FK enforcement
    enabled to raise `sqlite3.OperationalError: unable to open database file`
    (#8301). The same command succeeds when run via `docker exec` because that
    context allows the file-based temp store.
  - Value being patched: pinned/prebuilt `/opt/hermes/hermes_state.py`
    `SessionDB.__init__` connection setup block; specifically, the statement
    immediately following `apply_wal_with_fallback()` that enables FK enforcement.
    `PRAGMA temp_store=MEMORY` is inserted before `PRAGMA foreign_keys=ON` so the
    in-memory store is active before any FK-constrained write.
  - Source-fix constraint: NemoClaw layers a sandbox image on top of the
    published Hermes runtime; the source fix belongs upstream in Hermes, not in
    NemoClaw's TypeScript or wrapper code.
  - Regression proof: this patcher verifies the un-patched pattern exists exactly
    once (fails closed on source drift); the Dockerfile greps for the inserted
    PRAGMA after patching; the image-build `session-delete` probe creates a
    SessionDB, inserts a session with messages, and calls `delete_session()` to
    confirm no OperationalError is raised.
  - Removal condition: delete this patch when the pinned Hermes runtime natively
    sets `PRAGMA temp_store=MEMORY` (or equivalent) in `SessionDB.__init__`.
"""

from __future__ import annotations

import argparse
from pathlib import Path

OLD = (
    'apply_wal_with_fallback(self._conn, db_label="state.db")\n'
    '                self._conn.execute("PRAGMA foreign_keys=ON")'
)
NEW = (
    'apply_wal_with_fallback(self._conn, db_label="state.db")\n'
    '                self._conn.execute("PRAGMA temp_store=MEMORY")\n'
    '                self._conn.execute("PRAGMA foreign_keys=ON")'
)
EXPECTED_OCCURRENCES = 1


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    old_count = source.count(OLD)
    new_count = source.count('self._conn.execute("PRAGMA temp_store=MEMORY")')
    if old_count == 0 and new_count >= EXPECTED_OCCURRENCES:
        return
    if old_count != EXPECTED_OCCURRENCES:
        raise SystemExit(
            "ERROR: Hermes SessionDB.__init__ connection setup shape changed; "
            f"expected {EXPECTED_OCCURRENCES} unpatched occurrences, found {old_count} "
            f"(already patched occurrences: {new_count})"
        )
    path.write_text(source.replace(OLD, NEW), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/hermes_state.py",
        help="Hermes state module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
