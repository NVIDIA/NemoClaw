#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Pin fail-safe defaults for every Hermes v0.21.3 profile home.

Fresh Hermes named profiles intentionally omit ``config.yaml``. The upstream
v2026.9.14 defaults would therefore enable smart command approval, browser
evaluation of sensitive primitives, reasoning/commentary display, update-time
state mutation, disk-backed SQLite temporary storage, and indefinite gateway
sessions outside NemoClaw's generated default home.

This image-level compatibility patch changes only the pinned upstream default
leaves that NemoClaw already writes explicitly for its default and dashboard
homes. It also fixes independent config copies and loaders that bypass
``DEFAULT_CONFIG``:

* ``tools.browser_tool_eval_policy`` reads raw per-home YAML, so its missing-key
  fallback must keep the sensitive-expression denylist enabled.
  ``tools.browser_tool`` must also keep its runtime npx fallback offline.
* ``gateway.config.SessionResetPolicy`` constructs its own dataclass default.
* ``cli.CLI_CONFIG`` carries an independent display default, while
  ``tui_gateway.server`` has two raw-YAML reasoning-display fallbacks.
* ``agent.agent_init`` has an independent commentary-visibility fallback.
* ``hermes_cli.update_cmd_maint`` independently defaults update backups and CUA refresh
  on when configuration is missing or unreadable.

Every input file is bound to its exact reviewed v2026.9.14 source state before
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
    "config": "dbb0bbeafc42d4586d02a291b4bb5606e566eb71c7d75c01644d696abe7c8bae",
    "browser": "29598fc950902eff9b503fa1fcfd02a8e4b15673acb6e8131fdc0bde65518f51",
    "browser_policy": "80d617bf062ff9e0e87fd592e8bbaadc3c6aaef7b96d2fe3ceb49fcfecaf368a",
    "gateway": "a9dd00bad424dfe7975cbd2002df978e4db0f0738555a8bf73379e434ab3deea",
    "cli": "f660357c101629a0ebcd8f4ce6aa2d3874fcfe87de6ea4b1d121cc8b2746584f",
    "tui": "addaab48a307fc4c7924e1b8210a3fb61f02813d612045609651f79e507fff54",
    "tui_config": "9bc5dc068aa2417e9d8466d23c02612b18f714009b6d70ed4cb2e956f89c3de2",
    "agent": "d1a1df8dc03a1381a9fd7591d4293e912fb1cb0fa2c1370f8c72a7500acb824a",
    "main": "a19a8e1593614f9b9010fec4b6ac665576a05d4f58ee8489d0fcbc577d6930e9",
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


def patch_gateway_source(source: str, values: dict[str, object]) -> str:
    expected = _literal(values["session_reset.mode"])
    replacements = ((
        'mode: str = "none"',
        "# NemoClaw compatibility override: generated policy bounds daily and idle reset.\n"
        f"    mode: str = {expected}",
    ),)
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
            "# Fallback True — keep in sync with DEFAULT_CONFIG display.show_reasoning (no DEFAULT_CONFIG merge here).\n"
            '    return bool(_display_cfg().get("show_reasoning", True))',
            "# NemoClaw compatibility override: missing raw YAML keeps reasoning hidden.\n"
            f'    return bool(_display_cfg().get("show_reasoning", {expected}))',
        ),),
        label="Hermes TUI policy",
    )


def patch_tui_config_source(source: str, values: dict[str, object]) -> str:
    expected = _literal(values["display.show_reasoning"])
    return _replace_exact(
        source,
        ((
            'display = "show" if (cfg.get("display") or {}).get("show_reasoning", True) else "hide"',
            "# NemoClaw compatibility override: missing raw YAML stays hidden.\n"
            f'    display = "show" if (cfg.get("display") or {{}}).get("show_reasoning", {expected}) else "hide"',
        ),),
        label="Hermes TUI config policy",
    )


def patch_agent_source(source: str, values: dict[str, object]) -> str:
    expected = _literal(values["display.show_commentary"])
    return _replace_exact(
        source,
        ((
            'agent.show_commentary = bool(_cfg_dict(_agent_cfg, "display").get("show_commentary", True))',
            "# NemoClaw compatibility override: a missing key keeps commentary hidden.\n"
            f'    agent.show_commentary = bool(_cfg_dict(_agent_cfg, "display").get("show_commentary", {expected}))',
        ),),
        label="Hermes agent policy",
    )


def patch_main_source(source: str, values: dict[str, object]) -> str:
    backup = _literal(values["updates.pre_update_backup"])
    refresh = _literal(values["updates.refresh_cua_driver"])
    replacements = (
        (
            'raw = _load_updates_cfg().get("pre_update_backup", "quick")',
            "# NemoClaw compatibility override: missing config skips state duplication.\n"
            f'        raw = _load_updates_cfg().get("pre_update_backup", {backup})',
        ),
        (
            'raw = "quick"\n\n    if raw is True:',
            f'raw = {backup}  # NemoClaw config-error fallback.\n\n    if raw is True:',
        ),
        (
            "    refresh_cua_driver = True",
            "    # NemoClaw compatibility override: config errors do not fetch CUA updates.\n"
            f"    refresh_cua_driver = {refresh}",
        ),
        (
            '_load_updates_cfg().get("refresh_cua_driver", True)',
            f'_load_updates_cfg().get("refresh_cua_driver", {refresh})',
        ),
    )
    return _replace_exact(source, replacements, label="Hermes update policy")


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
        "--browser-policy",
        default="/opt/hermes/tools/browser_tool_eval_policy.py",
        help="Pinned Hermes browser evaluation policy module",
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
        default="/opt/hermes/hermes_cli/update_cmd_maint.py",
        help="Pinned Hermes main/update module",
    )
    args = parser.parse_args()
    try:
        values = profile_default_values(load_managed_policy(args.policy))
    except ManagedPolicyError as exc:
        raise SystemExit(f"ERROR: {args.policy}: {exc}") from exc

    patch_file(Path(args.config), "config", values)
    patch_file(Path(args.browser), "browser", values)
    patch_file(Path(args.browser_policy), "browser_policy", values)
    patch_file(Path(args.gateway), "gateway", values)
    patch_file(Path(args.cli), "cli", values)
    patch_file(Path(args.tui), "tui", values)
    patch_file(Path(args.tui_config), "tui_config", values)
    patch_file(Path(args.agent), "agent", values)
    patch_file(Path(args.main), "main", values)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
