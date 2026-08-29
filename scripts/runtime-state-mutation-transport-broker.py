#!/opt/hermes/.venv/bin/python3 -I
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Broker fixed root state-mutation requests while the supervisor is stopped."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time


ROOT = "/run/nemoclaw/runtime-state-mutation"
HELPER = "/usr/local/lib/nemoclaw/runtime-state-mutation-control.py"
EXPECTED_UID = 0
EXPECTED_GID = 0
MAXIMUM = 128 * 1024
TIMEOUTS = {
    "acquire": 30,
    "assert": 30,
    "publish": 900,
    "recover": 900,
    "rollback": 900,
    "activate": 485,
    "release": 300,
}
IDENTITY = re.compile(r"[a-f0-9]{64}\Z")
INCOMING = re.compile(
    r"([a-f0-9]{64})\.(acquire|assert|publish|recover|rollback|activate|release)\.incoming\Z"
)
PUBLICATION_SETTLE_SECONDS = 5


def fail(code: str) -> None:
    raise RuntimeError(code)


def directory(path: str) -> None:
    metadata = os.lstat(path)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != EXPECTED_UID
        or metadata.st_gid != EXPECTED_GID
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        fail("transport-directory-invalid")


def atomic(path: str, payload: bytes) -> None:
    temporary = path + ".tmp-" + str(os.getpid())
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
        0o600,
    )
    try:
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                fail("transport-write-failed")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def private_file(path: str) -> bytes:
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
    )
    try:
        before = os.fstat(descriptor)
        payload = os.read(descriptor, MAXIMUM + 1)
        after = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != EXPECTED_UID
            or before.st_gid != EXPECTED_GID
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_nlink != 1
            or len(payload) > MAXIMUM
            or os.read(descriptor, 1)
            or (
                before.st_dev,
                before.st_ino,
                before.st_mode,
                before.st_nlink,
                before.st_uid,
                before.st_gid,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            )
            != (
                after.st_dev,
                after.st_ino,
                after.st_mode,
                after.st_nlink,
                after.st_uid,
                after.st_gid,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            )
        ):
            fail("transport-file-invalid")
        return payload
    finally:
        os.close(descriptor)


def copied_file(path: str) -> bytes:
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
    )
    try:
        before = os.fstat(descriptor)
        payload = bytearray()
        while len(payload) <= MAXIMUM:
            chunk = os.read(
                descriptor,
                min(64 * 1024, MAXIMUM + 1 - len(payload)),
            )
            if not chunk:
                break
            payload.extend(chunk)
        after = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or len(payload) > MAXIMUM
            or (
                before.st_dev,
                before.st_ino,
                before.st_nlink,
                before.st_uid,
                before.st_gid,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            )
            != (
                after.st_dev,
                after.st_ino,
                after.st_nlink,
                after.st_uid,
                after.st_gid,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            )
        ):
            fail("transport-copied-file-invalid")
        return bytes(payload)
    finally:
        os.close(descriptor)


def response_payload(
    action: str,
    identity: str,
    status_code: int,
    stdout: str,
    stderr: str,
) -> bytes:
    return (
        json.dumps(
            {
                "schemaVersion": 1,
                "action": action,
                "identity": identity,
                "status": status_code,
                "stdout": stdout,
                "stderr": stderr,
            },
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
    )


def failure_stderr(action: str, code: str) -> str:
    return (
        json.dumps(
            {
                "schemaVersion": 1,
                "action": action,
                "status": "failed",
                "code": code,
            },
            ensure_ascii=True,
            separators=(",", ":"),
        )
        + "\n"
    )


def post_validation_failure_code(error: BaseException) -> str:
    if isinstance(error, RuntimeError):
        code = str(error)
        if code in (
            "helper-file-missing",
            "helper-file-invalid",
            "transport-response-too-large",
        ):
            return code
        return "transport-runtime-failed"
    if isinstance(error, UnicodeError):
        return "transport-response-encoding-invalid"
    if isinstance(error, FileNotFoundError):
        return "transport-resource-missing"
    if isinstance(error, PermissionError):
        return "transport-permission-denied"
    if isinstance(error, OSError):
        return "transport-io-failed"
    return "transport-response-invalid"


def normalize_helper_stderr(action: str, status_code: int, stderr: bytes) -> bytes:
    if not stderr:
        return stderr
    try:
        failure = json.loads(stderr.decode("utf-8", "strict"))
        if (
            isinstance(failure, dict)
            and failure.get("schemaVersion") == 1
            and failure.get("action") == action
            and failure.get("status") == "failed"
            and isinstance(failure.get("code"), str)
            and re.fullmatch(r"[a-z][a-z0-9-]{0,127}", failure["code"])
            is not None
        ):
            return stderr
    except (UnicodeError, ValueError):
        pass
    code = "helper-process-failed" if status_code != 0 else "helper-protocol-stderr"
    return failure_stderr(action, code).encode("utf-8")


def run_helper(action: str, request: bytes) -> subprocess.CompletedProcess[bytes]:
    try:
        metadata = os.lstat(HELPER)
    except FileNotFoundError:
        fail("helper-file-missing")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != EXPECTED_UID
        or metadata.st_gid != EXPECTED_GID
        or stat.S_IMODE(metadata.st_mode) & 0o022
    ):
        fail("helper-file-invalid")
    deadline = time.monotonic() + TIMEOUTS[action]
    completed: subprocess.CompletedProcess[bytes] | None = None
    for _ in range(2):
        process = subprocess.Popen(
            [sys.executable, "-I", HELPER, action],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(
                request,
                timeout=max(0.001, deadline - time.monotonic()),
            )
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                try:
                    process.kill()
                except OSError:
                    pass
            try:
                process.communicate(timeout=5)
            except (subprocess.TimeoutExpired, OSError):
                pass
            raise
        completed = subprocess.CompletedProcess(
            process.args,
            process.returncode,
            stdout=stdout,
            stderr=stderr,
        )
        if completed.returncode >= 0:
            return completed
        # Replay one signal exit inside this action's deadline.
    assert completed is not None
    return completed


def serve(transaction: str) -> None:
    os.makedirs(ROOT, mode=0o700, exist_ok=True)
    directory(ROOT)
    session = os.path.join(ROOT, transaction)
    os.makedirs(session, mode=0o700, exist_ok=True)
    directory(session)
    lock = os.open(
        os.path.join(session, "broker.lock"),
        os.O_RDWR | os.O_CREAT | os.O_CLOEXEC,
        0o600,
    )
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    atomic(os.path.join(session, "ready"), (transaction + "\n").encode("ascii"))
    pending: dict[str, float] = {}

    while True:
        names = sorted(os.listdir(session))
        if "released" in names and "resumed" in names:
            try:
                expected = (transaction + "\n").encode("ascii")
                if private_file(
                    os.path.join(session, "released")
                ) == expected and copied_file(os.path.join(session, "resumed")) == expected:
                    for name in ("released", "resumed", "ready", "broker.lock"):
                        try:
                            os.unlink(os.path.join(session, name))
                        except FileNotFoundError:
                            pass
                    try:
                        os.rmdir(session)
                    except OSError:
                        pass
                    return
            except (OSError, RuntimeError, UnicodeError, ValueError):
                pass
        for name in names:
            incoming = INCOMING.fullmatch(name)
            if incoming is None:
                continue
            identity, action = incoming.groups()
            request_path = os.path.join(session, name)
            response_path = os.path.join(session, identity + ".response")
            if os.path.exists(response_path):
                continue
            validated = False
            try:
                request = copied_file(request_path)
                if (
                    not request.endswith(b"\n")
                    or hashlib.sha256(request).hexdigest() != identity
                ):
                    fail("transport-request-invalid")
                envelope = json.loads(request.decode("utf-8", "strict"))
                if (
                    not isinstance(envelope, dict)
                    or envelope.get("action") != action
                    or envelope.get("transactionId") != transaction
                ):
                    fail("transport-request-invalid")
                validated = True
                pending.pop(name, None)
                os.unlink(request_path)
                completed = run_helper(action, request)
                if len(completed.stdout) > MAXIMUM or len(completed.stderr) > MAXIMUM:
                    fail("transport-response-too-large")
                status_code = (
                    completed.returncode
                    if completed.returncode >= 0
                    else 128 - completed.returncode
                )
                stderr = normalize_helper_stderr(action, status_code, completed.stderr)
                response = response_payload(
                    action,
                    identity,
                    status_code,
                    completed.stdout.decode("utf-8", "strict"),
                    stderr.decode("utf-8", "strict"),
                )
            except subprocess.TimeoutExpired:
                response = response_payload(
                    action,
                    identity,
                    1,
                    "",
                    failure_stderr(action, "helper-timeout"),
                )
            except (OSError, RuntimeError, UnicodeError, ValueError) as error:
                if not validated:
                    first_observed = pending.setdefault(name, time.monotonic())
                    if (
                        time.monotonic() - first_observed
                        < PUBLICATION_SETTLE_SECONDS
                    ):
                        continue
                    pending.pop(name, None)
                    try:
                        os.unlink(request_path)
                    except FileNotFoundError:
                        pass
                    response = response_payload(
                        action,
                        identity,
                        1,
                        "",
                        failure_stderr(action, "transport-request-invalid"),
                    )
                else:
                    # Return a safe failure class, never exception text or contents.
                    response = response_payload(
                        action,
                        identity,
                        1,
                        "",
                        failure_stderr(action, post_validation_failure_code(error)),
                    )
            atomic(response_path, response)
        for name in names:
            if not name.endswith(".ack"):
                continue
            identity = name[:-4]
            if IDENTITY.fullmatch(identity) is None:
                continue
            response_path = os.path.join(session, identity + ".response")
            if not os.path.exists(response_path):
                continue
            try:
                response = json.loads(private_file(response_path).decode("utf-8", "strict"))
                if copied_file(os.path.join(session, name)) != (
                    identity + "\n"
                ).encode("ascii"):
                    fail("transport-ack-invalid")
                successful_release = (
                    response.get("action") == "release"
                    and response.get("status") == 0
                )
                for suffix in (".response", ".ack"):
                    try:
                        os.unlink(os.path.join(session, identity + suffix))
                    except FileNotFoundError:
                        pass
                if successful_release:
                    atomic(
                        os.path.join(session, "released"),
                        (transaction + "\n").encode("ascii"),
                    )
            except (OSError, RuntimeError, UnicodeError, ValueError):
                pass
        time.sleep(0.05)


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 1 or IDENTITY.fullmatch(arguments[0]) is None:
        print("runtime-state-mutation-transport-broker: invalid arguments", file=sys.stderr)
        return 64
    serve(arguments[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
