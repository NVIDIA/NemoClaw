#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Keep required approval, browser, and SQLite defaults in fresh Hermes profiles.

Display, session resets, memory, and update choices use the pinned harness defaults.
Reviewed hashes bind the remaining patches to Hermes v0.21.3 sources.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from managed_policy import (  # noqa: E402
    MANAGED_POLICY_PATH,
    ManagedPolicyError,
    load_managed_policy,
    profile_default_values,
)

EXPECTED_SOURCE_SHA256 = {
    "config": "dbb0bbeafc42d4586d02a291b4bb5606e566eb71c7d75c01644d696abe7c8bae",
    "browser": "29598fc950902eff9b503fa1fcfd02a8e4b15673acb6e8131fdc0bde65518f51",
    "browser_policy": "80d617bf062ff9e0e87fd592e8bbaadc3c6aaef7b96d2fe3ceb49fcfecaf368a",
}

CONFIG_REQUIRED_UNCHANGED = ('"allow_unsafe_evaluate": False',)


def _literal(value: object) -> str:
    if value is True:
        return "True"
    if value is False:
        return "False"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value)
    raise ValueError(f"unsupported managed policy literal type: {type(value).__name__}")


def _sha256(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _replace_exact(
    source: str,
    replacements: Iterable[tuple[str, str]],
    *,
    label: str,
) -> str:
    patched = source
    for old, new in replacements:
        old_count = patched.count(old)
        new_count = patched.count(new)
        if old_count != 1 or new_count != 0:
            raise ValueError(
                f"{label} source shape changed for {old!r}: "
                f"expected one unpatched occurrence, found {old_count}; "
                f"prepatched occurrences: {new_count}"
            )
        patched = patched.replace(old, new)
    return patched


def patch_config_source(source: str, values: dict[str, object]) -> str:
    for shape in CONFIG_REQUIRED_UNCHANGED:
        count = source.count(shape)
        if count != 1:
            raise ValueError(
                "Hermes config source shape changed for "
                f"{shape!r}: expected one occurrence, found {count}"
            )
    replacements = (
        (
            '"journal_size_limit": None,',
            '"journal_size_limit": None,\n'
            "        # NemoClaw compatibility override: temporary SQLite state stays in memory.\n"
            f'        "temp_store": {_literal(values["database.temp_store"])}',
        ),
        (
            '"restrict_evaluate": False',
            "# NemoClaw compatibility override: generated policy restricts sensitive evaluation.\n"
            f'        "restrict_evaluate": {_literal(values["browser.restrict_evaluate"])}',
        ),
        (
            '"mode": "smart"',
            "# NemoClaw compatibility override: generated policy requires manual approval.\n"
            f'        "mode": {_literal(values["approvals.mode"])}',
        ),
    )
    return _replace_exact(source, replacements, label="Hermes config")


def patch_browser_source(source: str, values: dict[str, object]) -> str:
    replacements = ((
        "    env.update({k: os.environ[k] for k in _BROWSER_PASSTHROUGH_KEYS if k in os.environ})\n"
        "    return env",
        "    env.update({k: os.environ[k] for k in _BROWSER_PASSTHROUGH_KEYS if k in os.environ})\n"
        "    # NemoClaw compatibility override: runtime npx never uses the network.\n"
        '    env["npm_config_offline"] = "true"\n'
        "    return env",
    ),)
    return _replace_exact(source, replacements, label="Hermes browser policy")


def patch_browser_policy_source(source: str, values: dict[str, object]) -> str:
    expected = _literal(values["browser.restrict_evaluate"])
    replacements = (
        (
            "def _browser_eval_flag(key: str) -> bool:\n"
            '    """Read boolean ``browser.<key>`` (default False) through the origin\'s config reader."""\n'
            "    _bt = _origin()\n"
            '    return _bt._browser_cfg(key, False, lambda v: is_truthy_value(v, default=False), f"browser.{key} from config")',
            "def _browser_eval_flag(key: str, *, default: bool = False) -> bool:\n"
            '    """Read boolean ``browser.<key>`` through the origin\'s config reader."""\n'
            "    _bt = _origin()\n"
            '    return _bt._browser_cfg(key, default, lambda v: is_truthy_value(v, default=default), f"browser.{key} from config")',
        ),
        (
            'return _browser_eval_flag("restrict_evaluate")',
            "# NemoClaw compatibility override: missing raw YAML stays restricted.\n"
            f'    return _browser_eval_flag("restrict_evaluate", default={expected})',
        ),
    )
    return _replace_exact(source, replacements, label="Hermes browser evaluation policy")


def patch_file(path: Path, kind: str, values: dict[str, object]) -> None:
    source = path.read_text(encoding="utf-8")
    actual_sha256 = _sha256(source)
    expected_sha256 = EXPECTED_SOURCE_SHA256[kind]
    if actual_sha256 != expected_sha256:
        raise SystemExit(
            f"ERROR: {path} is not the reviewed Hermes v2026.9.14 {kind} source; "
            f"expected sha256 {expected_sha256}, got {actual_sha256}"
        )

    patcher = {
        "config": patch_config_source,
        "browser": patch_browser_source,
        "browser_policy": patch_browser_policy_source,
    }[kind]
    try:
        patched = patcher(source, values)
    except ValueError as exc:
        raise SystemExit(f"ERROR: {exc}") from exc
    path.write_text(patched, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--policy",
        type=Path,
        default=MANAGED_POLICY_PATH,
        help="NemoClaw managed Hermes policy manifest",
    )
    parser.add_argument(
        "--config",
        default="/opt/hermes/hermes_cli/config_defaults.py",
        help="Pinned Hermes configuration module",
    )
    parser.add_argument(
        "--browser",
        default="/opt/hermes/tools/browser_tool.py",
        help="Pinned Hermes browser tool module",
    )
    parser.add_argument(
        "--browser-policy",
        default="/opt/hermes/tools/browser_tool_eval_policy.py",
        help="Pinned Hermes browser evaluation policy module",
    )
    args = parser.parse_args()
    try:
        values = profile_default_values(load_managed_policy(args.policy))
    except ManagedPolicyError as exc:
        raise SystemExit(f"ERROR: {args.policy}: {exc}") from exc

    patch_file(Path(args.config), "config", values)
    patch_file(Path(args.browser), "browser", values)
    patch_file(Path(args.browser_policy), "browser_policy", values)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
