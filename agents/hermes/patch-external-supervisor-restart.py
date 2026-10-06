#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Route a managed Hermes gateway restart through its external supervisor.

NemoClaw runs Hermes with ``gateway run --external-supervisor`` and supervises
that process as the sandbox's long-lived service. Hermes 0.21.3 already maps a
SIGUSR1 restart request to exit status 75 so an external supervisor can replace
the gateway. Its ``gateway restart`` command does not inspect that live flag,
however: without systemd or s6 it stops the gateway with status 0 and tries to
start the replacement from the transient CLI execution context. NemoClaw's
supervisor correctly treats status 0 as a normal stop, so no gateway remains.

Patch only the single-profile restart command. It identifies the current
gateway through Hermes's PID and command-line checks, then uses Hermes's own
drain-aware SIGUSR1 helper when the exact live argv contains
``--external-supervisor``. Other gateways keep the upstream service-manager or
manual restart path, and a failed signal or drain wait remains a hard failure.

Remove this patch when the minimum supported Hermes release routes
``gateway restart`` through a live gateway's declared external supervisor.
"""

from __future__ import annotations

import argparse
from pathlib import Path

HELPER_MARKER = "\ndef _cmd_restart(args):\n"
HELPER = '''
def _restart_via_external_supervisor() -> bool:
    """Ask a verified externally supervised gateway to exit for replacement."""
    from gateway.status import get_running_pid

    pid = get_running_pid()
    if pid is None:
        return False
    argv = _capture_gateway_argv(pid)
    if not argv or "--external-supervisor" not in argv:
        return False
    if not _graceful_restart_via_sigusr1(pid, _get_restart_exit_wait_budget()):
        print("✗ Externally supervised gateway did not exit for restart")
        sys.exit(1)
    print("✓ Handed gateway restart to the external supervisor")
    return True


def _cmd_restart(args):
'''

OLD_RESTART_BRANCH = "    if restart_all and _dispatch_all_via_service_manager_if_s6(\"restart\"):\n"
NEW_RESTART_BRANCH = '''    if not restart_all and _restart_via_external_supervisor():
        return
    # A restart without a verified supervisor may launch from this CLI process.
    # Preserve native route validation before any service-manager/manual fallback.
    import subprocess
    native_guard = subprocess.run(
        [sys.executable, "-I", "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
         "native-inference-credential", "--hermes-dir", "/sandbox/.hermes",
         "--hash-file", "/etc/nemoclaw/hermes.config-hash"], check=False
    )
    if native_guard.returncode != 0:
        sys.exit(native_guard.returncode)
    if restart_all and _dispatch_all_via_service_manager_if_s6("restart"):
'''


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")

    already_patched = source.count(HELPER) == 1 and source.count(NEW_RESTART_BRANCH) == 1
    # The replacement retains the original service-manager branch after its guard.
    if already_patched and source.count(OLD_RESTART_BRANCH) == 1:
        return

    helper_count = source.count(HELPER_MARKER)
    branch_count = source.count(OLD_RESTART_BRANCH)
    if helper_count != 1 or branch_count != 1 or HELPER in source or NEW_RESTART_BRANCH in source:
        raise SystemExit(
            "ERROR: Hermes external-supervisor restart source shape changed; "
            f"expected one command and one restart branch, found {helper_count} and {branch_count}"
        )

    source = source.replace(HELPER_MARKER, "\n" + HELPER, 1)
    source = source.replace(OLD_RESTART_BRANCH, NEW_RESTART_BRANCH, 1)
    path.write_text(source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/hermes_cli/gateway.py",
        help="Hermes gateway CLI module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
