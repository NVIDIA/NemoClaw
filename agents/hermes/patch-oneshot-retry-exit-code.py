#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Exit non-zero when a Hermes one-shot exhausts retries without an answer.

Hermes v0.20.6's ``hermes -z`` writes its own retry-exhaustion notice
("API call failed after N retries: ...") into ``final_response`` and still
sets ``result["failed"] = True`` (``agent/conversation_loop.py``). The CLI's
exit-code gate in ``hermes_cli/oneshot.py:run_oneshot`` only turns
``failed``/``partial`` into a non-zero exit when the response text is also
empty, so a run that reports its own failure as content exits 0. A oneshot
invoked from a script, cron job, or NemoClaw sandbox exec then cannot tell a
delivered answer from a reported failure by exit code alone (NVIDIA/NemoClaw#11848).

The source fix belongs in Hermes. This pinned image patch drops the
response-emptiness condition from the failed/partial branch so any run the
agent itself marked failed or partial exits non-zero, regardless of whether
it produced text.
"""

from __future__ import annotations

import argparse
from pathlib import Path

UNPATCHED = """    if (result.get("failed") or result.get("partial")) and not (response or "").strip():
        return 2"""

PATCHED = """    if result.get("failed") or result.get("partial"):
        return 2"""


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    unpatched_count = source.count(UNPATCHED)
    patched_count = source.count(PATCHED)

    if unpatched_count == 0 and patched_count == 1:
        return
    if unpatched_count != 1 or patched_count != 0:
        raise SystemExit(
            "ERROR: Hermes oneshot exit-code gate changed; "
            f"found {unpatched_count} unpatched and {patched_count} patched blocks"
        )

    path.write_text(source.replace(UNPATCHED, PATCHED), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/hermes_cli/oneshot.py",
        help="Hermes CLI oneshot module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
