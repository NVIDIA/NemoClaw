#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch pinned Hermes v0.21.3 agent-home resolution for NemoClaw's shared ledger.

Source-of-truth note for this localized Hermes runtime patch:
  - Invalid state: Hermes v0.21.3 opens the session ledger through its
    registry, which resolves NemoClaw's `/sandbox/.hermes/state.db ->
    runtime/state.db` link. `_agent_home()` then returns
    `/sandbox/.hermes/runtime` for the default profile, so gateway, CLI, and
    cron prompts lose `SOUL.md` and the skills index.
  - Values being patched: the session-ledger fallback in
    `/opt/hermes/agent/system_prompt.py::_agent_home` and
    `/opt/hermes/tools/bot_mode_dm.py::_agent_home`. Only the linked ledger
    maps back to `/sandbox/.hermes`. Other ledgers and a bound home override
    keep upstream behavior.
  - Source-fix constraint: NemoClaw layers a sandbox image on top of the
    published Hermes runtime; the source fix belongs upstream in Hermes, not in
    NemoClaw's TypeScript or wrapper code.
  - Regression test: the build fails when either pinned source shape drifts.
    The image-build `agent-home` probe resolves the ledger path like the
    registry. It requires both `_agent_home()` helpers and
    `_agent_skills_dir()` to use `/sandbox/.hermes` for the linked ledger and
    the profile directory for a named-profile ledger.
  - Removal condition: delete this patch when the pinned Hermes runtime keeps
    the default profile's home for a linked session ledger, or when NemoClaw
    stops linking `state.db` into `runtime/`.
"""

from __future__ import annotations

import argparse
from pathlib import Path

HELPER = '''_NEMOCLAW_SHARED_STATE_LINK = Path("/sandbox/.hermes/state.db")
_NEMOCLAW_SHARED_STATE_TARGET = Path("runtime/state.db")


def _nemoclaw_ledger_home(db_path: Path) -> Path:
    """Return the Hermes home that links NemoClaw's resolved session ledger."""
    home = _NEMOCLAW_SHARED_STATE_LINK.parent
    if (
        db_path == home / _NEMOCLAW_SHARED_STATE_TARGET
        and _NEMOCLAW_SHARED_STATE_LINK.is_symlink()
        and _NEMOCLAW_SHARED_STATE_LINK.readlink() == _NEMOCLAW_SHARED_STATE_TARGET
    ):
        return home
    return db_path.parent'''
SYSTEM_PROMPT_OLD = """        db_path = getattr(getattr(agent, "_session_db", None), "db_path", None)
        return Path(db_path).parent if db_path else None
    except Exception:
        return None


def _agent_skills_dir(agent: Any) -> Optional[Path]:
"""
SYSTEM_PROMPT_NEW = f"""        db_path = getattr(getattr(agent, "_session_db", None), "db_path", None)
        return _nemoclaw_ledger_home(Path(db_path)) if db_path else None
    except Exception:
        return None


{HELPER}


def _agent_skills_dir(agent: Any) -> Optional[Path]:
"""
BOT_MODE_OLD = """        db_path = getattr(getattr(agent, "_session_db", None), "db_path", None)
        if db_path:
            return str(Path(db_path).parent)
    return _default_home()


def _session_title(agent: Any) -> str:
"""
BOT_MODE_NEW = f"""        db_path = getattr(getattr(agent, "_session_db", None), "db_path", None)
        if db_path:
            return str(_nemoclaw_ledger_home(Path(db_path)))
    return _default_home()


{HELPER}


def _session_title(agent: Any) -> str:
"""


def patched_source(source: str, old: str, new: str, label: str) -> str:
    old_count = source.count(old)
    new_count = source.count(new)
    if old_count == 0 and new_count == 1:
        return source
    if old_count != 1 or new_count != 0:
        raise SystemExit(
            f"ERROR: Hermes {label} agent-home shape changed; "
            f"expected 1 unpatched occurrence, found {old_count} "
            f"(already patched occurrences: {new_count})"
        )
    return source.replace(old, new)


def patch_files(system_prompt_path: Path, bot_mode_dm_path: Path) -> None:
    targets = (
        (system_prompt_path, SYSTEM_PROMPT_OLD, SYSTEM_PROMPT_NEW, "system prompt"),
        (bot_mode_dm_path, BOT_MODE_OLD, BOT_MODE_NEW, "Bot Mode DM"),
    )
    updates = []
    for path, old, new, label in targets:
        source = path.read_text(encoding="utf-8")
        patched = patched_source(source, old, new, label)
        if patched != source:
            updates.append((path, patched))
    for path, patched in updates:
        path.write_text(patched, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--system-prompt-path",
        default="/opt/hermes/agent/system_prompt.py",
        help="Hermes system prompt module to patch",
    )
    parser.add_argument(
        "--bot-mode-dm-path",
        default="/opt/hermes/tools/bot_mode_dm.py",
        help="Hermes Bot Mode DM tool module to patch",
    )
    args = parser.parse_args()
    patch_files(Path(args.system_prompt_path), Path(args.bot_mode_dm_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
