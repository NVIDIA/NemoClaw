#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch SessionDB for SQLite temp storage and NemoClaw's shared state ledger.

Source-of-truth note for this localized Hermes runtime patch:
  - Invalid state: Hermes v0.19.0 SessionDB does not set PRAGMA temp_store=MEMORY,
    so SQLite falls back to file-based temp storage when processing FK constraints
    (for example, the ON DELETE CASCADE on session_model_usage -> sessions). When
    `hermes sessions delete` is invoked through OpenShell sandbox execution —
    the code path used by `nemohermes <sandbox> sessions delete <id>` — the
    process runs in a restricted environment where SQLite's temp-file creation
    syscalls fail with
    SQLITE_CANTOPEN, causing every `DELETE FROM sessions` with FK enforcement
    enabled to raise `sqlite3.OperationalError: unable to open database file`
    (#8301). The same command succeeds through Docker execution because that
    context allows the file-based temp store.
  - A second invalid state exists in NemoClaw's root-separated runtime: SQLite
    creates state.db and its WAL/SHM sidecars as 0640 even under umask 0007.
    The gateway owns those files, so the sandbox-group CLI cannot persist a chat
    session. Only the fixed `.hermes/state.db -> runtime/state.db` layout is
    normalized to gateway/sandbox-shared mode 0660; other Hermes homes and files
    keep upstream permissions.
  - Value being patched: pinned/prebuilt `/opt/hermes/hermes_state.py`
    `SessionDB.__init__` connection setup. The patch inserts one descriptor-safe
    fixed-layout normalizer before SQLite opens an existing database and again
    after schema initialization has created its WAL sidecars. It also inserts
    `PRAGMA temp_store=MEMORY` before `PRAGMA foreign_keys=ON`.
  - Source-fix constraint: NemoClaw layers a sandbox image on top of the
    published Hermes runtime; the source fix belongs upstream in Hermes, not in
    NemoClaw's TypeScript or wrapper code.
  - Regression evidence: on first application, this patcher accepts exactly one
    unpatched connection setup block and no temp-store statement. A later
    application accepts exactly one complete patched block with one temp-store
    statement. Every other source shape fails without writing. The Dockerfile
    checks for the inserted PRAGMA after patching. The image-build
    `session-delete` behavior test covers the temp store. The image's
    `session-state-create` and `session-state-reopen` probes execute the patched
    SessionDB as gateway then sandbox and require exact state.db metadata plus a
    persisted cross-identity append. They require exact WAL/SHM metadata when
    SQLite retains WAL mode and require those sidecars absent when Hermes'
    `apply_wal_with_fallback` selects DELETE mode on a WAL-incompatible filesystem.
  - Removal condition: delete this patch when the pinned Hermes runtime natively
    sets `PRAGMA temp_store=MEMORY` (or equivalent) in `SessionDB.__init__`.
"""

from __future__ import annotations

import argparse
from pathlib import Path

IMPORTS_OLD = """import logging
import random
import re
import sqlite3
import sys"""
IMPORTS_NEW = """import logging
import os
import random
import re
import sqlite3
import stat
import sys"""
HELPER_ANCHOR_OLD = """DEFAULT_DB_PATH = get_hermes_home() / "state.db"

SCHEMA_VERSION = 22"""
HELPER = '''_NEMOCLAW_SHARED_STATE_LINK = Path("/sandbox/.hermes/state.db")
_NEMOCLAW_SHARED_STATE_DIRECTORY = Path("/sandbox/.hermes/runtime")
_NEMOCLAW_SHARED_STATE_NAMES = ("state.db", "state.db-wal", "state.db-shm")


def _nemoclaw_normalize_shared_state_permissions(db_path: Path) -> None:
    """Keep only NemoClaw's fixed cross-UID session ledger group-writable."""
    if Path(db_path) != _NEMOCLAW_SHARED_STATE_LINK:
        return
    link_metadata = os.lstat(_NEMOCLAW_SHARED_STATE_LINK)
    if (
        not stat.S_ISLNK(link_metadata.st_mode)
        or os.readlink(_NEMOCLAW_SHARED_STATE_LINK) != "runtime/state.db"
    ):
        raise PermissionError("NemoClaw shared state link is unsafe")
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise PermissionError("NemoClaw shared state descriptor flags are unavailable")

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory_flags |= getattr(os, "O_CLOEXEC", 0)
    directory_fd = os.open(_NEMOCLAW_SHARED_STATE_DIRECTORY, directory_flags)
    try:
        directory_metadata = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(directory_metadata.st_mode)
            or stat.S_IMODE(directory_metadata.st_mode) != 0o2770
        ):
            raise PermissionError("NemoClaw shared state directory is unsafe")

        file_flags = os.O_RDONLY | os.O_NOFOLLOW
        file_flags |= getattr(os, "O_CLOEXEC", 0)
        file_flags |= getattr(os, "O_NONBLOCK", 0)
        for index, name in enumerate(_NEMOCLAW_SHARED_STATE_NAMES):
            try:
                descriptor = os.open(name, file_flags, dir_fd=directory_fd)
            except FileNotFoundError:
                if index == 0:
                    for sidecar in _NEMOCLAW_SHARED_STATE_NAMES[1:]:
                        try:
                            os.stat(sidecar, dir_fd=directory_fd, follow_symlinks=False)
                        except FileNotFoundError:
                            continue
                        raise PermissionError(
                            "NemoClaw shared state sidecar exists without state.db"
                        )
                    return
                continue
            try:
                before = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(before.st_mode)
                    or before.st_nlink != 1
                    or before.st_gid != directory_metadata.st_gid
                ):
                    raise PermissionError(f"NemoClaw shared state file is unsafe: {name}")
                if before.st_uid == os.geteuid():
                    os.fchmod(descriptor, 0o660)
                elif stat.S_IMODE(before.st_mode) != 0o660:
                    raise PermissionError(
                        f"NemoClaw shared state file is not group-writable: {name}"
                    )
                after = os.fstat(descriptor)
                current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if (
                    not stat.S_ISREG(after.st_mode)
                    or after.st_nlink != 1
                    or after.st_dev != before.st_dev
                    or after.st_ino != before.st_ino
                    or after.st_gid != directory_metadata.st_gid
                    or stat.S_IMODE(after.st_mode) != 0o660
                    or current.st_dev != after.st_dev
                    or current.st_ino != after.st_ino
                    or current.st_mode != after.st_mode
                    or current.st_uid != after.st_uid
                    or current.st_gid != after.st_gid
                ):
                    raise PermissionError(
                        f"NemoClaw shared state file changed during normalization: {name}"
                    )
            finally:
                os.close(descriptor)
    finally:
        os.close(directory_fd)'''
HELPER_ANCHOR_NEW = f'''DEFAULT_DB_PATH = get_hermes_home() / "state.db"

{HELPER}

SCHEMA_VERSION = 22'''
CONNECT_ANCHOR_OLD = """            def _connect_and_init():
                self._conn = sqlite3.connect("""
CONNECT_ANCHOR_NEW = """            def _connect_and_init():
                _nemoclaw_normalize_shared_state_permissions(self.db_path)
                self._conn = sqlite3.connect("""
INIT_ANCHOR_OLD = """                self._init_schema()"""
INIT_ANCHOR_NEW = """                self._init_schema()
                _nemoclaw_normalize_shared_state_permissions(self.db_path)"""
CONNECTION_OLD = (
    'apply_wal_with_fallback(self._conn, db_label="state.db")\n'
    '                self._conn.execute("PRAGMA foreign_keys=ON")'
)
CONNECTION_TEMP_ONLY = (
    'apply_wal_with_fallback(self._conn, db_label="state.db")\n'
    '                self._conn.execute("PRAGMA temp_store=MEMORY")\n'
    '                self._conn.execute("PRAGMA foreign_keys=ON")'
)
EXPECTED_OCCURRENCES = 1


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    old_count = source.count(CONNECTION_OLD)
    temp_only_count = source.count(CONNECTION_TEMP_ONLY)
    temp_statement_count = source.count('self._conn.execute("PRAGMA temp_store=MEMORY")')
    helper_count = source.count("def _nemoclaw_normalize_shared_state_permissions(")
    call_count = source.count("_nemoclaw_normalize_shared_state_permissions(self.db_path)")
    if (
        old_count == 0
        and temp_only_count == EXPECTED_OCCURRENCES
        and temp_statement_count == EXPECTED_OCCURRENCES
        and helper_count == EXPECTED_OCCURRENCES
        and call_count == 2
        and source.count(IMPORTS_NEW) == EXPECTED_OCCURRENCES
        and source.count(HELPER_ANCHOR_NEW) == EXPECTED_OCCURRENCES
        and source.count(CONNECT_ANCHOR_NEW) == EXPECTED_OCCURRENCES
        and source.count(INIT_ANCHOR_NEW) == EXPECTED_OCCURRENCES
    ):
        return
    if (
        old_count + temp_only_count != EXPECTED_OCCURRENCES
        or temp_statement_count != temp_only_count
        or helper_count != 0
        or call_count != 0
        or source.count(IMPORTS_OLD) != EXPECTED_OCCURRENCES
        or source.count(IMPORTS_NEW) != 0
        or source.count(HELPER_ANCHOR_OLD) != EXPECTED_OCCURRENCES
        or source.count(CONNECT_ANCHOR_OLD) != EXPECTED_OCCURRENCES
        or source.count(CONNECT_ANCHOR_NEW) != 0
        or source.count(INIT_ANCHOR_OLD) != EXPECTED_OCCURRENCES
        or source.count(INIT_ANCHOR_NEW) != 0
    ):
        raise SystemExit(
            "ERROR: Hermes SessionDB.__init__ connection setup shape changed; "
            "expected one unpatched or legacy temp-store block with no shared-state "
            f"helper; found {old_count} unpatched blocks, {temp_only_count} legacy "
            f"temp-store blocks, {temp_statement_count} temp-store statements, "
            f"{helper_count} helpers, and {call_count} helper calls"
        )
    connection = CONNECTION_OLD if old_count == EXPECTED_OCCURRENCES else CONNECTION_TEMP_ONLY
    patched = source.replace(IMPORTS_OLD, IMPORTS_NEW)
    patched = patched.replace(HELPER_ANCHOR_OLD, HELPER_ANCHOR_NEW)
    patched = patched.replace(CONNECT_ANCHOR_OLD, CONNECT_ANCHOR_NEW)
    patched = patched.replace(INIT_ANCHOR_OLD, INIT_ANCHOR_NEW)
    patched = patched.replace(connection, CONNECTION_TEMP_ONLY)
    path.write_text(patched, encoding="utf-8")


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
