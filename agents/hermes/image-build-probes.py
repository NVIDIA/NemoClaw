# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Builder-independent assertions for the managed Hermes image."""

from __future__ import annotations

import sys
from collections.abc import Callable
from pathlib import Path


def verify_profile_policy() -> None:
    from types import SimpleNamespace

    from cli import CLI_CONFIG
    from gateway.config import SessionResetPolicy, load_gateway_config
    from hermes_cli import config as hermes_config
    from hermes_cli.config import load_config_readonly
    from hermes_cli.main import _resolve_pre_update_backup_mode
    from tools.browser_tool import (
        _allow_unsafe_browser_evaluate,
        _restrict_browser_evaluate,
    )
    from tui_gateway.server import _load_show_reasoning

    config = load_config_readonly()
    assert config["approvals"]["mode"] == "manual", config["approvals"]
    assert config["browser"]["allow_unsafe_evaluate"] is False, config["browser"]
    assert config["browser"]["restrict_evaluate"] is True, config["browser"]
    assert config["display"]["show_reasoning"] is False, config["display"]
    assert config["display"]["show_commentary"] is False, config["display"]
    assert config["updates"]["pre_update_backup"] is False, config["updates"]
    assert config["updates"]["refresh_cua_driver"] is False, config["updates"]
    assert CLI_CONFIG["display"]["show_reasoning"] is False, CLI_CONFIG["display"]
    assert _allow_unsafe_browser_evaluate() is False
    assert _restrict_browser_evaluate() is True
    assert _load_show_reasoning() is False
    assert SessionResetPolicy().mode == "both"
    assert SessionResetPolicy.from_dict({}).mode == "both"
    gateway = load_gateway_config()
    assert gateway.default_reset_policy.mode == "both", gateway.default_reset_policy
    assert gateway.default_reset_policy.at_hour == 4, gateway.default_reset_policy
    assert gateway.default_reset_policy.idle_minutes == 1440, gateway.default_reset_policy
    tui_source = Path("/opt/hermes/tui_gateway/server.py").read_text(encoding="utf-8")
    assert tui_source.count('.get("show_reasoning", True)') == 0
    assert tui_source.count('.get("show_reasoning", False)') == 2
    agent_source = Path("/opt/hermes/agent/agent_init.py").read_text(encoding="utf-8")
    assert agent_source.count("agent.show_commentary = True") == 0
    assert agent_source.count("agent.show_commentary = False") == 2
    assert agent_source.count('.get("show_commentary", True)') == 0
    assert agent_source.count('.get("show_commentary", False)') == 1
    original_load_config = hermes_config.load_config
    try:

        def fail_config_load():
            raise RuntimeError("nemoclaw build probe")

        hermes_config.load_config = fail_config_load
        args = SimpleNamespace(no_backup=False, backup=False)
        assert _resolve_pre_update_backup_mode(args) == "off"
    finally:
        hermes_config.load_config = original_load_config
    main_source = Path("/opt/hermes/hermes_cli/main.py").read_text(encoding="utf-8")
    assert main_source.count('updates_cfg.get("pre_update_backup", "quick")') == 0
    assert main_source.count('updates_cfg.get("pre_update_backup", False)') == 1
    assert main_source.count("refresh_cua_driver = True") == 0
    assert main_source.count("refresh_cua_driver = False") == 1
    assert main_source.count('_update_cfg.get("refresh_cua_driver", True)') == 0
    assert main_source.count('_update_cfg.get("refresh_cua_driver", False)') == 1


def verify_gateway_runtime_metadata() -> None:
    from gateway.status import (
        _get_gateway_lock_path,
        _get_pid_path,
        _get_process_hermes_home,
        _get_runtime_status_path,
    )

    home = _get_process_hermes_home()
    runtime = home / "runtime"
    assert _get_pid_path() == runtime / "gateway.pid"
    assert _get_gateway_lock_path() == runtime / "gateway.lock"
    assert _get_runtime_status_path() == runtime / "gateway_state.json"
    assert all(
        path.parent == runtime
        for path in (
            _get_pid_path(),
            _get_gateway_lock_path(),
            _get_runtime_status_path(),
        )
    )
    assert isinstance(home, Path)


def verify_cron_runtime_source() -> None:
    from cron.executions import EXECUTIONS_FILE
    from hermes_cli.backup import _QUICK_STATE_FILES
    from hermes_constants import get_hermes_home

    expected = get_hermes_home().resolve() / "runtime" / "cron-executions.db"
    assert EXECUTIONS_FILE == expected
    assert "runtime/cron-executions.db" in _QUICK_STATE_FILES
    assert "cron/executions.db" not in _QUICK_STATE_FILES


def verify_session_preview() -> None:
    from hermes_state import SessionDB

    db = SessionDB()
    session_id = "nemoclaw-preview-smoke"
    db.create_session(session_id, "cli")
    db.append_message(session_id, "user", "NEMOCLAW_PREVIEW_FIRST")
    db.append_message(session_id, "assistant", "ack")
    db.append_message(session_id, "user", "NEMOCLAW_PREVIEW_LATEST")
    rows = db.list_sessions_rich(limit=1)
    assert rows and rows[0]["id"] == session_id, rows
    assert rows[0]["preview"] == "NEMOCLAW_PREVIEW_LATEST", rows


def verify_discord_recovery_source() -> None:
    source = Path("/opt/hermes/plugins/platforms/discord/recovery.py").read_text(
        encoding="utf-8"
    )
    assert source.count('_DB_FILENAME = "discord_message_recovery.db"') == 1
    assert source.count('directory = self._hermes_home / "gateway"') == 1
    assert source.count("os.chmod(path, 0o600)") == 0
    assert source.count("os.chmod(path, 0o660)") == 1


def verify_langfuse_credentials() -> None:
    import importlib.util

    path = "/opt/hermes/plugins/observability/langfuse/__init__.py"
    spec = importlib.util.spec_from_file_location("nemoclaw_langfuse_contract", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    validate = module._validate_langfuse_key
    assert validate("HERMES_LANGFUSE_PUBLIC_KEY", "pk-lf-public") is None
    assert validate("HERMES_LANGFUSE_SECRET_KEY", "sk-lf-secret") is None
    assert (
        validate(
            "HERMES_LANGFUSE_PUBLIC_KEY",
            "openshell:resolve:env:LANGFUSE_PUBLIC_KEY",
        )
        is None
    )
    assert (
        validate(
            "HERMES_LANGFUSE_SECRET_KEY",
            "openshell:resolve:env:v1_LANGFUSE_SECRET_KEY",
        )
        is None
    )
    assert (
        validate(
            "HERMES_LANGFUSE_PUBLIC_KEY",
            "openshell:resolve:env:LANGFUSE_SECRET_KEY",
        )
        is not None
    )
    assert (
        validate(
            "HERMES_LANGFUSE_SECRET_KEY",
            "openshell:resolve:env:v1_LANGFUSE_PUBLIC_KEY",
        )
        is not None
    )


def verify_wrapper_session_boundaries() -> None:
    import ast

    wrapper_tree = ast.parse(
        Path("/usr/local/lib/nemoclaw/hermes-wrapper.py").read_text(encoding="utf-8")
    )
    wrapper_assignments = [
        node
        for node in wrapper_tree.body
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == "_HERMES_SESSION_NAME_BOUNDARIES"
    ]
    if len(wrapper_assignments) != 1:
        raise SystemExit("ERROR: expected one wrapper session-name boundary constant")
    wrapper_value = wrapper_assignments[0].value
    if not (
        isinstance(wrapper_value, ast.Call)
        and isinstance(wrapper_value.func, ast.Name)
        and wrapper_value.func.id == "frozenset"
        and len(wrapper_value.args) == 1
        and not wrapper_value.keywords
    ):
        raise SystemExit("ERROR: wrapper session-name boundaries are not a literal frozenset")
    wrapper_boundaries = set(ast.literal_eval(wrapper_value.args[0]))

    upstream_tree = ast.parse(
        Path("/opt/hermes/hermes_cli/main.py").read_text(encoding="utf-8")
    )
    coalescers = [
        node
        for node in upstream_tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "_coalesce_session_name_args"
    ]
    if len(coalescers) != 1:
        raise SystemExit("ERROR: expected one pinned Hermes session-name coalescer")
    upstream_assignments = [
        node
        for node in coalescers[0].body
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == "_SUBCOMMANDS"
    ]
    if len(upstream_assignments) != 1:
        raise SystemExit("ERROR: expected one pinned Hermes coalescer boundary set")
    upstream_boundaries = set(ast.literal_eval(upstream_assignments[0].value))

    missing = sorted(upstream_boundaries - wrapper_boundaries)
    stale = sorted(wrapper_boundaries - upstream_boundaries)
    if missing or stale:
        raise SystemExit(
            "ERROR: Hermes wrapper session-name boundaries drifted from pinned coalescer: "
            f"missing={','.join(missing)} stale={','.join(stale)}"
        )


def verify_dashboard_policy(path: Path) -> None:
    import yaml

    config = yaml.safe_load(path.read_text(encoding="utf-8"))
    expected = {
        "approvals": {"mode": "manual"},
        "browser": {"restrict_evaluate": True},
        "session_reset": {
            "mode": "both",
            "at_hour": 4,
            "idle_minutes": 1440,
            "notify": True,
            "notify_exclude_platforms": ["api_server", "webhook"],
            "bg_process_max_age_hours": 24,
        },
        "display": {
            "show_reasoning": False,
            "show_commentary": False,
        },
        "updates": {
            "pre_update_backup": False,
            "refresh_cua_driver": False,
        },
    }
    for section, values in expected.items():
        assert config.get(section) == values, (section, config.get(section), values)
    path.unlink()


def verify_cron_create() -> None:
    from cron.executions import create_execution

    created = create_execution(
        "nemoclaw-cross-uid-create-probe",
        source="nemoclaw-image-build",
    )
    assert created["job_id"] == "nemoclaw-cross-uid-create-probe"
    assert created["status"] == "claimed"


def verify_cron_backup() -> None:
    import os
    import sqlite3
    import stat
    import subprocess

    path = Path("/sandbox/.hermes/runtime/cron-executions.db")
    staged = path.with_name(".nemoclaw-cron-executions-staged")
    staged.unlink(missing_ok=True)
    source = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    target = sqlite3.connect(staged, timeout=30)
    try:
        assert source.execute(
            "SELECT job_id, status FROM executions"
        ).fetchone() == ("nemoclaw-cross-uid-create-probe", "claimed")
        source.backup(target)
        assert target.execute("PRAGMA quick_check").fetchone() == ("ok",)
    finally:
        target.close()
        source.close()
    # The gateway belongs to the sandbox group and must reopen this replacement ledger for writing.
    subprocess.run(["chmod", "0660", "--", str(staged)], check=True)
    assert stat.S_IMODE(staged.stat().st_mode) == 0o660
    os.replace(staged, path)
    for suffix in ("-wal", "-shm"):
        path.with_name(f"{path.name}{suffix}").unlink(missing_ok=True)


def verify_cron_reopen() -> None:
    from cron.executions import create_execution, list_executions

    created = create_execution(
        "nemoclaw-cross-uid-reopen-probe",
        source="nemoclaw-image-build",
    )
    assert created["job_id"] == "nemoclaw-cross-uid-reopen-probe"
    assert {row["job_id"] for row in list_executions(limit=10)} == {
        "nemoclaw-cross-uid-create-probe",
        "nemoclaw-cross-uid-reopen-probe",
    }


def verify_discord_create() -> None:
    from plugins.platforms.discord.recovery import DiscordRecoveryStore

    store = DiscordRecoveryStore(Path("/sandbox/.hermes"))

    def create_probe(conn):
        conn.execute(
            "CREATE TABLE IF NOT EXISTS nemoclaw_identity_probe "
            "(value TEXT NOT NULL)"
        )
        conn.execute("DELETE FROM nemoclaw_identity_probe")
        conn.execute(
            "INSERT INTO nemoclaw_identity_probe(value) VALUES (?)",
            ("gateway-created",),
        )
        return True

    assert store.call(create_probe, default=False) is True


def verify_discord_backup() -> None:
    import os
    import sqlite3
    import stat
    import subprocess

    path = Path("/sandbox/.hermes/gateway/discord_message_recovery.db")
    staged = path.with_name(".nemoclaw-discord-recovery-staged")
    staged.unlink(missing_ok=True)
    source = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    target = sqlite3.connect(staged, timeout=30)
    try:
        assert source.execute(
            "SELECT value FROM nemoclaw_identity_probe"
        ).fetchone() == ("gateway-created",)
        source.backup(target)
        assert target.execute("PRAGMA quick_check").fetchone() == ("ok",)
    finally:
        target.close()
        source.close()
    # The gateway belongs to the sandbox group and must reopen this replacement ledger for writing.
    subprocess.run(["chmod", "0660", "--", str(staged)], check=True)
    assert stat.S_IMODE(staged.stat().st_mode) == 0o660
    os.replace(staged, path)


def verify_discord_reopen() -> None:
    from plugins.platforms.discord.recovery import DiscordRecoveryStore

    store = DiscordRecoveryStore(Path("/sandbox/.hermes"))

    def reopen_probe(conn):
        conn.execute(
            "UPDATE nemoclaw_identity_probe SET value = ?",
            ("gateway-reopened",),
        )
        return conn.execute(
            "SELECT value FROM nemoclaw_identity_probe"
        ).fetchone()

    assert store.call(reopen_probe) == ("gateway-reopened",)


COMMANDS: dict[str, Callable[[], None]] = {
    "cron-backup": verify_cron_backup,
    "cron-create": verify_cron_create,
    "cron-reopen": verify_cron_reopen,
    "cron-runtime-source": verify_cron_runtime_source,
    "discord-backup": verify_discord_backup,
    "discord-create": verify_discord_create,
    "discord-recovery-source": verify_discord_recovery_source,
    "discord-reopen": verify_discord_reopen,
    "gateway-runtime-metadata": verify_gateway_runtime_metadata,
    "langfuse-credentials": verify_langfuse_credentials,
    "profile-policy": verify_profile_policy,
    "session-preview": verify_session_preview,
    "wrapper-session-boundaries": verify_wrapper_session_boundaries,
}


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "dashboard-policy":
        verify_dashboard_policy(Path(argv[2]))
        return 0
    if len(argv) != 2 or argv[1] not in COMMANDS:
        commands = ", ".join(sorted([*COMMANDS, "dashboard-policy"]))
        raise SystemExit(f"usage: {Path(argv[0]).name} <command> [path]\ncommands: {commands}")
    COMMANDS[argv[1]]()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
