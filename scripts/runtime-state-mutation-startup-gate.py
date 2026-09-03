#!/opt/hermes/.venv/bin/python3 -I
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Validate the exact non-root startup admitted by a root state-mutation permit.

The helper has no caller-selected path or command surface.  It is installed
root-owned and read-only in the Hermes image, reads only the fixed root-owned
permit/receipt names, binds them to its exact ``nemoclaw-start`` parent, and
publishes one canonical startup-complete candidate into the controller-created
nonce directory.  The root controller independently verifies that candidate
and the live process tree before promoting it to activation evidence.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import signal
import stat
import sys
from typing import NoReturn


SCHEMA_VERSION = 1
ROOT_UID = 0
ROOT_GID = 0
DURABLE_DIRECTORY = "/var/lib/nemoclaw/runtime-state-mutation"
ACTIVE_NAME = "active.json"
PERMIT_NAME = "activation-permit.json"
RELEASE_NAME = "activation-release.json"
RETRY_NAME = "activation-retry.json"
HANDOFF_ROOT = "/run/nemoclaw/runtime-state-mutation-startup"
CANDIDATE_NAME = "startup-complete.json"
RETRY_ACK_NAME = "retry-ack.json"
RELEASE_ACK_NAME = "release-ack.json"
PERMIT_PROTOCOL = "nemoclaw-runtime-state-mutation-activation-permit-v1"
RELEASE_PROTOCOL = "nemoclaw-runtime-state-mutation-activation-release-v1"
RETRY_PROTOCOL = "nemoclaw-runtime-state-mutation-activation-retry-v1"
CANDIDATE_PROTOCOL = "nemoclaw-runtime-state-mutation-startup-complete-v1"
RETRY_ACK_PROTOCOL = "nemoclaw-runtime-state-mutation-retry-ack-v1"
RELEASE_ACK_PROTOCOL = "nemoclaw-runtime-state-mutation-release-ack-v1"
MAX_FILE_BYTES = 32 * 1024
HEX_64 = re.compile(r"[0-9a-f]{64}\Z")
DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
PROCESS_REFERENCE_KEYS = (
    "pid",
    "startIdentity",
    "parentPid",
    "uids",
    "commandSha256",
    "procDevice",
    "procInode",
    "executableDevice",
    "executableInode",
)
PERMIT_KEYS = (
    "schemaVersion",
    "protocol",
    "transactionId",
    "nonce",
    "markerSha256",
    "start",
    "candidateDirectory",
)
RELEASE_KEYS = (
    "schemaVersion",
    "protocol",
    "transactionId",
    "nonce",
    "checkpointSha256",
    "start",
    "candidateDirectory",
)
RETRY_KEYS = (
    "schemaVersion",
    "protocol",
    "transactionId",
    "nonce",
    "permitSha256",
    "checkpointSha256",
    "start",
    "candidateDirectory",
)


class GateError(RuntimeError):
    """A fixed, non-sensitive startup-gate refusal."""

    def __init__(self, code: str, transaction_id: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.transaction_id = transaction_id

    def with_transaction(self, transaction_id: str) -> GateError:
        if self.transaction_id is not None:
            return self
        return GateError(self.code, transaction_id)


def _fail(code: str) -> NoReturn:
    raise GateError(code)


def _pairs(values: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in values:
        if key in result:
            _fail("duplicate-json-field")
        result[key] = value
    return result


def _canonical(value: object) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8", "strict"
        )
    except (TypeError, ValueError, UnicodeEncodeError):
        return _fail("invalid-json")


def _parse(raw: bytes, code: str) -> object:
    if not raw or len(raw) > MAX_FILE_BYTES:
        _fail(code)
    try:
        value = json.loads(
            raw.decode("utf-8", "strict"),
            object_pairs_hook=_pairs,
            parse_constant=lambda _value: _fail(code),
            parse_float=lambda _value: _fail(code),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, GateError):
        _fail(code)
    if raw != _canonical(value) + b"\n":
        _fail(code)
    return value


def _directory_flags(*, readable: bool = False) -> int:
    # Linux O_PATH preserves search-only 0711 traversal without granting the
    # sandbox identity directory-enumeration access. Writers reopen only the
    # sandbox-owned final directory readably so its fsync remains valid.
    directory_access = os.O_RDONLY if readable else getattr(os, "O_PATH", os.O_RDONLY)
    return directory_access | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def _open_absolute_directory(path: str, *, readable_final: bool = False) -> int:
    if not path.startswith("/") or os.path.normpath(path) != path:
        _fail("unsafe-directory")
    components = path.split("/")[1:]
    current = os.open("/", _directory_flags(readable=readable_final and not components))
    try:
        for index, component in enumerate(components):
            next_fd = os.open(
                component,
                _directory_flags(
                    readable=readable_final and index == len(components) - 1
                ),
                dir_fd=current,
            )
            os.close(current)
            current = next_fd
        return current
    except OSError:
        os.close(current)
        return _fail("unsafe-directory")


def _stable_stat(value: os.stat_result) -> tuple[object, ...]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_nlink,
        value.st_uid,
        value.st_gid,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _same_filesystem_object(first: os.stat_result, second: os.stat_result) -> bool:
    return first.st_dev == second.st_dev and first.st_ino == second.st_ino


def _read_at(
    directory_fd: int,
    name: str,
    *,
    uid: int,
    gid: int,
    mode: int,
    missing: bool = False,
) -> bytes | None:
    try:
        fd = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
            dir_fd=directory_fd,
        )
    except FileNotFoundError:
        if missing:
            return None
        _fail("gate-file-missing")
    except OSError:
        _fail("gate-file-invalid")
    try:
        before = os.fstat(fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != uid
            or before.st_gid != gid
            or stat.S_IMODE(before.st_mode) != mode
            or before.st_nlink != 1
        ):
            _fail("gate-file-invalid")
        payload = os.read(fd, MAX_FILE_BYTES + 1)
        after = os.fstat(fd)
        if (
            len(payload) > MAX_FILE_BYTES
            or os.read(fd, 1)
            or _stable_stat(before) != _stable_stat(after)
        ):
            _fail("gate-file-invalid")
        return payload
    finally:
        os.close(fd)


def _active_directory() -> int | None:
    try:
        before = os.stat(DURABLE_DIRECTORY, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError:
        _fail("gate-directory-invalid")
    directory_fd = _open_absolute_directory(DURABLE_DIRECTORY)
    metadata = os.fstat(directory_fd)
    if (
        _stable_stat(before) != _stable_stat(metadata)
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != ROOT_UID
        or metadata.st_gid != ROOT_GID
        or stat.S_IMODE(metadata.st_mode) != 0o711
    ):
        os.close(directory_fd)
        _fail("gate-directory-invalid")
    return directory_fd


def _active_exists(directory_fd: int | None) -> bool:
    if directory_fd is None:
        return False
    try:
        metadata = os.stat(ACTIVE_NAME, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    except OSError:
        _fail("active-gate-invalid")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != ROOT_UID
        or metadata.st_gid != ROOT_GID
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        _fail("active-gate-invalid")
    return True


def _hex(value: object, code: str) -> str:
    if not isinstance(value, str) or HEX_64.fullmatch(value) is None:
        _fail(code)
    return value


def _decimal(value: object, code: str) -> str:
    if not isinstance(value, str) or DECIMAL.fullmatch(value) is None:
        _fail(code)
    return value


def _command_sha256(command: tuple[bytes, ...]) -> str:
    framed = b"".join(len(part).to_bytes(4, "big") + part for part in command)
    return hashlib.sha256(framed).hexdigest()


def _read_proc_file(path: str) -> bytes:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError:
        _fail("start-process-unavailable")
    try:
        payload = os.read(fd, MAX_FILE_BYTES + 1)
        if len(payload) > MAX_FILE_BYTES or os.read(fd, 1):
            _fail("start-process-unavailable")
        return payload
    finally:
        os.close(fd)


def _parse_proc_stat(raw: bytes) -> tuple[int, str]:
    try:
        text = raw.decode("ascii", "strict")
        suffix = text[text.rindex(") ") + 2 :].split()
        parent = int(suffix[1], 10)
        start = suffix[19]
    except (UnicodeDecodeError, ValueError, IndexError):
        _fail("start-process-unavailable")
    if parent < 0 or DECIMAL.fullmatch(start) is None:
        _fail("start-process-unavailable")
    return parent, start


def _parse_uids(raw: bytes) -> tuple[int, int, int, int]:
    try:
        lines = raw.decode("ascii", "strict").splitlines()
    except UnicodeDecodeError:
        _fail("start-process-unavailable")
    for line in lines:
        if not line.startswith("Uid:"):
            continue
        fields = line.split()[1:]
        if len(fields) == 4 and all(DECIMAL.fullmatch(field) for field in fields):
            return tuple(int(field, 10) for field in fields)  # type: ignore[return-value]
    return _fail("start-process-unavailable")


def _capture_parent() -> dict[str, object]:
    pid = os.getppid()
    process_path = f"/proc/{pid}"
    executable_path = f"{process_path}/exe"
    try:
        before = os.stat(process_path, follow_symlinks=False)
        executable_before = os.stat(executable_path)
        first = _read_proc_file(f"{process_path}/stat")
        status = _read_proc_file(f"{process_path}/status")
        command_raw = _read_proc_file(f"{process_path}/cmdline")
        second = _read_proc_file(f"{process_path}/stat")
        executable_after = os.stat(executable_path)
        after = os.stat(process_path, follow_symlinks=False)
    except OSError:
        _fail("start-process-unavailable")
    first_parent, first_start = _parse_proc_stat(first)
    second_parent, second_start = _parse_proc_stat(second)
    if (
        not stat.S_ISDIR(before.st_mode)
        or _stable_stat(before) != _stable_stat(after)
        or not _same_filesystem_object(executable_before, executable_after)
        or (first_parent, first_start) != (second_parent, second_start)
    ):
        _fail("start-process-unavailable")
    command = tuple(part for part in command_raw.split(b"\0") if part)
    return {
        "pid": pid,
        "startIdentity": second_start,
        "parentPid": second_parent,
        "uids": list(_parse_uids(status)),
        "commandSha256": _command_sha256(command),
        "procDevice": str(before.st_dev),
        "procInode": str(before.st_ino),
        "executableDevice": str(executable_after.st_dev),
        "executableInode": str(executable_after.st_ino),
    }


def _process_reference(value: object, code: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != set(PROCESS_REFERENCE_KEYS):
        _fail(code)
    if (
        type(value["pid"]) is not int
        or value["pid"] <= 1
        or type(value["parentPid"]) is not int
        or value["parentPid"] < 0
        or not isinstance(value["uids"], list)
        or len(value["uids"]) != 4
        or any(type(uid) is not int or uid < 0 for uid in value["uids"])
    ):
        _fail(code)
    return {
        "pid": value["pid"],
        "startIdentity": _decimal(value["startIdentity"], code),
        "parentPid": value["parentPid"],
        "uids": value["uids"],
        "commandSha256": _hex(value["commandSha256"], code),
        "procDevice": _decimal(value["procDevice"], code),
        "procInode": _decimal(value["procInode"], code),
        "executableDevice": _decimal(value["executableDevice"], code),
        "executableInode": _decimal(value["executableInode"], code),
    }


def _binding(raw: bytes, protocol: str, keys: tuple[str, ...]) -> dict[str, object]:
    value = _parse(raw, "gate-receipt-invalid")
    if not isinstance(value, dict) or set(value) != set(keys):
        _fail("gate-receipt-invalid")
    if value["schemaVersion"] != SCHEMA_VERSION or value["protocol"] != protocol:
        _fail("gate-receipt-invalid")
    transaction_id = _hex(value["transactionId"], "gate-receipt-invalid")
    try:
        nonce = _hex(value["nonce"], "gate-receipt-invalid")
        expected_directory = f"{HANDOFF_ROOT}/{nonce}"
        if value["candidateDirectory"] != expected_directory:
            _fail("gate-receipt-invalid")
        start = _process_reference(value["start"], "gate-receipt-invalid")
        if _canonical(start) != _canonical(_capture_parent()):
            _fail("gate-start-mismatch")
        if protocol == PERMIT_PROTOCOL:
            protocol_binding: dict[str, object] = {
                "markerSha256": _hex(value["markerSha256"], "gate-receipt-invalid")
            }
        elif protocol == RELEASE_PROTOCOL:
            protocol_binding = {
                "checkpointSha256": _hex(value["checkpointSha256"], "gate-receipt-invalid")
            }
        else:
            checkpoint = value["checkpointSha256"]
            protocol_binding = {
                "permitSha256": _hex(value["permitSha256"], "gate-receipt-invalid"),
                "checkpointSha256": (
                    None
                    if checkpoint is None
                    else _hex(checkpoint, "gate-receipt-invalid")
                ),
            }
        normalized = {
            "schemaVersion": SCHEMA_VERSION,
            "protocol": protocol,
            "transactionId": transaction_id,
            "nonce": nonce,
            **protocol_binding,
            "start": start,
            "candidateDirectory": expected_directory,
        }
        if raw != _canonical(normalized) + b"\n":
            _fail("gate-receipt-invalid")
        return normalized
    except GateError as error:
        raise error.with_transaction(transaction_id) from None


def _read_binding(
    directory_fd: int, name: str, protocol: str, keys: tuple[str, ...]
) -> dict[str, object] | None:
    raw = _read_at(
        directory_fd,
        name,
        uid=ROOT_UID,
        gid=ROOT_GID,
        mode=0o444,
        missing=True,
    )
    return None if raw is None else _binding(raw, protocol, keys)


def _candidate(binding: dict[str, object]) -> tuple[dict[str, object], bytes]:
    candidate = {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": CANDIDATE_PROTOCOL,
        "transactionId": binding["transactionId"],
        "nonce": binding["nonce"],
        "markerSha256": binding["markerSha256"],
        "start": binding["start"],
    }
    return candidate, _canonical(candidate) + b"\n"


def _publish_candidate(binding: dict[str, object]) -> None:
    directory = str(binding["candidateDirectory"])
    directory_fd = _open_absolute_directory(directory, readable_final=True)
    try:
        metadata = os.fstat(directory_fd)
        if (
            metadata.st_uid != os.geteuid()
            or metadata.st_gid != os.getegid()
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            _fail("candidate-directory-invalid")
        _value, payload = _candidate(binding)
        existing = _read_at(
            directory_fd,
            CANDIDATE_NAME,
            uid=os.geteuid(),
            gid=os.getegid(),
            mode=0o600,
            missing=True,
        )
        if existing is not None:
            if existing != payload:
                _fail("candidate-conflict")
            return
        temporary = f".{CANDIDATE_NAME}.{os.getpid()}.{secrets.token_hex(8)}"
        fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=directory_fd,
        )
        try:
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    _fail("candidate-write-failed")
                view = view[written:]
            os.fchmod(fd, 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(
            temporary,
            CANDIDATE_NAME,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        os.fsync(directory_fd)
    except OSError:
        _fail("candidate-write-failed")
    finally:
        os.close(directory_fd)


def _verify_release_candidate(binding: dict[str, object]) -> None:
    directory_fd = _open_absolute_directory(str(binding["candidateDirectory"]))
    try:
        raw = _read_at(
            directory_fd,
            CANDIDATE_NAME,
            uid=os.geteuid(),
            gid=os.getegid(),
            mode=0o600,
        )
    finally:
        os.close(directory_fd)
    if raw is None or hashlib.sha256(raw).hexdigest() != binding["checkpointSha256"]:
        _fail("release-candidate-mismatch")


def _verify_retry_binding(directory_fd: int, binding: dict[str, object]) -> bytes:
    permit_raw = _read_at(
        directory_fd,
        PERMIT_NAME,
        uid=ROOT_UID,
        gid=ROOT_GID,
        mode=0o444,
    )
    if (
        permit_raw is None
        or hashlib.sha256(permit_raw).hexdigest() != binding["permitSha256"]
    ):
        _fail("retry-permit-mismatch")
    permit = _binding(permit_raw, PERMIT_PROTOCOL, PERMIT_KEYS)
    if (
        binding["transactionId"] != permit["transactionId"]
        or binding["nonce"] != permit["nonce"]
        or binding["start"] != permit["start"]
        or binding["candidateDirectory"] != permit["candidateDirectory"]
    ):
        _fail("retry-permit-mismatch")
    checkpoint = binding["checkpointSha256"]
    if checkpoint is not None:
        candidate_fd = _open_absolute_directory(str(binding["candidateDirectory"]))
        try:
            candidate_raw = _read_at(
                candidate_fd,
                CANDIDATE_NAME,
                uid=os.geteuid(),
                gid=os.getegid(),
                mode=0o600,
            )
        finally:
            os.close(candidate_fd)
        if (
            candidate_raw is None
            or hashlib.sha256(candidate_raw).hexdigest() != checkpoint
        ):
            _fail("retry-candidate-mismatch")
    return _canonical(binding) + b"\n"


def _publish_retry_ack(binding: dict[str, object], retry_payload: bytes) -> None:
    directory_fd = _open_absolute_directory(
        str(binding["candidateDirectory"]), readable_final=True
    )
    try:
        metadata = os.fstat(directory_fd)
        if (
            metadata.st_uid != os.geteuid()
            or metadata.st_gid != os.getegid()
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            _fail("candidate-directory-invalid")
        ack = {
            "schemaVersion": SCHEMA_VERSION,
            "protocol": RETRY_ACK_PROTOCOL,
            "transactionId": binding["transactionId"],
            "nonce": binding["nonce"],
            "retrySha256": hashlib.sha256(retry_payload).hexdigest(),
            "start": binding["start"],
        }
        payload = _canonical(ack) + b"\n"
        existing = _read_at(
            directory_fd,
            RETRY_ACK_NAME,
            uid=os.geteuid(),
            gid=os.getegid(),
            mode=0o600,
            missing=True,
        )
        if existing is not None:
            if existing != payload:
                _fail("retry-ack-conflict")
            return
        temporary = f".{RETRY_ACK_NAME}.{os.getpid()}.{secrets.token_hex(8)}"
        fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=directory_fd,
        )
        try:
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    _fail("retry-ack-write-failed")
                view = view[written:]
            os.fchmod(fd, 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(
            temporary,
            RETRY_ACK_NAME,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        os.fsync(directory_fd)
    except OSError:
        _fail("retry-ack-write-failed")
    finally:
        os.close(directory_fd)
    return


def _prepare_release_ack(binding: dict[str, object]) -> str:
    directory_fd = _open_absolute_directory(
        str(binding["candidateDirectory"]), readable_final=True
    )
    try:
        metadata = os.fstat(directory_fd)
        if (
            metadata.st_uid != os.geteuid()
            or metadata.st_gid != os.getegid()
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            _fail("candidate-directory-invalid")
        release_payload = _canonical(binding) + b"\n"
        ack = {
            "schemaVersion": SCHEMA_VERSION,
            "protocol": RELEASE_ACK_PROTOCOL,
            "transactionId": binding["transactionId"],
            "nonce": binding["nonce"],
            "releaseSha256": hashlib.sha256(release_payload).hexdigest(),
            "start": binding["start"],
        }
        payload = _canonical(ack) + b"\n"
        existing = _read_at(
            directory_fd,
            RELEASE_ACK_NAME,
            uid=os.geteuid(),
            gid=os.getegid(),
            mode=0o600,
            missing=True,
        )
        if existing is not None:
            if existing != payload:
                _fail("release-ack-conflict")
            return str(binding["nonce"])
        temporary = f".{RELEASE_ACK_NAME}.{os.getpid()}.{secrets.token_hex(8)}"
        fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=directory_fd,
        )
        try:
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    _fail("release-ack-write-failed")
                view = view[written:]
            os.fchmod(fd, 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(
            temporary,
            RELEASE_ACK_NAME,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        os.fsync(directory_fd)
        return str(binding["nonce"])
    except OSError:
        return _fail("release-ack-write-failed")
    finally:
        os.close(directory_fd)


def _run(action: str) -> str:
    directory_fd = _active_directory()
    if not _active_exists(directory_fd):
        if directory_fd is not None:
            os.close(directory_fd)
        if action == "acknowledge":
            _fail("activation-release-missing")
        return "inactive"
    assert directory_fd is not None
    transaction_id: str | None = None
    try:
        released = _read_binding(
            directory_fd, RELEASE_NAME, RELEASE_PROTOCOL, RELEASE_KEYS
        )
        if released is not None:
            transaction_id = str(released["transactionId"])
            _verify_release_candidate(released)
            if action == "acknowledge":
                return _prepare_release_ack(released)
            return "released"
        retry = _read_binding(directory_fd, RETRY_NAME, RETRY_PROTOCOL, RETRY_KEYS)
        if retry is not None:
            transaction_id = str(retry["transactionId"])
            retry_payload = _verify_retry_binding(directory_fd, retry)
            if action == "admit":
                _publish_retry_ack(retry, retry_payload)
                return "retry-wait"
            if action in ("restart", "resume"):
                return "retry"
            _fail("activation-retry-pending")
        permit = _read_binding(directory_fd, PERMIT_NAME, PERMIT_PROTOCOL, PERMIT_KEYS)
        if permit is None:
            _fail("activation-not-permitted")
        transaction_id = str(permit["transactionId"])
        if action == "checkpoint":
            _publish_candidate(permit)
            return "activation-ready"
        if action in ("restart", "resume"):
            _fail("activation-not-released")
        return "permitted"
    except GateError as error:
        if transaction_id is None:
            raise
        raise error.with_transaction(transaction_id) from None
    finally:
        os.close(directory_fd)


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if arguments not in (
        ["admit"],
        ["checkpoint"],
        ["restart"],
        ["resume"],
        ["acknowledge"],
    ):
        print("runtime-state-mutation-startup-gate: invalid action", file=sys.stderr)
        return 64
    try:
        state = _run(arguments[0])
        print(state)
        if arguments[0] == "acknowledge":
            # Keep the exact publisher inspectable until the root controller
            # resumes it. Its parent cannot report success before this process
            # exits and is reaped.
            os.kill(os.getpid(), signal.SIGSTOP)
            return 0
        return {
            "inactive": 0,
            "released": 0,
            "permitted": 10,
            "activation-ready": 11,
            "retry": 12,
            "retry-wait": 75,
        }[state]
    except GateError as error:
        transaction_id = error.transaction_id or "unknown"
        print(
            "runtime-state-mutation-startup-gate: invalid-state "
            f"code={error.code} transaction={transaction_id}",
            file=sys.stderr,
        )
        return 76
    except OSError:
        print(
            "runtime-state-mutation-startup-gate: invalid-state "
            "code=gate-io-error transaction=unknown",
            file=sys.stderr,
        )
        return 76


if __name__ == "__main__":
    raise SystemExit(main())
