#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Root-only lifecycle control for an OpenShell-managed gateway.

OpenShell is container PID 1 in its managed topology and starts
``nemoclaw-start`` as the unprivileged ``sandbox`` user.  The shell entrypoint
still owns and reaps the gateway child, so this helper never launches a second
gateway and never trusts a status file writable by that user.  Instead it:

* verifies a stable OpenShell -> nemoclaw-start -> gateway process tree;
* signals the already-proven gateway through a pidfd;
* waits for the entrypoint's normal respawn loop; and
* independently proves the replacement process, listener, and HTTP health.

The host enters this helper through registry-scoped ``docker exec --user root``.
The installed copy is root-owned and mode 0500, which is the host request
authentication boundary.  No same-UID request or completion channel exists.
Because the managed supervisor, gateway, and agent all share the ``sandbox``
UID, this process-shape proof prevents PID reuse and accidental cross-process
signalling but cannot establish provenance against a malicious same-UID agent.

Managed non-root startup has no durable root-owned config hash for mutable
configuration.  Hermes therefore gets its canonical secret-boundary checks and
strict hash verification whenever the files are in the locked root-owned
posture, but mutable config retains the same trust/TOCTOU limitations as the
managed cold-start path.  Do not describe this branch as equivalent to the
root-PID-1 restart seal.

This helper also cannot manufacture gateway/agent UID isolation: both remain
``sandbox`` processes in the OpenShell-managed topology.  It authenticates the
host lifecycle action and prevents PID-reuse signaling, but the same sandbox
UID can already signal its peers.  Full isolation requires a root supervisor
that launches the gateway under a distinct UID.

This compatibility path cannot fix that upstream process topology locally
without replacing OpenShell's PID 1 ownership contract.  Remove it when the
minimum supported OpenShell launches a root-owned lifecycle supervisor or a
gateway under a UID distinct from the agent, then migrate both built-in agents
to that source-of-truth boundary.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import http.client
import importlib.util
import os
import pwd
import re
import select
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass


INSTALLED_HELPER_PATH = "/usr/local/lib/nemoclaw/managed-gateway-control.py"
HERMES_GUARD_PATH = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"
HERMES_BOUNDARY_PATH = (
    "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py"
)
OPENCLAW_GUARD_PATH = "/usr/local/lib/nemoclaw/openclaw-config-guard.py"
OPENSHELL_ARGV0 = b"/opt/openshell/bin/openshell-sandbox"
NEMOCLAW_START_PATH = b"/usr/local/bin/nemoclaw-start"
MAX_PROC_ENTRIES = 32768
MAX_PROC_FILE_BYTES = 1024 * 1024
MAX_ENV_BYTES = 4 * 1024 * 1024
MAX_CONFIG_BYTES = 16 * 1024 * 1024
MAX_HASH_BYTES = 64 * 1024
STOP_GRACE_SECONDS = 5.0
KILL_GRACE_SECONDS = 5.0
RECOVERY_TIMEOUT_SECONDS = 150.0
RECOVER_EXISTING_GRACE_SECONDS = 10.0
POLL_SECONDS = 0.2
SUPERVISOR_DISCOVERY_ATTEMPTS = 3
SUPERVISOR_DISCOVERY_RETRY_SECONDS = 0.02
NEMOCLAW_RUNTIME_DIR = "/run/nemoclaw"
NEMOCLAW_RUNTIME_DIR_MODE = 0o711
EXPECTED_EXIT_MARKER_NAME = "managed-gateway-expected-exit"
EXPECTED_EXIT_LOCK_NAME = "managed-gateway-expected-exit.lock"
NONCE_RE = re.compile(r"[0-9a-f]{64}\Z")
ENV_KEY_RE = re.compile(rb"[A-Za-z_][A-Za-z0-9_]*\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")


class ControlError(RuntimeError):
    """A failure whose code is part of the existing host marker contract."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    start_time: str
    parent_pid: int
    state: str
    uids: tuple[int, int, int, int]
    namespace_pid: int
    namespace_inode: int | None
    cmdline: tuple[bytes, ...]
    proc_device: int
    proc_inode: int

    def stable_key(self) -> tuple[object, ...]:
        return (
            self.pid,
            self.start_time,
            self.parent_pid,
            self.state == "Z",
            self.uids,
            self.namespace_pid,
            self.namespace_inode,
            self.cmdline,
            self.proc_device,
            self.proc_inode,
        )


@dataclass(frozen=True)
class AgentSpec:
    name: str
    port: int
    health_path: str = "/health"
    readiness_checks: tuple[tuple[int, str], ...] = ()


@dataclass(frozen=True)
class ExpectedExitLease:
    """Pinned authorization marker and root-only controller lock."""

    directory_fd: int
    lock_fd: int
    marker_fd: int
    name: str
    device: int
    inode: int


def _source_mode() -> bool:
    return os.path.abspath(__file__) != INSTALLED_HELPER_PATH


def _source_test_mode() -> bool:
    return (
        _source_mode()
        and os.environ.get("NEMOCLAW_MANAGED_CONTROL_ALLOW_NONROOT_TEST") == "1"
    )


def _proc_root() -> str:
    if _source_test_mode():
        return os.environ.get("NEMOCLAW_MANAGED_CONTROL_PROC_ROOT", "/proc")
    return "/proc"


def _system_root() -> str:
    if _source_test_mode():
        return os.environ.get("NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT", "/")
    return "/"


def _system_path(path: str) -> str:
    root = os.path.abspath(_system_root())
    if root == "/":
        return path
    return os.path.join(root, path.lstrip("/"))


def _require_root() -> None:
    allow_source_test = _source_test_mode()
    if os.geteuid() != 0 and not allow_source_test:
        raise ControlError("PRIVILEGED_CONTROL_UNAVAILABLE")


def _validate_trusted_regular(path: str, *, exact_mode: int | None = None) -> None:
    """Validate a fixed installed file without following its final component."""

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise ControlError("SUPERVISOR_REBUILD_REQUIRED") from exc
    try:
        metadata = os.fstat(fd)
        trusted_uid = 0 if not _source_mode() else os.geteuid()
        mode = stat.S_IMODE(metadata.st_mode)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != trusted_uid
            or metadata.st_nlink != 1
            or mode & 0o022
            or (exact_mode is not None and mode != exact_mode)
        ):
            raise ControlError("SUPERVISOR_REBUILD_REQUIRED")
    finally:
        os.close(fd)


def _require_installed_helper_trust() -> None:
    if not _source_mode():
        _validate_trusted_regular(INSTALLED_HELPER_PATH, exact_mode=0o500)


def _trusted_agent_marker(path: str) -> bool:
    mapped = _system_path(path)
    if not os.path.exists(mapped):
        return False
    _validate_trusted_regular(mapped)
    return True


def _detect_agent() -> str:
    hermes = _trusted_agent_marker(HERMES_GUARD_PATH)
    openclaw = _trusted_agent_marker(OPENCLAW_GUARD_PATH)
    if hermes == openclaw:
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    return "hermes" if hermes else "openclaw"


def _open_directory(path: str) -> int:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    return os.open(path, flags)


def _trusted_runtime_owner() -> tuple[int, int]:
    if _source_mode():
        return os.geteuid(), os.getegid()
    return 0, 0


def _open_managed_runtime_directory() -> int:
    """Open the fixed root-owned runtime directory, creating it if absent."""

    runtime_dir = _system_path(NEMOCLAW_RUNTIME_DIR)
    parent = os.path.dirname(runtime_dir)
    name = os.path.basename(runtime_dir)
    expected_uid, expected_gid = _trusted_runtime_owner()
    parent_fd = _open_directory(parent)
    directory_fd = -1
    try:
        parent_stat = os.fstat(parent_fd)
        if (
            not stat.S_ISDIR(parent_stat.st_mode)
            or parent_stat.st_uid != expected_uid
            or parent_stat.st_gid != expected_gid
            or stat.S_IMODE(parent_stat.st_mode) & 0o022
        ):
            raise ControlError("SUPERVISOR_UNAVAILABLE")
        try:
            os.mkdir(name, NEMOCLAW_RUNTIME_DIR_MODE, dir_fd=parent_fd)
        except FileExistsError:
            # Another root controller may have created the fixed directory;
            # the descriptor-relative owner and mode checks below decide trust.
            pass
        flags = (
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        directory_fd = os.open(name, flags, dir_fd=parent_fd)
        directory_stat = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(directory_stat.st_mode)
            or directory_stat.st_uid != expected_uid
            or directory_stat.st_gid != expected_gid
            or stat.S_IMODE(directory_stat.st_mode) & 0o022
        ):
            raise ControlError("SUPERVISOR_UNAVAILABLE")
        if stat.S_IMODE(directory_stat.st_mode) != NEMOCLAW_RUNTIME_DIR_MODE:
            os.fchmod(directory_fd, NEMOCLAW_RUNTIME_DIR_MODE)
            if stat.S_IMODE(os.fstat(directory_fd).st_mode) != NEMOCLAW_RUNTIME_DIR_MODE:
                raise ControlError("SUPERVISOR_UNAVAILABLE")
        return directory_fd
    except Exception:
        if directory_fd >= 0:
            os.close(directory_fd)
        raise
    finally:
        os.close(parent_fd)


def _lease_path_matches(
    directory_fd: int, name: str, device: int, inode: int
) -> bool:
    try:
        metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise ControlError("SUPERVISOR_UNAVAILABLE") from exc
    return metadata.st_dev == device and metadata.st_ino == inode


def _unlink_matching_runtime_file(
    directory_fd: int, name: str, device: int, inode: int
) -> None:
    if _lease_path_matches(directory_fd, name, device, inode):
        os.unlink(name, dir_fd=directory_fd)


def _validate_runtime_regular(
    metadata: os.stat_result, expected_mode: int
) -> None:
    expected_uid, expected_gid = _trusted_runtime_owner()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != expected_uid
        or metadata.st_gid != expected_gid
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != expected_mode
    ):
        raise ControlError("SUPERVISOR_UNAVAILABLE")


def _open_expected_exit_lock(directory_fd: int) -> int:
    """Acquire the root-only lock that serializes authorization publication."""

    base_flags = (
        os.O_RDWR
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    lock_fd = -1
    created = False
    for _attempt in range(3):
        try:
            lock_fd = os.open(
                EXPECTED_EXIT_LOCK_NAME,
                base_flags | os.O_CREAT | os.O_EXCL,
                0o600,
                dir_fd=directory_fd,
            )
            created = True
            break
        except FileExistsError:
            try:
                lock_fd = os.open(
                    EXPECTED_EXIT_LOCK_NAME,
                    base_flags,
                    dir_fd=directory_fd,
                )
                break
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise ControlError("SUPERVISOR_UNAVAILABLE") from exc
        except OSError as exc:
            raise ControlError("SUPERVISOR_UNAVAILABLE") from exc
    if lock_fd < 0:
        raise ControlError("SUPERVISOR_BUSY")

    try:
        if created:
            os.fchmod(lock_fd, 0o600)
        metadata = os.fstat(lock_fd)
        _validate_runtime_regular(metadata, 0o600)
        if not _lease_path_matches(
            directory_fd,
            EXPECTED_EXIT_LOCK_NAME,
            metadata.st_dev,
            metadata.st_ino,
        ):
            raise ControlError("SUPERVISOR_UNAVAILABLE")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ControlError("SUPERVISOR_BUSY") from exc
        locked = os.fstat(lock_fd)
        _validate_runtime_regular(locked, 0o600)
        if (
            locked.st_dev != metadata.st_dev
            or locked.st_ino != metadata.st_ino
            or not _lease_path_matches(
                directory_fd,
                EXPECTED_EXIT_LOCK_NAME,
                locked.st_dev,
                locked.st_ino,
            )
        ):
            raise ControlError("SUPERVISOR_UNAVAILABLE")
        return lock_fd
    except Exception:
        os.close(lock_fd)
        raise


def _trusted_expected_exit_marker(
    directory_fd: int,
) -> tuple[int, os.stat_result] | None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        marker_fd = os.open(EXPECTED_EXIT_MARKER_NAME, flags, dir_fd=directory_fd)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ControlError("SUPERVISOR_UNAVAILABLE") from exc
    try:
        metadata = os.fstat(marker_fd)
        _validate_runtime_regular(metadata, 0o444)
        return marker_fd, metadata
    except Exception:
        os.close(marker_fd)
        raise


def _controller_process_identity(reader: ProcReader) -> ProcessIdentity:
    identity = reader.capture(os.getpid())
    expected_uid, _expected_gid = _trusted_runtime_owner()
    if identity.state == "Z" or identity.uids != (expected_uid,) * 4:
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    return identity


def _publish_expected_exit_lease(
    identity: ProcessIdentity,
    controller: ProcessIdentity,
) -> ExpectedExitLease:
    """Authorize one exact gateway exit while this root controller is live."""

    directory_fd = _open_managed_runtime_directory()
    lock_fd = -1
    marker_fd = -1
    try:
        lock_fd = _open_expected_exit_lock(directory_fd)
        existing = _trusted_expected_exit_marker(directory_fd)
        if existing is not None:
            existing_fd, metadata = existing
            try:
                _unlink_matching_runtime_file(
                    directory_fd,
                    EXPECTED_EXIT_MARKER_NAME,
                    metadata.st_dev,
                    metadata.st_ino,
                )
            finally:
                os.close(existing_fd)

        payload = (
            f"v1 {identity.pid} {identity.start_time} "
            f"{controller.pid} {controller.start_time}\n"
        ).encode("ascii")
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        try:
            marker_fd = os.open(
                EXPECTED_EXIT_MARKER_NAME,
                flags,
                0o600,
                dir_fd=directory_fd,
            )
        except FileExistsError as exc:
            raise ControlError("SUPERVISOR_BUSY") from exc
        offset = 0
        while offset < len(payload):
            written = os.write(marker_fd, payload[offset:])
            if written <= 0:
                raise ControlError("SUPERVISOR_UNAVAILABLE")
            offset += written
        os.fchmod(marker_fd, 0o444)
        os.fsync(marker_fd)
        metadata = os.fstat(marker_fd)
        marker_device = metadata.st_dev
        marker_inode = metadata.st_ino
        _validate_runtime_regular(metadata, 0o444)
        if not _lease_path_matches(
            directory_fd,
            EXPECTED_EXIT_MARKER_NAME,
            marker_device,
            marker_inode,
        ):
            raise ControlError("SUPERVISOR_UNAVAILABLE")
    except Exception:
        try:
            if marker_fd >= 0:
                metadata = os.fstat(marker_fd)
                _unlink_matching_runtime_file(
                    directory_fd,
                    EXPECTED_EXIT_MARKER_NAME,
                    metadata.st_dev,
                    metadata.st_ino,
                )
        except (ControlError, OSError):
            # Preserve the original publication failure; cleanup is best effort
            # and inode matching prevents this path from removing a replacement.
            pass
        if marker_fd >= 0:
            os.close(marker_fd)
        if lock_fd >= 0:
            os.close(lock_fd)
        os.close(directory_fd)
        raise
    return ExpectedExitLease(
        directory_fd=directory_fd,
        lock_fd=lock_fd,
        marker_fd=marker_fd,
        name=EXPECTED_EXIT_MARKER_NAME,
        device=marker_device,
        inode=marker_inode,
    )


def _clear_expected_exit_lease(lease: ExpectedExitLease) -> None:
    try:
        _unlink_matching_runtime_file(
            lease.directory_fd,
            lease.name,
            lease.device,
            lease.inode,
        )
    except (ControlError, OSError):
        # The exact exited identity cannot recur. Never delete a path that no
        # longer names this authorization merely to clean up an orphan marker.
        pass
    finally:
        os.close(lease.marker_fd)
        os.close(lease.lock_fd)
        os.close(lease.directory_fd)


def _open_pid(proc_fd: int, pid: int) -> int:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    return os.open(str(pid), flags, dir_fd=proc_fd)


def _read_at(directory_fd: int, name: str, limit: int = MAX_PROC_FILE_BYTES) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(name, flags, dir_fd=directory_fd)
    try:
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - total))
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
            total += len(chunk)
            if total > limit:
                raise ControlError("SUPERVISOR_UNAVAILABLE")
    finally:
        os.close(fd)


def _namespace_inode(pid_fd: int) -> int | None:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open("ns/pid", flags, dir_fd=pid_fd)
    except OSError:
        # OpenShell's Landlock policy can deny namespace symlink traversal even
        # when the same caller can descriptor-pin stat/status/cmdline.  The two
        # captures in ProcReader must agree on unavailability; parent, UID,
        # NSpid, starttime, argv, and proc-dir inode proof remain mandatory.
        return None
    try:
        return os.fstat(fd).st_ino
    finally:
        os.close(fd)


def _parse_stat(raw: bytes) -> tuple[str, int, str]:
    try:
        text = raw.decode("ascii")
        suffix = text.rsplit(") ", 1)[1].split()
        state = suffix[0]
        parent_pid = int(suffix[1], 10)
        start_time = suffix[19]
    except (IndexError, UnicodeDecodeError, ValueError) as exc:
        raise ControlError("SUPERVISOR_UNAVAILABLE") from exc
    if not start_time.isascii() or not start_time.isdigit() or len(state) != 1:
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    return state, parent_pid, start_time


def _parse_status(raw: bytes, pid: int) -> tuple[tuple[int, int, int, int], int]:
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ControlError("SUPERVISOR_UNAVAILABLE") from exc
    uid_line = next((line for line in text.splitlines() if line.startswith("Uid:")), "")
    nspid_line = next(
        (line for line in text.splitlines() if line.startswith("NSpid:")), ""
    )
    try:
        uid_values = tuple(int(value, 10) for value in uid_line.split()[1:5])
        namespace_values = tuple(int(value, 10) for value in nspid_line.split()[1:])
    except ValueError as exc:
        raise ControlError("SUPERVISOR_UNAVAILABLE") from exc
    if len(uid_values) != 4 or not namespace_values or namespace_values[-1] != pid:
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    return uid_values, namespace_values[-1]


def _parse_cmdline(raw: bytes) -> tuple[bytes, ...]:
    values = tuple(value for value in raw.split(b"\0") if value)
    if not values or sum(len(value) for value in values) > MAX_PROC_FILE_BYTES:
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    return values


class ProcReader:
    """Bounded, descriptor-relative reader for one procfs process namespace."""

    def __init__(self, root: str | None = None):
        self.root = root or _proc_root()
        self.fd = _open_directory(self.root)

    def close(self) -> None:
        os.close(self.fd)

    def __enter__(self) -> ProcReader:
        return self

    def __exit__(self, _kind: object, _value: object, _traceback: object) -> None:
        self.close()

    def pids(self) -> list[int]:
        values: list[int] = []
        observed = 0
        with os.scandir(self.fd) as entries:
            for entry in entries:
                if not entry.name.isascii() or not entry.name.isdigit():
                    continue
                observed += 1
                if observed > MAX_PROC_ENTRIES:
                    raise ControlError("SUPERVISOR_UNAVAILABLE")
                values.append(int(entry.name, 10))
        return values

    def capture(self, pid: int) -> ProcessIdentity:
        pid_fd = _open_pid(self.fd, pid)
        try:
            before = os.fstat(pid_fd)
            first_stat = _parse_stat(_read_at(pid_fd, "stat"))
            first_status = _parse_status(_read_at(pid_fd, "status"), pid)
            first_cmdline = _parse_cmdline(_read_at(pid_fd, "cmdline"))
            first_namespace = _namespace_inode(pid_fd)
            second_stat = _parse_stat(_read_at(pid_fd, "stat"))
            second_status = _parse_status(_read_at(pid_fd, "status"), pid)
            second_cmdline = _parse_cmdline(_read_at(pid_fd, "cmdline"))
            second_namespace = _namespace_inode(pid_fd)
            after = os.fstat(pid_fd)
            if (
                first_stat[1:] != second_stat[1:]
                or (first_stat[0] == "Z") != (second_stat[0] == "Z")
                or first_status != second_status
                or first_cmdline != second_cmdline
                or first_namespace != second_namespace
                or before.st_dev != after.st_dev
                or before.st_ino != after.st_ino
            ):
                raise ControlError("SUPERVISOR_UNAVAILABLE")
            state, parent_pid, start_time = second_stat
            uids, namespace_pid = second_status
            return ProcessIdentity(
                pid=pid,
                start_time=start_time,
                parent_pid=parent_pid,
                state=state,
                uids=uids,
                namespace_pid=namespace_pid,
                namespace_inode=second_namespace,
                cmdline=second_cmdline,
                proc_device=before.st_dev,
                proc_inode=before.st_ino,
            )
        finally:
            os.close(pid_fd)

    def read_stable_file(
        self, identity: ProcessIdentity, name: str, limit: int
    ) -> bytes:
        pid_fd = _open_pid(self.fd, identity.pid)
        try:
            pinned = os.fstat(pid_fd)
            if (
                pinned.st_dev != identity.proc_device
                or pinned.st_ino != identity.proc_inode
            ):
                raise ControlError("SUPERVISOR_UNAVAILABLE")
            first = _read_at(pid_fd, name, limit)
            second = _read_at(pid_fd, name, limit)
            current = self.capture(identity.pid)
            if first != second or current.stable_key() != identity.stable_key():
                raise ControlError("SUPERVISOR_UNAVAILABLE")
            return first
        finally:
            os.close(pid_fd)


def _basename(value: bytes) -> bytes:
    return value.rsplit(b"/", 1)[-1]


def _is_openshell(identity: ProcessIdentity) -> bool:
    return bool(
        identity.pid == 1
        and identity.parent_pid == 0
        and identity.state != "Z"
        and identity.uids == (0, 0, 0, 0)
        and identity.namespace_pid == 1
        and identity.cmdline[0] == OPENSHELL_ARGV0
    )


def _is_nemoclaw_start(identity: ProcessIdentity, sandbox_uid: int) -> bool:
    argv = identity.cmdline
    direct = argv in ((b"nemoclaw-start",), (NEMOCLAW_START_PATH,))
    bash = len(argv) == 2 and _basename(argv[0]) == b"bash" and argv[1] in (
        b"nemoclaw-start",
        NEMOCLAW_START_PATH,
    )
    return bool(
        identity.pid > 1
        and identity.parent_pid == 1
        and identity.state != "Z"
        and identity.uids == (sandbox_uid,) * 4
        and identity.namespace_pid == identity.pid
        and (direct or bash)
    )


def _sandbox_uid() -> int:
    try:
        return pwd.getpwnam("sandbox").pw_uid
    except KeyError as exc:
        raise ControlError("SUPERVISOR_UNAVAILABLE") from exc


def _supervisor_candidates(
    reader: ProcReader, pid1: ProcessIdentity, sandbox_uid: int
) -> tuple[list[ProcessIdentity], bool]:
    matches: list[ProcessIdentity] = []
    inconclusive = False
    for pid in reader.pids():
        if pid == 1:
            continue
        try:
            identity = reader.capture(pid)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except (ControlError, PermissionError):
            inconclusive = True
            continue
        if (
            _is_nemoclaw_start(identity, sandbox_uid)
            and (
                pid1.namespace_inode is None
                or identity.namespace_inode == pid1.namespace_inode
            )
        ):
            matches.append(identity)
            if len(matches) > 1:
                break
    return matches, inconclusive


def _discover_supervisor(reader: ProcReader) -> ProcessIdentity:
    pid1 = reader.capture(1)
    if not _is_openshell(pid1):
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    sandbox_uid = _sandbox_uid()
    matches, inconclusive = _supervisor_candidates(reader, pid1, sandbox_uid)
    if inconclusive:
        # Busy agents can create or reap an unrelated short-lived process while
        # /proc is being read. Retry only when one exact supervisor was already
        # proven, and require that same pinned identity on every scan. A missing,
        # changing, or duplicate supervisor still fails closed immediately.
        if len(matches) != 1:
            raise ControlError("SUPERVISOR_UNAVAILABLE")
        expected = matches[0].stable_key()
        for _attempt in range(1, SUPERVISOR_DISCOVERY_ATTEMPTS):
            time.sleep(SUPERVISOR_DISCOVERY_RETRY_SECONDS)
            if reader.capture(1).stable_key() != pid1.stable_key():
                raise ControlError("SUPERVISOR_UNAVAILABLE")
            matches, inconclusive = _supervisor_candidates(reader, pid1, sandbox_uid)
            if len(matches) != 1 or matches[0].stable_key() != expected:
                raise ControlError("SUPERVISOR_UNAVAILABLE")
            if not inconclusive:
                break
        if inconclusive:
            raise ControlError("SUPERVISOR_UNAVAILABLE")
    if len(matches) == 0:
        # A zero-match scan is the only absence signal that may authorize the
        # host to recreate a legacy Docker container with its managed startup
        # command. Re-scan the complete process table and pin PID 1 around both
        # observations so ambiguity, process churn, and supervisor startup
        # races remain generic unavailability rather than destructive-recovery
        # authorization.
        between_pid1 = reader.capture(1)
        second_matches, second_inconclusive = _supervisor_candidates(
            reader, pid1, sandbox_uid
        )
        after_pid1 = reader.capture(1)
        if (
            between_pid1.stable_key() == pid1.stable_key()
            and after_pid1.stable_key() == pid1.stable_key()
            and not second_inconclusive
            and len(second_matches) == 0
        ):
            raise ControlError("SUPERVISOR_NOT_RUNNING")
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    if len(matches) != 1:
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    current_pid1 = reader.capture(1)
    current_supervisor = reader.capture(matches[0].pid)
    if (
        current_pid1.stable_key() != pid1.stable_key()
        or current_supervisor.stable_key() != matches[0].stable_key()
    ):
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    return current_supervisor


def _is_hermes_gateway(identity: ProcessIdentity) -> bool:
    argv = identity.cmdline
    hermes = (b"/usr/local/bin/hermes", b"/usr/local/bin/hermes.real")
    if len(argv) == 3:
        return argv[0] in hermes and argv[1:] == (b"gateway", b"run")
    return bool(
        len(argv) == 4
        and _basename(argv[0]) in (b"python", b"python3")
        and argv[1] in hermes
        and argv[2:] == (b"gateway", b"run")
    )


def _is_openclaw_gateway(identity: ProcessIdentity, port: int) -> bool:
    argv = identity.cmdline
    if len(argv) == 1 and _basename(argv[0]) in (b"openclaw", b"openclaw-gateway"):
        return True
    command_index = 0
    if len(argv) >= 2 and _basename(argv[0]) in (b"node", b"nodejs"):
        command_index = 1
    if command_index >= len(argv) or _basename(argv[command_index]) not in (
        b"openclaw",
        b"openclaw.mjs",
    ):
        return False
    arguments = argv[command_index + 1 :]
    expected_port = str(port).encode("ascii")
    return arguments in (
        (b"gateway", b"run", b"--port", expected_port),
        (b"gateway", b"run", b"--port=" + expected_port),
    )


def _parse_environment(raw: bytes) -> dict[str, str]:
    values: dict[str, str] = {}
    for item in raw.split(b"\0"):
        if not item:
            continue
        key, separator, value = item.partition(b"=")
        if not separator or not ENV_KEY_RE.fullmatch(key) or key in {
            existing.encode("ascii") for existing in values
        }:
            raise ControlError("GATEWAY_UNSAFE_CONFIG_PATH")
        try:
            values[key.decode("ascii")] = value.decode("utf-8", "surrogateescape")
        except UnicodeDecodeError as exc:
            raise ControlError("GATEWAY_UNSAFE_CONFIG_PATH") from exc
    return values


def _openclaw_port(reader: ProcReader, supervisor: ProcessIdentity) -> int:
    environment = _parse_environment(
        reader.read_stable_file(supervisor, "environ", MAX_ENV_BYTES)
    )
    raw = environment.get("NEMOCLAW_DASHBOARD_PORT", "").strip()
    if not raw:
        chat_url = environment.get("CHAT_UI_URL", "")
        match = re.search(r":([0-9]{1,5})(?:/|\Z)", chat_url)
        raw = match.group(1) if match else "18789"
    try:
        port = int(raw, 10)
    except ValueError as exc:
        raise ControlError("GATEWAY_UNSAFE_CONFIG_PATH") from exc
    if port < 1024 or port > 65535:
        raise ControlError("GATEWAY_UNSAFE_CONFIG_PATH")
    return port


def _agent_spec(
    name: str, reader: ProcReader, supervisor: ProcessIdentity
) -> AgentSpec:
    if name == "hermes":
        return AgentSpec(
            name="hermes",
            port=18642,
            readiness_checks=((8642, "/health"),),
        )
    return AgentSpec(name="openclaw", port=_openclaw_port(reader, supervisor))


def _gateway_matches(
    identity: ProcessIdentity,
    supervisor: ProcessIdentity,
    spec: AgentSpec,
) -> bool:
    if not (
        identity.pid > 1
        and identity.parent_pid == supervisor.pid
        and identity.state != "Z"
        and identity.uids == (_sandbox_uid(),) * 4
        and identity.namespace_pid == identity.pid
        and identity.namespace_inode == supervisor.namespace_inode
    ):
        return False
    if spec.name == "hermes":
        return _is_hermes_gateway(identity)
    return _is_openclaw_gateway(identity, spec.port)


def _gateway_candidates(
    reader: ProcReader, supervisor: ProcessIdentity, spec: AgentSpec
) -> list[ProcessIdentity]:
    matches: list[ProcessIdentity] = []
    for pid in reader.pids():
        if pid in (1, supervisor.pid):
            continue
        try:
            identity = reader.capture(pid)
        except (ControlError, FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if _gateway_matches(identity, supervisor, spec):
            matches.append(identity)
            if len(matches) > 1:
                break
    current_supervisor = reader.capture(supervisor.pid)
    if current_supervisor.stable_key() != supervisor.stable_key():
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    if len(matches) > 1:
        raise ControlError("SUPERVISOR_UNAVAILABLE")
    return matches


def _listener_inodes(
    reader: ProcReader, identity: ProcessIdentity, port: int
) -> set[str]:
    expected = f"{port:04X}"
    inodes: set[str] = set()
    pid_fd = _open_pid(reader.fd, identity.pid)
    try:
        pinned = os.fstat(pid_fd)
        if (
            pinned.st_dev != identity.proc_device
            or pinned.st_ino != identity.proc_inode
        ):
            return set()
        for table in ("net/tcp", "net/tcp6"):
            try:
                raw = _read_at(pid_fd, table, MAX_PROC_FILE_BYTES)
            except OSError:
                continue
            for line in raw.decode("ascii", "ignore").splitlines()[1:]:
                fields = line.split()
                if len(fields) < 10:
                    continue
                local = fields[1].rsplit(":", 1)
                if (
                    len(local) == 2
                    and local[1].upper() == expected
                    and fields[3] == "0A"
                ):
                    inodes.add(fields[9])
        if reader.capture(identity.pid).stable_key() != identity.stable_key():
            return set()
    finally:
        os.close(pid_fd)
    return inodes


def _owns_listener(
    reader: ProcReader, identity: ProcessIdentity, port: int
) -> bool:
    current = reader.capture(identity.pid)
    if current.stable_key() != identity.stable_key():
        return False
    inodes = _listener_inodes(reader, identity, port)
    if not inodes:
        return False
    pid_fd = _open_pid(reader.fd, identity.pid)
    try:
        pinned = os.fstat(pid_fd)
        if (
            pinned.st_dev != identity.proc_device
            or pinned.st_ino != identity.proc_inode
        ):
            return False
        flags = (
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        fd_dir = os.open("fd", flags, dir_fd=pid_fd)
        try:
            with os.scandir(fd_dir) as entries:
                for entry in entries:
                    try:
                        target = os.readlink(entry.name, dir_fd=fd_dir)
                    except OSError:
                        continue
                    match = re.fullmatch(r"socket:\[([0-9]+)\]", target)
                    if match and match.group(1) in inodes:
                        return reader.capture(identity.pid).stable_key() == identity.stable_key()
        finally:
            os.close(fd_dir)
    finally:
        os.close(pid_fd)
    return False


def _http_healthy(port: int, path: str) -> bool:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        response.read(4096)
        return response.status in (200, 401)
    except OSError:
        return False
    finally:
        connection.close()


def _http_healthy_in_gateway_namespace(
    reader: ProcReader,
    identity: ProcessIdentity,
    port: int,
    path: str,
) -> bool:
    """Probe loopback from the gateway's network namespace, then restore ours."""

    setns = getattr(os, "setns", None)
    if setns is None:
        raise ControlError("PRIVILEGED_CONTROL_UNAVAILABLE")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    current_namespace = os.open("/proc/self/ns/net", flags)
    pid_fd = -1
    target_namespace = -1
    switched = False
    try:
        pid_fd = _open_pid(reader.fd, identity.pid)
        pinned = os.fstat(pid_fd)
        if (
            pinned.st_dev != identity.proc_device
            or pinned.st_ino != identity.proc_inode
        ):
            return False
        target_namespace = os.open("ns/net", flags, dir_fd=pid_fd)
        if reader.capture(identity.pid).stable_key() != identity.stable_key():
            return False
        setns(target_namespace, getattr(os, "CLONE_NEWNET", 0x40000000))
        switched = True
        return _http_healthy(port, path)
    except OSError as exc:
        if exc.errno in (errno.ENOENT, errno.ENOTDIR, errno.ESRCH):
            return False
        raise ControlError("PRIVILEGED_CONTROL_UNAVAILABLE") from exc
    finally:
        if switched:
            try:
                setns(current_namespace, getattr(os, "CLONE_NEWNET", 0x40000000))
            except OSError as exc:
                raise ControlError("GATEWAY_FAILED") from exc
        if target_namespace >= 0:
            os.close(target_namespace)
        if pid_fd >= 0:
            os.close(pid_fd)
        os.close(current_namespace)


def _gateway_healthy(
    reader: ProcReader, identity: ProcessIdentity, spec: AgentSpec
) -> bool:
    return bool(
        _owns_listener(reader, identity, spec.port)
        and _http_healthy_in_gateway_namespace(
            reader, identity, spec.port, spec.health_path
        )
        and _owns_listener(reader, identity, spec.port)
    )


def _gateway_auxiliaries_healthy(
    reader: ProcReader, identity: ProcessIdentity, spec: AgentSpec
) -> bool:
    """Prove the public API relay the host probes before completing control."""

    for port, path in spec.readiness_checks:
        if not _http_healthy_in_gateway_namespace(reader, identity, port, path):
            return False
    # The public probes can take several seconds. Re-prove the exact gateway
    # after them so a replacement that exited during auxiliary repair is never
    # reported as the completed child.
    return _gateway_healthy(reader, identity, spec)


def _run_fixed_validator(script: str, arguments: list[str]) -> None:
    _validate_trusted_regular(script)
    result = subprocess.run(
        [sys.executable, "-I", script, *arguments],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
    if result.returncode != 0:
        raise ControlError("SECRET_BOUNDARY_REFUSED")


def _validate_runtime_environment(script: str, environment: dict[str, str]) -> None:
    """Validate runtime values without execing a root process under them."""

    _validate_trusted_regular(script)
    spec = importlib.util.spec_from_file_location(
        "_nemoclaw_managed_boundary_validator", script
    )
    if spec is None or spec.loader is None:
        raise ControlError("SECRET_BOUNDARY_VALIDATOR_MISSING")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        validator = getattr(module, "validate_runtime_env")
        result = validator(environment)
    except (AttributeError, ImportError, OSError, RuntimeError) as exc:
        raise ControlError("SECRET_BOUNDARY_REFUSED") from exc
    if result != 0:
        raise ControlError("SECRET_BOUNDARY_REFUSED")


def _read_regular(path: str, limit: int) -> tuple[bytes, os.stat_result]:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_NONBLOCK", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    fd = os.open(path, flags)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ControlError("GATEWAY_UNSAFE_CONFIG_PATH")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > limit:
                raise ControlError("GATEWAY_UNSAFE_CONFIG_PATH")
        after = os.fstat(fd)
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
        ):
            raise ControlError("GATEWAY_UNSAFE_CONFIG_PATH")
        return b"".join(chunks), before
    finally:
        os.close(fd)


def _verify_locked_hermes_hash() -> None:
    config_path = _system_path("/sandbox/.hermes/config.yaml")
    env_path = _system_path("/sandbox/.hermes/.env")
    hash_path = _system_path("/etc/nemoclaw/hermes.config-hash")
    config, config_stat = _read_regular(config_path, MAX_CONFIG_BYTES)
    environment, env_stat = _read_regular(env_path, MAX_ENV_BYTES)
    locked = tuple(
        item.st_uid == 0 and stat.S_IMODE(item.st_mode) & 0o222 == 0
        for item in (config_stat, env_stat)
    )
    if locked == (False, False):
        # The managed non-root cold-start path owns only a mutable compatibility
        # hash.  Treating it as a root trust anchor would let same-UID code bless
        # arbitrary drift.  The caller still receives the canonical secret
        # checks, process proof, pidfd safety, and post-launch health proof.
        return
    if locked != (True, True):
        raise ControlError("GATEWAY_UNSAFE_CONFIG_PATH")
    strict, strict_stat = _read_regular(hash_path, MAX_HASH_BYTES)
    if strict_stat.st_uid != 0 or stat.S_IMODE(strict_stat.st_mode) & 0o022:
        raise ControlError("GATEWAY_UNSAFE_CONFIG_PATH")
    try:
        records = {}
        for line in strict.decode("ascii").splitlines():
            digest, pathname = line.split(maxsplit=1)
            records[pathname.strip()] = digest.lower()
    except (UnicodeDecodeError, ValueError) as exc:
        raise ControlError("GATEWAY_CONFIG_HASH_MISMATCH") from exc
    expected_paths = {
        "/sandbox/.hermes/config.yaml": hashlib.sha256(config).hexdigest(),
        "/sandbox/.hermes/.env": hashlib.sha256(environment).hexdigest(),
    }
    if set(records) != set(expected_paths) or any(
        not SHA256_RE.fullmatch(records[path])
        or records[path] != digest
        for path, digest in expected_paths.items()
    ):
        raise ControlError("GATEWAY_CONFIG_HASH_MISMATCH")


def _hermes_preflight(reader: ProcReader, supervisor: ProcessIdentity) -> None:
    validator = _system_path(HERMES_BOUNDARY_PATH)
    if not os.path.exists(validator):
        raise ControlError("SECRET_BOUNDARY_VALIDATOR_MISSING")
    _run_fixed_validator(
        validator,
        ["env-file", _system_path("/sandbox/.hermes/.env")],
    )
    raw_environment = reader.read_stable_file(supervisor, "environ", MAX_ENV_BYTES)
    _validate_runtime_environment(validator, _parse_environment(raw_environment))
    _verify_locked_hermes_hash()


def _openclaw_preflight() -> None:
    guard = _system_path(OPENCLAW_GUARD_PATH)
    _validate_trusted_regular(guard)
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            guard,
            "preflight-restart",
            "--config-dir",
            _system_path("/sandbox/.openclaw"),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
    if result.returncode != 0:
        raise ControlError("GATEWAY_UNSAFE_CONFIG_PATH")


def _preflight(
    spec: AgentSpec, reader: ProcReader, supervisor: ProcessIdentity
) -> None:
    if spec.name == "hermes":
        _hermes_preflight(reader, supervisor)
    else:
        _openclaw_preflight()


def _pidfd_open(pid: int) -> int:
    opener = getattr(os, "pidfd_open", None)
    sender = getattr(signal, "pidfd_send_signal", None)
    if opener is None or sender is None:
        raise ControlError("PRIVILEGED_CONTROL_UNAVAILABLE")
    try:
        return opener(pid, 0)
    except OSError as exc:
        raise ControlError("SUPERVISOR_UNAVAILABLE") from exc


def _pidfd_exited(pidfd: int, timeout_seconds: float) -> bool:
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    return bool(poller.poll(max(0, int(timeout_seconds * 1000))))


def _send_pidfd(pidfd: int, signum: signal.Signals) -> None:
    sender = getattr(signal, "pidfd_send_signal", None)
    if sender is None:
        raise ControlError("PRIVILEGED_CONTROL_UNAVAILABLE")
    try:
        sender(pidfd, signum, None, 0)
    except OSError as exc:
        raise ControlError("GATEWAY_FAILED") from exc


def _terminate_gateway(reader: ProcReader, identity: ProcessIdentity) -> None:
    pidfd = _pidfd_open(identity.pid)
    try:
        current = reader.capture(identity.pid)
        if current.stable_key() != identity.stable_key():
            raise ControlError("SUPERVISOR_UNAVAILABLE")
        _send_pidfd(pidfd, signal.SIGTERM)
        if _pidfd_exited(pidfd, STOP_GRACE_SECONDS):
            return
        current = reader.capture(identity.pid)
        if current.stable_key() != identity.stable_key():
            raise ControlError("SUPERVISOR_UNAVAILABLE")
        _send_pidfd(pidfd, signal.SIGKILL)
        if not _pidfd_exited(pidfd, KILL_GRACE_SECONDS):
            raise ControlError("GATEWAY_FAILED")
    finally:
        os.close(pidfd)


def _wait_for_healthy_gateway(
    reader: ProcReader,
    supervisor: ProcessIdentity,
    spec: AgentSpec,
    old_identity: ProcessIdentity | None,
    timeout_seconds: float = RECOVERY_TIMEOUT_SECONDS,
    require_auxiliary_health: bool = False,
) -> ProcessIdentity:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            candidates = _gateway_candidates(reader, supervisor, spec)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            raise ControlError("SUPERVISOR_UNAVAILABLE")
        for candidate in candidates:
            if old_identity is not None and (
                candidate.pid,
                candidate.start_time,
            ) == (old_identity.pid, old_identity.start_time):
                continue
            try:
                if _gateway_healthy(reader, candidate, spec) and (
                    not require_auxiliary_health
                    or _gateway_auxiliaries_healthy(reader, candidate, spec)
                ):
                    return candidate
            except (FileNotFoundError, ProcessLookupError):
                continue
            except ControlError as error:
                if error.code != "SUPERVISOR_UNAVAILABLE":
                    raise
        time.sleep(POLL_SECONDS)
    raise ControlError("GATEWAY_HEALTH_TIMEOUT")


def _wait_for_recovery_candidate(
    reader: ProcReader,
    supervisor: ProcessIdentity,
    spec: AgentSpec,
    initial_identity: ProcessIdentity,
) -> tuple[ProcessIdentity | None, ProcessIdentity | None]:
    """Give the observed candidate, and at most one successor, a full grace."""

    observed = initial_identity
    for _attempt in range(2):
        try:
            healthy = _wait_for_healthy_gateway(
                reader,
                supervisor,
                spec,
                None,
                RECOVER_EXISTING_GRACE_SECONDS,
            )
            return healthy, None
        except ControlError as error:
            if error.code != "GATEWAY_HEALTH_TIMEOUT":
                raise

        candidates = _gateway_candidates(reader, supervisor, spec)
        current = candidates[0] if candidates else None
        if current is None:
            return None, None
        if current.stable_key() == observed.stable_key():
            return None, current
        observed = current

    return None, observed


def _control(action: str, nonce: str) -> tuple[str, int, int]:
    agent = _detect_agent()
    with ProcReader() as reader:
        supervisor = _discover_supervisor(reader)
        spec = _agent_spec(agent, reader, supervisor)
        candidates = _gateway_candidates(reader, supervisor, spec)
        old_identity = candidates[0] if candidates else None

        _preflight(spec, reader, supervisor)

        if action == "probe":
            if old_identity is None:
                raise ControlError("GATEWAY_HEALTH_TIMEOUT")
            if not _gateway_healthy(reader, old_identity, spec):
                raise ControlError("GATEWAY_HEALTH_TIMEOUT")
            if not _gateway_auxiliaries_healthy(reader, old_identity, spec):
                raise ControlError("GATEWAY_HEALTH_TIMEOUT")
            healthy = reader.capture(old_identity.pid)
            if healthy.stable_key() != old_identity.stable_key():
                raise ControlError("GATEWAY_HEALTH_TIMEOUT")
            return "already-running", old_identity.pid, healthy.pid

        if action == "recover" and old_identity is not None:
            # PID 1 continuously supervises the managed gateway. A host
            # recovery request can arrive after PID 1 has launched a
            # replacement but before its listener is healthy. Give that proven
            # child a short grace period. If its identity changes during that
            # grace, give the one successor its own bounded grace before any
            # signal so recovery cannot churn a newly launched replacement.
            original_identity = old_identity
            existing, old_identity = _wait_for_recovery_candidate(
                reader,
                supervisor,
                spec,
                original_identity,
            )
            if existing is not None:
                completed = _wait_for_healthy_gateway(
                    reader,
                    supervisor,
                    spec,
                    None,
                    RECOVERY_TIMEOUT_SECONDS,
                    True,
                )
                return "already-running", original_identity.pid, completed.pid

        expected_exit_lease = None
        try:
            if old_identity is not None and spec.name == "hermes":
                # The nonroot entrypoint owns the child and its crash budget.
                # Publish an exact root-owned authorization before the pidfd
                # signal. The marker names this live root controller so a
                # delayed reap remains authorized without trusting wall time,
                # while an orphaned marker fails closed as an ordinary crash.
                controller_identity = _controller_process_identity(reader)
                expected_exit_lease = _publish_expected_exit_lease(
                    old_identity,
                    controller_identity,
                )
            if old_identity is not None:
                _terminate_gateway(reader, old_identity)

            replacement = _wait_for_healthy_gateway(
                reader,
                supervisor,
                spec,
                old_identity,
                RECOVERY_TIMEOUT_SECONDS,
                True,
            )
            return "ok", old_identity.pid if old_identity else 0, replacement.pid
        finally:
            if expected_exit_lease is not None:
                _clear_expected_exit_lease(expected_exit_lease)


def _validate_request(argv: list[str]) -> tuple[str, str]:
    if len(argv) != 2:
        raise ControlError("SUPERVISOR_INVALID_REQUEST")
    action, nonce = argv
    if action not in ("restart", "recover", "probe"):
        raise ControlError("SUPERVISOR_INVALID_ACTION")
    if not NONCE_RE.fullmatch(nonce):
        raise ControlError("SUPERVISOR_INVALID_NONCE")
    return action, nonce


def main(argv: list[str]) -> int:
    try:
        action, nonce = _validate_request(argv)
        _require_root()
        _require_installed_helper_trust()
        result, old_pid, new_pid = _control(action, nonce)
        print(f"v1 {nonce} complete {result} {old_pid} {new_pid}")
        print(f"GATEWAY_PID={new_pid}")
        return 0
    except ControlError as error:
        print(error.code, file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError):
        print("GATEWAY_FAILED", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
