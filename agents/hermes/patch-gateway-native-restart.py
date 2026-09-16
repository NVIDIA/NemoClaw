#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Keep planned Hermes restarts inside the foreground gateway process.

Hermes 0.20.6 exits 75 after draining a SIGUSR1 restart. NemoClaw starts
Hermes without a service manager, so that exit terminates the sandbox.
Re-execute the guarded launcher after native teardown instead. The PID and
entrypoint parent remain stable; crashes and operator stops still exit.
Remove this patch when pinned Hermes supports foreground process re-execution.
"""

from pathlib import Path
import sys

OLD = "    os._exit(exit_code)\n"
NEW = '    if exit_code == 75:\n        os.execv("/usr/local/bin/hermes", ["hermes", "gateway", "run"])\n    os._exit(exit_code)\n'


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    if source.count(NEW) == 1:
        return
    if source.count(OLD) != 1:
        raise SystemExit("Hermes native exit source changed; review the restart patch")
    path.write_text(source.replace(OLD, NEW), encoding="utf-8")


if __name__ == "__main__":
    patch_file(Path(sys.argv[1]))
