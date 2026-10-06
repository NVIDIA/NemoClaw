#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Give managed Hermes SIGTERM recovery a distinct process exit status.

Hermes 0.21.3 converts an unplanned SIGTERM into process exit status 1 so a
service manager can revive the gateway. NemoClaw must first wait for its
root-owned recovery transaction, while ordinary status-1 failures must still
stop the managed container.

When ``gateway run --external-supervisor`` set Hermes's existing supervisor
environment marker, map only the upstream unplanned-signal verdict to a
NemoClaw-private status. SIGINT is an upstream planned stop and does not reach
this branch. The NemoClaw shell supervisor gates this status until the
authenticated recovery request completes.

Remove this patch when the minimum supported Hermes release exposes a distinct
external-supervisor exit status for an unplanned SIGTERM.
"""

from __future__ import annotations

import argparse
from pathlib import Path

OLD_IMPORT = """from gateway.restart import (
    DEFAULT_GATEWAY_CRON_DRAIN_TIMEOUT, GATEWAY_SERVICE_RESTART_EXIT_CODE, resolve_cron_drain_budget
)
"""
NEW_IMPORT = """from gateway.restart import (
    DEFAULT_GATEWAY_CRON_DRAIN_TIMEOUT, EXTERNAL_GATEWAY_SUPERVISOR_ENV,
    GATEWAY_SERVICE_RESTART_EXIT_CODE, resolve_cron_drain_budget
)
"""

OLD_VERDICT = '''    if signal_initiated_shutdown and not runner._restart_requested:
        logger.info(
            "Exiting with code 1 (signal-initiated shutdown without restart "
            "request) so the service manager can revive the gateway."
        )
        return False
'''
NEW_VERDICT = '''    if signal_initiated_shutdown and not runner._restart_requested:
        if os.environ.get(EXTERNAL_GATEWAY_SUPERVISOR_ENV) == "1":
            logger.info(
                "Exiting with code %d (externally supervised signal shutdown) "
                "so NemoClaw can gate recovery.",
                NEMOCLAW_GATEWAY_RECOVERY_EXIT_CODE,
            )
            raise SystemExit(NEMOCLAW_GATEWAY_RECOVERY_EXIT_CODE)
        logger.info(
            "Exiting with code 1 (signal-initiated shutdown without restart "
            "request) so the service manager can revive the gateway."
        )
        return False
'''

LOGGER_MARKER = 'logger = logging.getLogger("gateway.run")\n'
PRIVATE_STATUS = "\n# NemoClaw-private status outside the sysexits range used by Hermes.\nNEMOCLAW_GATEWAY_RECOVERY_EXIT_CODE = 79\n"


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")

    already_patched = (
        source.count(NEW_IMPORT) == 1
        and source.count(NEW_VERDICT) == 1
        and source.count(PRIVATE_STATUS) == 1
    )
    if already_patched and source.count(OLD_IMPORT) == 0 and source.count(OLD_VERDICT) == 0:
        return

    import_count = source.count(OLD_IMPORT)
    verdict_count = source.count(OLD_VERDICT)
    logger_count = source.count(LOGGER_MARKER)
    if (
        import_count != 1
        or verdict_count != 1
        or logger_count != 1
        or NEW_IMPORT in source
        or NEW_VERDICT in source
        or PRIVATE_STATUS in source
    ):
        raise SystemExit(
            "ERROR: Hermes external-supervisor recovery source shape changed; "
            f"expected one import, verdict, and logger marker, found "
            f"{import_count}, {verdict_count}, and {logger_count}"
        )

    source = source.replace(OLD_IMPORT, NEW_IMPORT, 1)
    source = source.replace(LOGGER_MARKER, LOGGER_MARKER + PRIVATE_STATUS, 1)
    source = source.replace(OLD_VERDICT, NEW_VERDICT, 1)
    path.write_text(source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/gateway/run_shutdown.py",
        help="Hermes gateway shutdown module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
