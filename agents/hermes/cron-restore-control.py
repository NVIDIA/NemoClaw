# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Control Hermes cron dispatch while NemoClaw restores durable state.

Cron restore control is the rebuild-time gate that keeps dispatch disabled until
backed-up scripts and job definitions are valid and the replacement gateway is
ready. The initial gateway identity is pinned across begin and validate. The
replacement identity is observed around managed health verification, and the
complete action requires that same live identity before releasing the gate. A
drain token is the client-side secret proving ownership of the server-side
persisted drain marker.

Before release, the controller durably writes a separate root-owned recovery
record with the original gate-acquisition time. That write-ahead record survives
a failed marker rollback and lets ``prepare-recover`` reacquire the same gate
before host gateway repair. ``recover`` then validates cron state before
clearing NemoClaw-owned recovery state.
"""

from __future__ import annotations

import argparse
import fcntl
import hmac
import json
import os
import secrets
import stat
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

HERMES_HOME = Path("/sandbox/.hermes")
SANDBOX_HOME = Path("/sandbox")
NEMOCLAW_HOME = SANDBOX_HOME / ".nemoclaw"
CONTROL_LOCK_PATH = Path("/run/nemoclaw/hermes-cron-restore-control.lock")
CONTROL_MARKER_NAME = "hermes-cron-restore-drain.json"
RELEASE_RECOVERY_NAME = "hermes-cron-restore-release-recovery.json"
RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:"
CONTROL_ERROR_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_ERROR_V1:"
CONTROL_ERROR_CODE = "control-failure"
DRAIN_MARKER_ROLLBACK_FAILED_CODE = "drain-marker-rollback-failed"
BEGIN_TIMEOUT_SECONDS = 60.0
RELEASE_TIMEOUT_SECONDS = 15.0
POLL_SECONDS = 0.1
MAX_JOBS_BYTES = 8 * 1024 * 1024
MAX_MARKER_BYTES = 4096
ROOT_UID = 0
ROOT_GID = 0


class ControlError(RuntimeError):
    """Expected fail-closed control or validation error."""

    def __init__(self, message: str, *, code: str = CONTROL_ERROR_CODE) -> None:
        super().__init__(message)
        self.code = code


def _emit_control_error(error: ControlError) -> None:
    """Write the stable control signal after the existing human-readable error."""
    print(f"HERMES_CRON_RESTORE_ERROR: {error}", file=sys.stderr)
    print(
        CONTROL_ERROR_PREFIX
        + json.dumps(
            {"code": error.code, "message": str(error)},
            separators=(",", ":"),
            sort_keys=True,
        ),
        file=sys.stderr,
    )


def _marker_path() -> Path:
    return NEMOCLAW_HOME / CONTROL_MARKER_NAME


def _release_recovery_path() -> Path:
    return NEMOCLAW_HOME / RELEASE_RECOVERY_NAME


def _require_root() -> None:
    if os.geteuid() != ROOT_UID or os.getegid() != ROOT_GID:
        raise ControlError("Hermes cron restore control requires root")


def _require_secure_directory(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ControlError(f"{label} is unavailable") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise ControlError(f"{label} is not a regular directory")
    if metadata.st_uid != ROOT_UID or metadata.st_gid != ROOT_GID:
        raise ControlError(f"{label} is not root-owned")
    if stat.S_IMODE(metadata.st_mode) & 0o022:
        raise ControlError(f"{label} is writable outside root")


def _fsync_directory(path: Path, label: str) -> None:
    """Durably order a state-directory entry transition."""
    _require_secure_directory(path, label)
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ControlError(f"{label} could not be opened for durability") from error
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != ROOT_UID
            or metadata.st_gid != ROOT_GID
            or stat.S_IMODE(metadata.st_mode) & 0o022
        ):
            raise ControlError(f"{label} metadata is unsafe for durability")
        os.fsync(descriptor)
    except OSError as error:
        raise ControlError(f"{label} durability sync failed") from error
    finally:
        os.close(descriptor)


@contextmanager
def _control_lock() -> Iterator[None]:
    _require_root()
    _require_secure_directory(CONTROL_LOCK_PATH.parent, "cron restore lock directory")
    flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(CONTROL_LOCK_PATH, flags, 0o600)
    except OSError as error:
        raise ControlError("Hermes cron restore control lock is unavailable") from error
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != ROOT_UID
            or metadata.st_gid != ROOT_GID
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            raise ControlError("Hermes cron restore control lock metadata is unsafe")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    except OSError as error:
        raise ControlError("Hermes cron restore control lock failed") from error
    finally:
        os.close(descriptor)


def _validate_marker_metadata(metadata: os.stat_result, label: str) -> None:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != ROOT_UID
        or metadata.st_gid != ROOT_GID
        or stat.S_IMODE(metadata.st_mode) != 0o400
        or metadata.st_nlink != 1
    ):
        raise ControlError(f"{label} metadata is unsafe")
    if metadata.st_size <= 0 or metadata.st_size > MAX_MARKER_BYTES:
        raise ControlError(f"{label} size is invalid")


def _read_owned_payload(
    path: Path,
    label: str,
    *,
    required: bool,
) -> tuple[dict[str, Any], os.stat_result] | None:
    _require_secure_directory(NEMOCLAW_HOME, "NemoClaw state root")
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError as error:
        if not required:
            return None
        raise ControlError(f"{label} is not active") from error
    except OSError as error:
        raise ControlError(f"{label} is unreadable") from error
    try:
        metadata = os.fstat(descriptor)
        _validate_marker_metadata(metadata, label)
        raw = os.read(descriptor, MAX_MARKER_BYTES + 1)
    except OSError as error:
        raise ControlError(f"{label} is unreadable") from error
    finally:
        os.close(descriptor)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError) as error:
        raise ControlError(f"{label} is invalid") from error
    if not isinstance(payload, dict):
        raise ControlError(f"{label} has an invalid schema")
    return payload, metadata


def _validate_drain_token(payload: dict[str, Any], label: str) -> str:
    token = payload.get("token")
    if (
        not isinstance(token, str)
        or len(token) != 32
        or not token.isascii()
        or not all(character.isalnum() or character in "-_" for character in token)
    ):
        raise ControlError(f"{label} has an invalid token")
    return token


def _read_owned_token_record(
    path: Path,
    label: str,
    *,
    required: bool,
) -> tuple[str, os.stat_result] | None:
    observed = _read_owned_payload(path, label, required=required)
    if observed is None:
        return None
    payload, metadata = observed
    if set(payload) != {"token", "version"} or payload.get("version") != 1:
        raise ControlError(f"{label} has an invalid schema")
    return _validate_drain_token(payload, label), metadata


def _read_owned_token(path: Path, label: str, *, required: bool) -> str | None:
    observed = _read_owned_token_record(path, label, required=required)
    return None if observed is None else observed[0]


def _read_owned_drain_token(*, required: bool = True) -> str | None:
    return _read_owned_token(
        _marker_path(),
        "NemoClaw cron restore drain marker",
        required=required,
    )


def _read_release_recovery(
    *,
    required: bool = True,
) -> tuple[str, int] | None:
    observed = _read_owned_payload(
        _release_recovery_path(),
        "NemoClaw cron restore release recovery record",
        required=required,
    )
    if observed is None:
        return None
    payload, _metadata = observed
    if (
        set(payload) != {"drain_started_at_ns", "token", "version"}
        or payload.get("version") != 2
    ):
        raise ControlError(
            "NemoClaw cron restore release recovery record has an invalid schema"
        )
    started_at_ns = payload.get("drain_started_at_ns")
    if (
        isinstance(started_at_ns, bool)
        or not isinstance(started_at_ns, int)
        or started_at_ns <= 0
        or started_at_ns > (1 << 63) - 1
    ):
        raise ControlError(
            "NemoClaw cron restore release recovery record has an invalid drain time"
        )
    return (
        _validate_drain_token(
            payload,
            "NemoClaw cron restore release recovery record",
        ),
        started_at_ns,
    )


def _read_release_recovery_token(*, required: bool = True) -> str | None:
    observed = _read_release_recovery(required=required)
    return None if observed is None else observed[0]


def _require_owned_token(
    path: Path,
    label: str,
    ownership_label: str,
    drain_token: str,
) -> None:
    observed_token = _read_owned_token(path, label, required=True)
    if observed_token is None:
        raise ControlError(f"{label} is not active")
    if not hmac.compare_digest(observed_token, drain_token):
        raise ControlError(f"{ownership_label} ownership changed")


def _require_owned_drain(drain_token: str) -> None:
    _require_owned_token(
        _marker_path(),
        "NemoClaw cron restore drain marker",
        "NemoClaw cron restore drain",
        drain_token,
    )


def _owned_drain_started_at_ns(drain_token: str) -> int:
    """Return the authenticated drain marker's durable creation time."""
    observed = _read_owned_token_record(
        _marker_path(),
        "NemoClaw cron restore drain marker",
        required=True,
    )
    if observed is None:
        raise ControlError("NemoClaw cron restore drain marker is not active")
    observed_token, metadata = observed
    if not hmac.compare_digest(observed_token, drain_token):
        raise ControlError("NemoClaw cron restore drain ownership changed")
    return metadata.st_mtime_ns


def _owned_drain_started_at(drain_token: str) -> datetime:
    started_at_ns = _owned_drain_started_at_ns(drain_token)
    return datetime.fromtimestamp(started_at_ns / 1_000_000_000, timezone.utc)


def _rearm_drained_oneshots(drain_token: str) -> int:
    """Re-arm only one-shots due at or after this drain was acquired."""
    started_at = _owned_drain_started_at(drain_token)
    try:
        from cron.jobs import rearm_nemoclaw_drained_oneshots
    except Exception as error:
        raise ControlError("Hermes cron restore re-arm helper is unavailable") from error
    try:
        profile_homes = [profile_home for _label, profile_home in _profile_homes(HERMES_HOME)]
        changed = rearm_nemoclaw_drained_oneshots(started_at, profile_homes)
    except Exception as error:
        raise ControlError("Hermes cron restore could not re-arm delayed one-shots") from error
    if isinstance(changed, bool) or not isinstance(changed, int) or changed < 0:
        raise ControlError("Hermes cron restore re-arm result is invalid")
    return changed


def _write_owned_record(
    path: Path,
    label: str,
    payload: bytes,
    *,
    temp_prefix: str,
    exists_message: str,
    write_message: str,
    mtime_ns: int | None = None,
) -> None:
    _require_secure_directory(NEMOCLAW_HOME, "NemoClaw state root")
    if not payload or len(payload) > MAX_MARKER_BYTES:
        raise ControlError(f"{label} payload is invalid")
    descriptor = -1
    staged_path: Path | None = None
    try:
        descriptor, staged_raw = tempfile.mkstemp(
            prefix=temp_prefix,
            dir=NEMOCLAW_HOME,
        )
        staged_path = Path(staged_raw)
        os.fchown(descriptor, ROOT_UID, ROOT_GID)
        os.fchmod(descriptor, 0o400)
        written = os.write(descriptor, payload)
        if written != len(payload):
            raise OSError("short marker write")
        if mtime_ns is not None:
            os.utime(descriptor, ns=(mtime_ns, mtime_ns))
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        try:
            os.link(staged_path, path)
        except FileExistsError as error:
            raise ControlError(exists_message) from error
        staged_path.unlink()
        staged_path = None
        _fsync_directory(NEMOCLAW_HOME, "NemoClaw state root")
    except ControlError:
        raise
    except OSError as error:
        raise ControlError(write_message) from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if staged_path is not None:
            staged_path.unlink(missing_ok=True)


def _write_owned_drain(drain_token: str, *, started_at_ns: int | None = None) -> None:
    payload = json.dumps(
        {"token": drain_token, "version": 1},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    _write_owned_record(
        _marker_path(),
        "NemoClaw cron restore drain marker",
        payload,
        temp_prefix=".hermes-cron-restore-drain-",
        exists_message="a NemoClaw cron restore drain already requires recovery",
        write_message="NemoClaw cron restore drain could not be acquired",
        mtime_ns=started_at_ns,
    )
    _require_owned_drain(drain_token)
    if started_at_ns is not None and _owned_drain_started_at_ns(drain_token) != started_at_ns:
        raise ControlError("NemoClaw cron restore drain time changed")


def _write_release_recovery(drain_token: str, drain_started_at_ns: int) -> None:
    payload = json.dumps(
        {
            "drain_started_at_ns": drain_started_at_ns,
            "token": drain_token,
            "version": 2,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    _write_owned_record(
        _release_recovery_path(),
        "NemoClaw cron restore release recovery record",
        payload,
        temp_prefix=".hermes-cron-restore-release-recovery-",
        exists_message="a NemoClaw cron restore release recovery already exists",
        write_message="NemoClaw cron restore release recovery could not be recorded",
    )
    observed = _read_release_recovery(required=True)
    if observed != (drain_token, drain_started_at_ns):
        raise ControlError("NemoClaw cron restore release recovery record changed")


def _ensure_release_recovery(drain_token: str) -> None:
    drain_started_at_ns = _owned_drain_started_at_ns(drain_token)
    observed = _read_release_recovery(required=False)
    if observed is None:
        _write_release_recovery(drain_token, drain_started_at_ns)
        return
    observed_token, observed_started_at_ns = observed
    if not hmac.compare_digest(observed_token, drain_token):
        raise ControlError("NemoClaw cron restore release recovery ownership changed")
    if observed_started_at_ns != drain_started_at_ns:
        raise ControlError("NemoClaw cron restore release recovery drain time changed")
    _fsync_directory(NEMOCLAW_HOME, "NemoClaw state root")


def _ensure_owned_drain(
    drain_token: str,
    *,
    started_at_ns: int | None = None,
) -> None:
    observed_token = _read_owned_drain_token(required=False)
    if observed_token is None:
        recovery = _read_release_recovery(required=started_at_ns is None)
        if recovery is not None:
            recovery_token, recovery_started_at_ns = recovery
            if not hmac.compare_digest(recovery_token, drain_token):
                raise ControlError("NemoClaw cron restore release recovery ownership changed")
            if started_at_ns is None:
                started_at_ns = recovery_started_at_ns
            elif started_at_ns != recovery_started_at_ns:
                raise ControlError("NemoClaw cron restore release recovery drain time changed")
        if started_at_ns is None:
            raise ControlError("NemoClaw cron restore drain time is unavailable")
        _write_owned_drain(drain_token, started_at_ns=started_at_ns)
        return
    if not hmac.compare_digest(observed_token, drain_token):
        raise ControlError("NemoClaw cron restore drain ownership changed")
    if started_at_ns is not None and _owned_drain_started_at_ns(drain_token) != started_at_ns:
        raise ControlError("NemoClaw cron restore drain time changed")
    _fsync_directory(NEMOCLAW_HOME, "NemoClaw state root")


def _remove_owned_token(
    path: Path,
    label: str,
    ownership_label: str,
    drain_token: str,
    *,
    failure_message: str,
) -> None:
    _require_owned_token(path, label, ownership_label, drain_token)
    try:
        path.unlink()
    except OSError as error:
        raise ControlError(failure_message) from error
    _fsync_directory(NEMOCLAW_HOME, "NemoClaw state root")


def _remove_owned_drain(drain_token: str) -> None:
    _remove_owned_token(
        _marker_path(),
        "NemoClaw cron restore drain marker",
        "NemoClaw cron restore drain",
        drain_token,
        failure_message="NemoClaw cron restore drain could not be released",
    )


def _remove_release_recovery(drain_token: str) -> None:
    observed = _read_release_recovery(required=True)
    if observed is None:
        raise ControlError("NemoClaw cron restore release recovery record is not active")
    observed_token, _drain_started_at_ns = observed
    if not hmac.compare_digest(observed_token, drain_token):
        raise ControlError("NemoClaw cron restore release recovery ownership changed")
    try:
        _release_recovery_path().unlink()
    except OSError as error:
        raise ControlError(
            "NemoClaw cron restore release recovery could not be cleared"
        ) from error
    _fsync_directory(NEMOCLAW_HOME, "NemoClaw state root")


def _profile_homes(home: Path) -> list[tuple[str, Path]]:
    profiles: list[tuple[str, Path]] = [("default", home)]
    profiles_root = home / "profiles"
    try:
        entries = sorted(profiles_root.iterdir(), key=lambda entry: entry.name)
    except FileNotFoundError:
        return profiles
    except OSError as error:
        raise ControlError("named profile state is unreadable") from error

    for index, entry in enumerate(entries, start=1):
        try:
            mode = entry.lstat().st_mode
        except OSError as error:
            raise ControlError(f"named profile #{index} is unreadable") from error
        if stat.S_ISLNK(mode):
            raise ControlError(f"named profile #{index} is a symlink")
        if stat.S_ISDIR(mode):
            profiles.append((f"named profile #{index}", entry))
    return profiles


def _load_jobs(profile_label: str, profile_home: Path) -> list[dict[str, Any]]:
    jobs_path = profile_home / "cron" / "jobs.json"
    try:
        metadata = jobs_path.lstat()
    except FileNotFoundError:
        return []
    except OSError as error:
        raise ControlError(f"{profile_label} cron store is unreadable") from error

    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ControlError(f"{profile_label} cron store is not a regular file")
    if metadata.st_size > MAX_JOBS_BYTES:
        raise ControlError(f"{profile_label} cron store exceeds the validation limit")
    try:
        payload = json.loads(jobs_path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, ValueError) as error:
        raise ControlError(f"{profile_label} cron store is invalid") from error

    jobs = (
        payload
        if isinstance(payload, list)
        else payload.get("jobs")
        if isinstance(payload, dict)
        else None
    )
    if not isinstance(jobs, list):
        raise ControlError(f"{profile_label} cron store has an invalid jobs collection")
    if not all(isinstance(job, dict) for job in jobs):
        raise ControlError(f"{profile_label} cron store contains an invalid job")
    return jobs


def _expand_script_path(raw: str, scripts_root: Path, sandbox_home: Path) -> Path:
    if "\0" in raw:
        raise ControlError("script path contains a NUL byte")
    candidate = Path(raw)
    if raw == "~":
        candidate = sandbox_home
    elif raw.startswith("~/"):
        candidate = sandbox_home / raw[2:]
    elif raw.startswith("~"):
        raise ControlError("script path uses an unsupported user-home expansion")
    elif not candidate.is_absolute():
        candidate = scripts_root / candidate
    return candidate


def _validate_script(
    profile_label: str,
    job_index: int,
    script: str,
    profile_home: Path,
    sandbox_home: Path,
) -> None:
    scripts_root = profile_home / "scripts"
    candidate = _expand_script_path(script, scripts_root, sandbox_home)
    try:
        root_metadata = scripts_root.lstat()
        target_metadata = candidate.lstat()
        resolved_root = scripts_root.resolve(strict=True)
        resolved_target = candidate.resolve(strict=True)
    except (FileNotFoundError, OSError) as error:
        raise ControlError(
            f"{profile_label} active job #{job_index} references a missing script"
        ) from error

    if stat.S_ISLNK(root_metadata.st_mode) or not stat.S_ISDIR(root_metadata.st_mode):
        raise ControlError(f"{profile_label} scripts root is not a regular directory")
    if stat.S_ISLNK(target_metadata.st_mode) or not stat.S_ISREG(target_metadata.st_mode):
        raise ControlError(
            f"{profile_label} active job #{job_index} script is not a regular file"
        )
    try:
        resolved_target.relative_to(resolved_root)
    except ValueError as error:
        raise ControlError(
            f"{profile_label} active job #{job_index} script escapes its profile"
        ) from error
    if not target_metadata.st_mode & 0o444 or not os.access(resolved_target, os.R_OK):
        raise ControlError(
            f"{profile_label} active job #{job_index} script is not readable"
        )


def validate_cron_tree(
    home: Path = HERMES_HOME,
    sandbox_home: Path = SANDBOX_HOME,
) -> dict[str, int]:
    profile_count = 0
    active_jobs = 0
    script_jobs = 0
    for profile_label, profile_home in _profile_homes(home):
        profile_count += 1
        for job_index, job in enumerate(_load_jobs(profile_label, profile_home), start=1):
            if job.get("enabled", True) is False or job.get("state") == "paused":
                continue
            active_jobs += 1
            script = job.get("script")
            if script is None or script == "":
                continue
            if not isinstance(script, str) or not script.strip():
                raise ControlError(
                    f"{profile_label} active job #{job_index} has an invalid script"
                )
            script_jobs += 1
            _validate_script(
                profile_label,
                job_index,
                script.strip(),
                profile_home,
                sandbox_home,
            )
    return {
        "profiles": profile_count,
        "active_jobs": active_jobs,
        "script_jobs": script_jobs,
    }


def _load_gateway_modules() -> tuple[Any, Any]:
    os.environ["HERMES_HOME"] = str(HERMES_HOME)
    try:
        from gateway import drain_control, status
    except Exception as error:
        raise ControlError("pinned Hermes gateway control modules are unavailable") from error
    return drain_control, status


def _gateway_identity(status_module: Any) -> tuple[dict[str, Any], int, int]:
    payload = status_module.read_runtime_status()
    if not isinstance(payload, dict):
        raise ControlError("Hermes gateway runtime status is unavailable")
    pid = payload.get("pid")
    start_time = payload.get("start_time")
    if not isinstance(pid, int) or pid <= 0:
        raise ControlError("Hermes gateway PID identity is invalid")
    if not isinstance(start_time, int) or start_time < 0:
        raise ControlError("Hermes gateway start identity is invalid")
    running_pid = status_module.get_runtime_status_running_pid(
        runtime=payload,
        expected_home=HERMES_HOME,
    )
    if running_pid != pid:
        raise ControlError("Hermes gateway process identity is not live")
    return payload, pid, start_time


def _require_identity(status_module: Any, pid: int, start_time: int) -> dict[str, Any]:
    payload, observed_pid, observed_start = _gateway_identity(status_module)
    if observed_pid != pid or observed_start != start_time:
        raise ControlError("Hermes gateway identity changed during cron restore")
    return payload


def _wait_for_state(
    status_module: Any,
    *,
    pid: int,
    start_time: int,
    state: str,
    require_idle: bool,
    timeout_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_payload: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        last_payload = _require_identity(status_module, pid, start_time)
        active_agents = status_module.parse_active_agents(last_payload.get("active_agents"))
        if last_payload.get("gateway_state") == state and (not require_idle or active_agents == 0):
            return last_payload
        time.sleep(POLL_SECONDS)
    observed_state = last_payload.get("gateway_state") if last_payload else "unavailable"
    raise ControlError(f"Hermes gateway did not reach {state} from {observed_state}")


def _receipt(
    action: str,
    pid: int,
    start_time: int,
    drain_token: str | None,
    **fields: Any,
) -> None:
    payload = {
        "version": 1,
        "action": action,
        "pid": pid,
        "start_time": start_time,
        "drain_acquired": drain_token is not None,
        **fields,
    }
    if drain_token is not None:
        payload["drain_token"] = drain_token
    print(f"{RECEIPT_PREFIX}{json.dumps(payload, separators=(',', ':'), sort_keys=True)}")


def _prepare_recovery_receipt(drain_acquired: bool) -> None:
    payload = {
        "version": 1,
        "action": "prepare-recover",
        "drain_acquired": drain_acquired,
        "disposition": "gate-prepared" if drain_acquired else "not-required",
    }
    print(f"{RECEIPT_PREFIX}{json.dumps(payload, separators=(',', ':'), sort_keys=True)}")


def _operator_drain_active(drain_control: Any) -> bool:
    predicate = getattr(drain_control, "operator_drain_requested", None)
    if not callable(predicate):
        raise ControlError("patched Hermes operator drain predicate is unavailable")
    try:
        return bool(predicate(home=HERMES_HOME))
    except Exception as error:
        raise ControlError("Hermes operator drain state is unavailable") from error


def _require_drained_idle(
    status_module: Any,
    pid: int,
    start_time: int,
) -> dict[str, Any]:
    payload = _require_identity(status_module, pid, start_time)
    if payload.get("gateway_state") != "draining":
        raise ControlError("Hermes gateway is not draining during cron restore")
    if status_module.parse_active_agents(payload.get("active_agents")) != 0:
        raise ControlError("Hermes gateway became active during cron restore")
    return payload


def _wait_for_release_disposition(
    drain_control: Any,
    status_module: Any,
    *,
    pid: int,
    start_time: int,
) -> tuple[dict[str, Any], bool, str]:
    deadline = time.monotonic() + RELEASE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        payload = _require_identity(status_module, pid, start_time)
        active_agents = status_module.parse_active_agents(payload.get("active_agents"))
        operator_drain_active = _operator_drain_active(drain_control)
        if (
            operator_drain_active
            and payload.get("gateway_state") == "draining"
            and active_agents == 0
        ):
            return payload, True, "operator-drain-preserved"
        if not operator_drain_active and payload.get("gateway_state") == "running":
            return payload, False, "dispatch-reactivated"
        time.sleep(POLL_SECONDS)
    raise ControlError("Hermes gateway did not prove cron restore drain release")


def _complete_release(
    action: str,
    drain_control: Any,
    status_module: Any,
    *,
    pid: int,
    start_time: int,
    drain_token: str,
    **fields: Any,
) -> None:
    _require_drained_idle(status_module, pid, start_time)
    drain_started_at_ns = _owned_drain_started_at_ns(drain_token)
    _ensure_release_recovery(drain_token)
    rearmed_oneshots = 0
    if not _operator_drain_active(drain_control):
        rearmed_oneshots = _rearm_drained_oneshots(drain_token)
    try:
        _remove_owned_drain(drain_token)
    except ControlError as release_error:
        try:
            _ensure_owned_drain(drain_token, started_at_ns=drain_started_at_ns)
        except ControlError as rollback_error:
            raise ControlError(
                "Hermes cron restore drain release failed and its marker could not be restored",
                code=DRAIN_MARKER_ROLLBACK_FAILED_CODE,
            ) from rollback_error
        raise release_error
    try:
        payload, operator_drain_active, disposition = _wait_for_release_disposition(
            drain_control,
            status_module,
            pid=pid,
            start_time=start_time,
        )
    except Exception as release_error:
        try:
            _ensure_owned_drain(drain_token, started_at_ns=drain_started_at_ns)
        except ControlError as rollback_error:
            raise ControlError(
                "Hermes cron restore drain release failed and its marker could not be restored",
                code=DRAIN_MARKER_ROLLBACK_FAILED_CODE,
            ) from rollback_error
        if isinstance(release_error, ControlError):
            raise release_error
        raise
    try:
        _remove_release_recovery(drain_token)
    except ControlError as cleanup_error:
        try:
            _ensure_owned_drain(drain_token, started_at_ns=drain_started_at_ns)
        except ControlError as rollback_error:
            raise ControlError(
                "Hermes cron restore drain release failed and its marker could not be restored",
                code=DRAIN_MARKER_ROLLBACK_FAILED_CODE,
            ) from rollback_error
        raise ControlError(
            "Hermes cron restore release recovery could not be cleared; "
            "the drain marker was restored"
        ) from cleanup_error
    _receipt(
        action,
        pid,
        start_time,
        drain_token,
        active_agents=status_module.parse_active_agents(payload.get("active_agents")),
        disposition=disposition,
        operator_drain_active=operator_drain_active,
        preserved_drain=operator_drain_active,
        rearmed_oneshots=rearmed_oneshots,
        **fields,
    )


def _prepare_owned_drain() -> str | None:
    drain_token = _read_owned_drain_token(required=False)
    recovery = _read_release_recovery(required=False)
    if drain_token is not None and recovery is not None:
        recovery_token, recovery_started_at_ns = recovery
        if not hmac.compare_digest(drain_token, recovery_token):
            raise ControlError(
                "NemoClaw cron restore drain and release recovery ownership differ"
            )
        if _owned_drain_started_at_ns(drain_token) != recovery_started_at_ns:
            raise ControlError(
                "NemoClaw cron restore drain and release recovery times differ"
            )
        _fsync_directory(NEMOCLAW_HOME, "NemoClaw state root")
    elif drain_token is None and recovery is not None:
        recovery_token, recovery_started_at_ns = recovery
        _write_owned_drain(recovery_token, started_at_ns=recovery_started_at_ns)
        drain_token = recovery_token
    elif drain_token is not None:
        _fsync_directory(NEMOCLAW_HOME, "NemoClaw state root")
    return drain_token


def prepare_recovery() -> None:
    """Re-establish any persisted NemoClaw gate before host gateway repair."""
    with _control_lock():
        _prepare_recovery_receipt(_prepare_owned_drain() is not None)


def begin_drain() -> str:
    with _control_lock():
        drain_control, status_module = _load_gateway_modules()
        if _read_release_recovery_token(required=False) is not None:
            raise ControlError(
                "a NemoClaw cron restore release recovery already requires recovery"
            )
        _, pid, start_time = _gateway_identity(status_module)
        drain_token = secrets.token_urlsafe(24)
        _write_owned_drain(drain_token)
        payload = _wait_for_state(
            status_module,
            pid=pid,
            start_time=start_time,
            state="draining",
            require_idle=True,
            timeout_seconds=BEGIN_TIMEOUT_SECONDS,
        )
        _receipt(
            "begin",
            pid,
            start_time,
            drain_token,
            active_agents=status_module.parse_active_agents(payload.get("active_agents")),
            disposition="drain-acquired",
            operator_drain_active=_operator_drain_active(drain_control),
        )
        return drain_token


def validate_restore(pid: int, start_time: int, drain_token: str) -> None:
    with _control_lock():
        drain_control, status_module = _load_gateway_modules()
        _require_owned_drain(drain_token)
        _require_drained_idle(status_module, pid, start_time)
        counts = validate_cron_tree()
        _receipt(
            "validate",
            pid,
            start_time,
            drain_token,
            disposition="restore-validated",
            operator_drain_active=_operator_drain_active(drain_control),
            **counts,
        )


def observe_replacement(pid: int, start_time: int, drain_token: str) -> None:
    with _control_lock():
        drain_control, status_module = _load_gateway_modules()
        _require_owned_drain(drain_token)
        _, replacement_pid, replacement_start_time = _gateway_identity(status_module)
        if replacement_pid == pid and replacement_start_time == start_time:
            raise ControlError("Hermes gateway identity did not change during cron restore")
        payload = _wait_for_state(
            status_module,
            pid=replacement_pid,
            start_time=replacement_start_time,
            state="draining",
            require_idle=True,
            timeout_seconds=BEGIN_TIMEOUT_SECONDS,
        )
        _receipt(
            "observe",
            replacement_pid,
            replacement_start_time,
            drain_token,
            active_agents=status_module.parse_active_agents(
                payload.get("active_agents")
            ),
            disposition="replacement-observed",
            operator_drain_active=_operator_drain_active(drain_control),
        )


def complete_replacement(
    pid: int,
    start_time: int,
    replacement_pid: int,
    replacement_start_time: int,
    drain_token: str,
) -> None:
    with _control_lock():
        drain_control, status_module = _load_gateway_modules()
        _require_owned_drain(drain_token)
        if replacement_pid == pid and replacement_start_time == start_time:
            raise ControlError("Hermes gateway identity did not change during cron restore")
        _wait_for_state(
            status_module,
            pid=replacement_pid,
            start_time=replacement_start_time,
            state="draining",
            require_idle=True,
            timeout_seconds=BEGIN_TIMEOUT_SECONDS,
        )
        counts = validate_cron_tree()
        _complete_release(
            "complete",
            drain_control,
            status_module,
            pid=replacement_pid,
            start_time=replacement_start_time,
            drain_token=drain_token,
            **counts,
        )


def recover_drain() -> None:
    with _control_lock():
        drain_control, status_module = _load_gateway_modules()
        payload, pid, start_time = _gateway_identity(status_module)
        drain_token = _prepare_owned_drain()
        if drain_token is None:
            operator_drain_active = _operator_drain_active(drain_control)
            _receipt(
                "recover",
                pid,
                start_time,
                None,
                active_agents=status_module.parse_active_agents(
                    payload.get("active_agents")
                ),
                disposition="not-required",
                operator_drain_active=operator_drain_active,
                preserved_drain=operator_drain_active,
            )
            return
        _wait_for_state(
            status_module,
            pid=pid,
            start_time=start_time,
            state="draining",
            require_idle=True,
            timeout_seconds=BEGIN_TIMEOUT_SECONDS,
        )
        counts = validate_cron_tree()
        _complete_release(
            "recover",
            drain_control,
            status_module,
            pid=pid,
            start_time=start_time,
            drain_token=drain_token,
            **counts,
        )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="action", required=True)
    subparsers.add_parser("begin")
    subparsers.add_parser("prepare-recover")
    subparsers.add_parser("recover")
    for action in ("validate", "observe", "complete"):
        subparser = subparsers.add_parser(action)
        subparser.add_argument("--pid", required=True, type=int)
        subparser.add_argument("--start-time", required=True, type=int)
        subparser.add_argument("--drain-token", required=True)
        if action == "complete":
            subparser.add_argument("--replacement-pid", required=True, type=int)
            subparser.add_argument(
                "--replacement-start-time", required=True, type=int
            )
    tree = subparsers.add_parser("validate-tree")
    tree.add_argument("--home", required=True, type=Path)
    tree.add_argument("--sandbox-home", required=True, type=Path)
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.action == "begin":
            begin_drain()
        elif args.action == "prepare-recover":
            prepare_recovery()
        elif args.action == "recover":
            recover_drain()
        elif args.action == "validate":
            validate_restore(args.pid, args.start_time, args.drain_token)
        elif args.action == "observe":
            observe_replacement(args.pid, args.start_time, args.drain_token)
        elif args.action == "complete":
            complete_replacement(
                args.pid,
                args.start_time,
                args.replacement_pid,
                args.replacement_start_time,
                args.drain_token,
            )
        else:
            counts = validate_cron_tree(args.home, args.sandbox_home)
            print(json.dumps(counts, separators=(",", ":"), sort_keys=True))
    except ControlError as error:
        _emit_control_error(error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
