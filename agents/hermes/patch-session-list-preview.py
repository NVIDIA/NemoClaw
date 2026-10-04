#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch pinned Hermes v0.21.3 session lists to show the latest user turn.

Source-of-truth note for this localized Hermes runtime patch:
  - Invalid state: Hermes v0.21.3 computes `sessions list` preview text from
    the first user message. Its workspace-aware titled table then hides the
    preview behind an automatic seed title, so #5254's resumed/continued
    one-shot UX keeps displaying the seed turn instead of the latest appended
    turn. User-authored titles remain authoritative.
  - Values being patched: pinned/prebuilt `/opt/hermes/hermes_state_common.py`,
    `/opt/hermes/hermes_state_sessions.py`, and
    `/opt/hermes/hermes_state_telegram.py` preview queries, plus the title cell in
    `/opt/hermes/hermes_cli/sessions_cmd.py`.
  - Source-fix constraint: NemoClaw layers a sandbox image on top of the
    published Hermes runtime; the source fix belongs upstream in Hermes, not in
    NemoClaw's TypeScript or wrapper code.
  - Regression test: this script's exact occurrence count fails closed when the
    pinned source shape drifts. The Dockerfile smoke test creates a titled,
    workspace-bound `SessionDB` row, appends first/latest user turns, and
    asserts both the list preview and rendered table use
    `NEMOCLAW_PREVIEW_LATEST`.
  - Removal condition: delete this patch when the pinned Hermes runtime
    natively uses the latest user turn for `sessions list` previews.
"""

from __future__ import annotations

import argparse
from pathlib import Path

STATE_OLD = "ORDER BY m.timestamp, m.id LIMIT 1"
STATE_NEW = "ORDER BY m.timestamp DESC, m.id DESC LIMIT 1"
STATE_EXPECTED_OCCURRENCES = (1, 2, 1)
COMMAND_OLD = '''    _title = lambda s, n: (s.get("title") or "—")[:n]  # noqa: E731
'''
COMMAND_NEW = '''    _title = lambda s, n: (  # noqa: E731
        (
            s.get("preview")
            if s.get("title_source") in ("derived", "llm")
            else s.get("title")
        )
        or s.get("preview")
        or "—"
    )[:n]
'''


def patched_source(path: Path, old: str, new: str, expected: int, label: str) -> str:
    source = path.read_text(encoding="utf-8")
    old_count = source.count(old)
    new_count = source.count(new)
    if old_count == 0 and new_count == expected:
        return source
    if old_count != expected or new_count != 0:
        raise SystemExit(
            f"ERROR: Hermes session {label} shape changed; "
            f"expected {expected} unpatched occurrences, found {old_count} "
            f"(already patched occurrences: {new_count})"
        )
    return source.replace(old, new)


def patch_files(state_paths: tuple[Path, Path, Path], command_path: Path) -> None:
    state_sources = [
        patched_source(path, STATE_OLD, STATE_NEW, expected, "preview query")
        for path, expected in zip(state_paths, STATE_EXPECTED_OCCURRENCES, strict=True)
    ]
    command_source = patched_source(
        command_path,
        COMMAND_OLD,
        COMMAND_NEW,
        1,
        "list renderer",
    )
    for path, source in zip(state_paths, state_sources, strict=True):
        path.write_text(source, encoding="utf-8")
    command_path.write_text(command_source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--state-common-path",
        default="/opt/hermes/hermes_state_common.py",
        help="Hermes shared state module to patch",
    )
    parser.add_argument(
        "--state-sessions-path",
        default="/opt/hermes/hermes_state_sessions.py",
        help="Hermes session state module to patch",
    )
    parser.add_argument(
        "--state-telegram-path",
        default="/opt/hermes/hermes_state_telegram.py",
        help="Hermes Telegram state module to patch",
    )
    parser.add_argument(
        "--sessions-command-path",
        default="/opt/hermes/hermes_cli/sessions_cmd.py",
        help="Hermes sessions command module to patch",
    )
    args = parser.parse_args()
    patch_files(
        (
            Path(args.state_common_path),
            Path(args.state_sessions_path),
            Path(args.state_telegram_path),
        ),
        Path(args.sessions_command_path),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
