#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Relocate the pinned Hermes cron execution ledger into writable runtime state.

Hermes v2026.8.27 / 0.20.6 creates ``cron/executions.db`` from the gateway.
NemoClaw keeps ``cron`` separate from the writable execution ledger because it is a high-risk
location for cron job definitions, so a managed gateway restart cannot reopen
that database.

NemoClaw already provisions ``HERMES_HOME/runtime`` as the descriptor-verified
cross-identity lifecycle boundary. Patch the execution ledger and Hermes quick
snapshot inventory together so only the mutable audit database moves while
cron job definitions remain sealed. The exact source-shape checks fail closed
when the pinned Hermes implementation changes.

Remove this patch when the minimum supported Hermes release separates mutable
cron execution history from cron job definitions.
"""

from __future__ import annotations

import argparse
from pathlib import Path

OLD_EXECUTIONS_PATH = (
    '    path = EXECUTIONS_FILE or (get_hermes_home().resolve() / "cron" / "executions.db")'
)
NEW_EXECUTIONS_PATH = (
    '    path = EXECUTIONS_FILE or (get_hermes_home().resolve() / "runtime" / "cron-executions.db")'
)
EXECUTIONS_CONTEXT = "from hermes_constants import get_hermes_home"

OLD_BACKUP_PATH = '    "cron/executions.db",'
NEW_BACKUP_PATH = '    "runtime/cron-executions.db",'
BACKUP_CONTEXT = "_QUICK_STATE_FILES = ("


def _require_exact(source: str, shape: str, description: str) -> None:
    count = source.count(shape)
    if count != 1:
        raise SystemExit(
            "ERROR: Hermes cron execution runtime source shape changed; "
            f"expected one {description}, found {count}"
        )


def _state(source: str, old: str, new: str, description: str) -> str:
    old_count = source.count(old)
    new_count = source.count(new)
    if old_count == 1 and new_count == 0:
        return "unpatched"
    if old_count == 0 and new_count == 1:
        return "patched"
    raise SystemExit(
        "ERROR: Hermes cron execution runtime source shape changed; "
        f"{description} has {old_count} unpatched and {new_count} patched occurrences"
    )


def patch_files(executions_path: Path, backup_path: Path) -> None:
    executions_source = executions_path.read_text(encoding="utf-8")
    backup_source = backup_path.read_text(encoding="utf-8")

    _require_exact(executions_source, EXECUTIONS_CONTEXT, "Hermes home import")
    _require_exact(backup_source, BACKUP_CONTEXT, "quick snapshot inventory")
    executions_state = _state(
        executions_source,
        OLD_EXECUTIONS_PATH,
        NEW_EXECUTIONS_PATH,
        "execution ledger path",
    )
    backup_state = _state(
        backup_source,
        OLD_BACKUP_PATH,
        NEW_BACKUP_PATH,
        "quick snapshot path",
    )
    if executions_state != backup_state:
        raise SystemExit(
            "ERROR: Hermes cron execution runtime patch is only partially applied"
        )
    if executions_state == "patched":
        return

    executions_path.write_text(
        executions_source.replace(OLD_EXECUTIONS_PATH, NEW_EXECUTIONS_PATH),
        encoding="utf-8",
    )
    backup_path.write_text(
        backup_source.replace(OLD_BACKUP_PATH, NEW_BACKUP_PATH),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--executions",
        default="/opt/hermes/cron/executions.py",
        help="Hermes cron execution ledger module to patch",
    )
    parser.add_argument(
        "--backup",
        default="/opt/hermes/hermes_cli/backup.py",
        help="Hermes quick snapshot module to patch",
    )
    args = parser.parse_args()
    patch_files(Path(args.executions), Path(args.backup))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
