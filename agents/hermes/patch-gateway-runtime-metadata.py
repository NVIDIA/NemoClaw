#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Relocate pinned Hermes gateway metadata below its writable runtime directory.

Hermes v0.20.6 stores ``gateway.pid``, ``gateway.lock``, and
``gateway_state.json`` directly below ``HERMES_HOME``. NemoClaw
correctly makes that config root root-owned and non-writable, so NemoClaw's
managed stop/start recovery cannot remove the old PID file or atomically
refresh runtime status. The next managed start exits with "PID file race lost".

NemoClaw already provisions ``HERMES_HOME/runtime`` as the writable lifecycle
boundary. Patch only the central helpers exercised by NemoClaw's managed
default-gateway lifecycle. Direct upstream ``--replace`` cleanup,
planned-stop/takeover markers, and named-profile or service readers still use
top-level paths; that inherited bounded residual is documented in the
dependency review and is not claimed by this patch. The exact source-shape
checks fail closed when the pinned Hermes implementation changes.

Remove this patch when the minimum supported Hermes release natively separates
writable gateway metadata from its configuration root.
"""

from __future__ import annotations

import argparse
from pathlib import Path

OLD_PID_HELPER = '''def _get_pid_path() -> Path:
    """Return the path to the gateway PID file, respecting HERMES_HOME."""
    home = _get_process_hermes_home()
    return home / "gateway.pid"
'''
NEW_PID_HELPER = '''def _get_pid_path() -> Path:
    """Return the path to the gateway PID file, respecting HERMES_HOME."""
    home = _get_process_hermes_home()
    return home / "runtime" / "gateway.pid"
'''

OLD_LOCK_HELPER = '''def _get_gateway_lock_path(pid_path: Optional[Path] = None) -> Path:
    """Return the path to the runtime gateway lock file."""
    if pid_path is not None:
        return pid_path.with_name(_GATEWAY_LOCK_FILENAME)
    home = _get_process_hermes_home()
    return home / _GATEWAY_LOCK_FILENAME
'''
NEW_LOCK_HELPER = '''def _get_gateway_lock_path(pid_path: Optional[Path] = None) -> Path:
    """Return the path to the runtime gateway lock file."""
    if pid_path is not None:
        return pid_path.with_name(_GATEWAY_LOCK_FILENAME)
    home = _get_process_hermes_home()
    return home / "runtime" / _GATEWAY_LOCK_FILENAME
'''


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    replacements = (
        ("PID", OLD_PID_HELPER, NEW_PID_HELPER),
        ("lock", OLD_LOCK_HELPER, NEW_LOCK_HELPER),
    )

    if all(source.count(old) == 0 and source.count(new) == 1 for _, old, new in replacements):
        return

    for label, old, new in replacements:
        old_count = source.count(old)
        new_count = source.count(new)
        if old_count != 1 or new_count != 0:
            raise SystemExit(
                "ERROR: Hermes gateway runtime metadata source shape changed; "
                f"expected one unpatched {label} helper, found {old_count} "
                f"(already patched helpers: {new_count})"
            )

    for _, old, new in replacements:
        source = source.replace(old, new)
    path.write_text(source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/gateway/status.py",
        help="Hermes gateway status module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
