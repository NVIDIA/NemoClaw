#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Pin fail-safe defaults for every Hermes v0.20.6 profile home.

Fresh Hermes named profiles intentionally omit ``config.yaml``. The upstream
v2026.8.27 defaults would therefore enable smart command approval, browser
evaluation of sensitive primitives, reasoning/commentary display, update-time
state mutation, and indefinite gateway sessions outside NemoClaw's generated
default home.

This image-level compatibility patch changes only the pinned upstream default
leaves that NemoClaw already writes explicitly for its default and dashboard
homes. It also fixes independent config copies and loaders that bypass
``DEFAULT_CONFIG``:

* ``tools.browser_tool`` reads raw per-home YAML, so its missing-key and error
  fallbacks must keep the sensitive-expression denylist enabled. Its runtime
  npx fallback must also remain offline after all ambient values are copied.
* ``gateway.config.SessionResetPolicy`` constructs its own defaults, so both
  its dataclass and ``from_dict`` fallback must retain the prior 24-hour/daily
  reset policy.
* ``cli.CLI_CONFIG`` carries an independent display default, while
  ``tui_gateway.server`` has two raw-YAML reasoning-display fallbacks.
* ``agent.agent_init`` has three commentary-visibility fallbacks for missing
  keys and config-load errors.
* ``hermes_cli.main`` independently defaults update backups and CUA refresh
  on when configuration is missing or unreadable.

Every input file is bound to its exact reviewed v2026.8.27 source state before
any edit. The browser source hash includes NemoClaw's preceding exact
``agent-browser`` dependency pin. A Hermes upgrade must deliberately refresh
these hashes and source shapes instead of silently carrying the patch forward.

Delete this compatibility patch only when the pinned Hermes release applies
the managed-policy values to a config-less named profile across
``DEFAULT_CONFIG`` and every independent fallback listed above. The unmodified
upstream files must then pass the ``profile-policy`` image probe and
``test/agents/hermes/hermes-profile-policy-defaults.test.ts``.
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
    "config": "3fa2c9f02a76d77602f9b09b7b01f72ca45a40eea92dbac33cc3a1fc5071bff8",
    "browser": "b43608826bb10f9bf919ca97757bf36fc95247bd8b14fa8626a113c639cfd73e",
    "gateway": "d88dcda8c5a14b79d84afcc1d5784c165858ab5d6f289ba59fe421502d2c63a3",
    "cli": "85c95927002a77602b0fb0384413357b6ee0149dfc5b31e048c29d59654a22a9",
    "tui": "6fdeca2133b22a88c527a63764eb201c24a27fc2e894045e9bdb647f89ea7d26",
    "tui_config": "2ffe5fae39e8962a086d4eea7ec26c3f1d29f2bb8a97422d5606eecaa2b3f116",
    "agent": "883168664a89bcf8954bbe486b672ab01c96fc0c06c88acdaf21559905a60276",
    "main": "fb4ee75ebcf12bd9bc014d212c7abc110e1afbcf0c2cb79caa7230dd58006911",
}

CONFIG_REQUIRED_UNCHANGED = ('"allow_unsafe_evaluate": False',)


def _literal(value: object) -> str:
    if value is True:
        return "True"
    if value is False:
        return "False"
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
            '"restrict_evaluate": False',
            "# NemoClaw compatibility override: generated policy restricts sensitive evaluation.\n"
            f'        "restrict_evaluate": {_literal(values["browser.restrict_evaluate"])}',
        ),
        (
            '"show_reasoning": True',
            "# NemoClaw compatibility override: generated policy keeps reasoning hidden.\n"
            f'        "show_reasoning": {_literal(values["display.show_reasoning"])}',
        ),
        (
            '"show_commentary": True',
            "# NemoClaw compatibility override: generated policy keeps commentary hidden.\n"
            f'        "show_commentary": {_literal(values["display.show_commentary"])}',
        ),
        (
            '"mode": "smart"',
            "# NemoClaw compatibility override: generated policy requires manual approval.\n"
            f'        "mode": {_literal(values["approvals.mode"])}',
        ),
        (
            '"pre_update_backup": "quick"',
            "# NemoClaw compatibility override: generated policy leaves image state unchanged.\n"
            f'        "pre_update_backup": {_literal(values["updates.pre_update_backup"])}',
        ),
        (
            '"refresh_cua_driver": True',
            "# NemoClaw compatibility override: generated policy disables mutable CUA updates.\n"
            f'        "refresh_cua_driver": {_literal(values["updates.refresh_cua_driver"])}',
        ),
    )
    return _replace_exact(source, replacements, label="Hermes config")


def patch_browser_source(source: str, values: dict[str, object]) -> str:
    expected = _literal(values["browser.restrict_evaluate"])
    replacements = (
        (
            'return is_truthy_value(cfg_get(cfg, "browser", "restrict_evaluate"), default=False)',
            "# NemoClaw compatibility override: missing raw YAML stays restricted.\n"
            f'        return is_truthy_value(cfg_get(cfg, "browser", "restrict_evaluate"), default={expected})',
        ),
        (
            'logger.debug("Could not read browser.restrict_evaluate from config: %s", e)\n'
            "        return False",
            'logger.debug("Could not read browser.restrict_evaluate from config: %s", e)\n'
            "        # NemoClaw compatibility override: config errors fail restricted.\n"
            f"        return {expected}",
        ),
        (
            "            env[_key] = os.environ[_key]\n"
            "    return env",
            "            env[_key] = os.environ[_key]\n"
            "    # NemoClaw compatibility override: runtime npx never uses the network.\n"
            '    env["npm_config_offline"] = "true"\n'
            "    return env",
        ),
    )
    return _replace_exact(source, replacements, label="Hermes browser policy")


def patch_gateway_source(source: str, values: dict[str, object]) -> str:
    expected = _literal(values["session_reset.mode"])
    replacements = (
        (
            'mode: str = "none"  # "daily", "idle", "both", or "none"',
            "# NemoClaw compatibility override: generated policy bounds daily and idle reset.\n"
            f'    mode: str = {expected}  # "daily", "idle", "both", or "none"',
        ),
        (
            'mode=mode if mode is not None else "none"',
            "# NemoClaw compatibility override: missing config keeps bounded reset.\n"
            f"            mode=mode if mode is not None else {expected}",
        ),
    )
    return _replace_exact(source, replacements, label="Hermes gateway policy")


def patch_cli_source(source: str, values: dict[str, object]) -> str:
    replacements = ((
        '"show_reasoning": True',
        "# NemoClaw compatibility override: generated policy keeps reasoning hidden.\n"
        f'            "show_reasoning": {_literal(values["display.show_reasoning"])}',
    ),)
    return _replace_exact(source, replacements, label="Hermes CLI policy")


def patch_tui_source(source: str, values: dict[str, object]) -> str:
    expected = _literal(values["display.show_reasoning"])
    return _replace_exact(
        source,
        ((
            "# Fallback True — keep in sync with DEFAULT_CONFIG display.show_reasoning\n"
            "    # (this loader reads the raw user YAML without the DEFAULT_CONFIG merge).\n"
            '    return bool((_load_cfg().get("display") or {}).get("show_reasoning", True))',
            "# NemoClaw compatibility override: missing raw YAML keeps reasoning hidden.\n"
            f'    return bool((_load_cfg().get("display") or {{}}).get("show_reasoning", {expected}))',
        ),),
        label="Hermes TUI policy",
    )


def patch_tui_config_source(source: str, values: dict[str, object]) -> str:
    expected = _literal(values["display.show_reasoning"])
    return _replace_exact(
        source,
        ((
            'if bool((cfg.get("display") or {}).get("show_reasoning", True))',
            "# NemoClaw compatibility override: missing raw YAML stays hidden.\n"
            f'            if bool((cfg.get("display") or {{}}).get("show_reasoning", {expected}))',
        ),),
        label="Hermes TUI config policy",
    )


def patch_agent_source(source: str, values: dict[str, object]) -> str:
    expected = _literal(values["display.show_commentary"])
    replacements = (
        (
            "# Codex commentary visibility (display.show_commentary, default true).\n",
            "# Codex commentary visibility is generated from NemoClaw's managed policy.\n",
        ),
        (
            "agent.show_commentary = True",
            f"agent.show_commentary = {expected}  # NemoClaw config-error fallback.",
        ),
        (
            'agent.show_commentary = bool(_display_section.get("show_commentary", True))',
            "# NemoClaw compatibility override: a missing key keeps commentary hidden.\n"
            "            agent.show_commentary = bool(\n"
            f'                _display_section.get("show_commentary", {expected})\n'
            "            )",
        ),
    )
    patched = source
    for old, new in replacements:
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


def patch_main_source(source: str, values: dict[str, object]) -> str:
    backup = _literal(values["updates.pre_update_backup"])
    refresh = _literal(values["updates.refresh_cua_driver"])
    replacements = (
        (
            'raw = updates_cfg.get("pre_update_backup", "quick")',
            "# NemoClaw compatibility override: missing config skips state duplication.\n"
            f'    raw = updates_cfg.get("pre_update_backup", {backup})',
        ),
        (
            "refresh_cua_driver = True",
            "# NemoClaw compatibility override: config errors do not fetch CUA updates.\n"
            f"            refresh_cua_driver = {refresh}",
        ),
        (
            '_update_cfg.get("refresh_cua_driver", True)',
            f'_update_cfg.get("refresh_cua_driver", {refresh})  '
            "# NemoClaw missing-key fallback.",
        ),
    )
    return _replace_exact(source, replacements, label="Hermes update policy")


def patch_file(path: Path, kind: str, values: dict[str, object]) -> None:
    source = path.read_text(encoding="utf-8")
    actual_sha256 = _sha256(source)
    expected_sha256 = EXPECTED_SOURCE_SHA256[kind]
    if actual_sha256 != expected_sha256:
        raise SystemExit(
            f"ERROR: {path} is not the reviewed Hermes v2026.8.27 {kind} source; "
            f"expected sha256 {expected_sha256}, got {actual_sha256}"
        )

    patcher = {
        "config": patch_config_source,
        "browser": patch_browser_source,
        "gateway": patch_gateway_source,
        "cli": patch_cli_source,
        "tui": patch_tui_source,
        "tui_config": patch_tui_config_source,
        "agent": patch_agent_source,
        "main": patch_main_source,
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
        "--tui-config",
        default="/opt/hermes/tui_gateway/methods_config.py",
        help="Pinned Hermes TUI configuration methods module",
    )
    parser.add_argument(
        "--main",
        default="/opt/hermes/hermes_cli/update_cmd.py",
        help="Pinned Hermes main/update module",
    )
    args = parser.parse_args()
    try:
        values = profile_default_values(load_managed_policy(args.policy))
    except ManagedPolicyError as exc:
        raise SystemExit(f"ERROR: {args.policy}: {exc}") from exc

    patch_file(Path(args.config), "config", values)
    patch_file(Path(args.browser), "browser", values)
    patch_file(Path(args.gateway), "gateway", values)
    patch_file(Path(args.cli), "cli", values)
    patch_file(Path(args.tui), "tui", values)
    patch_file(Path(args.tui_config), "tui_config", values)
    patch_file(Path(args.agent), "agent", values)
    patch_file(Path(args.main), "main", values)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
