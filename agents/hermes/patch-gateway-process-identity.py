#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Teach the pinned Hermes gateway matcher about NemoClaw's renamed entrypoint.

NemoClaw installs its own wrapper at ``/usr/local/bin/hermes`` and moves the
real Hermes entrypoint to ``/usr/local/bin/hermes.real``, so every managed
gateway runs as ``... /usr/local/bin/hermes.real gateway run``.

``gateway.status._gateway_command_subcommand`` only accepts a command line whose
entry token has the basename ``hermes`` or ``hermes.exe``. The renamed
entrypoint therefore fails that check, and the matcher is the single gate in
front of both ways Hermes recognises its own gateway: the liveness re-check
inside ``get_running_pid()`` (so a valid PID file is discarded) and the
process-table fallback used by ``hermes_cli.gateway.find_gateway_pids()``. With
both defeated, ``hermes status`` reports the Gateway Service as stopped while
the foreground gateway is running and serving (#7804).

Patch only the entry-token allowlist. The subcommand grammar around it is
unchanged, so a match still requires a real ``gateway run`` command line and no
other process becomes visible as a gateway. NemoClaw's own supervisor already
carries the same compensation for the rename in ``agents/hermes/start.sh``.

Remove this patch when the minimum supported Hermes release resolves its
entrypoint by content or configuration rather than by executable basename.
"""

from __future__ import annotations

import argparse
from pathlib import Path

OLD_ENTRY_ALLOWLIST = '''        or any(t.rsplit("/", 1)[-1] in ("hermes", "hermes.exe") for t in tokens)
'''
NEW_ENTRY_ALLOWLIST = '''        or any(
            t.rsplit("/", 1)[-1] in ("hermes", "hermes.exe", "hermes.real")
            for t in tokens
        )
'''


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")

    if source.count(OLD_ENTRY_ALLOWLIST) == 0 and source.count(NEW_ENTRY_ALLOWLIST) == 1:
        return

    old_count = source.count(OLD_ENTRY_ALLOWLIST)
    new_count = source.count(NEW_ENTRY_ALLOWLIST)
    if old_count != 1 or new_count != 0:
        raise SystemExit(
            "ERROR: Hermes gateway entry-token allowlist source shape changed; "
            f"expected one unpatched allowlist, found {old_count} "
            f"(already patched allowlists: {new_count})"
        )

    path.write_text(
        source.replace(OLD_ENTRY_ALLOWLIST, NEW_ENTRY_ALLOWLIST), encoding="utf-8"
    )


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
