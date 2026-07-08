#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch pinned Hermes v0.17.0 session-list previews to show the latest user turn.

Source-of-truth note for this localized Hermes runtime patch:
  - Invalid state: Hermes v0.17.0 computes `sessions list` preview text from
    the first user message, but #5254's resumed/continued one-shot UX expects
    the original row to reflect the latest appended turn.
  - Value being patched: pinned/prebuilt `/opt/hermes/hermes_state.py`
    occurrences of `ORDER BY m.timestamp, m.id LIMIT 1` inside
    `SessionDB.list_sessions_rich()`.
  - Source-fix constraint: NemoClaw layers a sandbox image on top of the
    published Hermes runtime; the source fix belongs upstream in Hermes, not in
    NemoClaw's TypeScript or wrapper code.
  - Regression test: this script's exact occurrence count fails closed when the
    pinned source shape drifts, the Dockerfile greps for the patched query
    pattern after patching, and the Dockerfile smoke test creates a
    `SessionDB`, appends first/latest user turns, and asserts the list preview
    returns `NEMOCLAW_PREVIEW_LATEST`.
  - Removal condition: delete this patch when the pinned Hermes runtime
    natively uses the latest user turn for `sessions list` previews.
"""

from __future__ import annotations

import argparse
from pathlib import Path

OLD = "ORDER BY m.timestamp, m.id LIMIT 1"
NEW = "ORDER BY m.timestamp DESC, m.id DESC LIMIT 1"
EXPECTED_OCCURRENCES = 6


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    old_count = source.count(OLD)
    new_count = source.count(NEW)
    if old_count == 0 and new_count == EXPECTED_OCCURRENCES:
        return
    if old_count != EXPECTED_OCCURRENCES:
        raise SystemExit(
            "ERROR: Hermes session preview query shape changed; "
            f"expected {EXPECTED_OCCURRENCES} unpatched occurrences, found {old_count} "
            f"(already patched occurrences: {new_count})"
        )
    path.write_text(source.replace(OLD, NEW), encoding="utf-8")


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
