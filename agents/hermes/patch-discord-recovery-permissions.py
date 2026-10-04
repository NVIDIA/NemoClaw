#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch the pinned Hermes Discord recovery ledger to remain group-writable.

Hermes v2026.8.27 / 0.20.6 creates the Discord recovery database as the
``gateway`` user and then forces mode 0600. NemoClaw snapshot and restore
commands run as the ``sandbox`` user, so that mode prevents online backup and
prevents the gateway from reopening a sandbox-restored database.

The image owns a narrow cross-identity contract instead: the ``gateway``
directory is gateway:sandbox 2770 and the ledger is 0660. This patch fails
closed unless the pinned upstream filename, parent directory, and chmod source
shape are all still exact. Remove it when upstream provides an equivalent
group-writable or separately configurable recovery-ledger mode.
"""

from __future__ import annotations

import argparse
from pathlib import Path

DB_FILENAME_SHAPE = '_DB_FILENAME = "discord_message_recovery.db"'
DIRECTORY_SHAPE = 'directory = self._hermes_home / "gateway"'
OLD_CHMOD = "os.chmod(path, 0o600)"
NEW_CHMOD = "os.chmod(path, 0o660)"


def _require_exact(source: str, shape: str, description: str) -> None:
    count = source.count(shape)
    if count != 1:
        raise SystemExit(
            "ERROR: Hermes Discord recovery source shape changed; "
            f"expected one {description}, found {count}"
        )


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    _require_exact(source, DB_FILENAME_SHAPE, "recovery database filename")
    _require_exact(source, DIRECTORY_SHAPE, "gateway directory assignment")

    old_count = source.count(OLD_CHMOD)
    new_count = source.count(NEW_CHMOD)
    if old_count != 1 or new_count != 0:
        raise SystemExit(
            "ERROR: Hermes Discord recovery chmod shape changed; "
            f"expected one unpatched 0600 chmod, found {old_count}; "
            f"prepatched 0660 chmods: {new_count}"
        )

    path.write_text(source.replace(OLD_CHMOD, NEW_CHMOD), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/plugins/platforms/discord/recovery.py",
        help="Hermes Discord recovery module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
