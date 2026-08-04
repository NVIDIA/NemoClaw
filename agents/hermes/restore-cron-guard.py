#!/opt/hermes/.venv/bin/python -I
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Quiesce Hermes cron dispatch while NemoClaw restores scheduled work state."""

from __future__ import annotations

import argparse
import grp
import json
import os
import pwd
import secrets
import stat
import sys
import time
from pathlib import Path
from typing import Any

_OWNER_PREFIX = "nemoclaw-state-restore:"
_POLL_INTERVAL_SECONDS = 0.1
_OWNERSHIP_FILE = ".nemoclaw-restore-drain"
_GATEWAY_USER = "gateway"


def _configure_home(raw_home: str) -> Path:
    home = Path(raw_home)
    if not home.is_absolute():
        raise ValueError("Hermes restore guard requires an absolute --home path")
    os.environ["HERMES_HOME"] = str(home)
    return home


def _gateway_modules() -> tuple[Any, Any]:
    from gateway import drain_control, status

    return drain_control, status


def _runtime_is_safely_drained(status: Any, pid: int) -> bool:
    runtime = status.read_runtime_status()
    return bool(
        isinstance(runtime, dict)
        and runtime.get("pid") == pid
        and runtime.get("gateway_state") == "draining"
        and status.parse_active_agents(runtime.get("active_agents")) == 0
    )


def _owned_marker_present(drain_control: Any, home: Path, token: str) -> bool:
    marker = drain_control.read_drain_request(home=home)
    return bool(isinstance(marker, dict) and marker.get("principal") == token)


def _release_owned_marker(drain_control: Any, home: Path, token: str) -> None:
    if not _owned_marker_present(drain_control, home, token):
        return
    if not drain_control.clear_drain_request(home=home):
        raise RuntimeError("Hermes restore guard could not clear its drain marker")


def _ownership_path(home: Path) -> Path:
    return home / _OWNERSHIP_FILE


def _claim_ownership(home: Path, token: str) -> bool:
    try:
        descriptor = os.open(
            _ownership_path(home), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600
        )
    except FileExistsError:
        return False
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(token)
    return True


def _release_ownership(home: Path, token: str) -> None:
    path = _ownership_path(home)
    try:
        recorded = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return
    if recorded == token:
        path.unlink(missing_ok=True)


def begin_drain(home: Path, timeout_seconds: float) -> str:
    drain_control, status = _gateway_modules()
    token = f"{_OWNER_PREFIX}{secrets.token_hex(16)}"
    if not _claim_ownership(home, token):
        raise RuntimeError("Another NemoClaw restore already owns the Hermes drain")

    owned = False
    try:
        if drain_control.drain_requested(home=home):
            result = "preserved"
        else:
            drain_control.write_drain_request(principal=token, home=home)
            owned = True
            result = token

        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            live_pid = status.get_running_pid()
            if live_pid is None or _runtime_is_safely_drained(status, live_pid):
                if not owned:
                    _release_ownership(home, token)
                return result
            time.sleep(_POLL_INTERVAL_SECONDS)
    except BaseException:
        if owned:
            _release_owned_marker(drain_control, home, token)
        _release_ownership(home, token)
        raise

    if owned:
        _release_owned_marker(drain_control, home, token)
    _release_ownership(home, token)
    raise TimeoutError(
        f"Hermes gateway did not drain active messaging, API, and cron work within {timeout_seconds:g}s"
    )


def assert_safely_drained(home: Path) -> None:
    drain_control, status = _gateway_modules()
    pid = status.get_running_pid()
    if pid is None:
        return
    if not drain_control.drain_requested(home=home) or not _runtime_is_safely_drained(
        status, pid
    ):
        raise RuntimeError("Hermes gateway is not safely drained for scheduled-work restore")


def _gateway_identity() -> tuple[int, set[int]] | None:
    try:
        entry = pwd.getpwnam(_GATEWAY_USER)
    except KeyError:
        return None
    memberships = {
        group.gr_gid for group in grp.getgrall() if _GATEWAY_USER in group.gr_mem
    }
    memberships.add(entry.pw_gid)
    return entry.pw_uid, memberships


def _readable_by_gateway(script_path: Path) -> bool:
    identity = _gateway_identity()
    if identity is None:
        return os.access(script_path, os.R_OK)
    uid, gids = identity
    if uid == os.geteuid():
        return os.access(script_path, os.R_OK)
    info = script_path.stat()
    if info.st_uid == uid:
        return bool(info.st_mode & stat.S_IRUSR)
    if info.st_gid in gids:
        return bool(info.st_mode & stat.S_IRGRP)
    return bool(info.st_mode & stat.S_IROTH)


def _load_jobs(jobs_file: Path) -> list[Any]:
    if not jobs_file.exists():
        return []
    data = json.loads(jobs_file.read_text(encoding="utf-8-sig"))
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
    if not isinstance(jobs, list):
        raise ValueError("Hermes cron database must contain a jobs list")
    return jobs


def validate_enabled_scripts(home: Path) -> None:
    scripts_dir = (home / "scripts").resolve()
    for index, job in enumerate(_load_jobs(home / "cron" / "jobs.json")):
        if not isinstance(job, dict):
            raise ValueError(f"Hermes cron job at index {index} is not an object")
        if not job.get("enabled", True) or job.get("state") == "paused":
            continue
        script = job.get("script")
        if script in {None, ""}:
            if job.get("no_agent"):
                raise ValueError(
                    f"Enabled no-agent Hermes cron job at index {index} has no script"
                )
            continue
        if not isinstance(script, str):
            raise ValueError(f"Enabled Hermes cron job at index {index} has a non-string script")
        raw_path = Path(script).expanduser()
        script_path = (
            raw_path.resolve()
            if raw_path.is_absolute()
            else (scripts_dir / raw_path).resolve()
        )
        try:
            script_path.relative_to(scripts_dir)
        except ValueError as error:
            raise ValueError(
                f"Enabled Hermes cron job at index {index} resolves outside the scripts directory"
            ) from error
        if not script_path.is_file() or not _readable_by_gateway(script_path):
            raise ValueError(
                f"Enabled Hermes cron job at index {index} references a missing or unreadable script"
            )


def validate_restore(home: Path) -> None:
    assert_safely_drained(home)
    validate_enabled_scripts(home)


def release_drain(home: Path, token: str) -> None:
    if not token.startswith(_OWNER_PREFIX) or len(token) != len(_OWNER_PREFIX) + 32:
        raise ValueError("Invalid Hermes restore drain ownership token")
    drain_control, _status = _gateway_modules()
    _release_owned_marker(drain_control, home, token)
    _release_ownership(home, token)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("begin", "assert-safe", "validate", "release"))
    parser.add_argument("--home", required=True)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--token")
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        home = _configure_home(args.home)
        if args.action == "begin":
            if args.timeout <= 0:
                raise ValueError("Hermes restore drain timeout must be positive")
            print(begin_drain(home, args.timeout))
        elif args.action == "assert-safe":
            assert_safely_drained(home)
        elif args.action == "validate":
            validate_restore(home)
        else:
            if not args.token:
                raise ValueError("Hermes restore drain release requires --token")
            release_drain(home, args.token)
        return 0
    except Exception as error:
        print(f"Hermes restore guard failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
