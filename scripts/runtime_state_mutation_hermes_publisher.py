#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Nonce-bound Hermes publisher for one normalized state-mutation plan.

The runtime-state-mutation controller imports :func:`apply_plan_posture` only
after it has authenticated and normalized the durable marker.  This module has
no caller-selected command, path, or callback surface: it accepts that marker
and either its exact target or rollback posture, then drives the fixed Hermes
shields transaction already shipped in the image.

The publisher keeps a root-only journal beside the controller marker.  The
journal binds the provider nonce and complete canonical plan before the Hermes
guard begins, so a lost provider exec response can resume only the same
transaction.  A successful retry independently verifies the top-level
config/hash projection and every selector in the installed state-lock plan.
"""

from __future__ import annotations

import fcntl
import hashlib
import importlib.util
import json
import os
import pwd
import grp
import re
import secrets
import stat
import subprocess
import sys
import time
from types import ModuleType
from typing import NoReturn


SCHEMA_VERSION = 1
PLAN_SCHEMA_VERSION = 2
ROOT_UID = 0
ROOT_GID = 0
HERMES_DIR = "/sandbox/.hermes"
HERMES_HASH_FILE = "/etc/nemoclaw/hermes.config-hash"
DURABLE_DIRECTORY = "/var/lib/nemoclaw/runtime-state-mutation"
JOURNAL_NAME = "hermes-publisher.json"
LOCK_NAME = "hermes-publisher.lock"
GUARD_STATE_NAME = "hermes-publisher-guard-state.json"
RUNTIME_GUARD_PATH = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"
STATE_DIR_GUARD_PATH = "/usr/local/lib/nemoclaw/state-dir-guard.py"
STATE_LOCK_PLAN_PATH = "/usr/local/share/nemoclaw/state-lock-plan.json"
PYTHON_PATH = "/opt/hermes/.venv/bin/python3"
MAX_PLAN_BYTES = 64 * 1024
MAX_JOURNAL_BYTES = 256 * 1024
MAX_GUARD_STATE_BYTES = 4 * 1024 * 1024
MAX_GUARD_OUTPUT_BYTES = 16 * 1024
GUARD_TIMEOUT_SECONDS = 13 * 60
HEX_64 = re.compile(r"[0-9a-f]{64}\Z")
POSITIVE_DECIMAL = re.compile(r"[1-9][0-9]*\Z")
BEGIN_OUTPUT = re.compile(r"lock_token=([0-9a-f]{64}) original_locked=([01])\n?\Z")
PHASES = frozenset(
    {
        "intent",
        "begun",
        "state-applied",
        "top-applied",
        "abort-requested",
        "abort-prepared",
        "abort-state-applied",
    }
)
TOP_SELECTORS = (".config-hash", ".env", "config.yaml")


class PublisherError(RuntimeError):
    """A fixed, non-sensitive publisher failure."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _fail(code: str) -> NoReturn:
    raise PublisherError(code)


def _canonical(value: object) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8", "strict"
        )
    except (TypeError, ValueError, UnicodeEncodeError):
        return _fail("publisher-json-invalid")


def _pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            _fail("publisher-json-invalid")
        result[key] = value
    return result


def _parse_json(raw: bytes, maximum: int, code: str) -> object:
    if not raw or len(raw) > maximum:
        _fail(code)
    try:
        return json.loads(
            raw.decode("utf-8", "strict"),
            object_pairs_hook=_pairs,
            parse_constant=lambda _value: _fail(code),
            parse_float=lambda _value: _fail(code),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, PublisherError):
        return _fail(code)


def _exact_record(value: object, keys: tuple[str, ...], code: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != set(keys):
        _fail(code)
    return value


def _hex(value: object, code: str) -> str:
    if not isinstance(value, str) or HEX_64.fullmatch(value) is None:
        _fail(code)
    return value


def _positive_decimal(value: object, code: str) -> str:
    if not isinstance(value, str) or POSITIVE_DECIMAL.fullmatch(value) is None:
        _fail(code)
    return value


def _safe_component(value: object, code: str) -> str:
    if (
        not isinstance(value, str)
        or value in {"", ".", ".."}
        or "/" in value
        or "\\" in value
        or re.fullmatch(r"[A-Za-z0-9._-]+", value) is None
    ):
        _fail(code)
    return value


def _safe_relative(value: object, code: str) -> str:
    if not isinstance(value, str) or value.startswith("/") or "\\" in value:
        _fail(code)
    pieces = value.split("/")
    if any(piece in {"", ".", ".."} for piece in pieces):
        _fail(code)
    for piece in pieces:
        if "*" in piece and piece != "*":
            _fail(code)
    if pieces[-1] == "*":
        _fail(code)
    return value


def _string_list(value: object, code: str, validator) -> list[str]:
    if not isinstance(value, list) or len(value) > 256:
        _fail(code)
    result = [validator(item, code) for item in value]
    if len(result) != len(set(result)):
        _fail(code)
    return result


def _normalize_state_lock_plan(value: object, *, installed: bool) -> dict[str, object]:
    if not isinstance(value, dict):
        _fail("publisher-state-lock-plan-invalid")
    allowed = {
        "version",
        "readOnlyRoots",
        "confidentialRoots",
        "readOnlyPrefixes",
        "confidentialPrefixes",
        "writableSubpaths",
    }
    if installed:
        allowed.add("$comment")
    if set(value) - allowed or allowed - {"$comment"} - set(value):
        _fail("publisher-state-lock-plan-invalid")
    if "$comment" in value and not isinstance(value["$comment"], str):
        _fail("publisher-state-lock-plan-invalid")
    if type(value.get("version")) is not int or value["version"] != 1:
        _fail("publisher-state-lock-plan-invalid")
    read_only_roots = _string_list(
        value["readOnlyRoots"], "publisher-state-lock-plan-invalid", _safe_component
    )
    confidential_roots = _string_list(
        value["confidentialRoots"],
        "publisher-state-lock-plan-invalid",
        _safe_component,
    )
    read_only_prefixes = _string_list(
        value["readOnlyPrefixes"],
        "publisher-state-lock-plan-invalid",
        _safe_component,
    )
    confidential_prefixes = _string_list(
        value["confidentialPrefixes"],
        "publisher-state-lock-plan-invalid",
        _safe_component,
    )
    writable_subpaths = _string_list(
        value["writableSubpaths"],
        "publisher-state-lock-plan-invalid",
        _safe_relative,
    )
    roots = read_only_roots + confidential_roots
    prefixes = read_only_prefixes + confidential_prefixes
    if len(roots) != len(set(roots)) or len(prefixes) != len(set(prefixes)):
        _fail("publisher-state-lock-plan-invalid")
    if any(root.startswith(prefix) for root in roots for prefix in prefixes):
        _fail("publisher-state-lock-plan-invalid")
    for index, prefix in enumerate(prefixes):
        if any(
            prefix.startswith(other) or other.startswith(prefix)
            for other in prefixes[index + 1 :]
        ):
            _fail("publisher-state-lock-plan-invalid")
    if any(path.split("/", 1)[0] not in read_only_roots for path in writable_subpaths):
        _fail("publisher-state-lock-plan-invalid")
    return {
        "version": 1,
        "readOnlyRoots": read_only_roots,
        "confidentialRoots": confidential_roots,
        "readOnlyPrefixes": read_only_prefixes,
        "confidentialPrefixes": confidential_prefixes,
        "writableSubpaths": writable_subpaths,
    }


def _read_regular(
    path: str, maximum: int, code: str, *, exact_mode: int | None = None
) -> bytes:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        _fail(code)
    try:
        metadata = os.fstat(fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != ROOT_UID
            or metadata.st_gid != ROOT_GID
            or metadata.st_nlink != 1
            or (exact_mode is not None and stat.S_IMODE(metadata.st_mode) != exact_mode)
            or (exact_mode is None and stat.S_IMODE(metadata.st_mode) & 0o022)
        ):
            _fail(code)
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, min(64 * 1024, maximum + 1 - total))
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                _fail(code)
    finally:
        os.close(fd)


def _installed_state_lock_plan() -> tuple[dict[str, object], str]:
    raw = _read_regular(
        STATE_LOCK_PLAN_PATH,
        MAX_PLAN_BYTES,
        "publisher-installed-plan-invalid",
        exact_mode=0o444,
    )
    normalized = _normalize_state_lock_plan(
        _parse_json(raw, MAX_PLAN_BYTES, "publisher-installed-plan-invalid"),
        installed=True,
    )
    return normalized, _canonical(normalized).decode("utf-8", "strict")


def _normalize_marker(marker: object, posture: str) -> dict[str, object]:
    if os.geteuid() != ROOT_UID:
        _fail("publisher-root-required")
    if not isinstance(marker, dict):
        _fail("publisher-marker-invalid")
    transaction_id = _hex(marker.get("transactionId"), "publisher-marker-invalid")
    nonce = _hex(marker.get("nonce"), "publisher-marker-invalid")
    plan_sha256 = _hex(marker.get("planSha256"), "publisher-marker-invalid")
    projection_sha256 = _hex(marker.get("projectionSha256"), "publisher-marker-invalid")
    state_root_device = _positive_decimal(
        marker.get("stateRootDevice"), "publisher-marker-invalid"
    )
    state_root_inode = _positive_decimal(
        marker.get("stateRootInode"), "publisher-marker-invalid"
    )
    provider_id = marker.get("providerId")
    if (
        not isinstance(provider_id, str)
        or re.fullmatch(r"[a-z][a-z0-9-]{0,62}", provider_id) is None
        or marker.get("stateRoot") != HERMES_DIR
    ):
        _fail("publisher-marker-invalid")
    target = marker.get("target")
    rollback = marker.get("rollback")
    if (
        target not in ("locked", "mutable")
        or rollback not in ("locked", "mutable")
        or target == rollback
        or posture not in (target, rollback)
    ):
        _fail("publisher-posture-invalid")
    plan_text = marker.get("plan")
    if not isinstance(plan_text, str):
        _fail("publisher-marker-invalid")
    try:
        plan_raw = plan_text.encode("utf-8", "strict")
    except UnicodeEncodeError:
        _fail("publisher-marker-invalid")
    if (
        len(plan_raw) > MAX_PLAN_BYTES
        or hashlib.sha256(plan_raw).hexdigest() != plan_sha256
    ):
        _fail("publisher-plan-binding-mismatch")
    plan = _exact_record(
        _parse_json(plan_raw, MAX_PLAN_BYTES, "publisher-plan-invalid"),
        (
            "schemaVersion",
            "intent",
            "target",
            "rollback",
            "stateLockPlan",
            "stateRoot",
            "selectors",
            "projectionSha256",
        ),
        "publisher-plan-invalid",
    )
    if _canonical(plan) != plan_raw:
        _fail("publisher-plan-noncanonical")
    if (
        type(plan["schemaVersion"]) is not int
        or plan["schemaVersion"] != PLAN_SCHEMA_VERSION
        or plan["intent"] != "protection-transition"
        or plan["target"] != target
        or plan["rollback"] != rollback
        or plan["stateRoot"] != HERMES_DIR
        or plan["projectionSha256"] != projection_sha256
    ):
        _fail("publisher-plan-binding-mismatch")
    state_plan = _normalize_state_lock_plan(plan["stateLockPlan"], installed=False)
    installed_plan, installed_plan_json = _installed_state_lock_plan()
    if not secrets.compare_digest(_canonical(state_plan), _canonical(installed_plan)):
        _fail("publisher-installed-plan-mismatch")
    expected_selectors = [
        *(f"path:{name}" for name in TOP_SELECTORS),
        *(f"path:{name}" for name in state_plan["readOnlyRoots"]),  # type: ignore[index]
        *(f"path:{name}" for name in state_plan["confidentialRoots"]),  # type: ignore[index]
        *(f"prefix:{name}" for name in state_plan["readOnlyPrefixes"]),  # type: ignore[index]
        *(f"prefix:{name}" for name in state_plan["confidentialPrefixes"]),  # type: ignore[index]
    ]
    expected_selectors.sort(key=lambda item: item.encode("utf-8"))
    selectors = plan["selectors"]
    if not isinstance(selectors, list):
        _fail("publisher-plan-selector-mismatch")
    observed_selectors: list[str] = []
    for selector in selectors:
        if not isinstance(selector, dict) or selector.get("kind") not in (
            "path",
            "prefix",
        ):
            _fail("publisher-plan-selector-mismatch")
        if selector["kind"] == "path":
            exact = _exact_record(
                selector, ("kind", "path"), "publisher-plan-selector-mismatch"
            )
            observed_selectors.append(
                "path:"
                + _safe_relative(exact["path"], "publisher-plan-selector-mismatch")
            )
        else:
            exact = _exact_record(
                selector, ("kind", "prefix"), "publisher-plan-selector-mismatch"
            )
            observed_selectors.append(
                "prefix:"
                + _safe_component(exact["prefix"], "publisher-plan-selector-mismatch")
            )
    if observed_selectors != expected_selectors:
        _fail("publisher-plan-selector-mismatch")
    binding = {
        "schemaVersion": SCHEMA_VERSION,
        "transactionId": transaction_id,
        "nonce": nonce,
        "planSha256": plan_sha256,
        "projectionSha256": projection_sha256,
        "stateRootDevice": state_root_device,
        "stateRootInode": state_root_inode,
        "target": target,
        "rollback": rollback,
        "plan": plan_text,
    }
    return {
        "binding": binding,
        "bindingSha256": hashlib.sha256(_canonical(binding)).hexdigest(),
        "providerId": provider_id,
        "transactionId": transaction_id,
        "nonce": nonce,
        "planSha256": plan_sha256,
        "projectionSha256": projection_sha256,
        "stateRootDevice": state_root_device,
        "stateRootInode": state_root_inode,
        "target": target,
        "rollback": rollback,
        "posture": posture,
        "stateLockPlan": state_plan,
        "stateLockPlanJson": installed_plan_json,
    }


def _open_durable_directory() -> int:
    try:
        fd = os.open(
            DURABLE_DIRECTORY,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
    except OSError:
        _fail("publisher-durable-directory-invalid")
    metadata = os.fstat(fd)
    if (
        metadata.st_uid != ROOT_UID
        or metadata.st_gid != ROOT_GID
        or stat.S_IMODE(metadata.st_mode) != 0o711
    ):
        os.close(fd)
        _fail("publisher-durable-directory-invalid")
    return fd


def _read_at(directory_fd: int, name: str, maximum: int, code: str) -> bytes | None:
    try:
        fd = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory_fd
        )
    except FileNotFoundError:
        return None
    except OSError:
        _fail(code)
    try:
        metadata = os.fstat(fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != ROOT_UID
            or metadata.st_gid != ROOT_GID
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) != 0o600
        ):
            _fail(code)
        payload = os.read(fd, maximum + 1)
        if len(payload) > maximum or os.read(fd, 1):
            _fail(code)
        return payload
    finally:
        os.close(fd)


def _atomic_write(directory_fd: int, name: str, value: object) -> None:
    payload = _canonical(value) + b"\n"
    if len(payload) > MAX_JOURNAL_BYTES:
        _fail("publisher-journal-invalid")
    temporary = f".{name}.{os.getpid()}.{secrets.token_hex(8)}"
    fd = -1
    try:
        fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=directory_fd,
        )
        os.fchmod(fd, 0o600)
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                _fail("publisher-journal-write-failed")
            view = view[written:]
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    except OSError:
        _fail("publisher-journal-write-failed")
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError:
            # A successful replace consumes the temporary name; cleanup is best-effort.
            pass


def _operation(posture: str, rollback_posture: str) -> dict[str, object]:
    return {
        "posture": posture,
        "rollbackPosture": rollback_posture,
        "phase": "intent",
        "guardToken": None,
    }


def _new_journal(normalized: dict[str, object]) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "bindingSha256": normalized["bindingSha256"],
        "transactionId": normalized["transactionId"],
        "nonce": normalized["nonce"],
        "planSha256": normalized["planSha256"],
        "projectionSha256": normalized["projectionSha256"],
        "target": normalized["target"],
        "rollback": normalized["rollback"],
        "finalPosture": None,
        "operation": None,
    }


def _validate_operation(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    operation = _exact_record(
        value,
        ("posture", "rollbackPosture", "phase", "guardToken"),
        "publisher-journal-invalid",
    )
    if (
        operation["posture"] not in ("locked", "mutable")
        or operation["rollbackPosture"] not in ("locked", "mutable")
        or operation["posture"] == operation["rollbackPosture"]
        or operation["phase"] not in PHASES
        or (
            operation["guardToken"] is not None
            and HEX_64.fullmatch(str(operation["guardToken"])) is None
        )
    ):
        _fail("publisher-journal-invalid")
    return operation


def _load_journal(
    directory_fd: int, normalized: dict[str, object]
) -> dict[str, object]:
    raw = _read_at(
        directory_fd, JOURNAL_NAME, MAX_JOURNAL_BYTES, "publisher-journal-invalid"
    )
    if raw is None:
        journal = _new_journal(normalized)
        _atomic_write(directory_fd, JOURNAL_NAME, journal)
        return journal
    journal = _exact_record(
        _parse_json(raw, MAX_JOURNAL_BYTES, "publisher-journal-invalid"),
        (
            "schemaVersion",
            "bindingSha256",
            "transactionId",
            "nonce",
            "planSha256",
            "projectionSha256",
            "target",
            "rollback",
            "finalPosture",
            "operation",
        ),
        "publisher-journal-invalid",
    )
    if type(journal["schemaVersion"]) is not int or journal["schemaVersion"] != 1:
        _fail("publisher-journal-invalid")
    operation = _validate_operation(journal["operation"])
    final_posture = journal["finalPosture"]
    if final_posture not in (None, "locked", "mutable"):
        _fail("publisher-journal-invalid")
    if journal["bindingSha256"] != normalized["bindingSha256"]:
        if operation is not None:
            _fail("publisher-binding-mismatch")
        journal = _new_journal(normalized)
        _atomic_write(directory_fd, JOURNAL_NAME, journal)
        return journal
    expected = {
        "transactionId": normalized["transactionId"],
        "nonce": normalized["nonce"],
        "planSha256": normalized["planSha256"],
        "projectionSha256": normalized["projectionSha256"],
        "target": normalized["target"],
        "rollback": normalized["rollback"],
    }
    if any(journal[key] != value for key, value in expected.items()):
        _fail("publisher-binding-mismatch")
    return journal


def _write_journal(directory_fd: int, journal: dict[str, object]) -> None:
    _atomic_write(directory_fd, JOURNAL_NAME, journal)


def _acquire_lock(directory_fd: int) -> int:
    try:
        fd = os.open(
            LOCK_NAME,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=directory_fd,
        )
        metadata = os.fstat(fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != ROOT_UID
            or metadata.st_gid != ROOT_GID
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) != 0o600
        ):
            os.close(fd)
            _fail("publisher-lock-invalid")
        fcntl.flock(fd, fcntl.LOCK_EX)
        return fd
    except OSError:
        return _fail("publisher-lock-invalid")


def _trusted_executable(path: str) -> None:
    try:
        metadata = os.stat(path, follow_symlinks=False)
    except OSError:
        _fail("publisher-guard-untrusted")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != ROOT_UID
        or metadata.st_gid != ROOT_GID
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) & 0o022
    ):
        _fail("publisher-guard-untrusted")


def _run_guard(action: str, arguments: list[str]) -> str:
    _trusted_executable(RUNTIME_GUARD_PATH)
    command = [
        PYTHON_PATH,
        "-I",
        RUNTIME_GUARD_PATH,
        action,
        "--hermes-dir",
        HERMES_DIR,
        *arguments,
    ]
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=GUARD_TIMEOUT_SECONDS,
            env={
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "LANG": "C",
                "LC_ALL": "C",
            },
        )
    except (OSError, subprocess.TimeoutExpired):
        _fail("publisher-guard-failed")
    if (
        result.returncode != 0
        or len(result.stdout) > MAX_GUARD_OUTPUT_BYTES
        or len(result.stderr) > MAX_GUARD_OUTPUT_BYTES
    ):
        _fail("publisher-guard-failed")
    try:
        return result.stdout.decode("ascii", "strict")
    except UnicodeDecodeError:
        return _fail("publisher-guard-failed")


def _guard_state_path() -> str:
    return os.path.join(DURABLE_DIRECTORY, GUARD_STATE_NAME)


def _guard_arguments(*values: str) -> list[str]:
    return list(values)


def _begin_guard(
    posture: str,
    rollback_posture: str,
    state_root_device: str,
    state_root_inode: str,
) -> str:
    output = _run_guard(
        "begin-shields-transition",
        _guard_arguments(
            "--hash-file",
            HERMES_HASH_FILE,
            "--state-file",
            _guard_state_path(),
            "--shields-mode",
            posture,
            "--rollback-shields-mode",
            rollback_posture,
            "--expected-hermes-device",
            state_root_device,
            "--expected-hermes-inode",
            state_root_inode,
        ),
    )
    matched = BEGIN_OUTPUT.fullmatch(output)
    if matched is None:
        _fail("publisher-guard-failed")
    return matched.group(1)


def _state_guard(token: str, posture: str, plan_json: str) -> None:
    _run_guard(
        "run-state-dir-transition",
        _guard_arguments(
            "--state-file",
            _guard_state_path(),
            "--lock-token",
            token,
            "--state-action",
            "lock" if posture == "locked" else "unlock",
            "--state-lock-plan-json",
            plan_json,
        ),
    )


def _apply_guard(token: str) -> None:
    _run_guard(
        "apply-shields-transition",
        _guard_arguments("--state-file", _guard_state_path(), "--lock-token", token),
    )


def _finish_guard(token: str) -> None:
    _run_guard(
        "finish-shields-transition",
        _guard_arguments(
            "--hash-file",
            HERMES_HASH_FILE,
            "--state-file",
            _guard_state_path(),
            "--lock-token",
            token,
        ),
    )


def _prepare_abort_guard(token: str) -> None:
    _run_guard(
        "prepare-shields-abort",
        _guard_arguments("--state-file", _guard_state_path(), "--lock-token", token),
    )


def _abort_guard(token: str) -> None:
    _run_guard(
        "abort-shields-transition",
        _guard_arguments("--state-file", _guard_state_path(), "--lock-token", token),
    )


def _load_guard_state(directory_fd: int) -> dict[str, object] | None:
    raw = _read_at(
        directory_fd,
        GUARD_STATE_NAME,
        MAX_GUARD_STATE_BYTES,
        "publisher-guard-state-invalid",
    )
    if raw is None:
        return None
    value = _parse_json(raw, MAX_GUARD_STATE_BYTES, "publisher-guard-state-invalid")
    if not isinstance(value, dict):
        _fail("publisher-guard-state-invalid")
    return value


def _matching_guard_token(
    directory_fd: int, posture: str, rollback_posture: str
) -> tuple[str, str] | None:
    state = _load_guard_state(directory_fd)
    if state is None:
        return None
    transition = state.get("shields_transition")
    token = state.get("mutation_lock_token")
    phase = state.get("phase")
    if (
        not isinstance(transition, dict)
        or HEX_64.fullmatch(str(token)) is None
        or state.get("hermes_dir") != HERMES_DIR
        or state.get("hash_file") != HERMES_HASH_FILE
        or transition.get("mode") != posture
        or transition.get("rollback_mode") != rollback_posture
        or not isinstance(phase, str)
    ):
        _fail("publisher-guard-state-invalid")
    return str(token), phase


def _load_module(path: str, name: str) -> ModuleType:
    _trusted_executable(path)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        _fail("publisher-verifier-unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        _fail("publisher-verifier-unavailable")
    return module


def _verify_top_posture(posture: str) -> None:
    runtime = _load_module(
        RUNTIME_GUARD_PATH, "_nemoclaw_runtime_state_mutation_hermes_guard"
    )
    try:
        runtime._verify_strict_hash(HERMES_DIR, HERMES_HASH_FILE)
        runtime._verify_compat_hash(
            HERMES_HASH_FILE, os.path.join(HERMES_DIR, ".config-hash")
        )
        sandbox_uid = pwd.getpwnam("sandbox").pw_uid
        sandbox_gid = grp.getgrnam("sandbox").gr_gid
    except Exception:
        _fail("publisher-top-posture-invalid")
    parent = os.stat(os.path.dirname(HERMES_DIR), follow_symlinks=False)
    root = os.stat(HERMES_DIR, follow_symlinks=False)
    if not stat.S_ISDIR(parent.st_mode) or not stat.S_ISDIR(root.st_mode):
        _fail("publisher-top-posture-invalid")
    if posture == "locked":
        expected_parent = (ROOT_UID, sandbox_gid, 0o1775)
        expected_root_owners = (ROOT_UID, sandbox_gid)
        expected_root_modes = (0o3770,)
        expected_file = (ROOT_UID, ROOT_GID, 0o444)
    else:
        expected_parent = (sandbox_uid, sandbox_gid, 0o755)
        expected_root_owners = (sandbox_uid, sandbox_gid)
        expected_root_modes = (0o700, 0o3770)
        expected_file = (sandbox_uid, sandbox_gid, 0o640)
    if (parent.st_uid, parent.st_gid, stat.S_IMODE(parent.st_mode)) != expected_parent:
        _fail("publisher-top-posture-invalid")
    if (root.st_uid, root.st_gid) != expected_root_owners or stat.S_IMODE(
        root.st_mode
    ) not in expected_root_modes:
        _fail("publisher-top-posture-invalid")
    for name in TOP_SELECTORS:
        path = os.path.join(HERMES_DIR, name)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            _fail("publisher-top-posture-invalid")
        try:
            metadata = os.fstat(fd)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_nlink != 1
                or (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode))
                != expected_file
            ):
                _fail("publisher-top-posture-invalid")
        finally:
            os.close(fd)


def _verify_state_posture(posture: str, plan_json: str) -> None:
    guard = _load_module(
        STATE_DIR_GUARD_PATH, "_nemoclaw_runtime_state_mutation_state_dir_guard"
    )
    try:
        plan = guard.parse_agent_state_lock_plan(plan_json)
        identity = guard._production_identity()
        if posture == "mutable":
            result = guard.run_guard(
                "verify-mutable",
                HERMES_DIR,
                identity,
                plan,
                mutable_top_level_files=tuple(
                    os.path.join(HERMES_DIR, name) for name in TOP_SELECTORS
                ),
            )
            if not result.ok:
                _fail("publisher-state-posture-invalid")
            return
        config_fd = guard._open_absolute_dir_nofollow(HERMES_DIR)
        config_st = os.fstat(config_fd)
        deadline = time.monotonic() + guard.MAX_GUARD_SECONDS
        roots, issues = guard._preflight(
            config_fd,
            HERMES_DIR,
            config_st.st_dev,
            deadline,
            "lock" if posture == "locked" else "unlock",
            plan,
        )
        if issues:
            _fail("publisher-state-posture-invalid")
        expected_roots = {(root.name, root.dev, root.ino) for root in roots}
        context = guard.TraversalContext(
            config_fd,
            HERMES_DIR,
            config_st.st_dev,
            tuple(root.name for root in roots),
            guard.WorkBudget(deadline),
            plan.writable_subpaths,
        )
        verification_issues: list[object] = []
        for root in roots:
            root_st = os.stat(root.name, dir_fd=config_fd, follow_symlinks=False)
            root_fd = guard._open_child_dir(config_fd, root.name, root_st)
            try:
                guard._verify_dir(
                    context,
                    root_fd,
                    root.name,
                    root.policy,
                    "lock" if posture == "locked" else "unlock",
                    identity,
                    {},
                    verification_issues,
                    1,
                    is_root=True,
                )
            finally:
                os.close(root_fd)
        current, selection_issues = guard._select_roots(
            config_fd, HERMES_DIR, config_st.st_dev, plan
        )
        if (
            verification_issues
            or selection_issues
            or {(root.name, root.dev, root.ino) for root in current} != expected_roots
        ):
            _fail("publisher-state-posture-invalid")
    except PublisherError:
        raise
    except Exception:
        _fail("publisher-state-posture-invalid")
    finally:
        if "config_fd" in locals():
            os.close(config_fd)


def _verify_final_posture(posture: str, plan_json: str) -> str:
    _verify_top_posture(posture)
    _verify_state_posture(posture, plan_json)
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "posture": posture,
        "stateLockPlanSha256": hashlib.sha256(plan_json.encode("utf-8")).hexdigest(),
    }
    return hashlib.sha256(_canonical(payload)).hexdigest()


def _receipt(
    normalized: dict[str, object], verification_sha256: str
) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": "nemoclaw-runtime-state-mutation-publisher-v1",
        "transactionId": normalized["transactionId"],
        "nonce": normalized["nonce"],
        "planSha256": normalized["planSha256"],
        "projectionSha256": normalized["projectionSha256"],
        "posture": normalized["posture"],
        "verificationSha256": verification_sha256,
    }


def _persist_phase(
    directory_fd: int,
    journal: dict[str, object],
    operation: dict[str, object],
    phase: str,
    token: str | None = None,
) -> None:
    operation["phase"] = phase
    if token is not None:
        operation["guardToken"] = token
    journal["operation"] = operation
    _write_journal(directory_fd, journal)


def _complete(
    directory_fd: int,
    journal: dict[str, object],
    normalized: dict[str, object],
) -> dict[str, object]:
    verification = _verify_final_posture(
        str(normalized["posture"]), str(normalized["stateLockPlanJson"])
    )
    journal["finalPosture"] = normalized["posture"]
    journal["operation"] = None
    _write_journal(directory_fd, journal)
    return _receipt(normalized, verification)


def _continue_forward(
    directory_fd: int,
    journal: dict[str, object],
    operation: dict[str, object],
    normalized: dict[str, object],
) -> dict[str, object]:
    posture = str(operation["posture"])
    rollback_posture = str(operation["rollbackPosture"])
    phase = str(operation["phase"])
    token = operation["guardToken"]
    guard_state = _matching_guard_token(directory_fd, posture, rollback_posture)
    if phase == "intent":
        if guard_state is None:
            token = _begin_guard(
                posture,
                rollback_posture,
                str(normalized["stateRootDevice"]),
                str(normalized["stateRootInode"]),
            )
        else:
            token, guard_phase = guard_state
            if guard_phase not in (
                "shields-transition-pending",
                "shields-transition-applied",
            ):
                _fail("publisher-guard-state-incomplete")
        _persist_phase(directory_fd, journal, operation, "begun", str(token))
        phase = "begun"
    if not isinstance(token, str) or HEX_64.fullmatch(token) is None:
        _fail("publisher-journal-invalid")
    if phase == "begun":
        _state_guard(token, posture, str(normalized["stateLockPlanJson"]))
        _persist_phase(directory_fd, journal, operation, "state-applied")
        phase = "state-applied"
    if phase == "state-applied":
        _apply_guard(token)
        _persist_phase(directory_fd, journal, operation, "top-applied")
        phase = "top-applied"
    if phase == "top-applied":
        if _load_guard_state(directory_fd) is not None:
            _finish_guard(token)
        return _complete(directory_fd, journal, normalized)
    return _fail("publisher-journal-invalid")


def _continue_abort(
    directory_fd: int,
    journal: dict[str, object],
    operation: dict[str, object],
    normalized: dict[str, object],
) -> dict[str, object]:
    token = operation["guardToken"]
    if not isinstance(token, str) or HEX_64.fullmatch(token) is None:
        _fail("publisher-journal-invalid")
    requested = str(normalized["posture"])
    if operation["rollbackPosture"] != requested:
        _fail("publisher-posture-invalid")
    phase = str(operation["phase"])
    if phase == "abort-requested":
        state = _load_guard_state(directory_fd)
        transition = (
            state.get("shields_transition") if isinstance(state, dict) else None
        )
        if (
            isinstance(state, dict)
            and state.get("phase") == "shields-transition-aborting"
            and isinstance(transition, dict)
            and transition.get("mode") == requested
        ):
            pass
        else:
            _prepare_abort_guard(token)
        _persist_phase(directory_fd, journal, operation, "abort-prepared")
        phase = "abort-prepared"
    if phase == "abort-prepared":
        _state_guard(token, requested, str(normalized["stateLockPlanJson"]))
        _persist_phase(directory_fd, journal, operation, "abort-state-applied")
        phase = "abort-state-applied"
    if phase == "abort-state-applied":
        if _load_guard_state(directory_fd) is not None:
            _abort_guard(token)
        return _complete(directory_fd, journal, normalized)
    return _fail("publisher-journal-invalid")


def apply_plan_posture(marker: dict[str, object], posture: str) -> dict[str, object]:
    """Apply and verify ``posture`` for one controller-normalized marker.

    ``posture`` must be exactly ``marker["target"]`` or
    ``marker["rollback"]``.  The return value is a canonicalizable receipt;
    callers must still keep the controller fence active until activation and
    host-ledger completion.
    """

    normalized = _normalize_marker(marker, posture)
    directory_fd = _open_durable_directory()
    lock_fd = -1
    try:
        lock_fd = _acquire_lock(directory_fd)
        journal = _load_journal(directory_fd, normalized)
        operation = _validate_operation(journal["operation"])
        if operation is None and journal["finalPosture"] == posture:
            verification = _verify_final_posture(
                posture, str(normalized["stateLockPlanJson"])
            )
            return _receipt(normalized, verification)
        if operation is None:
            rollback_posture = (
                str(journal["finalPosture"])
                if journal["finalPosture"] in ("locked", "mutable")
                else str(
                    normalized["rollback"]
                    if posture == normalized["target"]
                    else normalized["target"]
                )
            )
            if rollback_posture == posture:
                _fail("publisher-journal-invalid")
            operation = _operation(posture, rollback_posture)
            journal["operation"] = operation
            _write_journal(directory_fd, journal)
        if operation["posture"] != posture:
            guard_state = _load_guard_state(directory_fd)
            if operation["phase"] == "top-applied" and guard_state is None:
                # finish committed and removed its state, but the Docker exec
                # response was lost before this journal advanced. Prove that
                # posture first, then perform the requested opposite posture
                # as a fresh complete transaction.
                _verify_final_posture(
                    str(operation["posture"]),
                    str(normalized["stateLockPlanJson"]),
                )
                journal["finalPosture"] = operation["posture"]
                operation = _operation(posture, str(journal["finalPosture"]))
                journal["operation"] = operation
                _write_journal(directory_fd, journal)
            elif operation["phase"] == "intent" and guard_state is None:
                rollback_posture = str(operation["posture"])
                operation = _operation(posture, rollback_posture)
                journal["operation"] = operation
                _write_journal(directory_fd, journal)
            else:
                if operation["rollbackPosture"] != posture:
                    _fail("publisher-posture-invalid")
                if operation["phase"] == "intent":
                    recovered = _matching_guard_token(
                        directory_fd,
                        str(operation["posture"]),
                        str(operation["rollbackPosture"]),
                    )
                    if recovered is None or recovered[1] not in (
                        "shields-transition-pending",
                        "shields-transition-applied",
                    ):
                        _fail("publisher-guard-state-incomplete")
                    _persist_phase(
                        directory_fd,
                        journal,
                        operation,
                        "begun",
                        recovered[0],
                    )
                if operation["phase"] not in (
                    "abort-requested",
                    "abort-prepared",
                    "abort-state-applied",
                ):
                    _persist_phase(directory_fd, journal, operation, "abort-requested")
                return _continue_abort(directory_fd, journal, operation, normalized)
        if str(operation["phase"]).startswith("abort-"):
            return _continue_abort(directory_fd, journal, operation, normalized)
        return _continue_forward(directory_fd, journal, operation, normalized)
    finally:
        if lock_fd >= 0:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
        os.close(directory_fd)


def main() -> int:
    print(
        "runtime_state_mutation_hermes_publisher is a controller-imported module",
        file=sys.stderr,
    )
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
