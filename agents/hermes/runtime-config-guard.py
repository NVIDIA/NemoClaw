#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Descriptor-safe runtime config updates for the Hermes sandbox entrypoint."""

from __future__ import annotations

import argparse
import base64
import errno
import fcntl
import grp
import hashlib
import json
import os
import pwd
import re
import secrets
import signal
import stat
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field

import yaml


API_SERVER_KEY_RE = re.compile(r"^[0-9a-f]{64}$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SCOPED_PLACEHOLDER_PREFIX = "openshell:resolve:env:"
BOUNDARY_VALIDATOR_TIMEOUT_SECONDS = 5
FS_IOC_GETFLAGS = 0x80086601
FS_IOC_SETFLAGS = 0x40086602
FS_IMMUTABLE_FL = 0x00000010
FS_APPEND_FL = 0x00000020
MAX_CONFIG_INPUT_BYTES = 16 * 1024 * 1024
MAX_ENV_BYTES = 4 * 1024 * 1024
MAX_HASH_BYTES = 4 * 1024
MAX_RUNTIME_PLAN_BYTES = 4 * 1024 * 1024
MAX_RESTART_STATE_BYTES = 32 * 1024 * 1024
MAX_MUTATION_LOCK_BYTES = 16 * 1024
MAX_PROC_BYTES = 1024 * 1024
PROC_ROOT = "/proc"
MAX_PROC_ENTRIES = 32768
MCP_HASH_STATE_PREFIX = "# nemoclaw-hermes-mcp-state-v1"
MCP_INTEGRITY_PENDING_EXIT_CODE = 10
MCP_HASH_STATE_RE = re.compile(
    rf"{re.escape(MCP_HASH_STATE_PREFIX)} intended=([0-9a-f]{{64}}) applied=([0-9a-f]{{64}})"
)
NEMOCLAW_START_ARGV = (b"nemoclaw-start", b"/usr/local/bin/nemoclaw-start")
OPENSHELL_SUPERVISOR_ARGV0 = b"/opt/openshell/bin/openshell-sandbox"
# Keep this in parity with the generated config, environment, and hash files.
# The integration test protects this separate in-image recovery boundary.
SEALED_FILE_NAMES = ("config.yaml", ".env", ".config-hash")
RESTART_ORPHAN_MARKER_NAME = ".nemoclaw-hermes-restart-seal"
STATE_WORKER_LEASE_SECONDS = 15 * 60
HERMES_STARTUP_READY_FILE = "/run/nemoclaw/hermes-startup-ready"
HERMES_ROOT_LIFECYCLE_MARKER = "/run/nemoclaw/hermes-root-lifecycle"
NEMOCLAW_RUNTIME_DIR = "/run/nemoclaw"
NEMOCLAW_RUNTIME_DIR_MODE = 0o711
HERMES_RESTART_STATE_FILE = "/run/nemoclaw/hermes-restart-seal.json"
HERMES_MUTATION_LOCK_FILE = "/run/nemoclaw/hermes-config-mutation.lock"
DIRECTORY_FSYNC_UNSUPPORTED_ERRNOS = frozenset(
    {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP}
)
_DIRECTORY_FSYNC_WARNING_EMITTED = False
INSTALLED_RUNTIME_CONFIG_GUARD = (
    "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"
)
GUARD_DEADLINE_SECONDS = 10 * 60
# Restrictive compatibility fallback for provider placeholders persisted before
# Hermes messaging runtime-plan metadata existed. New channels must flow through
# runtime-plan credentialBindings/envAliases; do not broaden this set without a
# migration plan and source-of-truth review.
LEGACY_PROVIDER_PLACEHOLDER_KEYS = frozenset(
    {
        "TELEGRAM_BOT_TOKEN",
        "DISCORD_BOT_TOKEN",
        "SLACK_BOT_TOKEN",
        "SLACK_APP_TOKEN",
        "WECHAT_BOT_TOKEN",
        "MSTEAMS_APP_PASSWORD",
    }
)


class UnsafePathError(RuntimeError):
    """Raised when a mutable runtime config path is unsafe to trust."""


class StrictHashMismatchError(UnsafePathError):
    """Raised only when safe strict-hash bytes do not match safe config inputs."""


def _no_follow_flag() -> int:
    flag = getattr(os, "O_NOFOLLOW", 0)
    if not flag:
        raise UnsafePathError("O_NOFOLLOW is unavailable")
    return flag


def _cloexec_flag() -> int:
    return getattr(os, "O_CLOEXEC", 0)


def _directory_flag() -> int:
    return getattr(os, "O_DIRECTORY", 0)


@dataclass(frozen=True)
class FileSnapshot:
    dev: int
    ino: int
    mode: int
    uid: int
    gid: int
    nlink: int
    size: int
    mtime_ns: int
    ctime_ns: int

    @classmethod
    def from_stat(cls, st: os.stat_result) -> "FileSnapshot":
        return cls(
            dev=st.st_dev,
            ino=st.st_ino,
            mode=stat.S_IMODE(st.st_mode),
            uid=st.st_uid,
            gid=st.st_gid,
            nlink=st.st_nlink,
            size=st.st_size,
            mtime_ns=st.st_mtime_ns,
            ctime_ns=st.st_ctime_ns,
        )


# invalidState: persisted intent is treated as gateway-applied before a healthy
# replacement gateway has consumed it, or mutable config bytes race an anchor
# transition and are accidentally blessed.
# sourceBoundary: this guard owns parsing and atomically advancing the durable
# intended/applied marker; the transaction helper owns candidate writes and
# rollback, while startup advances `applied` only after replacement health.
# whyNotSourceFix: config bytes prove desired state but cannot prove which bytes
# a long-lived Hermes gateway consumed; Hermes/OpenShell exposes no authenticated
# applied-config digest in the pinned runtime.
# regressionTest: hermes-mcp-integrity-state covers pending/current transitions,
# metadata-only apply, stale snapshots, rollback, and startup commit ordering.
# removalCondition: replace this marker only when the runtime exposes an
# authenticated applied-config digest with equivalent transactional rollback.
@dataclass(frozen=True)
class McpHashState:
    intended: str
    applied: str


# invalidState: managed-state inspection authenticates one config snapshot, then
# reopens mutable config and accidentally compares different bytes to host intent.
# sourceBoundary: this guard owns the authenticated config/env/hash snapshots;
# the transaction helper may parse the returned config text, but must revalidate
# this opaque snapshot immediately before reporting a managed-state match.
# whyNotSourceFix: the Hermes config has no runtime-provided authenticated read
# API, so host reconciliation must bind its comparison to the local trust anchor.
# regressionTest: hermes-mcp-integrity-state mutates config after authentication
# and proves the final snapshot validation refuses the raced managed-state match.
# removalCondition: remove this snapshot token only when Hermes exposes an
# authenticated applied-config digest and exact config bytes through one API;
# #6257 tracks that upstream attestation boundary.
@dataclass(frozen=True)
class McpIntegritySnapshot:
    state: str
    # Authenticated config bytes can include credentials; never expose them
    # through the generated dataclass representation.
    config_text: str = field(repr=False)
    config_path: str
    config_snapshot: FileSnapshot
    env_path: str
    env_snapshot: FileSnapshot
    hash_snapshots: tuple[tuple[str, FileSnapshot], ...]


class OpenFile:
    def __init__(self, path: str, fd: int, snapshot: FileSnapshot):
        self.path = path
        self.fd = fd
        self.snapshot = snapshot

    def close(self) -> None:
        os.close(self.fd)

    def read_bytes(self, max_bytes: int = MAX_CONFIG_INPUT_BYTES) -> bytes:
        if max_bytes < 0 or self.snapshot.size > max_bytes:
            raise UnsafePathError(
                f"refusing oversized runtime config path: {self.path}"
            )
        os.lseek(self.fd, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(self.fd, min(1024 * 1024, max_bytes + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise UnsafePathError(
                    f"refusing oversized runtime config path: {self.path}"
                )
            chunks.append(chunk)
        if FileSnapshot.from_stat(os.fstat(self.fd)) != self.snapshot:
            raise UnsafePathError(f"refusing raced runtime config path: {self.path}")
        return b"".join(chunks)

    def sha256(self, max_bytes: int) -> str:
        if max_bytes < 0 or self.snapshot.size > max_bytes:
            raise UnsafePathError(
                f"refusing oversized runtime config path: {self.path}"
            )
        os.lseek(self.fd, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(self.fd, min(1024 * 1024, max_bytes + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise UnsafePathError(
                    f"refusing oversized runtime config path: {self.path}"
                )
            digest.update(chunk)
        if FileSnapshot.from_stat(os.fstat(self.fd)) != self.snapshot:
            raise UnsafePathError(f"refusing raced runtime config path: {self.path}")
        return digest.hexdigest()


def _die(message: str) -> None:
    print(f"[SECURITY] {message}", file=sys.stderr)
    sys.exit(1)


def _deadline_expired(_signum: int, _frame: object) -> None:
    raise UnsafePathError("Hermes runtime config guard exceeded its deadline")


def _open_proc_root() -> int:
    return os.open(
        PROC_ROOT,
        os.O_RDONLY | _directory_flag() | _no_follow_flag() | _cloexec_flag(),
    )


def _open_proc_pid(proc_root_fd: int, pid: int | str) -> int:
    return os.open(
        str(pid),
        os.O_RDONLY | _directory_flag() | _no_follow_flag() | _cloexec_flag(),
        dir_fd=proc_root_fd,
    )


def _read_proc_pid_file(
    proc_pid_fd: int, name: str, display_path: str
) -> bytes:
    fd = os.open(
        name,
        os.O_RDONLY | _no_follow_flag() | _cloexec_flag(),
        dir_fd=proc_pid_fd,
    )
    try:
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, min(4096, MAX_PROC_BYTES + 1 - total))
            if not chunk:
                return b"".join(chunks)
            total += len(chunk)
            if total > MAX_PROC_BYTES:
                raise UnsafePathError(
                    f"refusing oversized proc entry: {display_path}"
                )
            chunks.append(chunk)
    finally:
        os.close(fd)


def _proc_pid_namespace_inode(proc_pid_fd: int) -> int | None:
    ns_fd = -1
    try:
        ns_fd = os.open(
            "ns",
            os.O_RDONLY | _directory_flag() | _no_follow_flag() | _cloexec_flag(),
            dir_fd=proc_pid_fd,
        )
        inode = os.stat("pid", dir_fd=ns_fd, follow_symlinks=True).st_ino
        return inode if inode > 0 else None
    except OSError:
        return None
    finally:
        if ns_fd >= 0:
            os.close(ns_fd)


def _cmdline_is_nemoclaw_start(raw: bytes) -> bool:
    normalized = raw.rstrip(b"\0")
    arguments = tuple(normalized.split(b"\0")) if normalized else ()
    # Docker appends CMD arguments after ENTRYPOINT. Authenticate the canonical
    # startup script position while allowing those opaque trailing arguments.
    direct = bool(arguments) and arguments[0] in NEMOCLAW_START_ARGV
    bash = (
        len(arguments) >= 2
        and arguments[0] in {b"bash", b"/bin/bash", b"/usr/bin/bash"}
        and arguments[1] in NEMOCLAW_START_ARGV
    )
    return direct or bash


def _cmdline_is_openshell_supervisor(raw: bytes) -> bool:
    arguments = raw.split(b"\0")
    return bool(arguments and arguments[0] == OPENSHELL_SUPERVISOR_ARGV0)


def _parse_process_parent_pid(raw: bytes) -> int | None:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    closing_paren = text.rfind(")")
    if closing_paren < 0:
        return None
    fields_after_comm = text[closing_paren + 2 :].split()
    if len(fields_after_comm) <= 1:
        return None
    try:
        parent_pid = int(fields_after_comm[1], 10)
    except ValueError:
        return None
    return parent_pid if parent_pid >= 0 else None


def _process_status_identity(raw: bytes) -> tuple[int, tuple[int, ...]] | None:
    try:
        lines = raw.decode("ascii").splitlines()
    except UnicodeDecodeError:
        return None
    uid_fields: list[str] | None = None
    namespace_pids: tuple[int, ...] | None = None
    for line in lines:
        if line.startswith("Uid:"):
            uid_fields = line.removeprefix("Uid:").split()
        elif line.startswith("NSpid:"):
            try:
                namespace_pids = tuple(
                    int(value, 10) for value in line.removeprefix("NSpid:").split()
                )
            except ValueError:
                return None
    if uid_fields is None or len(uid_fields) != 4 or not namespace_pids:
        return None
    try:
        effective_uid = int(uid_fields[1], 10)
    except ValueError:
        return None
    if effective_uid < 0 or any(pid <= 0 for pid in namespace_pids):
        return None
    return effective_uid, namespace_pids


def _pid1_is_nemoclaw_start() -> bool:
    proc_root_fd = -1
    proc_pid_fd = -1
    try:
        proc_root_fd = _open_proc_root()
        proc_pid_fd = _open_proc_pid(proc_root_fd, 1)
        cmdline = _read_proc_pid_file(
            proc_pid_fd, "cmdline", f"{PROC_ROOT}/1/cmdline"
        )
    except (OSError, UnsafePathError):
        return False
    finally:
        if proc_pid_fd >= 0:
            os.close(proc_pid_fd)
        if proc_root_fd >= 0:
            os.close(proc_root_fd)
    # SOURCE_OF_TRUTH_REVIEW (#6110): OpenShell owns PID 1 in Docker-driver
    # sandboxes and starts the workload as its direct non-root child. NemoClaw's
    # GPU recreate used to append that workload to the supervisor argv; the
    # source fix is buildDockerGpuCloneRunArgs() in docker-gpu-patch.ts, which
    # now preserves an empty Config.Cmd. An attacker controlling an image or
    # recreate argv could otherwise append `nemoclaw-start`, impersonate direct
    # PID 1 authority, and bypass the startup identity check. Keep this
    # exclusion as defense in depth; live proof is in
    # assertHermesGpuStartupProof() in
    # test/e2e/live/hermes-gpu-startup-proof.ts. The dual-mode authorization
    # branch can be removed only after direct-PID1 images are no longer
    # supported; this supervisor exclusion itself remains a security invariant.
    return (
        not _cmdline_is_openshell_supervisor(cmdline)
        and _cmdline_is_nemoclaw_start(cmdline)
    )


def _pinned_process_matches_startup_identity(
    proc_root_fd: int,
    pid: str,
    expected_start_time: str,
    expected_namespace_inode: int,
    expected_effective_uid: int,
) -> bool:
    proc_pid_fd = -1
    try:
        proc_pid_fd = _open_proc_pid(proc_root_fd, pid)
        pinned_before = os.fstat(proc_pid_fd)
        first_start_time = _parse_process_start_time(
            _read_proc_pid_file(
                proc_pid_fd, "stat", f"{PROC_ROOT}/{pid}/stat"
            )
        )
        if first_start_time is None or not secrets.compare_digest(
            first_start_time, expected_start_time
        ):
            return False
        first_status = _process_status_identity(
            _read_proc_pid_file(
                proc_pid_fd, "status", f"{PROC_ROOT}/{pid}/status"
            )
        )
        if (
            first_status is None
            or first_status[0] != expected_effective_uid
            or first_status[1][-1] != 1
        ):
            return False
        cmdline = _read_proc_pid_file(
            proc_pid_fd, "cmdline", f"{PROC_ROOT}/{pid}/cmdline"
        )
        if not _cmdline_is_nemoclaw_start(cmdline):
            return False
        first_namespace_inode = _proc_pid_namespace_inode(proc_pid_fd)
        if first_namespace_inode != expected_namespace_inode:
            return False
        second_start_time = _parse_process_start_time(
            _read_proc_pid_file(
                proc_pid_fd, "stat", f"{PROC_ROOT}/{pid}/stat"
            )
        )
        second_cmdline = _read_proc_pid_file(
            proc_pid_fd, "cmdline", f"{PROC_ROOT}/{pid}/cmdline"
        )
        second_status = _process_status_identity(
            _read_proc_pid_file(
                proc_pid_fd, "status", f"{PROC_ROOT}/{pid}/status"
            )
        )
        second_namespace_inode = _proc_pid_namespace_inode(proc_pid_fd)
        pinned_after = os.fstat(proc_pid_fd)
        return bool(
            second_start_time is not None
            and secrets.compare_digest(second_start_time, expected_start_time)
            and second_status is not None
            and second_status[0] == expected_effective_uid
            and second_status[1][-1] == 1
            and _cmdline_is_nemoclaw_start(second_cmdline)
            and second_namespace_inode == expected_namespace_inode
            and pinned_before.st_dev == pinned_after.st_dev
            and pinned_before.st_ino == pinned_after.st_ino
        )
    except (OSError, UnsafePathError):
        return False
    finally:
        if proc_pid_fd >= 0:
            os.close(proc_pid_fd)


def _startup_process_identity_is_live(
    expected_start_time: str,
    expected_namespace_inode: int,
    expected_effective_uid: int = 0,
) -> bool:
    if (
        not re.fullmatch(r"[0-9]+", expected_start_time)
        or expected_namespace_inode <= 0
    ):
        return False
    proc_root_fd = -1
    try:
        proc_root_fd = _open_proc_root()
        observed = 0
        matches = 0
        with os.scandir(proc_root_fd) as entries:
            for entry in entries:
                if not entry.name.isascii() or not entry.name.isdigit():
                    continue
                observed += 1
                if observed > MAX_PROC_ENTRIES:
                    return False
                if _pinned_process_matches_startup_identity(
                    proc_root_fd,
                    entry.name,
                    expected_start_time,
                    expected_namespace_inode,
                    expected_effective_uid,
                ):
                    matches += 1
                    if matches > 1:
                        return False
        return matches == 1
    except OSError:
        return False
    finally:
        if proc_root_fd >= 0:
            os.close(proc_root_fd)


def _openshell_supervisor_identity(
    expected_effective_uid: int,
) -> tuple[str, int | None] | None:
    proc_root_fd = -1
    proc_pid_fd = -1
    try:
        proc_root_fd = _open_proc_root()
        proc_pid_fd = _open_proc_pid(proc_root_fd, 1)
        pinned_before = os.fstat(proc_pid_fd)
        first_cmdline = _read_proc_pid_file(
            proc_pid_fd, "cmdline", f"{PROC_ROOT}/1/cmdline"
        )
        first_status = _process_status_identity(
            _read_proc_pid_file(proc_pid_fd, "status", f"{PROC_ROOT}/1/status")
        )
        first_stat = _read_proc_pid_file(
            proc_pid_fd, "stat", f"{PROC_ROOT}/1/stat"
        )
        first_start_time = _parse_process_start_time(first_stat)
        first_namespace_inode = _proc_pid_namespace_inode(proc_pid_fd)
        second_cmdline = _read_proc_pid_file(
            proc_pid_fd, "cmdline", f"{PROC_ROOT}/1/cmdline"
        )
        second_status = _process_status_identity(
            _read_proc_pid_file(proc_pid_fd, "status", f"{PROC_ROOT}/1/status")
        )
        second_stat = _read_proc_pid_file(
            proc_pid_fd, "stat", f"{PROC_ROOT}/1/stat"
        )
        second_start_time = _parse_process_start_time(second_stat)
        second_namespace_inode = _proc_pid_namespace_inode(proc_pid_fd)
        pinned_after = os.fstat(proc_pid_fd)
        if not (
            _cmdline_is_openshell_supervisor(first_cmdline)
            and _cmdline_is_openshell_supervisor(second_cmdline)
            and first_status is not None
            and second_status is not None
            and first_status[0] == expected_effective_uid
            and second_status[0] == expected_effective_uid
            and first_status[1][-1] == 1
            and second_status[1][-1] == 1
            and _parse_process_parent_pid(first_stat) == 0
            and _parse_process_parent_pid(second_stat) == 0
            and first_start_time is not None
            and second_start_time is not None
            and secrets.compare_digest(first_start_time, second_start_time)
            and (
                (first_namespace_inode is None and second_namespace_inode is None)
                or (
                    first_namespace_inode is not None
                    and first_namespace_inode == second_namespace_inode
                )
            )
            and pinned_before.st_dev == pinned_after.st_dev
            and pinned_before.st_ino == pinned_after.st_ino
        ):
            return None
        return first_start_time, first_namespace_inode
    except (OSError, UnsafePathError):
        return None
    finally:
        if proc_pid_fd >= 0:
            os.close(proc_pid_fd)
        if proc_root_fd >= 0:
            os.close(proc_root_fd)


def _pinned_process_matches_supervised_nonroot_start(
    proc_root_fd: int,
    pid: str,
    supervisor_identity: tuple[str, int | None],
    expected_effective_uid: int,
) -> bool:
    # OpenShell 0.0.106 keeps its supervisor at PID 1 and launches the non-root
    # NemoClaw entrypoint as a child, so startup authority must be proved from
    # pinned procfs identity rather than a PID-1 equality check. Remove this
    # compatibility proof when #6256 provides authenticated supervisor/runtime
    # attestation with a unified workload topology.
    proc_pid_fd = -1
    try:
        numeric_pid = int(pid, 10)
        if numeric_pid <= 1:
            return False
        proc_pid_fd = _open_proc_pid(proc_root_fd, pid)
        pinned_before = os.fstat(proc_pid_fd)
        first_stat = _read_proc_pid_file(
            proc_pid_fd, "stat", f"{PROC_ROOT}/{pid}/stat"
        )
        first_start_time = _parse_process_start_time(first_stat)
        first_status = _process_status_identity(
            _read_proc_pid_file(
                proc_pid_fd, "status", f"{PROC_ROOT}/{pid}/status"
            )
        )
        first_cmdline = _read_proc_pid_file(
            proc_pid_fd, "cmdline", f"{PROC_ROOT}/{pid}/cmdline"
        )
        first_namespace_inode = _proc_pid_namespace_inode(proc_pid_fd)
        second_stat = _read_proc_pid_file(
            proc_pid_fd, "stat", f"{PROC_ROOT}/{pid}/stat"
        )
        second_start_time = _parse_process_start_time(second_stat)
        second_status = _process_status_identity(
            _read_proc_pid_file(
                proc_pid_fd, "status", f"{PROC_ROOT}/{pid}/status"
            )
        )
        second_cmdline = _read_proc_pid_file(
            proc_pid_fd, "cmdline", f"{PROC_ROOT}/{pid}/cmdline"
        )
        second_namespace_inode = _proc_pid_namespace_inode(proc_pid_fd)
        pinned_after = os.fstat(proc_pid_fd)
        expected_namespace_inode = supervisor_identity[1]
        namespace_matches = (
            expected_namespace_inode is None
            and first_namespace_inode == second_namespace_inode
        ) or (
            expected_namespace_inode is not None
            and first_namespace_inode == expected_namespace_inode
            and second_namespace_inode == expected_namespace_inode
        )
        return bool(
            first_start_time is not None
            and second_start_time is not None
            and secrets.compare_digest(first_start_time, second_start_time)
            and _parse_process_parent_pid(first_stat) == 1
            and _parse_process_parent_pid(second_stat) == 1
            and first_status is not None
            and second_status is not None
            and first_status[0] == expected_effective_uid
            and second_status[0] == expected_effective_uid
            and first_status[1][-1] == numeric_pid
            and second_status[1][-1] == numeric_pid
            and first_cmdline == second_cmdline
            and _cmdline_is_nemoclaw_start(first_cmdline)
            and _cmdline_is_nemoclaw_start(second_cmdline)
            and namespace_matches
            and pinned_before.st_dev == pinned_after.st_dev
            and pinned_before.st_ino == pinned_after.st_ino
        )
    except (OSError, UnsafePathError, ValueError):
        return False
    finally:
        if proc_pid_fd >= 0:
            os.close(proc_pid_fd)


def _openshell_supervised_nonroot_start_is_live(
    expected_root_uid: int,
    expected_sandbox_uid: int,
    required_pid: int | None = None,
) -> bool:
    supervisor_identity = _openshell_supervisor_identity(expected_root_uid)
    if supervisor_identity is None:
        return False
    proc_root_fd = -1
    try:
        proc_root_fd = _open_proc_root()
        observed = 0
        matches = 0
        matched_pid: int | None = None
        with os.scandir(proc_root_fd) as entries:
            for entry in entries:
                if not entry.name.isascii() or not entry.name.isdigit():
                    continue
                observed += 1
                if observed > MAX_PROC_ENTRIES:
                    return False
                if _pinned_process_matches_supervised_nonroot_start(
                    proc_root_fd,
                    entry.name,
                    supervisor_identity,
                    expected_sandbox_uid,
                ):
                    matches += 1
                    matched_pid = int(entry.name, 10)
                    if matches > 1:
                        return False
        return bool(
            matches == 1
            and (required_pid is None or matched_pid == required_pid)
            and _openshell_supervisor_identity(expected_root_uid)
            == supervisor_identity
        )
    except OSError:
        return False
    finally:
        if proc_root_fd >= 0:
            os.close(proc_root_fd)


def _process_effective_uid(pid: int) -> int | None:
    proc_root_fd = -1
    proc_pid_fd = -1
    try:
        proc_root_fd = _open_proc_root()
        proc_pid_fd = _open_proc_pid(proc_root_fd, pid)
        status = _read_proc_pid_file(
            proc_pid_fd, "status", f"{PROC_ROOT}/{pid}/status"
        ).decode("utf-8")
    except (OSError, UnsafePathError, UnicodeDecodeError):
        return None
    finally:
        if proc_pid_fd >= 0:
            os.close(proc_pid_fd)
        if proc_root_fd >= 0:
            os.close(proc_root_fd)
    uid_line = next(
        (line for line in status.splitlines() if line.startswith("Uid:")), ""
    )
    try:
        values = [int(value) for value in uid_line.split()[1:]]
    except ValueError:
        return None
    return values[1] if len(values) >= 2 else None


def _startup_ready_marker_absent() -> bool:
    try:
        os.stat(HERMES_STARTUP_READY_FILE, follow_symlinks=False)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return False




def _validate_action_readiness(action: str, startup_owner: bool) -> None:
    installed_current = os.path.abspath(__file__) == INSTALLED_RUNTIME_CONFIG_GUARD
    try:
        sandbox_uid = pwd.getpwnam("sandbox").pw_uid
    except KeyError:
        sandbox_uid = -1
    startup_actions = {
        "commit-mcp-applied",
        "ensure-api-key",
        "inspect-mcp-integrity",
        "refresh-hashes",
        "provider-placeholders",
        "publish-startup-ready",
        "recover-prestate-lock",
    }
    if action in startup_actions:
        if not _pid1_is_nemoclaw_start():
            if (
                installed_current
                and startup_owner
                and sandbox_uid >= 0
                and _startup_ready_marker_absent()
                and _openshell_supervised_nonroot_start_is_live(
                    0, sandbox_uid, os.getppid()
                )
            ):
                return
            # Local source fixtures have no NemoClaw PID 1 and exercise the
            # guard against temporary directories. The installed production
            # helper never treats that compatibility path as authority.
            if installed_current:
                raise UnsafePathError(
                    "Hermes runtime config guard refuses mutation under a foreign PID 1"
                )
            return
        if not startup_owner or os.getppid() != 1:
            raise UnsafePathError(
                f"{action} is restricted to the Hermes PID 1 startup transaction"
            )
        return
    host_actions = {
        "seal-restart",
        "write-config",
    }
    pid1_is_nemoclaw_start = _pid1_is_nemoclaw_start()
    startup_ready = _startup_ready_for_current_pid1()
    if not pid1_is_nemoclaw_start and not startup_ready:
        if (
            installed_current
            and action in host_actions
            and sandbox_uid >= 0
            and _startup_ready_marker_absent()
            and _openshell_supervised_nonroot_start_is_live(0, sandbox_uid)
        ):
            return
        # Local source fixtures retain the explicit compatibility path. The
        # installed helper requires either the direct entrypoint PID 1 or a
        # root-owned marker bound to the remapped live startup process.
        if installed_current:
            raise UnsafePathError(
                "Hermes runtime config guard refuses mutation under a foreign PID 1"
            )
        return
    if action in host_actions and not startup_ready:
        # The macOS VM compatibility path runs NemoClaw PID 1 without root and
        # cannot publish a root-owned readiness lease. It also cannot exercise
        # the privileged root transaction; allow the historical best-effort
        # host path only when PID 1 itself is demonstrably non-root. Root PID 1
        # remains fail-closed on every missing or malformed readiness marker.
        pid1_euid = _process_effective_uid(1)
        if pid1_euid is not None and pid1_euid != 0:
            return
        raise UnsafePathError(
            "Hermes startup is not ready for host config or gateway mutations"
        )


def _startup_ready_for_current_pid1() -> bool:
    try:
        opened = _open_regular(HERMES_STARTUP_READY_FILE)
    except (FileNotFoundError, UnsafePathError):
        return False
    try:
        snapshot = opened.snapshot
        if (
            snapshot.uid != 0
            or snapshot.gid != 0
            or snapshot.mode != 0o600
            or snapshot.nlink != 1
        ):
            return False
        try:
            text = opened.read_bytes(MAX_HASH_BYTES).decode("ascii")
        except UnicodeDecodeError:
            return False
        legacy = re.fullmatch(r"v1 ([0-9]+)\n", text)
        if legacy:
            # Version 1 has no PID-namespace identity and is safe only when
            # the helper directly observes the NemoClaw entrypoint as PID 1.
            start_time = _process_start_time(1)
            return bool(
                start_time is not None
                and _pid1_is_nemoclaw_start()
                and secrets.compare_digest(legacy.group(1), start_time)
            )
        current = re.fullmatch(r"v2 ([0-9]+) ([0-9]+)\n", text)
        if not current:
            return False
        namespace_inode = int(current.group(2), 10)
        return _startup_process_identity_is_live(
            current.group(1), namespace_inode
        )
    finally:
        opened.close()


def publish_startup_ready() -> None:
    start_time = _process_start_time(1)
    namespace_inode = _process_namespace_inode(1)
    if start_time is None or namespace_inode is None:
        raise UnsafePathError("cannot identify Hermes PID 1 for startup readiness")
    payload = f"v2 {start_time} {namespace_inode}\n".encode("ascii")
    try:
        opened = _open_regular(HERMES_STARTUP_READY_FILE)
    except FileNotFoundError:
        _atomic_replace(
            HERMES_STARTUP_READY_FILE,
            payload,
            expected=None,
            mode=0o600,
            uid=0,
            gid=0,
        )
        return
    try:
        snapshot = opened.snapshot
    finally:
        opened.close()
    if snapshot.uid != 0 or snapshot.gid != 0 or snapshot.mode != 0o600:
        raise UnsafePathError("refusing unsafe stale Hermes startup readiness marker")
    _atomic_replace(
        HERMES_STARTUP_READY_FILE,
        payload,
        expected=snapshot,
        mode=0o600,
        uid=0,
        gid=0,
    )


def _split_path(path: str) -> tuple[str, str]:
    abs_path = os.path.abspath(path)
    return os.path.dirname(abs_path), os.path.basename(abs_path)


def _open_parent_dir(path: str) -> tuple[int, str]:
    directory, basename = _split_path(path)
    flags = os.O_RDONLY | _directory_flag() | _no_follow_flag() | _cloexec_flag()
    try:
        dir_fd = os.open(directory, flags)
    except OSError as exc:
        raise UnsafePathError(
            f"refusing runtime config update because {directory} is unsafe: {exc}"
        ) from exc
    st = os.fstat(dir_fd)
    if not stat.S_ISDIR(st.st_mode):
        os.close(dir_fd)
        raise UnsafePathError(
            f"refusing runtime config update because {directory} is not a directory"
        )
    return dir_fd, basename


def _validate_regular(path: str, st: os.stat_result) -> FileSnapshot:
    if stat.S_ISLNK(st.st_mode):
        raise UnsafePathError(f"refusing to follow symlink: {path}")
    if not stat.S_ISREG(st.st_mode):
        raise UnsafePathError(f"refusing non-regular runtime config path: {path}")
    if st.st_nlink != 1:
        raise UnsafePathError(f"refusing hardlinked runtime config path: {path}")
    mode = stat.S_IMODE(st.st_mode)
    if mode & 0o022:
        raise UnsafePathError(
            f"refusing group/world-writable runtime config path: {path}"
        )
    return FileSnapshot.from_stat(st)


def _open_regular(path: str, mode: int = os.O_RDONLY) -> OpenFile:
    dir_fd, basename = _open_parent_dir(path)
    try:
        flags = mode | _no_follow_flag() | _cloexec_flag()
        fd = os.open(basename, flags, dir_fd=dir_fd)
        try:
            snapshot = _validate_regular(path, os.fstat(fd))
        except Exception:
            os.close(fd)
            raise
        return OpenFile(path, fd, snapshot)
    finally:
        os.close(dir_fd)


def _stat_path_at(dir_fd: int, basename: str) -> os.stat_result:
    return os.stat(basename, dir_fd=dir_fd, follow_symlinks=False)


def _same_snapshot(st: os.stat_result, snapshot: FileSnapshot) -> bool:
    return (
        st.st_dev == snapshot.dev
        and st.st_ino == snapshot.ino
        and stat.S_IMODE(st.st_mode) == snapshot.mode
        and st.st_uid == snapshot.uid
        and st.st_gid == snapshot.gid
        and st.st_nlink == snapshot.nlink
        and st.st_size == snapshot.size
        and st.st_mtime_ns == snapshot.mtime_ns
        and st.st_ctime_ns == snapshot.ctime_ns
        and stat.S_ISREG(st.st_mode)
    )


def _assert_current_snapshot(
    dir_fd: int, basename: str, path: str, snapshot: FileSnapshot
) -> None:
    current = _stat_path_at(dir_fd, basename)
    if not _same_snapshot(current, snapshot):
        raise UnsafePathError(f"refusing raced runtime config path: {path}")


def _atomic_replace(
    path: str,
    data: bytes,
    *,
    expected: FileSnapshot | None,
    mode: int,
    uid: int,
    gid: int,
) -> None:
    dir_fd, basename = _open_parent_dir(path)
    tmp_name = f".{basename}.nemoclaw.{os.getpid()}.{secrets.token_hex(8)}"
    tmp_fd: int | None = None
    try:
        if expected is not None:
            _assert_current_snapshot(dir_fd, basename, path, expected)
        else:
            try:
                _stat_path_at(dir_fd, basename)
            except FileNotFoundError:
                pass
            else:
                raise UnsafePathError(f"refusing raced runtime config create: {path}")

        tmp_fd = os.open(
            tmp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _no_follow_flag() | _cloexec_flag(),
            0o600,
            dir_fd=dir_fd,
        )
        try:
            os.fchown(tmp_fd, uid, gid)
        except PermissionError:
            if os.geteuid() == 0:
                raise
        os.fchmod(tmp_fd, mode)
        with os.fdopen(tmp_fd, "wb", closefd=True) as handle:
            tmp_fd = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())

        if expected is not None:
            _assert_current_snapshot(dir_fd, basename, path, expected)
        os.replace(tmp_name, basename, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        _fsync_directory_after_replace(dir_fd)
    except Exception:
        try:
            os.unlink(tmp_name, dir_fd=dir_fd)
        except FileNotFoundError:
            # The temp file may not exist yet, or may already have been removed
            # by the failing operation path.
            pass
        except OSError:
            # Cleanup must not mask the original atomic-write failure.
            pass
        raise
    finally:
        if tmp_fd is not None:
            os.close(tmp_fd)
        os.close(dir_fd)


def _fsync_directory_after_replace(dir_fd: int) -> None:
    global _DIRECTORY_FSYNC_WARNING_EMITTED

    try:
        os.fsync(dir_fd)
    except OSError as exc:
        if exc.errno not in DIRECTORY_FSYNC_UNSUPPORTED_ERRNOS:
            raise
        if not _DIRECTORY_FSYNC_WARNING_EMITTED:
            print(
                "[security] directory fsync is unsupported; the atomic Hermes config rename completed without a directory durability barrier",
                file=sys.stderr,
            )
            _DIRECTORY_FSYNC_WARNING_EMITTED = True



def _atomic_replace_preserving_flags(
    path: str, data: bytes, expected: FileSnapshot
) -> None:
    opened = _open_regular(path)
    try:
        if opened.snapshot != expected:
            raise UnsafePathError(f"refusing raced runtime config path: {path}")
        original_flags = _get_inode_flags(opened.fd)
        mutable_flags = original_flags & ~(FS_IMMUTABLE_FL | FS_APPEND_FL)
        if mutable_flags != original_flags:
            _set_inode_flags(opened.fd, mutable_flags)
        mutable_snapshot = FileSnapshot.from_stat(os.fstat(opened.fd))
        try:
            _atomic_replace(
                path,
                data,
                expected=mutable_snapshot,
                mode=expected.mode,
                uid=expected.uid,
                gid=expected.gid,
            )
        except Exception:
            if mutable_flags != original_flags:
                try:
                    _set_inode_flags(opened.fd, original_flags)
                except Exception:
                    # Preserve the primary replacement failure; the caller
                    # retains the sealed transaction for explicit recovery.
                    pass
            raise
    finally:
        opened.close()

    replacement = _open_regular(path)
    try:
        if original_flags:
            _set_inode_flags(replacement.fd, original_flags)
    finally:
        replacement.close()


def _read_text(
    path: str, max_bytes: int = MAX_CONFIG_INPUT_BYTES
) -> tuple[str, FileSnapshot]:
    opened = _open_regular(path)
    try:
        return opened.read_bytes(max_bytes).decode("utf-8"), opened.snapshot
    finally:
        opened.close()


def _sha256_entry(path: str, max_bytes: int) -> tuple[str, FileSnapshot]:
    opened = _open_regular(path)
    try:
        digest = opened.sha256(max_bytes)
        return f"{digest}  {path}\n", opened.snapshot
    finally:
        opened.close()


def _write_existing(
    path: str, text: str, snapshot: FileSnapshot, mode: int | None = None
) -> None:
    if mode is not None and mode != snapshot.mode:
        _atomic_replace(
            path,
            text.encode("utf-8"),
            expected=snapshot,
            mode=mode,
            uid=snapshot.uid,
            gid=snapshot.gid,
        )
        return
    _atomic_replace_preserving_flags(path, text.encode("utf-8"), snapshot)


def _write_hash(path: str, text: str) -> None:
    try:
        opened = _open_regular(path)
    except FileNotFoundError:
        _atomic_replace(
            path,
            text.encode("utf-8"),
            expected=None,
            mode=0o600,
            uid=os.geteuid(),
            gid=os.getegid(),
        )
        return
    try:
        snapshot = opened.snapshot
    finally:
        opened.close()
    _atomic_replace_preserving_flags(path, text.encode("utf-8"), snapshot)


def _canonical_mcp_servers_digest(config_text: str) -> str:
    """Hash the effective MCP map without persisting or logging its contents."""
    try:
        parsed = yaml.safe_load(config_text)
    except yaml.YAMLError as exc:
        raise UnsafePathError("refusing invalid Hermes MCP configuration") from exc
    if parsed is None:
        parsed = {}
    if not isinstance(parsed, dict):
        raise UnsafePathError("refusing non-object Hermes configuration")
    servers = parsed.get("mcp_servers", {})
    if servers is None:
        servers = {}
    if not isinstance(servers, dict):
        raise UnsafePathError("refusing non-object Hermes mcp_servers configuration")
    try:
        canonical = json.dumps(
            servers,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise UnsafePathError(
            "refusing non-canonical Hermes mcp_servers configuration"
        ) from exc
    return hashlib.sha256(canonical).hexdigest()


def _current_mcp_servers_digest(config_path: str) -> tuple[str, FileSnapshot]:
    config_text, snapshot = _read_text(config_path, MAX_CONFIG_INPUT_BYTES)
    return _canonical_mcp_servers_digest(config_text), snapshot


def _hash_text_and_mcp_digest(
    config_path: str,
    env_path: str,
    mcp_state: McpHashState | None = None,
) -> tuple[str, FileSnapshot, FileSnapshot, str, str]:
    config_text, config_snapshot = _read_text(config_path, MAX_CONFIG_INPUT_BYTES)
    config_digest = hashlib.sha256(config_text.encode("utf-8")).hexdigest()
    config_entry = f"{config_digest}  {config_path}\n"
    env_entry, env_snapshot = _sha256_entry(env_path, MAX_ENV_BYTES)
    current_mcp = _canonical_mcp_servers_digest(config_text)
    state = mcp_state or McpHashState(current_mcp, current_mcp)
    state_entry = (
        f"{MCP_HASH_STATE_PREFIX} intended={state.intended} applied={state.applied}\n"
    )
    return (
        config_entry + env_entry + state_entry,
        config_snapshot,
        env_snapshot,
        current_mcp,
        config_text,
    )


def _hash_text(
    config_path: str,
    env_path: str,
    mcp_state: McpHashState | None = None,
) -> tuple[str, FileSnapshot, FileSnapshot]:
    (
        text,
        config_snapshot,
        env_snapshot,
        _current_mcp,
        _config_text,
    ) = _hash_text_and_mcp_digest(config_path, env_path, mcp_state)
    return text, config_snapshot, env_snapshot


def _applied_mcp_hash_text(
    config_path: str,
    env_path: str,
    compat_hash: str,
    source_hash_text: str,
    current_mcp: str,
    state: McpHashState,
    mode: str,
) -> tuple[str, FileSnapshot, FileSnapshot]:
    """Build the metadata-only MCP applied-state commit from one stable input."""
    if not secrets.compare_digest(current_mcp, state.intended):
        raise UnsafePathError("Hermes MCP config changed before applied-state commit")
    # Applying intent is a metadata-only commit. Require the complete
    # config/env snapshot to still match the pending trust anchor rather than
    # re-hashing and blessing unrelated concurrent changes.
    pending_hash_text, config_snapshot, env_snapshot = _hash_text(
        config_path, env_path, state
    )
    if not secrets.compare_digest(pending_hash_text, source_hash_text):
        raise UnsafePathError(
            "Hermes config or env changed before applied-state commit"
        )
    if mode == "both" and not secrets.compare_digest(
        _read_hash_file(compat_hash), source_hash_text
    ):
        raise UnsafePathError(
            "Hermes strict and compatibility MCP state differ before "
            "applied-state commit"
        )
    applied_state = McpHashState(state.intended, state.intended)
    lines = pending_hash_text.splitlines(keepends=True)
    state_line = (
        f"{MCP_HASH_STATE_PREFIX} intended={applied_state.intended} "
        f"applied={applied_state.applied}\n"
    )
    for index, line in enumerate(lines):
        if line.startswith(MCP_HASH_STATE_PREFIX):
            lines[index] = state_line
            break
    else:
        raise UnsafePathError(
            "Hermes MCP state marker missing before applied-state commit"
        )
    return "".join(lines), config_snapshot, env_snapshot


def _hash_text_for_refresh(
    config_path: str,
    env_path: str,
    compat_hash: str,
    source_hash_text: str,
    current_mcp: str,
    state: McpHashState,
    mode: str,
    mcp_transition: str,
) -> tuple[str, FileSnapshot, FileSnapshot]:
    """Resolve the hash refresh payload and its input snapshots in one step."""
    if mcp_transition == "apply":
        return _applied_mcp_hash_text(
            config_path,
            env_path,
            compat_hash,
            source_hash_text,
            current_mcp,
            state,
            mode,
        )
    return _hash_text(config_path, env_path, state)


def _sealed_file_limit(name: str) -> int:
    if name == "config.yaml":
        return MAX_CONFIG_INPUT_BYTES
    if name == ".env":
        return MAX_ENV_BYTES
    if name == ".config-hash":
        return MAX_HASH_BYTES
    raise UnsafePathError(f"refusing unknown Hermes sealed path: {name}")


def _decode_bounded_base64(value: str, max_bytes: int, label: str) -> bytes:
    # Check the encoded shape before decoding so a hostile journal cannot make
    # Python allocate an attacker-sized temporary merely to reject it later.
    max_encoded = ((max_bytes + 2) // 3) * 4
    if len(value) > max_encoded:
        raise UnsafePathError(f"refusing oversized {label}")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, UnicodeEncodeError, base64.binascii.Error) as exc:
        raise UnsafePathError(f"refusing invalid {label}") from exc
    if len(decoded) > max_bytes:
        raise UnsafePathError(f"refusing oversized {label}")
    return decoded


def _hash_state_from_file(path: str, config_path: str, env_path: str) -> McpHashState:
    text = _read_hash_file(path)
    _config_digest, _env_digest, state = _parse_config_hash(text, config_path, env_path)
    return state


def refresh_hashes(
    hermes_dir: str,
    hash_file: str,
    mode: str,
    mcp_transition: str = "preserve",
) -> None:
    """Advance the durable MCP intended/applied state without blessing drift.

    ``preserve`` requires current config to equal intended. ``intend`` records
    current config as the next intent while retaining the last applied digest.
    ``rollback`` requires restored config to equal the prior applied digest,
    then conservatively records restored/failed-candidate until reload health is
    proven. ``apply`` is a metadata-only intended/intended commit and requires
    the complete pending config/env anchor to remain byte-identical. Thus a new
    image begins current/current, add/remove moves to new/old, rollback moves to
    old/new, and only a healthy replacement advances either pending state to
    current/current; concurrent config or env changes fail closed.
    """
    config_path = os.path.join(hermes_dir, "config.yaml")
    env_path = os.path.join(hermes_dir, ".env")
    compat_hash = os.path.join(hermes_dir, ".config-hash")
    if mcp_transition not in {"preserve", "intend", "rollback", "apply"}:
        raise UnsafePathError("refusing unsupported Hermes MCP hash transition")

    # Snapshot-stability/TOCTOU contract: derive the config hash and canonical
    # MCP digest from one `_read_text` result, retain both config/env inode
    # snapshots, and reopen/compare them before each anchor write and once after
    # the final write. For `apply`, the complete pending anchor must also remain
    # byte-identical, so advancing only the metadata line cannot bless unrelated
    # config/env drift between gateway health and commit.
    state_path = hash_file if mode in ("strict", "both") else compat_hash
    # Runtime refresh is allowed to advance an existing trust anchor, never to
    # create one from the mutable config it is supposed to authenticate. Image
    # construction emits the initial intended/applied marker; missing or
    # malformed metadata must therefore fail closed.
    source_hash_text = _read_hash_file(state_path)
    _config_digest, _env_digest, state = _parse_config_hash(
        source_hash_text, config_path, env_path
    )
    current_mcp, _ = _current_mcp_servers_digest(config_path)
    # The transaction helper and the managed supervisor can both observe the
    # same pending reload. The helper may commit it first while the supervisor
    # still retains its earlier pending observation. Replacing an already-current
    # anchor with byte-identical content needlessly changes its inode and can
    # make a concurrent host reconciliation reject an otherwise coherent
    # snapshot. Keep the repeated apply fail-closed, but make it validation-only:
    # authenticate config, env, and every relevant anchor as one stable current
    # snapshot before returning without an atomic replacement.
    if mcp_transition == "apply" and secrets.compare_digest(
        state.intended, state.applied
    ):
        integrity = inspect_mcp_integrity_snapshot(
            hermes_dir,
            state_path,
            compat_hash if mode == "both" else None,
        )
        if integrity.state != "current":
            raise UnsafePathError(
                "Hermes MCP applied-state commit did not observe current state"
            )
        assert_mcp_integrity_snapshot_current(integrity)
        return
    if mcp_transition == "preserve":
        if not secrets.compare_digest(current_mcp, state.intended):
            raise UnsafePathError(
                "Hermes MCP config differs from persisted intended state"
            )
    elif mcp_transition == "intend":
        if state.intended != state.applied and not secrets.compare_digest(
            current_mcp, state.intended
        ):
            raise UnsafePathError(
                "Hermes MCP configuration has an incomplete prior transaction"
            )
        state = McpHashState(current_mcp, state.applied)
    elif mcp_transition == "rollback":
        # A failed desired-config reload leaves the runtime identity uncertain.
        # Re-anchor the restored config as intended, but retain the failed
        # candidate digest as the conservative applied value until a healthy
        # old-config replacement is observed.  This keeps startup/recovery
        # fail-closed if the rollback reload also fails.
        if secrets.compare_digest(state.intended, state.applied):
            raise UnsafePathError(
                "Hermes MCP rollback requires a pending desired configuration"
            )
        if not secrets.compare_digest(current_mcp, state.applied):
            raise UnsafePathError(
                "Hermes MCP rollback config does not match the previously applied state"
            )
        state = McpHashState(current_mcp, state.intended)
    hash_text, config_snapshot, env_snapshot = _hash_text_for_refresh(
        config_path,
        env_path,
        compat_hash,
        source_hash_text,
        current_mcp,
        state,
        mode,
        mcp_transition,
    )

    def assert_inputs_stable() -> None:
        config = _open_regular(config_path)
        env = _open_regular(env_path)
        try:
            if config.snapshot != config_snapshot or env.snapshot != env_snapshot:
                raise UnsafePathError(
                    "refusing raced Hermes config/env path before hash refresh"
                )
        finally:
            config.close()
            env.close()

    # `both` is the transaction contract: both trust anchors must advance or
    # the caller rolls the config write back. `compat` remains best-effort for
    # legacy startup paths where an old image can expose a read-only in-tree
    # anchor. Hash refresh is an atomic rename, so directory write authority
    # is what matters.
    compat_writable = os.access(hermes_dir, os.W_OK)
    # Applying a healthy gateway's intent must use the real atomic write as
    # the authority check. `os.access` is only a best-effort legacy probe and
    # can disagree with the effective credentials used by the write itself.
    compat_commit_required = mcp_transition == "apply" and mode == "compat"
    if mode == "both" or (
        mode == "compat" and (compat_writable or compat_commit_required)
    ):
        assert_inputs_stable()
        _write_hash(compat_hash, hash_text)

    # In `both` mode the root-owned strict anchor is the commit record and must
    # advance last. A crash after compat but before strict therefore makes the
    # next startup fail strict verification instead of blessing a half-commit.
    if mode in ("strict", "both"):
        assert_inputs_stable()
        _write_hash(hash_file, hash_text)

    # Detect same-inode rewrites that raced either anchor update. The restart
    # path temporarily makes both inputs root-owned/read-only, so this final
    # check also proves the launched gateway will consume the validated bytes.
    assert_inputs_stable()


def inspect_mcp_integrity_snapshot(
    hermes_dir: str,
    hash_file: str,
    compatibility_hash_file: str | None = None,
) -> McpIntegritySnapshot:
    config_path = os.path.join(hermes_dir, "config.yaml")
    env_path = os.path.join(hermes_dir, ".env")
    text, hash_snapshot = _read_text(hash_file, MAX_HASH_BYTES)
    hash_snapshots = [(hash_file, hash_snapshot)]
    if compatibility_hash_file is not None:
        compatibility_text, compatibility_snapshot = _read_text(
            compatibility_hash_file, MAX_HASH_BYTES
        )
        if not secrets.compare_digest(compatibility_text, text):
            raise UnsafePathError(
                "Hermes strict and compatibility MCP integrity anchors differ"
            )
        hash_snapshots.append((compatibility_hash_file, compatibility_snapshot))
    _config_digest, _env_digest, state = _parse_config_hash(text, config_path, env_path)
    (
        actual,
        config_snapshot,
        env_snapshot,
        current_mcp,
        config_text,
    ) = _hash_text_and_mcp_digest(config_path, env_path, state)
    if not secrets.compare_digest(actual, text):
        raise UnsafePathError("Hermes config hash does not match persisted inputs")
    if not secrets.compare_digest(current_mcp, state.intended):
        raise UnsafePathError("Hermes MCP config differs from persisted intended state")
    return McpIntegritySnapshot(
        state="pending" if state.intended != state.applied else "current",
        config_text=config_text,
        config_path=config_path,
        config_snapshot=config_snapshot,
        env_path=env_path,
        env_snapshot=env_snapshot,
        hash_snapshots=tuple(hash_snapshots),
    )


def assert_mcp_integrity_snapshot_current(snapshot: McpIntegritySnapshot) -> None:
    for path, expected in (
        (snapshot.config_path, snapshot.config_snapshot),
        (snapshot.env_path, snapshot.env_snapshot),
        *snapshot.hash_snapshots,
    ):
        try:
            opened = _open_regular(path)
        except OSError as exc:
            raise UnsafePathError(
                "refusing raced Hermes MCP integrity snapshot"
            ) from exc
        try:
            if opened.snapshot != expected:
                raise UnsafePathError("refusing raced Hermes MCP integrity snapshot")
        finally:
            opened.close()


def inspect_mcp_integrity(hermes_dir: str, hash_file: str) -> str:
    snapshot = inspect_mcp_integrity_snapshot(hermes_dir, hash_file)
    assert_mcp_integrity_snapshot_current(snapshot)
    return snapshot.state


def _inode_metadata(st: os.stat_result) -> dict[str, int]:
    return {
        "dev": st.st_dev,
        "ino": st.st_ino,
        "mode": stat.S_IMODE(st.st_mode),
        "uid": st.st_uid,
        "gid": st.st_gid,
    }


def _get_inode_flags(fd: int) -> int:
    try:
        result = fcntl.ioctl(fd, FS_IOC_GETFLAGS, struct.pack("I", 0))
        return struct.unpack("I", result)[0]
    except OSError as exc:
        if exc.errno in (errno.ENOTTY, errno.EOPNOTSUPP, errno.EINVAL):
            return 0
        raise


def _set_inode_flags(fd: int, flags: int) -> None:
    try:
        fcntl.ioctl(fd, FS_IOC_SETFLAGS, struct.pack("I", flags))
    except OSError as exc:
        if flags == 0 and exc.errno in (errno.ENOTTY, errno.EOPNOTSUPP, errno.EINVAL):
            return
        raise UnsafePathError(
            f"refusing restart seal because inode flags could not be restored: {exc}"
        ) from exc


def _open_directory(path: str) -> int:
    flags = os.O_RDONLY | _directory_flag() | _no_follow_flag() | _cloexec_flag()
    fd = os.open(path, flags)
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        os.close(fd)
        raise UnsafePathError(
            f"refusing restart seal because {path} is not a directory"
        )
    return fd


def _open_child_directory(parent_fd: int, name: str, path: str) -> int:
    flags = os.O_RDONLY | _directory_flag() | _no_follow_flag() | _cloexec_flag()
    fd = os.open(name, flags, dir_fd=parent_fd)
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        os.close(fd)
        raise UnsafePathError(
            f"refusing restart seal because {path} is not a directory"
        )
    return fd


def _same_inode(st: os.stat_result, metadata: dict[str, int]) -> bool:
    return st.st_dev == metadata["dev"] and st.st_ino == metadata["ino"]


def _read_hash_file(path: str) -> str:
    opened = _open_regular(path)
    try:
        return opened.read_bytes(MAX_HASH_BYTES).decode("utf-8")
    finally:
        opened.close()


def _verify_strict_hash(hermes_dir: str, hash_file: str) -> None:
    config_path = os.path.join(hermes_dir, "config.yaml")
    env_path = os.path.join(hermes_dir, ".env")
    strict = _read_hash_file(hash_file)
    _config_digest, _env_digest, state = _parse_config_hash(
        strict, config_path, env_path
    )
    actual, _config_snapshot, _env_snapshot = _hash_text(config_path, env_path, state)
    if actual != strict:
        raise StrictHashMismatchError(
            "strict hash verification failed for Hermes restart seal"
        )


def _verify_compat_hash(hash_file: str, compat_hash_file: str) -> None:
    if _read_hash_file(compat_hash_file) != _read_hash_file(hash_file):
        raise UnsafePathError("compat hash verification failed for Hermes restart seal")


def _parse_config_hash(
    text: str, config_path: str, env_path: str
) -> tuple[str, str, McpHashState]:
    parts = text.split("\n")
    if len(parts) != 4 or parts[-1] != "":
        raise UnsafePathError("refusing malformed Hermes config hash")
    lines = parts[:2]
    expected_paths = (config_path, env_path)
    if len(lines) != len(expected_paths):
        raise UnsafePathError("refusing malformed Hermes config hash")
    digests: list[str] = []
    for line, expected_path in zip(lines, expected_paths, strict=True):
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if match is None or match.group(2) != expected_path:
            raise UnsafePathError("refusing malformed Hermes config hash")
        digests.append(match.group(1))
    state_match = MCP_HASH_STATE_RE.fullmatch(parts[2])
    if state_match is None:
        raise UnsafePathError("refusing malformed Hermes MCP hash state")
    return (
        digests[0],
        digests[1],
        McpHashState(state_match.group(1), state_match.group(2)),
    )


def _without_single_generated_api_server_key(text: str) -> str:
    retained: list[str] = []
    removed = 0
    for line in text.splitlines(keepends=True):
        parsed = _parse_env_assignment(line)
        if parsed is None or parsed[1] != "API_SERVER_KEY":
            retained.append(line)
            continue
        if removed != 0 or re.fullmatch(r"API_SERVER_KEY=[0-9a-f]{64}\n", line) is None:
            raise UnsafePathError(
                "refusing unexpected API_SERVER_KEY change during non-root startup"
            )
        removed += 1
    if removed != 1:
        raise UnsafePathError(
            "refusing missing API_SERVER_KEY change during non-root startup"
        )
    return "".join(retained)


def _managed_nonroot_reconciliation_is_allowed() -> bool:
    installed_current = os.path.abspath(__file__) == INSTALLED_RUNTIME_CONFIG_GUARD
    if not installed_current:
        return False
    try:
        sandbox_uid = pwd.getpwnam("sandbox").pw_uid
    except KeyError:
        return False
    return _startup_ready_marker_absent() and _openshell_supervised_nonroot_start_is_live(
        0, sandbox_uid
    )


def _mutable_nonroot_reconciliation_posture_is_allowed(
    hermes_meta: dict[str, int],
    file_states: dict[str, dict[str, object]],
) -> bool:
    try:
        sandbox_uid, sandbox_gid = _sandbox_identity()
    except UnsafePathError:
        return False

    # OpenShell can present the live non-root home as private 0700 after the
    # managed supervisor/dashboard has started. The canonical root uses 03770.
    # Both are sandbox-owned mutable roots.
    if (
        hermes_meta.get("uid") != sandbox_uid
        or hermes_meta.get("gid") != sandbox_gid
        or hermes_meta.get("mode") not in (0o700, 0o3770)
    ):
        return False

    for name in ("config.yaml", ".env", ".config-hash"):
        original = file_states.get(name, {}).get("original")
        if (
            not isinstance(original, dict)
            or original.get("uid") != sandbox_uid
            or original.get("gid") != sandbox_gid
            or int(original.get("mode", 0)) not in (0o600, 0o640)
        ):
            return False
    return True


def _reconcile_nonroot_startup_api_key_hash(
    hermes_dir: str,
    hash_file: str,
    expected_config_sha256: str,
    hermes_meta: dict[str, int],
    file_states: dict[str, dict[str, object]],
) -> None:
    """Advance strict trust across the one non-root startup mutation we permit.

    OpenShell starts the Hermes entrypoint as ``sandbox``. That process must
    mint a per-sandbox API bearer token, but it cannot update the root-owned
    strict hash. A later root config write may reconcile that exact append only
    after the namespace has been frozen. Every other config or env difference
    remains a hard refusal.
    """

    if not _managed_nonroot_reconciliation_is_allowed():
        raise UnsafePathError(
            "strict hash verification failed outside managed non-root startup"
        )
    if not _mutable_nonroot_reconciliation_posture_is_allowed(
        hermes_meta, file_states
    ):
        raise UnsafePathError(
            "refusing strict hash reconciliation outside mutable Hermes posture"
        )

    config_path = os.path.join(hermes_dir, "config.yaml")
    env_path = os.path.join(hermes_dir, ".env")
    compat_hash_path = os.path.join(hermes_dir, ".config-hash")
    strict_text = _read_hash_file(hash_file)
    strict_config_sha256, strict_env_sha256, strict_mcp_state = _parse_config_hash(
        strict_text, config_path, env_path
    )
    actual_text, config_snapshot, env_snapshot = _hash_text(
        config_path, env_path, strict_mcp_state
    )
    actual_config_sha256, _actual_env_sha256, _actual_mcp_state = _parse_config_hash(
        actual_text, config_path, env_path
    )

    if not secrets.compare_digest(_read_hash_file(compat_hash_path), actual_text):
        raise UnsafePathError(
            "compat hash does not match frozen Hermes inputs during non-root reconciliation"
        )
    if not secrets.compare_digest(actual_config_sha256, expected_config_sha256):
        raise UnsafePathError("Hermes config changed after the host read it; retry the command")
    if not secrets.compare_digest(actual_config_sha256, strict_config_sha256):
        raise UnsafePathError(
            "refusing config drift during non-root strict hash reconciliation"
        )

    env_text, env_read_snapshot = _read_text(env_path, MAX_ENV_BYTES)
    if env_read_snapshot != env_snapshot:
        raise UnsafePathError("refusing raced Hermes env during strict hash reconciliation")
    prior_env_text = _without_single_generated_api_server_key(env_text)
    if not secrets.compare_digest(
        hashlib.sha256(prior_env_text.encode("utf-8")).hexdigest(), strict_env_sha256
    ):
        raise UnsafePathError(
            "refusing non-API-key env drift during non-root strict hash reconciliation"
        )

    # Recheck both path snapshots immediately before the root-owned commit.
    # A writable descriptor retained before the namespace freeze must not race
    # the bytes whose trust is being advanced.
    for path, expected_snapshot in (
        (config_path, config_snapshot),
        (env_path, env_snapshot),
    ):
        opened = _open_regular(path)
        try:
            if opened.snapshot != expected_snapshot:
                raise UnsafePathError(
                    "refusing raced Hermes inputs during strict hash reconciliation"
                )
        finally:
            opened.close()

    # The compatibility anchor already commits the frozen current inputs.
    # Advance the root-owned strict anchor last, then let the ordinary seal
    # verification and inode replacement path re-prove both anchors.
    _write_hash(hash_file, actual_text)


def _state_file_parent_is_safe(path: str) -> None:
    parent_fd, _basename = _open_parent_dir(path)
    try:
        st = os.fstat(parent_fd)
        if st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) & 0o022:
            raise UnsafePathError(
                f"refusing restart seal because state directory for {path} is not private"
            )
    finally:
        os.close(parent_fd)


def _ensure_private_runtime_directory(
    runtime_dir: str, expected_uid: int, expected_gid: int, expected_mode: int
) -> None:
    """Create one fixed protected runtime directory through a pinned safe parent."""

    parent = os.path.dirname(runtime_dir)
    basename = os.path.basename(runtime_dir)
    if not parent or not basename or basename in (".", ".."):
        raise UnsafePathError("refusing invalid Hermes runtime state directory")
    try:
        parent_fd = _open_directory(parent)
    except OSError as exc:
        raise UnsafePathError("Hermes runtime state parent is unavailable") from exc
    child_fd: int | None = None
    try:
        parent_st = os.fstat(parent_fd)
        if (
            parent_st.st_uid != expected_uid
            or parent_st.st_gid != expected_gid
            or stat.S_IMODE(parent_st.st_mode) & 0o022
        ):
            raise UnsafePathError("refusing unsafe Hermes runtime state parent")
        try:
            os.mkdir(basename, expected_mode, dir_fd=parent_fd)
        except FileExistsError:
            pass
        except OSError as exc:
            raise UnsafePathError("Hermes runtime state directory is unavailable") from exc
        try:
            child_fd = _open_child_directory(parent_fd, basename, runtime_dir)
        except OSError as exc:
            raise UnsafePathError("Hermes runtime state directory is unavailable") from exc
        child_st = os.fstat(child_fd)
        if (
            child_st.st_uid != expected_uid
            or child_st.st_gid != expected_gid
            or stat.S_IMODE(child_st.st_mode) & 0o022
        ):
            raise UnsafePathError("refusing unsafe Hermes runtime state directory")
        if stat.S_IMODE(child_st.st_mode) != expected_mode:
            # Managed OpenShell starts the supervisor as the sandbox user. It
            # must be able to stat the fixed startup-readiness pathname while
            # remaining unable to list or write this root-owned directory.
            os.fchmod(child_fd, expected_mode)
            child_st = os.fstat(child_fd)
            if stat.S_IMODE(child_st.st_mode) != expected_mode:
                raise UnsafePathError("could not make Hermes runtime state directory private")
    finally:
        if child_fd is not None:
            os.close(child_fd)
        os.close(parent_fd)


def _ensure_production_runtime_directory(lock_path: str, state_file: str) -> None:
    if (lock_path, state_file) != (
        HERMES_MUTATION_LOCK_FILE,
        HERMES_RESTART_STATE_FILE,
    ):
        return
    if os.geteuid() != 0 or os.getegid() != 0:
        raise UnsafePathError("Hermes production runtime state requires root")
    _ensure_private_runtime_directory(
        NEMOCLAW_RUNTIME_DIR, 0, 0, NEMOCLAW_RUNTIME_DIR_MODE
    )


def _acquire_mutation_lock(
    lock_path: str,
    token: str,
    purpose: str,
    state_file: str,
) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        raise UnsafePathError("refusing invalid Hermes config mutation lock token")
    _ensure_production_runtime_directory(lock_path, state_file)
    if os.path.exists(state_file):
        raise UnsafePathError("Hermes config mutation is already in progress")

    parent = os.path.dirname(lock_path)
    basename = os.path.basename(lock_path)
    parent_fd = _open_directory(parent)
    tmp_name = f".{basename}.{os.getpid()}.{secrets.token_hex(8)}"
    tmp_fd: int | None = None
    try:
        parent_st = os.fstat(parent_fd)
        if parent_st.st_uid != os.geteuid() or stat.S_IMODE(parent_st.st_mode) & 0o022:
            raise UnsafePathError("refusing unsafe Hermes config mutation lock parent")

        tmp_fd = os.open(
            tmp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _no_follow_flag() | _cloexec_flag(),
            0o600,
            dir_fd=parent_fd,
        )
        process_start_time = _process_start_time(os.getpid())
        payload = (
            json.dumps(
                {
                    "version": 1,
                    "token": token,
                    "purpose": purpose,
                    "pid": os.getpid(),
                    "pid_start_time": process_start_time,
                },
                sort_keys=True,
            )
            + "\n"
        ).encode("utf-8")
        offset = 0
        while offset < len(payload):
            offset += os.write(tmp_fd, payload[offset:])
        os.fchmod(tmp_fd, 0o600)
        os.fsync(tmp_fd)
        os.close(tmp_fd)
        tmp_fd = None

        # A hard link publishes a complete record atomically without replacing
        # an existing lock. A kill before this leaves no visible lock; a kill
        # after it leaves a complete token that release can validate.
        try:
            os.link(
                tmp_name,
                basename,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except FileExistsError as exc:
            raise UnsafePathError(
                "Hermes config mutation is already in progress"
            ) from exc
    finally:
        if tmp_fd is not None:
            os.close(tmp_fd)
        try:
            os.unlink(tmp_name, dir_fd=parent_fd)
        except FileNotFoundError:
            # The hard-link publication or an earlier cleanup consumed it.
            pass
        os.close(parent_fd)


def _parse_process_start_time(raw: bytes) -> str | None:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    closing_paren = text.rfind(")")
    if closing_paren < 0:
        return None
    fields_after_comm = text[closing_paren + 2 :].split()
    # The suffix starts at field 3 (`state`); starttime is field 22.
    if len(fields_after_comm) <= 19:
        return None
    return fields_after_comm[19]


def _process_start_time(pid: int) -> str | None:
    proc_root_fd = -1
    proc_pid_fd = -1
    try:
        proc_root_fd = _open_proc_root()
        proc_pid_fd = _open_proc_pid(proc_root_fd, pid)
        raw = _read_proc_pid_file(proc_pid_fd, "stat", f"{PROC_ROOT}/{pid}/stat")
    except (OSError, UnsafePathError):
        return None
    finally:
        if proc_pid_fd >= 0:
            os.close(proc_pid_fd)
        if proc_root_fd >= 0:
            os.close(proc_root_fd)
    return _parse_process_start_time(raw)


def _process_namespace_inode(pid: int) -> int | None:
    proc_root_fd = -1
    proc_pid_fd = -1
    try:
        proc_root_fd = _open_proc_root()
        proc_pid_fd = _open_proc_pid(proc_root_fd, pid)
        return _proc_pid_namespace_inode(proc_pid_fd)
    except OSError:
        return None
    finally:
        if proc_pid_fd >= 0:
            os.close(proc_pid_fd)
        if proc_root_fd >= 0:
            os.close(proc_root_fd)


def _read_proc_file(path: str) -> bytes:
    fd = os.open(path, os.O_RDONLY | _cloexec_flag())
    try:
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, min(4096, MAX_PROC_BYTES + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_PROC_BYTES:
                raise UnsafePathError(f"refusing oversized proc entry: {path}")
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def _read_mutation_lock(lock_path: str) -> tuple[int, dict[str, object]]:
    parent_fd, basename = _open_parent_dir(lock_path)
    try:
        fd = os.open(
            basename,
            os.O_RDONLY | _no_follow_flag() | _cloexec_flag(),
            dir_fd=parent_fd,
        )
        try:
            owner_st = os.fstat(fd)
            if (
                not stat.S_ISREG(owner_st.st_mode)
                or owner_st.st_uid != os.geteuid()
                or owner_st.st_gid != os.getegid()
                or stat.S_IMODE(owner_st.st_mode) != 0o600
                or owner_st.st_nlink != 1
            ):
                raise UnsafePathError("refusing unsafe Hermes config mutation lock")
            owner_snapshot = FileSnapshot.from_stat(owner_st)
            if owner_st.st_size > MAX_MUTATION_LOCK_BYTES:
                raise UnsafePathError("refusing oversized Hermes config mutation lock")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = os.read(
                    fd, min(4096, MAX_MUTATION_LOCK_BYTES + 1 - total)
                )
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_MUTATION_LOCK_BYTES:
                    raise UnsafePathError(
                        "refusing oversized Hermes config mutation lock"
                    )
                chunks.append(chunk)
            if FileSnapshot.from_stat(os.fstat(fd)) != owner_snapshot:
                raise UnsafePathError("refusing raced Hermes config mutation lock")
            try:
                owner = json.loads(b"".join(chunks).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise UnsafePathError(
                    "refusing corrupt Hermes config mutation lock"
                ) from exc
            recorded = owner.get("token") if isinstance(owner, dict) else None
            if not isinstance(owner, dict) or not isinstance(recorded, str):
                raise UnsafePathError(
                    "refusing corrupt Hermes config mutation lock token"
                )
            return parent_fd, owner
        finally:
            os.close(fd)
    except Exception:
        os.close(parent_fd)
        raise


def _release_mutation_lock(lock_path: str, token: str) -> None:
    try:
        parent_fd, owner = _read_mutation_lock(lock_path)
    except FileNotFoundError:
        return
    try:
        recorded = owner.get("token")
        if not isinstance(recorded, str):
            raise UnsafePathError("refusing corrupt Hermes config mutation lock token")
        if not secrets.compare_digest(recorded, token):
            raise UnsafePathError("refusing Hermes config mutation lock token mismatch")
        os.unlink(os.path.basename(lock_path), dir_fd=parent_fd)
    finally:
        os.close(parent_fd)



def recover_dead_prestate_mutation_lock(state_file: str) -> bool:
    """Remove only a dead, fully published lock that has no recovery state."""

    if os.path.exists(state_file):
        raise UnsafePathError("refusing pre-state lock recovery while state exists")
    lock_path = os.path.join(os.path.dirname(state_file), "hermes-config-mutation.lock")
    parent_fd, basename = _open_parent_dir(lock_path)
    quarantine = f".{basename}.dead.{os.getpid()}.{secrets.token_hex(8)}"
    fd: int | None = None
    moved = False
    try:
        try:
            fd = os.open(
                basename,
                os.O_RDONLY | _no_follow_flag() | _cloexec_flag(),
                dir_fd=parent_fd,
            )
        except FileNotFoundError:
            return False
        st = os.fstat(fd)
        if (
            not stat.S_ISREG(st.st_mode)
            or st.st_uid != os.geteuid()
            or st.st_gid != os.getegid()
            or stat.S_IMODE(st.st_mode) != 0o600
            or st.st_nlink != 1
            or st.st_size > MAX_MUTATION_LOCK_BYTES
        ):
            raise UnsafePathError("refusing unsafe dead Hermes mutation lock")
        opened = OpenFile(lock_path, fd, FileSnapshot.from_stat(st))
        try:
            raw = opened.read_bytes(MAX_MUTATION_LOCK_BYTES)
        finally:
            # `fd` remains owned by this function; OpenFile.close is not used.
            pass
        try:
            owner = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UnsafePathError("refusing corrupt dead Hermes mutation lock") from exc
        if (
            not isinstance(owner, dict)
            or owner.get("version") != 1
            or not isinstance(owner.get("purpose"), str)
            or not isinstance(owner.get("pid"), int)
            or not isinstance(owner.get("pid_start_time"), str)
            or not isinstance(owner.get("token"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", str(owner.get("token")))
        ):
            raise UnsafePathError("refusing malformed dead Hermes mutation lock")
        if _mutation_lock_owner_is_live(owner):
            raise UnsafePathError("Hermes config mutation owner is still active")

        os.rename(basename, quarantine, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        moved = True
        quarantine_fd = os.open(
            quarantine,
            os.O_RDONLY | _no_follow_flag() | _cloexec_flag(),
            dir_fd=parent_fd,
        )
        try:
            moved_st = os.fstat(quarantine_fd)
            if moved_st.st_dev != st.st_dev or moved_st.st_ino != st.st_ino:
                raise UnsafePathError("dead Hermes mutation lock changed during quarantine")
        finally:
            os.close(quarantine_fd)
        if os.path.exists(state_file):
            raise UnsafePathError("Hermes mutation state appeared during lock recovery")
        os.unlink(quarantine, dir_fd=parent_fd)
        moved = False
        os.fsync(parent_fd)
        return True
    except Exception:
        if moved:
            try:
                os.rename(
                    quarantine,
                    basename,
                    src_dir_fd=parent_fd,
                    dst_dir_fd=parent_fd,
                )
            except OSError:
                # Keep the quarantined root-owned lock and propagate the
                # original recovery failure; never guess at its ownership.
                pass
        raise
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent_fd)


def _mutation_lock_owner_is_live(owner: dict[str, object]) -> bool:
    pid = owner.get("pid")
    start_time = owner.get("pid_start_time")
    if not isinstance(pid, int) or pid <= 1 or not isinstance(start_time, str):
        return False
    if _process_start_time(pid) != start_time:
        return False
    try:
        status = _read_proc_file(f"/proc/{pid}/status").decode("utf-8")
        cmdline = _read_proc_file(f"/proc/{pid}/cmdline").split(b"\0")
    except (FileNotFoundError, PermissionError, UnicodeDecodeError):
        return False
    uid_line = next(
        (line for line in status.splitlines() if line.startswith("Uid:")), ""
    )
    try:
        uids = [int(value) for value in uid_line.split()[1:]]
    except ValueError:
        return False
    if len(uids) < 2 or uids[0] != 0 or uids[1] != 0:
        return False
    purpose = owner.get("purpose")
    if not isinstance(purpose, str):
        return False
    guard_names = {
        b"/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
        os.path.realpath(__file__).encode("utf-8"),
    }
    if not any(argument in guard_names for argument in cmdline):
        return False
    return any(
        action in cmdline
        for action in (
            b"seal-restart",
            b"write-config",
        )
    )


def inspect_mutation_owner(state_file: str, expected_token: str = "") -> str:
    lock_path = os.path.join(os.path.dirname(state_file), "hermes-config-mutation.lock")
    state_exists = os.path.exists(state_file)
    lock_exists = os.path.exists(lock_path)
    state_data: dict[str, object] | None = None
    state_token = ""
    if state_exists:
        state_data = _load_restart_state(state_file)
        candidate = state_data.get("mutation_lock_token")
        if not isinstance(candidate, str):
            raise UnsafePathError("refusing mutation state without a lock token")
        state_token = candidate

    owner: dict[str, object] | None = None
    if lock_exists:
        parent_fd, owner = _read_mutation_lock(lock_path)
        os.close(parent_fd)
        lock_token = owner.get("token")
        if not isinstance(lock_token, str):
            raise UnsafePathError("refusing mutation lock without a token")
        if state_token and not secrets.compare_digest(lock_token, state_token):
            raise UnsafePathError("refusing mismatched Hermes mutation state and lock")

    token_match = bool(
        expected_token
        and state_token
        and secrets.compare_digest(expected_token, state_token)
    )
    active = owner is not None and _mutation_lock_owner_is_live(owner)
    return (
        f"state={int(state_exists)} lock={int(lock_exists)} "
        f"owner_active={int(active)} token_match={int(token_match)}"
    )


def _write_restart_state(
    path: str, state_data: dict[str, object], *, create: bool
) -> None:
    _state_file_parent_is_safe(path)
    encoded = (json.dumps(state_data, sort_keys=True) + "\n").encode("utf-8")
    if len(encoded) > MAX_RESTART_STATE_BYTES:
        raise UnsafePathError("refusing oversized Hermes restart seal state")
    if create:
        _atomic_replace(
            path,
            encoded,
            expected=None,
            mode=0o600,
            uid=os.geteuid(),
            gid=os.getegid(),
        )
        return
    opened = _open_regular(path)
    try:
        snapshot = opened.snapshot
    finally:
        opened.close()
    _atomic_replace(
        path,
        encoded,
        expected=snapshot,
        mode=0o600,
        uid=os.geteuid(),
        gid=os.getegid(),
    )


def _load_restart_state(path: str) -> dict[str, object]:
    text, _snapshot = _read_text(path, MAX_RESTART_STATE_BYTES)
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise UnsafePathError(
            f"refusing corrupt Hermes restart seal state: {exc}"
        ) from exc
    if not isinstance(value, dict) or value.get("version") != 1:
        raise UnsafePathError("refusing unsupported Hermes restart seal state")
    return value


def _ensure_restart_orphan_marker(hermes_fd: int) -> None:
    try:
        fd = os.open(
            RESTART_ORPHAN_MARKER_NAME,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _no_follow_flag() | _cloexec_flag(),
            0o400,
            dir_fd=hermes_fd,
        )
    except FileExistsError:
        fd = os.open(
            RESTART_ORPHAN_MARKER_NAME,
            os.O_RDONLY | _no_follow_flag() | _cloexec_flag(),
            dir_fd=hermes_fd,
        )
        try:
            marker_st = os.fstat(fd)
            if (
                not stat.S_ISREG(marker_st.st_mode)
                or marker_st.st_uid != os.geteuid()
                or marker_st.st_gid != os.getegid()
                or stat.S_IMODE(marker_st.st_mode) != 0o400
                or marker_st.st_nlink != 1
            ):
                raise UnsafePathError("refusing unsafe Hermes restart orphan marker")
        finally:
            os.close(fd)
        return
    try:
        os.fchmod(fd, 0o400)
        os.fchown(fd, os.geteuid(), os.getegid())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(hermes_fd)


def _remove_restart_orphan_marker(hermes_fd: int) -> None:
    try:
        os.unlink(RESTART_ORPHAN_MARKER_NAME, dir_fd=hermes_fd)
        os.fsync(hermes_fd)
    except FileNotFoundError:
        # Removing an already-absent orphan marker is intentionally idempotent.
        pass


def _restore_restart_seal(
    state_file: str, *, verify_hash: bool, retain_transaction: bool = False
) -> bool:
    if not os.path.exists(state_file):
        return False
    state_data = _load_restart_state(state_file)
    if state_data.get("purpose") not in {"restart-seal", "config-write"}:
        raise UnsafePathError(
            "retired Hermes config state cannot be recovered in place; rebuild or recreate the sandbox"
        )
    lock_token = state_data.get("mutation_lock_token")
    lock_path = state_data.get("mutation_lock_path")
    if not isinstance(lock_token, str) or not isinstance(lock_path, str):
        raise UnsafePathError("refusing restart unseal without a mutation lock token")
    if state_data.get("phase") == "acquired":
        _release_mutation_lock(lock_path, lock_token)
        os.unlink(state_file)
        return True

    hermes_dir = str(state_data["hermes_dir"])
    hash_file = str(state_data["hash_file"])
    parent_path, hermes_name = _split_path(hermes_dir)
    parent_fd = _open_directory(parent_path)
    hermes_fd: int | None = None
    file_fds: list[tuple[int, dict[str, object]]] = []
    try:
        parent_meta = state_data["parent"]
        hermes_meta = state_data["hermes"]
        if not isinstance(parent_meta, dict) or not isinstance(hermes_meta, dict):
            raise UnsafePathError("refusing malformed Hermes restart seal metadata")
        if not _same_inode(os.fstat(parent_fd), parent_meta):
            raise UnsafePathError(
                "refusing restart unseal because the sandbox directory changed"
            )
        hermes_fd = _open_child_directory(parent_fd, hermes_name, hermes_dir)
        if not _same_inode(os.fstat(hermes_fd), hermes_meta):
            raise UnsafePathError(
                "refusing restart unseal because the Hermes directory changed"
            )

        if verify_hash:
            _verify_strict_hash(hermes_dir, hash_file)
            _verify_compat_hash(hash_file, os.path.join(hermes_dir, ".config-hash"))

        # Re-freeze the mutable sealed posture and clear any partially restored
        # immutable flags first. This makes unseal retryable if a prior attempt
        # failed after restoring one file but before completing the transaction.
        _set_inode_flags(
            parent_fd,
            _get_inode_flags(parent_fd) & ~(FS_IMMUTABLE_FL | FS_APPEND_FL),
        )
        os.fchown(parent_fd, os.geteuid(), os.getegid())
        os.fchmod(parent_fd, 0o755)
        _set_inode_flags(
            hermes_fd,
            _get_inode_flags(hermes_fd) & ~(FS_IMMUTABLE_FL | FS_APPEND_FL),
        )
        os.fchown(hermes_fd, os.geteuid(), os.getegid())
        # Restore runs as root. Keep the config tree inaccessible to sandbox
        # processes until every sealed file and directory is back in posture.
        os.fchmod(hermes_fd, 0o700)
        _ensure_restart_orphan_marker(hermes_fd)

        files = state_data["files"]
        if not isinstance(files, dict):
            raise UnsafePathError("refusing malformed Hermes restart file metadata")
        for name in SEALED_FILE_NAMES:
            file_state = files.get(name)
            if not isinstance(file_state, dict):
                raise UnsafePathError(
                    f"refusing missing Hermes restart metadata for {name}"
                )
            fd = os.open(
                name,
                os.O_RDONLY | _no_follow_flag() | _cloexec_flag(),
                dir_fd=hermes_fd,
            )
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                    raise UnsafePathError(f"refusing unsafe sealed Hermes path: {name}")
                sealed = file_state.get("sealed")
                if isinstance(sealed, dict) and not _same_inode(st, sealed):
                    raise UnsafePathError(
                        f"refusing restart unseal because sealed {name} changed"
                    )
                original = file_state.get("original")
                if not isinstance(original, dict):
                    raise UnsafePathError(
                        f"refusing malformed original metadata for {name}"
                    )
                _set_inode_flags(
                    fd,
                    _get_inode_flags(fd) & ~(FS_IMMUTABLE_FL | FS_APPEND_FL),
                )
                file_fds.append((fd, file_state))
                fd = -1
            finally:
                if fd >= 0:
                    os.close(fd)

        # Restore all ordinary metadata before reapplying any immutable flags.
        # Parent remains frozen until the very last operation.
        for fd, file_state in file_fds:
            original = file_state["original"]
            if not isinstance(original, dict):
                raise UnsafePathError(
                    "refusing malformed original Hermes file metadata"
                )
            os.fchown(fd, original["uid"], original["gid"])
            os.fchmod(fd, original["mode"])
        for fd, file_state in file_fds:
            _set_inode_flags(fd, int(file_state.get("flags", 0)))

        # Restore the directories while the persistent root-owned marker still
        # identifies this transaction. Chown can clear setgid, so chmod follows
        # chown. The marker is removed only after every mode/owner/flag is exact;
        # losing rootfs-local /run state at any earlier point remains detectable.
        os.fchown(hermes_fd, hermes_meta["uid"], hermes_meta["gid"])
        os.fchmod(hermes_fd, hermes_meta["mode"])
        _set_inode_flags(hermes_fd, int(state_data.get("hermes_flags", 0)))
        if not retain_transaction:
            os.fchmod(parent_fd, parent_meta["mode"])
            _set_inode_flags(parent_fd, int(state_data.get("parent_flags", 0)))
            _remove_restart_orphan_marker(hermes_fd)
            # Seal rejects set-id parent modes, so this final ownership change
            # cannot silently clear a mode bit. Before it succeeds, root parent
            # ownership remains the durable orphan marker; afterward metadata
            # is exact and no marker is needed.
            os.fchown(parent_fd, parent_meta["uid"], parent_meta["gid"])
    finally:
        for fd, _file_state in file_fds:
            os.close(fd)
        if hermes_fd is not None:
            os.close(hermes_fd)
        os.close(parent_fd)

    if not retain_transaction:
        _release_mutation_lock(lock_path, lock_token)
        os.unlink(state_file)
    return True


def seal_restart(
    hermes_dir: str,
    hash_file: str,
    state_file: str,
    purpose: str = "restart-seal",
    mutation_lock_token: str | None = None,
    expected_config_sha256: str | None = None,
) -> bool:
    if purpose not in {"restart-seal", "config-write"}:
        raise UnsafePathError("refusing unsupported Hermes config transaction purpose")
    if os.path.exists(state_file):
        raise UnsafePathError("Hermes restart seal is already active")
    mutation_lock_token = mutation_lock_token or secrets.token_hex(32)
    mutation_lock_path = os.path.join(
        os.path.dirname(state_file), "hermes-config-mutation.lock"
    )
    _acquire_mutation_lock(mutation_lock_path, mutation_lock_token, purpose, state_file)
    state_data: dict[str, object] = {
        "version": 1,
        "phase": "acquired",
        "mutation_lock_token": mutation_lock_token,
        "mutation_lock_path": mutation_lock_path,
        "hermes_dir": hermes_dir,
        "hash_file": hash_file,
        "purpose": purpose,
    }
    try:
        _write_restart_state(state_file, state_data, create=True)
    except Exception:
        _release_mutation_lock(mutation_lock_path, mutation_lock_token)
        raise

    state_created = True
    parent_path, hermes_name = _split_path(hermes_dir)
    parent_fd: int | None = None
    hermes_fd: int | None = None
    try:
        parent_fd = _open_directory(parent_path)
        parent_meta = _inode_metadata(os.fstat(parent_fd))
        parent_flags = _get_inode_flags(parent_fd)
        hermes_fd = _open_child_directory(parent_fd, hermes_name, hermes_dir)
        hermes_meta = _inode_metadata(os.fstat(hermes_fd))
        hermes_flags = _get_inode_flags(hermes_fd)

        # `/sandbox` ownership is the durable orphan-transaction marker when
        # the rootfs-local `/run` token is lost during container recreation.
        # Do not clear an immutable parent before that ownership marker can be
        # established, because a crash in between would be undetectable on the
        # next container. NemoClaw does not use an immutable `/sandbox` parent.
        if parent_flags & (FS_IMMUTABLE_FL | FS_APPEND_FL):
            raise UnsafePathError(
                "refusing restart seal because /sandbox has blocking inode flags"
            )
        if parent_meta["mode"] & (stat.S_ISUID | stat.S_ISGID):
            raise UnsafePathError(
                "refusing restart seal because /sandbox has set-id mode bits"
            )
        if hermes_flags & (FS_IMMUTABLE_FL | FS_APPEND_FL):
            raise UnsafePathError(
                "refusing restart seal because .hermes has blocking inode flags"
            )

        file_states: dict[str, dict[str, object]] = {}
        for name in SEALED_FILE_NAMES:
            fd = os.open(
                name,
                os.O_RDONLY | _no_follow_flag() | _cloexec_flag(),
                dir_fd=hermes_fd,
            )
            try:
                st = os.fstat(fd)
                _validate_regular(os.path.join(hermes_dir, name), st)
                file_states[name] = {
                    "original": _inode_metadata(st),
                    "flags": _get_inode_flags(fd),
                }
            finally:
                os.close(fd)

        # Persist recovery metadata before the first freeze mutation. A killed
        # guard/PID 1 in the same container writable layer can idempotently
        # restore the exact contract. If recreation loses `/run`, root ownership
        # of the persistent /sandbox parent makes startup fail closed instead.
        state_data.update(
            {
                "phase": "locking",
                "parent": parent_meta,
                "parent_flags": parent_flags,
                "hermes": hermes_meta,
                "hermes_flags": hermes_flags,
                "files": file_states,
            }
        )
        _write_restart_state(state_file, state_data, create=False)

        os.fchown(parent_fd, os.geteuid(), os.getegid())
        os.fchmod(parent_fd, 0o755)
        current_hermes = os.stat(hermes_name, dir_fd=parent_fd, follow_symlinks=False)
        if not _same_inode(current_hermes, hermes_meta):
            raise UnsafePathError("refusing raced Hermes directory before restart seal")
        _set_inode_flags(hermes_fd, hermes_flags & ~FS_IMMUTABLE_FL)
        os.fchown(hermes_fd, os.geteuid(), os.getegid())
        os.fchmod(hermes_fd, 0o755)
        try:
            os.stat(
                RESTART_ORPHAN_MARKER_NAME,
                dir_fd=hermes_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        else:
            raise UnsafePathError("refusing pre-existing Hermes restart orphan marker")
        _ensure_restart_orphan_marker(hermes_fd)

        # The agent could rename either file between the pre-token snapshot and
        # the parent freeze. Require the same inode before hashing or replacing.
        for name in SEALED_FILE_NAMES:
            current = os.stat(name, dir_fd=hermes_fd, follow_symlinks=False)
            original = file_states[name]["original"]
            if not isinstance(original, dict) or not _same_inode(current, original):
                raise UnsafePathError(f"refusing raced Hermes restart path: {name}")

        # Validate before creating replacement inodes. On mismatch the recovery
        # token restores both directory modes and leaves file paths untouched.
        compat_hash_path = os.path.join(hermes_dir, ".config-hash")
        try:
            _verify_strict_hash(hermes_dir, hash_file)
        except StrictHashMismatchError:
            if purpose != "config-write" or expected_config_sha256 is None:
                raise
            _reconcile_nonroot_startup_api_key_hash(
                hermes_dir,
                hash_file,
                expected_config_sha256,
                hermes_meta,
                file_states,
            )
            _verify_strict_hash(hermes_dir, hash_file)
        _verify_compat_hash(hash_file, compat_hash_path)

        for name in SEALED_FILE_NAMES:
            path = os.path.join(hermes_dir, name)
            opened = _open_regular(path)
            try:
                flags = int(file_states[name]["flags"])
                _set_inode_flags(opened.fd, flags & ~(FS_IMMUTABLE_FL | FS_APPEND_FL))
            finally:
                opened.close()
            text, snapshot = _read_text(path, _sealed_file_limit(name))
            if name == ".config-hash":
                strict_hash_text = _read_hash_file(hash_file)
                if text != strict_hash_text:
                    raise UnsafePathError(
                        "compat hash changed during Hermes restart seal"
                    )
                # Publish trusted anchor bytes, not bytes copied from a path for
                # which a sandbox process may retain a pre-seal descriptor.
                text = strict_hash_text
            file_states[name]["trusted_base64"] = base64.b64encode(
                text.encode("utf-8")
            ).decode("ascii")
            _atomic_replace(
                path,
                text.encode("utf-8"),
                expected=snapshot,
                mode=0o444,
                uid=os.geteuid(),
                gid=os.getegid(),
            )
            sealed_st = os.stat(name, dir_fd=hermes_fd, follow_symlinks=False)
            if not stat.S_ISREG(sealed_st.st_mode) or sealed_st.st_nlink != 1:
                raise UnsafePathError(f"refusing unsafe sealed Hermes path: {name}")
            file_states[name]["sealed"] = _inode_metadata(sealed_st)

        _verify_strict_hash(hermes_dir, hash_file)
        _verify_compat_hash(hash_file, compat_hash_path)
        state_data["phase"] = "sealed"
        state_data["files"] = file_states
        _write_restart_state(state_file, state_data, create=False)

        # Keep top-level runtime state writable while the short restart seal is
        # active.
        if hermes_meta["uid"] != os.geteuid() or hermes_meta["mode"] & 0o022:
            os.fchown(hermes_fd, os.geteuid(), hermes_meta["gid"])
            os.fchmod(hermes_fd, 0o3770)
    except Exception:
        if state_created:
            try:
                _restore_restart_seal(state_file, verify_hash=False)
            except Exception:
                # Preserve the frozen root-owned state for explicit recovery
                # and propagate the original seal failure.
                pass
        raise
    finally:
        if hermes_fd is not None:
            os.close(hermes_fd)
        if parent_fd is not None:
            os.close(parent_fd)
    return False


def unseal_restart(hermes_dir: str, state_file: str) -> None:
    if not os.path.exists(state_file):
        return
    state_data = _load_restart_state(state_file)
    if os.path.normpath(str(state_data.get("hermes_dir", ""))) != os.path.normpath(
        hermes_dir
    ):
        raise UnsafePathError(
            "refusing restart unseal for a different Hermes directory"
        )
    if str(state_data.get("phase", "")).startswith("config-write"):
        _recover_config_write_transaction(hermes_dir, state_file)
    _restore_restart_seal(state_file, verify_hash=True)


def _record_current_sealed_inodes(
    state_file: str, hermes_dir: str, names: tuple[str, ...]
) -> None:
    state_data = _load_restart_state(state_file)
    files = state_data.get("files")
    if not isinstance(files, dict):
        raise UnsafePathError("refusing malformed Hermes restart file metadata")
    # Resolve through an opened directory so state publication cannot be
    # redirected through a pathname swap.
    hermes_fd = _open_directory(hermes_dir)
    try:
        for name in names:
            file_state = files.get(name)
            if not isinstance(file_state, dict):
                raise UnsafePathError(
                    f"refusing missing Hermes restart metadata for {name}"
                )
            current_st = os.stat(name, dir_fd=hermes_fd, follow_symlinks=False)
            if not stat.S_ISREG(current_st.st_mode) or current_st.st_nlink != 1:
                raise UnsafePathError(f"refusing unsafe sealed Hermes path: {name}")
            file_state["sealed"] = _inode_metadata(current_st)
    finally:
        os.close(hermes_fd)
    state_data["files"] = files
    _write_restart_state(state_file, state_data, create=False)




def _sandbox_identity() -> tuple[int, int]:
    if os.geteuid() != 0:
        # Unit fixtures and rootless fallbacks can only use their own identity.
        return os.geteuid(), os.getegid()
    try:
        return pwd.getpwnam("sandbox").pw_uid, grp.getgrnam("sandbox").gr_gid
    except KeyError as exc:
        raise UnsafePathError("sandbox account lookup failed") from exc













def _recover_config_write_transaction(hermes_dir: str, state_file: str) -> None:
    state_data = _load_restart_state(state_file)
    phase = str(state_data.get("phase", ""))
    write_state = state_data.get("config_write")
    if not isinstance(write_state, dict):
        raise UnsafePathError(
            "refusing config-write recovery without rollback metadata"
        )
    encoded_original = write_state.get("original_base64")
    if not isinstance(encoded_original, str):
        files = state_data.get("files")
        config_state = files.get("config.yaml") if isinstance(files, dict) else None
        encoded_original = (
            config_state.get("trusted_base64")
            if isinstance(config_state, dict)
            else None
        )
    original_digest = write_state.get("original_sha256")
    if not isinstance(encoded_original, str) or not isinstance(original_digest, str):
        raise UnsafePathError(
            "refusing malformed Hermes config-write rollback metadata"
        )
    original_bytes = _decode_bounded_base64(
        encoded_original,
        MAX_CONFIG_INPUT_BYTES,
        "Hermes config-write rollback bytes",
    )
    if not secrets.compare_digest(
        hashlib.sha256(original_bytes).hexdigest(), original_digest
    ):
        raise UnsafePathError("refusing invalid Hermes config-write rollback digest")

    config_path = os.path.join(hermes_dir, "config.yaml")
    if phase == "config-write-prepared":
        current = _open_regular(config_path)
        try:
            current_snapshot = current.snapshot
        finally:
            current.close()
        _atomic_replace(
            config_path,
            original_bytes,
            expected=current_snapshot,
            mode=0o444,
            uid=os.geteuid(),
            gid=os.getegid(),
        )
        refresh_hashes(hermes_dir, str(state_data["hash_file"]), "both")
        _record_current_sealed_inodes(
            state_file, hermes_dir, ("config.yaml", ".config-hash")
        )
    elif phase == "config-write-committed":
        # The committed phase is published only after config + both hashes are
        # durable. Re-verify the strict anchor, but do not repeat the write.
        _verify_strict_hash(hermes_dir, str(state_data["hash_file"]))
    else:
        raise UnsafePathError(
            f"refusing unsupported Hermes config-write phase: {phase}"
        )

    state_data = _load_restart_state(state_file)
    state_data["phase"] = "sealed"
    state_data.pop("config_write", None)
    _write_restart_state(state_file, state_data, create=False)


def _validate_hermes_config_candidate(config_bytes: bytes) -> None:
    """Parse a candidate with Hermes' own config model before any mutation.

    The guard owns the sealed write transaction, while Hermes owns the schema.
    Loading the candidate into the bundled model catches incomplete nested objects
    such as ``platforms.teams.home_channel`` without maintaining a second schema.
    This function does not read or write sandbox state.
    """
    try:
        config_text = config_bytes.decode("utf-8")
        parsed = yaml.safe_load(config_text)
    except (UnicodeDecodeError, yaml.YAMLError) as exc:
        raise UnsafePathError("Hermes configuration is not valid YAML") from exc
    if not isinstance(parsed, dict):
        raise UnsafePathError("Hermes configuration must be a mapping")
    try:
        from gateway.config import GatewayConfig

        GatewayConfig.from_dict(parsed)
    except UnsafePathError:
        raise
    except Exception as exc:
        # Configuration values can contain credentials. KeyError identifies a
        # missing field without echoing the candidate; other parser failures
        # report only their exception type.
        detail = str(exc)[:300] if isinstance(exc, KeyError) else type(exc).__name__
        raise UnsafePathError(
            f"Hermes schema validation rejected the candidate: {detail}"
        ) from exc


def write_config_transaction(
    hermes_dir: str,
    hash_file: str,
    state_file: str,
    expected_config_sha256: str,
    config_bytes: bytes,
) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_config_sha256):
        raise UnsafePathError("write-config requires a valid expected config SHA-256")
    if len(config_bytes) > MAX_CONFIG_INPUT_BYTES:
        raise UnsafePathError("refusing oversized Hermes config input")

    # Validate before `seal_restart` writes the restart state or opens mutable
    # inputs. A rejected candidate must leave config, env, and both hash anchors
    # byte-for-byte unchanged. The established exact-size boundary runs its
    # filesystem check first when the config path is absent.
    config_path = os.path.join(hermes_dir, "config.yaml")
    if os.path.exists(config_path):
        _validate_hermes_config_candidate(config_bytes)

    seal_restart(
        hermes_dir,
        hash_file,
        state_file,
        purpose="config-write",
        expected_config_sha256=expected_config_sha256,
    )
    committed = False
    try:
        state_data = _load_restart_state(state_file)
        opened = _open_regular(config_path)
        try:
            original_bytes = opened.read_bytes(MAX_CONFIG_INPUT_BYTES)
            original_snapshot = opened.snapshot
        finally:
            opened.close()
        if not secrets.compare_digest(
            hashlib.sha256(original_bytes).hexdigest(), expected_config_sha256
        ):
            raise UnsafePathError(
                "Hermes config changed after the host read it; retry the command"
            )
        try:
            replacement_text = config_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise UnsafePathError("refusing non-UTF-8 Hermes config input") from exc
        current_state = _hash_state_from_file(
            hash_file, config_path, os.path.join(hermes_dir, ".env")
        )
        replacement_mcp = _canonical_mcp_servers_digest(replacement_text)
        if not secrets.compare_digest(replacement_mcp, current_state.intended):
            raise UnsafePathError(
                "non-MCP config transaction cannot change Hermes mcp_servers"
            )

        state_data["phase"] = "config-write-prepared"
        state_data["config_write"] = {
            "original_sha256": hashlib.sha256(original_bytes).hexdigest(),
        }
        _write_restart_state(state_file, state_data, create=False)

        _atomic_replace(
            config_path,
            config_bytes,
            expected=original_snapshot,
            mode=0o444,
            uid=os.geteuid(),
            gid=os.getegid(),
        )
        refresh_hashes(hermes_dir, hash_file, "both")
        _record_current_sealed_inodes(
            state_file, hermes_dir, ("config.yaml", ".config-hash")
        )
        state_data = _load_restart_state(state_file)
        state_data["phase"] = "config-write-committed"
        _write_restart_state(state_file, state_data, create=False)
        committed = True
        unseal_restart(hermes_dir, state_file)
    except Exception:
        try:
            unseal_restart(hermes_dir, state_file)
            if committed:
                return
        except Exception:
            # Retain the root-only token, frozen parent, and mutation lock.
            # PID 1 can retry recovery; it must never guess at metadata.
            pass
        raise


def _parse_env_assignment(line: str) -> tuple[str, str, str] | None:
    stripped = line.rstrip("\n")
    prefix = ""
    candidate = stripped
    if candidate.startswith("export "):
        prefix = "export "
        candidate = candidate[len(prefix) :].lstrip()
    if "=" not in candidate:
        return None
    key, value = candidate.split("=", 1)
    return prefix, key, value


def _upsert_env_assignments(
    text: str, assignments: dict[str, str]
) -> tuple[str, bool, set[str]]:
    if not assignments:
        return text, False, set()

    seen: set[str] = set()
    changed = False
    changed_keys: set[str] = set()
    updated: list[str] = []
    for line in text.splitlines(keepends=True):
        parsed = _parse_env_assignment(line)
        if parsed is None:
            updated.append(line)
            continue
        prefix, key, _value = parsed
        if key not in assignments:
            updated.append(line)
            continue
        if key in seen:
            changed = True
            changed_keys.add(key)
            continue
        seen.add(key)
        new_line = f"{prefix}{key}={assignments[key]}\n"
        updated.append(new_line)
        if new_line != line:
            changed = True
            changed_keys.add(key)

    for key, value in assignments.items():
        if key in seen:
            continue
        if updated and not updated[-1].endswith("\n"):
            updated[-1] = updated[-1] + "\n"
            changed = True
        # Appended provider placeholders use standard dotenv syntax; existing
        # export-prefixed assignments preserve their export prefix above.
        updated.append(f"{key}={value}\n")
        changed = True
        changed_keys.add(key)

    updated_text = "".join(updated)
    return updated_text, changed or updated_text != text, changed_keys


def _first_env_assignment_value(text: str, env_key: str) -> str | None:
    for line in text.splitlines(keepends=True):
        parsed = _parse_env_assignment(line)
        if parsed is None:
            continue
        _prefix, key, value = parsed
        if key == env_key:
            return value
    return None


def _env_assignment_keys(text: str) -> set[str]:
    keys: set[str] = set()
    for line in text.splitlines(keepends=True):
        parsed = _parse_env_assignment(line)
        if parsed is None:
            continue
        _prefix, key, _value = parsed
        keys.add(key)
    return keys


def _is_generated_api_server_key(value: str) -> bool:
    candidate = value.strip()
    if (
        len(candidate) >= 2
        and candidate[0] == candidate[-1]
        and candidate[0] in ("'", '"')
    ):
        candidate = candidate[1:-1]
    return API_SERVER_KEY_RE.fullmatch(candidate) is not None


def _placeholder_suffix_matches_env_key(suffix: str, env_key: str) -> bool:
    if suffix == env_key:
        return True
    revision_match = re.fullmatch(r"v[0-9]{1,20}_(.+)", suffix)
    return revision_match is not None and revision_match.group(1) == env_key


def _provider_placeholder_for_env_key(value: str, env_key: str) -> str | None:
    if not value.startswith(SCOPED_PLACEHOLDER_PREFIX):
        return None
    suffix = value[len(SCOPED_PLACEHOLDER_PREFIX) :]
    if not _placeholder_suffix_matches_env_key(suffix, env_key):
        return None
    return value


def _has_env_control_chars(value: str) -> bool:
    return "\x00" in value or "\r" in value or "\n" in value


def _validate_runtime_plan_env_key(value: object, label: str) -> str:
    if not isinstance(value, str) or not ENV_KEY_RE.fullmatch(value):
        raise UnsafePathError(f"messaging runtime plan {label} is invalid")
    return value


def _validate_env_text_with_boundary(
    text: str, boundary_validator_path: str | None
) -> None:
    if not boundary_validator_path:
        raise UnsafePathError(
            "Hermes provider placeholder refresh requires the secret-boundary validator"
        )
    fd, temp_path = tempfile.mkstemp(prefix="hermes-env-boundary-", text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(text)
        try:
            result = subprocess.run(
                [sys.executable, boundary_validator_path, "env-file", temp_path],
                check=False,
                timeout=BOUNDARY_VALIDATOR_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise UnsafePathError("Hermes secret-boundary validator timed out") from exc
        except OSError as exc:
            raise UnsafePathError(
                f"Hermes secret-boundary validator failed: {exc}"
            ) from exc
        if result.returncode != 0:
            raise UnsafePathError(
                "Hermes provider placeholder refresh would violate the secret boundary"
            )
    finally:
        if fd != -1:
            os.close(fd)
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            # Temp file may already be removed; cleanup should remain best-effort.
            pass


def _runtime_plan_replacements_and_provider_keys(
    runtime_plan_path: str | None,
) -> tuple[dict[str, tuple[str, str]], set[str], bool]:
    if not runtime_plan_path:
        return {}, set(), False
    try:
        runtime_plan_text, _runtime_plan_snapshot = _read_text(
            runtime_plan_path, MAX_RUNTIME_PLAN_BYTES
        )
    except FileNotFoundError:
        return {}, set(), False
    try:
        plan = json.loads(runtime_plan_text)
    except Exception as exc:
        raise UnsafePathError(f"messaging runtime plan is invalid: {exc}") from exc
    if not isinstance(plan, dict):
        raise UnsafePathError("messaging runtime plan must be an object")

    disabled_channels = {
        channel_id
        for channel_id in plan.get("disabledChannels", [])
        if isinstance(channel_id, str)
    }
    active_channel_ids: set[str] = set()
    for channel in plan.get("channels", []):
        if not isinstance(channel, dict):
            continue
        channel_id = channel.get("channelId")
        if (
            isinstance(channel_id, str)
            and channel.get("active") is True
            and channel.get("disabled") is not True
            and channel_id not in disabled_channels
        ):
            active_channel_ids.add(channel_id)

    provider_env_keys: set[str] = set()
    provider_env_keys_by_channel: dict[str, set[str]] = {}
    bindings = plan.get("credentialBindings", [])
    if not isinstance(bindings, list):
        raise UnsafePathError(
            "messaging runtime plan credentialBindings must be a list"
        )
    for binding in bindings:
        if not isinstance(binding, dict):
            raise UnsafePathError(
                "messaging runtime plan credentialBindings entries must be objects"
            )
        channel_id = binding.get("channelId")
        provider_env_key = binding.get("providerEnvKey")
        if isinstance(channel_id, str) and channel_id in active_channel_ids:
            validated_provider_env_key = _validate_runtime_plan_env_key(
                provider_env_key, "credentialBindings.providerEnvKey"
            )
            provider_env_keys.add(validated_provider_env_key)
            provider_env_keys_by_channel.setdefault(channel_id, set()).add(
                validated_provider_env_key
            )

    runtime_setup = plan.get("runtimeSetup") or {}
    if not isinstance(runtime_setup, dict):
        raise UnsafePathError("messaging runtime plan runtimeSetup must be an object")
    aliases = runtime_setup.get("envAliases", [])
    if not isinstance(aliases, list):
        raise UnsafePathError(
            "messaging runtime plan runtimeSetup.envAliases must be a list"
        )

    replacements: dict[str, tuple[str, str]] = {}
    for alias in aliases:
        if not isinstance(alias, dict):
            raise UnsafePathError(
                "messaging runtime plan envAliases entries must be objects"
            )
        channel_id = alias.get("channelId")
        if not isinstance(channel_id, str) or channel_id not in active_channel_ids:
            continue
        env_key = alias.get("envKey")
        target_env_key = alias.get("targetEnvKey")
        pattern = alias.get("match")
        value = alias.get("value")
        message = alias.get("message") or ""
        if (
            not isinstance(pattern, str)
            or not isinstance(value, str)
            or not isinstance(message, str)
        ):
            continue
        env_key = _validate_runtime_plan_env_key(
            env_key, "runtimeSetup.envAliases.envKey"
        )
        if target_env_key is not None:
            target_env_key = _validate_runtime_plan_env_key(
                target_env_key, "runtimeSetup.envAliases.targetEnvKey"
            )
            if target_env_key == env_key:
                raise UnsafePathError(
                    "messaging runtime plan cross-key env alias must use distinct keys"
                )
            if env_key not in provider_env_keys_by_channel.get(channel_id, set()):
                raise UnsafePathError(
                    "messaging runtime plan cross-key env alias source is not bound "
                    "to its channel"
                )
            expected_pattern = f"^openshell:resolve:env:v[0-9]+_{env_key}$"
            expected_value = f"{SCOPED_PLACEHOLDER_PREFIX}{env_key}"
            if pattern != expected_pattern or value != expected_value:
                raise UnsafePathError(
                    "messaging runtime plan cross-key env alias identity is invalid"
                )
        replacement_env_key = target_env_key or env_key
        if replacement_env_key in replacements:
            continue
        if _has_env_control_chars(value) or _has_env_control_chars(message):
            raise UnsafePathError(
                "messaging runtime plan env alias contains unsafe characters"
            )
        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            raise UnsafePathError(
                f"messaging runtime plan env alias regex is invalid: {exc}"
            ) from exc
        runtime_value = os.environ.get(env_key, "")
        if runtime_value.startswith(SCOPED_PLACEHOLDER_PREFIX):
            suffix = runtime_value[len(SCOPED_PLACEHOLDER_PREFIX) :]
            if not _placeholder_suffix_matches_env_key(suffix, env_key):
                continue
        if compiled.search(runtime_value):
            replacement_value = runtime_value if target_env_key else value
            alias_marker = "-OPENSHELL-RESOLVE-ENV-"
            if (
                target_env_key is None
                and alias_marker in value
                and runtime_value.startswith(SCOPED_PLACEHOLDER_PREFIX)
            ):
                runtime_suffix = runtime_value[len(SCOPED_PLACEHOLDER_PREFIX) :]
                alias_prefix, alias_suffix = value.split(alias_marker, 1)
                if alias_suffix == env_key and re.fullmatch(
                    rf"v[0-9]{{1,20}}_{re.escape(env_key)}", runtime_suffix
                ):
                    replacement_value = f"{alias_prefix}{alias_marker}{runtime_suffix}"
            replacements[replacement_env_key] = (replacement_value, message)
    return replacements, provider_env_keys, True


def ensure_api_key(hermes_dir: str, hash_file: str, mode: str) -> None:
    env_path = os.path.join(hermes_dir, ".env")
    if not os.path.exists(env_path):
        return
    text, snapshot = _read_text(env_path, MAX_ENV_BYTES)
    existing_value = _first_env_assignment_value(text, "API_SERVER_KEY")
    minted = existing_value is None or not _is_generated_api_server_key(existing_value)
    api_server_key = secrets.token_hex(32) if minted else existing_value
    updated_text, changed, _changed_keys = _upsert_env_assignments(
        text, {"API_SERVER_KEY": api_server_key}
    )

    if not changed:
        print("minted=0")
        return

    if snapshot.mode & 0o222 == 0:
        raise UnsafePathError(
            "Hermes startup cannot update the read-only .env file; rebuild or recreate the sandbox"
        )
    _write_existing(env_path, updated_text, snapshot)
    refresh_hashes(hermes_dir, hash_file, mode)
    print("minted=1" if minted else "updated=1")


def provider_placeholders(
    hermes_dir: str,
    hash_file: str,
    mode: str,
    runtime_plan_path: str | None,
    boundary_validator_path: str | None,
) -> None:
    env_path = os.path.join(hermes_dir, ".env")
    if not os.path.exists(env_path):
        return

    replacements, runtime_plan_provider_keys, runtime_plan_loaded = (
        _runtime_plan_replacements_and_provider_keys(runtime_plan_path)
    )
    text, snapshot = _read_text(env_path, MAX_ENV_BYTES)
    allowed_fallback_keys = (
        runtime_plan_provider_keys
        if runtime_plan_loaded
        else set(LEGACY_PROVIDER_PLACEHOLDER_KEYS).intersection(
            _env_assignment_keys(text)
        )
    )
    for key in allowed_fallback_keys:
        if key in replacements:
            continue
        placeholder = _provider_placeholder_for_env_key(
            os.environ.get(key, ""), key
        )
        if placeholder:
            replacements[key] = (placeholder, "")
    if not replacements:
        return

    assignment_values = {
        key: replacement for key, (replacement, _message) in replacements.items()
    }
    updated_text, changed, changed_keys = _upsert_env_assignments(
        text, assignment_values
    )

    if not changed:
        return

    _validate_env_text_with_boundary(updated_text, boundary_validator_path)

    if snapshot.mode & 0o222 == 0:
        raise UnsafePathError(
            "Hermes startup cannot update read-only provider placeholders; rebuild or recreate the sandbox"
        )

    try:
        _write_existing(env_path, updated_text, snapshot)
        refresh_hashes(hermes_dir, hash_file, mode)
    except PermissionError:
        if os.geteuid() != 0:
            print(
                "[config] Hermes provider placeholders supplied by OpenShell runtime env; "
                ".env refresh skipped without write access",
                file=sys.stderr,
            )
            return
        raise
    refreshed_keys = sorted(key for key in replacements if key in changed_keys)
    for key in refreshed_keys:
        # Runtime-plan diagnostics are data, not trusted format strings. Emit
        # only the validated environment key so a crafted plan cannot copy
        # secret-shaped message content into startup logs.
        print(
            f"[config] Refreshed Hermes provider placeholder for {key}", file=sys.stderr
        )
    print(
        "[config] Refreshed Hermes provider placeholders from OpenShell runtime env",
        file=sys.stderr,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=(
            "ensure-api-key",
            "refresh-hashes",
            "inspect-mcp-integrity",
            "commit-mcp-applied",
            "provider-placeholders",
            "publish-startup-ready",
            "seal-restart",
            "unseal-restart",
            "inspect-mutation-owner",
            "write-config",
            "recover-prestate-lock",
        ),
    )
    parser.add_argument("--hermes-dir", required=True)
    parser.add_argument("--hash-file", default="")
    parser.add_argument("--runtime-plan", default="")
    parser.add_argument("--boundary-validator", default="")
    parser.add_argument(
        "--mode", choices=("strict", "compat", "both"), default="strict"
    )
    parser.add_argument("--state-file", default="")
    parser.add_argument("--expected-config-sha256", default="")
    parser.add_argument("--lock-token", default="")
    parser.add_argument("--startup-owner", action="store_true")
    parser.add_argument("--mcp-state-exit-code", action="store_true")
    args = parser.parse_args()

    previous_alarm_handler = signal.signal(signal.SIGALRM, _deadline_expired)
    signal.alarm(GUARD_DEADLINE_SECONDS)
    try:
        if args.mcp_state_exit_code and args.action != "inspect-mcp-integrity":
            raise UnsafePathError(
                "--mcp-state-exit-code requires inspect-mcp-integrity"
            )
        _validate_action_readiness(args.action, args.startup_owner)
        if args.action == "ensure-api-key":
            if not args.hash_file:
                raise UnsafePathError("ensure-api-key requires --hash-file")
            ensure_api_key(args.hermes_dir, args.hash_file, args.mode)
        elif args.action == "refresh-hashes":
            if not args.hash_file:
                raise UnsafePathError("refresh-hashes requires --hash-file")
            refresh_hashes(args.hermes_dir, args.hash_file, args.mode)
        elif args.action == "inspect-mcp-integrity":
            if not args.hash_file:
                raise UnsafePathError("inspect-mcp-integrity requires --hash-file")
            state = inspect_mcp_integrity(args.hermes_dir, args.hash_file)
            if args.mcp_state_exit_code:
                # Startup uses an exit-only protocol so no same-UID process can
                # forge a named result file and no shell parser can truncate an
                # embedded NUL or accept a non-canonical response.
                if state == "current":
                    return 0
                if state == "pending":
                    return MCP_INTEGRITY_PENDING_EXIT_CODE
                raise UnsafePathError("refusing unknown Hermes MCP integrity state")
            print(f"mcp_state={state}")
        elif args.action == "commit-mcp-applied":
            if not args.hash_file:
                raise UnsafePathError("commit-mcp-applied requires --hash-file")
            refresh_hashes(
                args.hermes_dir,
                args.hash_file,
                args.mode,
                mcp_transition="apply",
            )
            print("mcp_applied=1")
        elif args.action == "provider-placeholders":
            if not args.hash_file:
                raise UnsafePathError("provider-placeholders requires --hash-file")
            provider_placeholders(
                args.hermes_dir,
                args.hash_file,
                args.mode,
                args.runtime_plan,
                args.boundary_validator,
            )
        elif args.action == "publish-startup-ready":
            publish_startup_ready()
            print("ready=1")
        elif args.action == "seal-restart":
            if not args.hash_file or not args.state_file:
                raise UnsafePathError(
                    "seal-restart requires --hash-file and --state-file"
                )
            if args.lock_token and not re.fullmatch(r"[0-9a-f]{64}", args.lock_token):
                raise UnsafePathError("seal-restart requires a valid lock token")
            seal_restart(
                args.hermes_dir,
                args.hash_file,
                args.state_file,
                mutation_lock_token=args.lock_token or None,
            )
            print("sealed=1")
        elif args.action == "unseal-restart":
            if not args.state_file:
                raise UnsafePathError("unseal-restart requires --state-file")
            unseal_restart(args.hermes_dir, args.state_file)
            print("unsealed=1")
        elif args.action == "inspect-mutation-owner":
            if not args.state_file:
                raise UnsafePathError("inspect-mutation-owner requires --state-file")
            if args.lock_token and not re.fullmatch(r"[0-9a-f]{64}", args.lock_token):
                raise UnsafePathError(
                    "inspect-mutation-owner requires a valid lock token"
                )
            print(inspect_mutation_owner(args.state_file, args.lock_token))
        elif args.action == "write-config":
            if (
                not args.hash_file
                or not args.state_file
                or not args.expected_config_sha256
            ):
                raise UnsafePathError(
                    "write-config requires --hash-file, --state-file, and --expected-config-sha256"
                )
            config_bytes = sys.stdin.buffer.read(MAX_CONFIG_INPUT_BYTES + 1)
            write_config_transaction(
                args.hermes_dir,
                args.hash_file,
                args.state_file,
                args.expected_config_sha256,
                config_bytes,
            )
            print("updated=1")
        elif args.action == "recover-prestate-lock":
            if not args.state_file:
                raise UnsafePathError(
                    "recover-prestate-lock requires --state-file"
                )
            recovered = recover_dead_prestate_mutation_lock(args.state_file)
            print(f"recovered={int(recovered)}")
    except UnsafePathError as exc:
        _die(str(exc))
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.EPERM, errno.EACCES):
            _die(f"refusing unsafe Hermes runtime config path: {exc}")
        raise
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_alarm_handler)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
