# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Builder-independent assertions for the managed Hermes image."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

sys.path.insert(0, "/usr/local/lib/nemoclaw")


def _run_required_build_command(
    label: str, argv: Sequence[str], *, env: Mapping[str, str]
) -> None:
    result = subprocess.run(argv, env=env, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"{label} exited with status {result.returncode}")


def prepare_generated_config(
    *,
    hermes: Path = Path("/usr/local/bin/hermes"),
    node: Path = Path("/usr/local/bin/node"),
    generator: Path = Path("/opt/nemoclaw-hermes-config/generate-config.ts"),
    hermes_home: Path = Path("/sandbox/.hermes"),
    env: Mapping[str, str] | None = None,
) -> None:
    """Run upstream repair before NemoClaw replaces its generated config."""
    child_env = dict(os.environ if env is None else env)
    child_env["HERMES_HOME"] = str(hermes_home)
    _run_required_build_command(
        "Hermes doctor", [str(hermes), "doctor", "--fix"], env=child_env
    )
    _run_required_build_command(
        "Hermes config generator",
        [str(node), "--experimental-strip-types", str(generator)],
        env=child_env,
    )


def verify_compatibility_retirement(
    *,
    hermes: Path = Path("/usr/local/bin/hermes"),
    adapter: Path = Path("/usr/local/share/nemoclaw/hermes-cli-adapter-v1.json"),
    oneshot: Path = Path("/opt/hermes/hermes_cli/oneshot.py"),
) -> None:
    """Reject an upgrade that retains Hermes 0.20.6 compatibility behavior."""
    result = subprocess.run(
        [str(hermes), "--version"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Hermes version probe exited with status {result.returncode}")
    version_output = result.stdout.strip()
    match = re.search(
        r"(?:^|[^0-9])v?([0-9]+\.[0-9]+\.[0-9]+)(?:$|[^0-9])",
        version_output,
    )
    if match is None:
        raise RuntimeError(f"could not parse Hermes semver from: {version_output}")
    semver = match.group(1)
    if semver != "0.20.6" and '"resumed_oneshot"' in adapter.read_text(encoding="utf-8"):
        raise RuntimeError(
            f"installed Hermes {semver} but Hermes v0.20.6 compatibility workarounds "
            "are still installed; re-review the workaround set before upgrading Hermes"
        )
    if (
        "process_registry.wait_for_pending_completions(oneshot_task_id)"
        not in oneshot.read_text(encoding="utf-8")
    ):
        raise RuntimeError("Hermes one-shot completion wait is not scoped to the exact turn")


def _verify_profile_config_policy(config: dict, expected: dict[str, object]) -> None:
    from managed_policy import policy_value

    for path, value in expected.items():
        if path.startswith("session_reset."):
            continue
        actual = policy_value(config, path)
        assert actual == value, (path, actual, value)


def _verify_session_reset_policy(reset_policy: object, expected: dict[str, object]) -> None:
    for field in ("mode", "at_hour", "idle_minutes"):
        path = f"session_reset.{field}"
        actual = getattr(reset_policy, field)
        assert actual == expected[path], (path, actual, expected[path])


def verify_profile_policy() -> None:
    from types import SimpleNamespace

    from cli import CLI_CONFIG
    from gateway.config import SessionResetPolicy, load_gateway_config
    from hermes_cli import config as hermes_config
    from hermes_cli.config import load_config_readonly
    from hermes_cli.main import _resolve_pre_update_backup_mode
    from managed_policy import load_managed_policy, profile_default_values
    from tools.browser_tool import (
        _allow_unsafe_browser_evaluate,
        _restrict_browser_evaluate,
    )
    from tui_gateway.server import _load_show_reasoning

    policy = load_managed_policy()
    expected = profile_default_values(policy)
    config = load_config_readonly()
    _verify_profile_config_policy(config, expected)
    assert CLI_CONFIG["display"]["show_reasoning"] == expected["display.show_reasoning"]
    assert _allow_unsafe_browser_evaluate() == expected["browser.allow_unsafe_evaluate"]
    assert _restrict_browser_evaluate() == expected["browser.restrict_evaluate"]
    assert _load_show_reasoning() == expected["display.show_reasoning"]
    _verify_session_reset_policy(SessionResetPolicy(), expected)
    _verify_session_reset_policy(SessionResetPolicy.from_dict({}), expected)
    gateway = load_gateway_config()
    _verify_session_reset_policy(gateway.default_reset_policy, expected)
    original_load_config = hermes_config.load_config
    try:

        def fail_config_load():
            raise RuntimeError("nemoclaw build probe")

        hermes_config.load_config = fail_config_load
        args = SimpleNamespace(no_backup=False, backup=False)
        expected_backup_mode = (
            "off"
            if expected["updates.pre_update_backup"] is False
            else str(expected["updates.pre_update_backup"])
        )
        assert _resolve_pre_update_backup_mode(args) == expected_backup_mode
    finally:
        hermes_config.load_config = original_load_config


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


def verify_gateway_process_identity() -> None:
    from gateway.status import (
        _gateway_command_subcommand,
        looks_like_gateway_command_line,
        looks_like_gateway_runtime_command_line,
    )

    renamed = "/opt/hermes/.venv/bin/python /usr/local/bin/hermes.real gateway run"
    upstream = "/opt/hermes/.venv/bin/python /usr/local/bin/hermes gateway run"

    assert looks_like_gateway_command_line(renamed)
    assert looks_like_gateway_runtime_command_line(renamed)
    assert _gateway_command_subcommand(renamed) == "run"
    assert _gateway_command_subcommand(
        "/opt/hermes/.venv/bin/python /usr/local/bin/hermes.real gateway restart"
    ) == "restart"

    assert looks_like_gateway_command_line(upstream)
    assert not looks_like_gateway_command_line(
        "/opt/hermes/.venv/bin/python /usr/local/bin/hermes.real gateway status"
    )
    assert not looks_like_gateway_command_line(
        "/opt/hermes/.venv/bin/python /usr/local/bin/hermes.real dashboard"
    )
    assert not looks_like_gateway_command_line("python -m tui_gateway run")
    assert not looks_like_gateway_command_line(
        "/opt/hermes/.venv/bin/python /usr/local/bin/hermes.realish gateway run"
    )


def verify_neutral_platform_inertness() -> None:
    import socket

    from gateway.config import Platform, load_gateway_config

    original_connect = socket.socket.connect
    original_create_connection = socket.create_connection

    def reject_network(*_args, **_kwargs):
        raise AssertionError("neutral Hermes configuration attempted a network connection")

    socket.socket.connect = reject_network
    socket.create_connection = reject_network
    try:
        config = load_gateway_config()
    finally:
        socket.socket.connect = original_connect
        socket.create_connection = original_create_connection
    for name in ("a2a", "buzz", "google_chat", "whatsapp_cloud"):
        platform = Platform(name)
        platform_config = config.platforms.get(platform)
        assert platform_config is not None, name
        assert platform_config.enabled is False, (name, platform_config)
        assert platform_config.token is None, (name, platform_config.token)
        assert platform_config.api_key is None, (name, platform_config.api_key)
        assert platform_config.extra == {}, (name, platform_config.extra)


def verify_cron_runtime_source() -> None:
    from cron.executions import EXECUTIONS_FILE, _connect
    from hermes_cli.backup import _QUICK_STATE_FILES
    from hermes_constants import get_hermes_home

    expected = get_hermes_home().resolve() / "runtime" / "cron-executions.db"
    assert EXECUTIONS_FILE is None
    connection = _connect()
    try:
        databases = connection.execute("PRAGMA database_list").fetchall()
    finally:
        connection.close()
    assert databases == [(0, "main", str(expected))], databases
    assert "runtime/cron-executions.db" in _QUICK_STATE_FILES
    assert "cron/executions.db" not in _QUICK_STATE_FILES


def verify_session_preview() -> None:
    import contextlib
    import io
    from types import SimpleNamespace

    from hermes_cli.sessions_cmd import cmd_sessions
    from hermes_state import SessionDB

    db = SessionDB()
    session_id = "nemoclaw-preview-smoke"
    db.create_session(session_id, "cli", cwd="/sandbox")
    assert db.set_auto_title(
        session_id,
        "NEMOCLAW_PREVIEW_FIRST",
        source=SessionDB.TITLE_SOURCE_DERIVED,
    )
    db.append_message(session_id, "user", "NEMOCLAW_PREVIEW_FIRST")
    db.append_message(session_id, "assistant", "ack")
    db.append_message(session_id, "user", "NEMOCLAW_PREVIEW_LATEST")
    rows = db.list_sessions_rich(limit=1)
    assert rows and rows[0]["id"] == session_id, rows
    assert rows[0]["preview"] == "NEMOCLAW_PREVIEW_LATEST", rows
    db.close()

    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = cmd_sessions(
            SimpleNamespace(
                sessions_action="list",
                source=None,
                limit=1,
                workspace=None,
            )
        )
    rendered = output.getvalue()
    assert result is None, result
    assert "NEMOCLAW_PREVIEW_LATEST" in rendered, rendered
    assert "NEMOCLAW_PREVIEW_FIRST" not in rendered, rendered

    db = SessionDB()
    assert db.set_session_title(session_id, "NEMOCLAW_USER_TITLE")
    db.close()
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = cmd_sessions(
            SimpleNamespace(
                sessions_action="list",
                source=None,
                limit=1,
                workspace=None,
            )
        )
    rendered = output.getvalue()
    assert result is None, result
    assert "NEMOCLAW_USER_TITLE" in rendered, rendered
    assert "NEMOCLAW_PREVIEW_LATEST" not in rendered, rendered


def verify_session_delete() -> None:
    from hermes_state import SessionDB

    db = SessionDB()
    session_id = "nemoclaw-session-delete-smoke"
    db.create_session(session_id, "cli")
    db.append_message(session_id, "user", "probe message 1")
    db.append_message(session_id, "assistant", "probe reply")
    deleted = db.delete_session(session_id)
    assert deleted, f"delete_session returned {deleted!r}"
    rows = db.list_sessions_rich(limit=10)
    assert not any(r["id"] == session_id for r in rows), "session still present after delete"


_SESSION_STATE_PROBE_ID = "nemoclaw-cross-uid-session-probe"
_SESSION_STATE_DIRECTORY = Path("/sandbox/.hermes/runtime")
_SESSION_STATE_SIDECAR_NAMES = ("state.db-wal", "state.db-shm")


def _session_state_journal_mode(db: object) -> str:
    connection = getattr(db, "_conn")
    row = connection.execute("PRAGMA journal_mode").fetchone()
    assert row and isinstance(row[0], str), row
    journal_mode = row[0].lower()
    assert journal_mode in {"delete", "wal"}, journal_mode
    return journal_mode


def _verify_session_state_metadata(
    journal_mode: str, expected_owners: dict[str, str]
) -> None:
    import grp
    import pwd
    import stat

    expected_names = {"state.db"}
    if journal_mode == "wal":
        expected_names.update(_SESSION_STATE_SIDECAR_NAMES)
    elif journal_mode == "delete":
        for name in _SESSION_STATE_SIDECAR_NAMES:
            path = _SESSION_STATE_DIRECTORY / name
            try:
                metadata = path.lstat()
            except FileNotFoundError:
                continue
            raise AssertionError((path, metadata))
    else:
        raise AssertionError(journal_mode)

    assert set(expected_owners) == expected_names, expected_owners
    for name in expected_names:
        path = _SESSION_STATE_DIRECTORY / name
        metadata = path.lstat()
        assert stat.S_ISREG(metadata.st_mode), (path, metadata)
        assert metadata.st_nlink == 1, (path, metadata.st_nlink)
        assert pwd.getpwuid(metadata.st_uid).pw_name == expected_owners[name], (
            path,
            metadata.st_uid,
        )
        assert grp.getgrgid(metadata.st_gid).gr_name == "sandbox", (path, metadata.st_gid)
        assert stat.S_IMODE(metadata.st_mode) == 0o660, (path, oct(metadata.st_mode))


def verify_session_state_create() -> None:
    from hermes_state import SessionDB

    db = SessionDB()
    try:
        db.create_session(_SESSION_STATE_PROBE_ID, "gateway")
        db.append_message(_SESSION_STATE_PROBE_ID, "user", "gateway-created")
        rows = db.list_sessions_rich(limit=10)
        assert any(row["id"] == _SESSION_STATE_PROBE_ID for row in rows), rows
        journal_mode = _session_state_journal_mode(db)
        expected_owners = {"state.db": "gateway"}
        if journal_mode == "wal":
            expected_owners.update(
                {name: "gateway" for name in _SESSION_STATE_SIDECAR_NAMES}
            )
        _verify_session_state_metadata(journal_mode, expected_owners)
    finally:
        db.close()


def verify_session_state_reopen() -> None:
    from hermes_state import SessionDB

    db = SessionDB()
    try:
        rows = db.list_sessions_rich(limit=10)
        assert any(row["id"] == _SESSION_STATE_PROBE_ID for row in rows), rows
        db.append_message(_SESSION_STATE_PROBE_ID, "assistant", "sandbox-appended")
        messages = db.get_messages(_SESSION_STATE_PROBE_ID)
        assert [message["content"] for message in messages[-2:]] == [
            "gateway-created",
            "sandbox-appended",
        ], messages
        journal_mode = _session_state_journal_mode(db)
        expected_owners = {"state.db": "gateway"}
        if journal_mode == "wal":
            expected_owners.update(
                {name: "sandbox" for name in _SESSION_STATE_SIDECAR_NAMES}
            )
        _verify_session_state_metadata(journal_mode, expected_owners)
        assert db.delete_session(_SESSION_STATE_PROBE_ID)
        assert not any(
            row["id"] == _SESSION_STATE_PROBE_ID
            for row in db.list_sessions_rich(limit=10)
        )
    finally:
        db.close()


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
    validate_base_url = module._validate_langfuse_base_url
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
    assert validate_base_url("https://cloud.langfuse.com") is None
    assert validate_base_url("https://langfuse.example.test:8443/base") is None
    assert validate_base_url("http://cloud.langfuse.com") is not None
    assert validate_base_url("https://user:pass@cloud.langfuse.com") is not None
    assert validate_base_url("https://cloud.langfuse.com?project=other") is not None
    assert validate_base_url("https://cloud.langfuse.com#fragment") is not None
    assert validate_base_url("https://cloud.langfuse.com:invalid") is not None
    assert (
        validate(
            "HERMES_LANGFUSE_SECRET_KEY",
            "openshell:resolve:env:v1_LANGFUSE_PUBLIC_KEY",
        )
        is not None
    )


def verify_dashboard_policy(path: Path) -> None:
    import yaml
    from managed_policy import load_managed_policy, policy_value

    config = yaml.safe_load(path.read_text(encoding="utf-8"))
    policy = load_managed_policy()
    for dotted_path in policy["managed_paths"]:
        expected = policy_value(policy["config"], dotted_path)
        actual = policy_value(config, dotted_path)
        assert actual == expected, (dotted_path, actual, expected)
    path.unlink()


def verify_cron_create() -> None:
    from cron.executions import create_execution

    created = create_execution(
        "nemoclaw-cross-uid-create-probe",
        source="nemoclaw-image-build",
    )
    assert created["job_id"] == "nemoclaw-cross-uid-create-probe"
    assert created["status"] == "claimed"


def verify_secure_directory_modes() -> None:
    import stat

    from hermes_cli.config import _secure_dir

    assert os.environ.get("HERMES_SKIP_CHMOD") == "1"
    expected_modes = {
        Path("/sandbox/.hermes"): 0o3770,
        Path("/sandbox/.hermes/runtime"): 0o2770,
    }
    for path, expected_mode in expected_modes.items():
        before = path.stat()
        assert stat.S_IMODE(before.st_mode) == expected_mode, (
            path,
            oct(before.st_mode),
        )
        _secure_dir(path)
        after = path.stat()
        assert (after.st_uid, after.st_gid) == (before.st_uid, before.st_gid), (
            path,
            before,
            after,
        )
        assert stat.S_IMODE(after.st_mode) == expected_mode, (
            path,
            oct(after.st_mode),
        )


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


def verify_googlechat_override_seams() -> None:
    """Fail the build when a Google Chat definition the channel override binds moves.

    The override subclasses the bundled adapter because ``PlatformEntry`` carries
    no credential or transport field. Those names are Hermes internals, so pin
    them: an upgrade that renames one stops the build instead of letting the
    channel fall back to the stock adapter unnoticed.
    """
    path = "/opt/hermes/plugins/platforms/google_chat/adapter.py"
    source = Path(path).read_text(encoding="utf-8")
    expected = {
        "def _validate_config(self) -> Tuple[str, Optional[str]]:": 1,
        "def _load_sa_credentials(self) -> Any:": 1,
        "def _new_authed_http(self) -> Any:": 1,
        "async def connect(self, *, is_reconnect: bool = False) -> bool:": 1,
        # connect() gates its gRPC subscriber precheck and its own supervisor on
        # this test; the override reports no subscription so both are skipped.
        "if subscription_path is not None:": 2,
    }
    for needle, count in expected.items():
        actual = source.count(needle)
        assert actual == count, (
            f"{path}: expected {count} occurrence(s) of {needle!r}, found {actual}. "
            "The Google Chat channel override binds this definition; re-review "
            "src/lib/messaging/channels/googlechat/runtime/hermes-adapter.py before "
            "upgrading Hermes."
        )


def verify_managed_runtime_capability() -> None:
    """Require the packaged ACP adapter and lazy MCP HTTP client surfaces."""
    import importlib.metadata as metadata

    import acp
    import mcp
    from acp_adapter.server import HermesACPAgent
    from tools import mcp_tool

    _ = (acp, mcp, HermesACPAgent)
    if metadata.version("agent-client-protocol") != "0.9.0":
        raise RuntimeError("Hermes ACP SDK version is unavailable")
    if not mcp_tool._ensure_mcp_sdk() or not getattr(mcp_tool, "_MCP_AVAILABLE", False):
        raise RuntimeError("Hermes MCP client runtime is unavailable")
    if not getattr(mcp_tool, "_MCP_HTTP_AVAILABLE", False):
        raise RuntimeError("Hermes MCP Streamable HTTP runtime is unavailable")


COMMANDS: dict[str, Callable[[], None]] = {
    "compatibility-retirement": verify_compatibility_retirement,
    "cron-backup": verify_cron_backup,
    "cron-create": verify_cron_create,
    "cron-reopen": verify_cron_reopen,
    "cron-runtime-source": verify_cron_runtime_source,
    "discord-backup": verify_discord_backup,
    "discord-create": verify_discord_create,
    "discord-recovery-source": verify_discord_recovery_source,
    "discord-reopen": verify_discord_reopen,
    "gateway-process-identity": verify_gateway_process_identity,
    "googlechat-override-seams": verify_googlechat_override_seams,
    "gateway-runtime-metadata": verify_gateway_runtime_metadata,
    "langfuse-credentials": verify_langfuse_credentials,
    "managed-runtime-capability": verify_managed_runtime_capability,
    "neutral-platform-inertness": verify_neutral_platform_inertness,
    "profile-policy": verify_profile_policy,
    "prepare-generated-config": prepare_generated_config,
    "session-delete": verify_session_delete,
    "session-preview": verify_session_preview,
    "session-state-create": verify_session_state_create,
    "session-state-reopen": verify_session_state_reopen,
    "secure-directory-modes": verify_secure_directory_modes,
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
