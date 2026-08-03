#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Pin fail-safe defaults for every Hermes v0.19.0 profile home.

Fresh Hermes named profiles intentionally omit ``config.yaml``. The upstream
v2026.7.20 defaults would therefore enable smart command approval, browser
evaluation of sensitive primitives, reasoning/commentary display, update-time
state mutation, and indefinite gateway sessions outside NemoClaw's generated
default home.

This image-level compatibility patch changes only the pinned upstream default
leaves that NemoClaw already writes explicitly for its default and dashboard
homes. It also fixes independent config copies and loaders that bypass
``DEFAULT_CONFIG``:

* ``tools.browser_tool`` reads raw per-home YAML, so its missing-key and error
  fallbacks must keep the sensitive-expression denylist enabled.
* ``gateway.config.SessionResetPolicy`` constructs its own defaults, so both
  its dataclass and ``from_dict`` fallback must retain the prior 24-hour/daily
  reset policy.
* ``cli.CLI_CONFIG`` carries an independent display default, while
  ``tui_gateway.server`` has two raw-YAML reasoning-display fallbacks.
* ``agent.agent_init`` has three commentary-visibility fallbacks for missing
  keys and config-load errors.
* ``hermes_cli.main`` independently defaults update backups and CUA refresh
  on when configuration is missing or unreadable.

Every input file is bound to the exact upstream v2026.7.20 source hash before
any edit. A Hermes upgrade must deliberately refresh these hashes and source
shapes instead of silently carrying the patch forward.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from typing import Iterable

EXPECTED_SOURCE_SHA256 = {
    "config": "172b78ecb923048859ca177d96f5b010b44ec74bb1d13553577ff49bde1a071d",
    "browser": "02b4a0a0c8fc8b204c8f818dff1dd64295a817e5543b8a643198bcedbfbbcba2",
    "gateway": "7221ee05798566ca7cf570035615a9b29034cf92ce5a6eaa5eec0693040c08aa",
    "cli": "cbcf1780174a03b225508244575915225a36502f54ad4cddf1da644d9174fec4",
    "tui": "5d00832327e4362ac75032f95003e1fa49aead4756cf7927dcfd66447b205a59",
    "agent": "85b7cb13d6e6306e75d5eec46f193433df680425533b7d35ee99e0f7eab9512a",
    "main": "d6bf89a33fb708376a7ab354cff8081a3c3726dbfb91d84bbb679cd667db596c",
}

CONFIG_REPLACEMENTS = (
    (
        '"restrict_evaluate": False',
        "# NemoClaw compatibility override: retain the outgoing denylist default.\n"
        '        "restrict_evaluate": True',
    ),
    (
        '"show_reasoning": True',
        "# NemoClaw compatibility override: reasoning remains hidden by default.\n"
        '        "show_reasoning": False',
    ),
    (
        '"show_commentary": True',
        "# NemoClaw compatibility override: commentary remains hidden by default.\n"
        '        "show_commentary": False',
    ),
    (
        '"mode": "smart"',
        "# NemoClaw compatibility override: flagged commands require manual approval.\n"
        '        "mode": "manual"',
    ),
    (
        '"pre_update_backup": "quick"',
        "# NemoClaw compatibility override: immutable images own update state.\n"
        '        "pre_update_backup": False',
    ),
    (
        '"refresh_cua_driver": True',
        "# NemoClaw compatibility override: immutable images do not fetch CUA updates.\n"
        '        "refresh_cua_driver": False',
    ),
)
CONFIG_REQUIRED_UNCHANGED = ('"allow_unsafe_evaluate": False',)

BROWSER_REPLACEMENTS = (
    (
        'return is_truthy_value(cfg_get(cfg, "browser", "restrict_evaluate"), '
        "default=False)",
        "# NemoClaw compatibility override: missing raw YAML stays restricted.\n"
        '        return is_truthy_value(cfg_get(cfg, "browser", "restrict_evaluate"), '
        "default=True)",
    ),
    (
        'logger.debug("Could not read browser.restrict_evaluate from config: %s", e)\n'
        "        return False",
        'logger.debug("Could not read browser.restrict_evaluate from config: %s", e)\n'
        "        # NemoClaw compatibility override: config errors fail restricted.\n"
        "        return True",
    ),
)

GATEWAY_REPLACEMENTS = (
    (
        'mode: str = "none"  # "daily", "idle", "both", or "none"',
        "# NemoClaw compatibility override: retain bounded daily and idle reset.\n"
        '    mode: str = "both"  # "daily", "idle", "both", or "none"',
    ),
    (
        'mode=mode if mode is not None else "none"',
        "# NemoClaw compatibility override: missing config keeps bounded reset.\n"
        '            mode=mode if mode is not None else "both"',
    ),
)

CLI_REPLACEMENTS = (
    (
        '"show_reasoning": True',
        "# NemoClaw compatibility override: reasoning remains hidden by default.\n"
        '            "show_reasoning": False',
    ),
)

TUI_REPLACEMENTS = (
    (
        "# Fallback True — keep in sync with DEFAULT_CONFIG display.show_reasoning\n"
        "    # (this loader reads the raw user YAML without the DEFAULT_CONFIG merge).\n"
        '    return bool((_load_cfg().get("display") or {}).get("show_reasoning", True))',
        "# NemoClaw compatibility override: missing raw YAML keeps reasoning hidden.\n"
        '    return bool((_load_cfg().get("display") or {}).get("show_reasoning", False))',
        1,
    ),
    (
        'if bool((cfg.get("display") or {}).get("show_reasoning", True))',
        "# NemoClaw compatibility override: missing raw YAML stays hidden.\n"
        '            if bool((cfg.get("display") or {}).get("show_reasoning", False))',
        1,
    ),
)

AGENT_REPLACEMENTS = (
    (
        "# Codex commentary visibility (display.show_commentary, default true).\n",
        "# Codex commentary visibility. NemoClaw keeps the missing/error fallback off.\n",
    ),
    (
        "agent.show_commentary = True",
        "agent.show_commentary = False  # NemoClaw compatibility override: fail hidden.",
    ),
    (
        'agent.show_commentary = bool(_display_section.get("show_commentary", True))',
        "# NemoClaw compatibility override: a missing key keeps commentary hidden.\n"
        "            agent.show_commentary = bool(\n"
        '                _display_section.get("show_commentary", False)\n'
        "            )",
    ),
)

MAIN_REPLACEMENTS = (
    (
        'raw = updates_cfg.get("pre_update_backup", "quick")',
        "# NemoClaw compatibility override: missing/error config skips state duplication.\n"
        '    raw = updates_cfg.get("pre_update_backup", False)',
    ),
    (
        "refresh_cua_driver = True",
        "# NemoClaw compatibility override: config errors do not fetch mutable CUA updates.\n"
        "            refresh_cua_driver = False",
    ),
    (
        '_update_cfg.get("refresh_cua_driver", True)',
        '_update_cfg.get("refresh_cua_driver", False)  '
        "# NemoClaw compatibility override: missing keys stay off.",
    ),
)


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


def patch_config_source(source: str) -> str:
    for shape in CONFIG_REQUIRED_UNCHANGED:
        count = source.count(shape)
        if count != 1:
            raise ValueError(
                "Hermes config source shape changed for "
                f"{shape!r}: expected one occurrence, found {count}"
            )
    return _replace_exact(source, CONFIG_REPLACEMENTS, label="Hermes config")


def patch_browser_source(source: str) -> str:
    return _replace_exact(source, BROWSER_REPLACEMENTS, label="Hermes browser policy")


def patch_gateway_source(source: str) -> str:
    return _replace_exact(source, GATEWAY_REPLACEMENTS, label="Hermes gateway policy")


def patch_cli_source(source: str) -> str:
    return _replace_exact(source, CLI_REPLACEMENTS, label="Hermes CLI policy")


def patch_tui_source(source: str) -> str:
    patched = source
    for old, new, expected_count in TUI_REPLACEMENTS:
        old_count = patched.count(old)
        new_count = patched.count(new)
        if old_count != expected_count or new_count != 0:
            raise ValueError(
                f"Hermes TUI policy source shape changed for {old!r}: "
                f"expected {expected_count} unpatched occurrences, found {old_count}; "
                f"prepatched occurrences: {new_count}"
            )
        patched = patched.replace(old, new)
    return patched


def patch_agent_source(source: str) -> str:
    patched = source
    for old, new in AGENT_REPLACEMENTS:
        expected_count = 2 if old == "agent.show_commentary = True" else 1
        old_count = patched.count(old)
        new_count = patched.count(new)
        if old_count != expected_count or new_count != 0:
            raise ValueError(
                f"Hermes agent policy source shape changed for {old!r}: "
                f"expected {expected_count} unpatched occurrences, found {old_count}; "
                f"prepatched occurrences: {new_count}"
            )
        patched = patched.replace(old, new)
    return patched


def patch_main_source(source: str) -> str:
    return _replace_exact(source, MAIN_REPLACEMENTS, label="Hermes update policy")


def patch_file(path: Path, kind: str) -> None:
    source = path.read_text(encoding="utf-8")
    actual_sha256 = _sha256(source)
    expected_sha256 = EXPECTED_SOURCE_SHA256[kind]
    if actual_sha256 != expected_sha256:
        raise SystemExit(
            f"ERROR: {path} is not the reviewed Hermes v2026.7.20 {kind} source; "
            f"expected sha256 {expected_sha256}, got {actual_sha256}"
        )

    patcher = {
        "config": patch_config_source,
        "browser": patch_browser_source,
        "gateway": patch_gateway_source,
        "cli": patch_cli_source,
        "tui": patch_tui_source,
        "agent": patch_agent_source,
        "main": patch_main_source,
    }[kind]
    try:
        patched = patcher(source)
    except ValueError as exc:
        raise SystemExit(f"ERROR: {exc}") from exc
    path.write_text(patched, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        default="/opt/hermes/hermes_cli/config.py",
        help="Pinned Hermes configuration module",
    )
    parser.add_argument(
        "--browser",
        default="/opt/hermes/tools/browser_tool.py",
        help="Pinned Hermes browser tool module",
    )
    parser.add_argument(
        "--gateway",
        default="/opt/hermes/gateway/config.py",
        help="Pinned Hermes gateway configuration module",
    )
    parser.add_argument(
        "--cli",
        default="/opt/hermes/cli.py",
        help="Pinned Hermes classic CLI module",
    )
    parser.add_argument(
        "--tui",
        default="/opt/hermes/tui_gateway/server.py",
        help="Pinned Hermes TUI gateway module",
    )
    parser.add_argument(
        "--agent",
        default="/opt/hermes/agent/agent_init.py",
        help="Pinned Hermes agent initialization module",
    )
    parser.add_argument(
        "--main",
        default="/opt/hermes/hermes_cli/main.py",
        help="Pinned Hermes main/update module",
    )
    args = parser.parse_args()

    patch_file(Path(args.config), "config")
    patch_file(Path(args.browser), "browser")
    patch_file(Path(args.gateway), "gateway")
    patch_file(Path(args.cli), "cli")
    patch_file(Path(args.tui), "tui")
    patch_file(Path(args.agent), "agent")
    patch_file(Path(args.main), "main")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
