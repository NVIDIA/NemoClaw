#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch Hermes shared state permissions for NemoClaw's split runtime identity.

Source-of-truth note for this localized Hermes runtime patch:
  - Invalid state: in NemoClaw's root-separated runtime, SQLite
    creates state.db and its WAL/SHM sidecars as 0640 even under umask 0007.
    The gateway owns those files, so the sandbox-group CLI cannot persist a chat
    session. Only the fixed `.hermes/state.db -> runtime/state.db` layout is
    normalized to gateway/sandbox-shared mode 0660; other Hermes homes and files
    keep upstream permissions.
  - Value being patched: pinned/prebuilt `/opt/hermes/hermes_state.py` writer
    connection setup. The patch inserts one descriptor-safe fixed-layout
    normalizer after each native `_secure_state_db_files` call. Hermes v0.21.3
    natively owns `database.temp_store`; NemoClaw sets that managed configuration
    to `2` (memory) instead of patching a PRAGMA into the source.
  - Source-fix constraint: NemoClaw layers a sandbox image on top of the
    published Hermes runtime; the source fix belongs upstream in Hermes, not in
    NemoClaw's TypeScript or wrapper code.
  - Regression evidence: on first application, this patcher accepts exactly two
    native hardening call sites with no shared-state helper. A later application
    accepts exactly one complete helper and two normalizer calls. Every other
    source shape fails without writing. The image-build
    `session-delete` behavior test covers the temp store. The image's
    `session-state-create` and `session-state-reopen` probes execute the patched
    SessionDB as gateway then sandbox and require exact state.db metadata plus a
    persisted cross-identity append. They require exact WAL/SHM metadata when
    SQLite retains WAL mode and require those sidecars absent when Hermes'
    selected journal mode is DELETE on a WAL-incompatible filesystem.
  - Removal condition: delete this patch when the pinned Hermes runtime natively
    supports a group-shared state database across separate runtime identities.
"""

from __future__ import annotations

import argparse
from pathlib import Path

HELPER_ANCHOR_OLD = """DEFAULT_DB_PATH = _IMPORT_DEFAULT_DB_PATH = get_hermes_home() / "state.db"

# Back off from read-only opens"""
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
HELPER_ANCHOR_NEW = f'''DEFAULT_DB_PATH = _IMPORT_DEFAULT_DB_PATH = get_hermes_home() / "state.db"

{HELPER}

# Back off from read-only opens'''
OPEN_ANCHOR_OLD = """            _secure_state_db_files(self.db_path)
            apply_database_pragmas(conn, db_label="state.db")"""
OPEN_ANCHOR_NEW = """            _secure_state_db_files(self.db_path)
            _nemoclaw_normalize_shared_state_permissions(self.db_path)
            apply_database_pragmas(conn, db_label="state.db")"""
INIT_ANCHOR_OLD = """        _secure_state_db_files(self.db_path, create_main=True)
        self._conn = self._open_writer_conn()"""
INIT_ANCHOR_NEW = """        _secure_state_db_files(self.db_path, create_main=True)
        _nemoclaw_normalize_shared_state_permissions(self.db_path)
        self._conn = self._open_writer_conn()"""


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    helper_count = source.count("def _nemoclaw_normalize_shared_state_permissions(")
    call_count = source.count("_nemoclaw_normalize_shared_state_permissions(self.db_path)")
    if (
        helper_count == 1
        and call_count == 2
        and source.count(HELPER_ANCHOR_NEW) == 1
        and source.count(OPEN_ANCHOR_NEW) == 1
        and source.count(INIT_ANCHOR_NEW) == 1
        and source.count("_secure_state_db_files(self.db_path)") == 1
        and source.count("_secure_state_db_files(self.db_path, create_main=True)") == 1
    ):
        return
    if (
        helper_count != 0
        or call_count != 0
        or source.count(HELPER_ANCHOR_OLD) != 1
        or source.count(OPEN_ANCHOR_OLD) != 1
        or source.count(OPEN_ANCHOR_NEW) != 0
        or source.count(INIT_ANCHOR_OLD) != 1
        or source.count(INIT_ANCHOR_NEW) != 0
        or source.count("_secure_state_db_files(self.db_path)") != 1
        or source.count("_secure_state_db_files(self.db_path, create_main=True)") != 1
    ):
        raise SystemExit(
            "ERROR: Hermes shared state hardening shape changed; expected two "
            f"unpatched native hardening sites; found {helper_count} helpers and "
            f"{call_count} helper calls"
        )
    patched = source.replace(HELPER_ANCHOR_OLD, HELPER_ANCHOR_NEW)
    patched = patched.replace(OPEN_ANCHOR_OLD, OPEN_ANCHOR_NEW)
    patched = patched.replace(INIT_ANCHOR_OLD, INIT_ANCHOR_NEW)
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
