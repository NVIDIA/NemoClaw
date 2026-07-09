#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Descriptor-safe OpenClaw top-level config shields transitions.

This helper is deliberately self-contained so the host can invoke the installed
root-only copy or inject the same source through ``python3 -`` into an older
container.  It mutates only ``openclaw.json`` and ``.config-hash``.  All path
resolution is rooted in directory descriptors and uses ``O_NOFOLLOW``.

``write-config`` accepts the replacement document on stdin. NemoClaw's current
writers serialize strict JSON, so the helper intentionally uses Python's
trusted standard-library JSON parser and rejects JSON5-only syntax rather than
shipping a second parser into the privileged boundary.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import errno
import fcntl
import grp
import hashlib
import json
import os
import posixpath
import pwd
import re
import secrets
import stat
import struct
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Literal


Action = Literal[
    "preflight",
    "preflight-restart",
    "lock",
    "unlock",
    "seal-restart",
    "unseal-restart",
    "revoke-startup-ready",
    "publish-startup-ready",
    "write-config",
    "recover",
]
StartupIdentity = tuple[int, str, int]
CONFIG_FILES = ("openclaw.json", ".config-hash")
PRODUCTION_CONFIG_DIR = "/sandbox/.openclaw"
MAX_FILE_BYTES = {
    "openclaw.json": 16 * 1024 * 1024,
    ".config-hash": 64 * 1024,
}
JOURNAL_PATH = "/etc/nemoclaw/openclaw-config-transaction.json"
PERSISTENT_JOURNAL_NAME = ".nemoclaw-config-transaction.json"
MAX_JOURNAL_BYTES = 48 * 1024 * 1024
MUTEX_PATH = "/run/nemoclaw/openclaw-config-mutation.lock"
MAX_MUTEX_BYTES = 16 * 1024
STARTUP_READY_PATH = "/run/nemoclaw/openclaw-config-ready.json"
STARTUP_CAPABILITY_PATH = "/run/nemoclaw/openclaw-config-ready-v1.capability.json"
MAX_READY_BYTES = 4096
PROC_ROOT = "/proc"
MAX_PROC_ENTRIES = 32768
NEMOCLAW_START_ARGV = (b"nemoclaw-start", b"/usr/local/bin/nemoclaw-start")
OPENSHELL_SUPERVISOR_ARGV0 = b"/opt/openshell/bin/openshell-sandbox"
NODE_BINARY_PATH = "/usr/local/bin/node"
JSON5_MODULE_PATH = "/opt/nemoclaw/node_modules/json5"
JSON5_VALIDATION_TIMEOUT_SECONDS = 5
INSTALLED_HELPER_PATH = "/usr/local/lib/nemoclaw/openclaw-config-guard.py"
COPY_BUFFER_BYTES = 1024 * 1024
STABLE_READ_ATTEMPTS = 3
FS_IMMUTABLE_FL = 0x00000010
FS_APPEND_FL = 0x00000020
FS_IOC_GETFLAGS = 0x80086601
FS_IOC_SETFLAGS = 0x40086602
SHA256_RECORD = re.compile(r"([0-9a-fA-F]{64}) ([ *])([^\r\n]+)\n?\Z")


@dataclass(frozen=True)
class Identity:
    root_uid: int
    root_gid: int
    sandbox_uid: int
    sandbox_gid: int


@dataclass(frozen=True)
class FileSnapshot:
    name: str
    dev: int
    ino: int
    uid: int
    gid: int
    mode: int
    atime_ns: int
    mtime_ns: int
    ctime_ns: int
    size: int
    data: bytes
    xattrs: tuple[tuple[str, bytes], ...]
    inode_flags: int | None


@dataclass
class OpenConfig:
    config_path: str
    parent_path: str
    config_name: str
    parent_fd: int
    config_fd: int
    parent_stat: os.stat_result
    config_stat: os.stat_result

    def close(self) -> None:
        os.close(self.config_fd)
        os.close(self.parent_fd)


@dataclass
class MutationMutex:
    fd: int
    parent_fd: int
    token: str
    exclusive: bool

    def close(self) -> None:
        os.close(self.fd)
        os.close(self.parent_fd)


class GuardError(RuntimeError):
    def __init__(self, code: str, path: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.path = path
        self.detail = detail

    def as_json(self) -> dict[str, str]:
        return {
            "type": "issue",
            "code": self.code,
            "path": self.path,
            "detail": self.detail,
        }


class MutableHandoffError(GuardError):
    """A failure after sandbox write access has become irreversible."""


def _stored_file(
    snapshot: FileSnapshot,
    *,
    data: bytes | None = None,
    uid: int | None = None,
    gid: int | None = None,
    mode: int | None = None,
    mtime_ns: int | None = None,
    inode_flags: int | None = None,
) -> dict[str, object]:
    stored_data = snapshot.data if data is None else data
    return {
        "name": snapshot.name,
        "uid": snapshot.uid if uid is None else uid,
        "gid": snapshot.gid if gid is None else gid,
        "mode": snapshot.mode if mode is None else mode,
        "atimeNs": snapshot.atime_ns,
        "mtimeNs": snapshot.mtime_ns if mtime_ns is None else mtime_ns,
        "data": base64.b64encode(stored_data).decode("ascii"),
        "xattrs": [
            [name, base64.b64encode(value).decode("ascii")]
            for name, value in snapshot.xattrs
        ],
        "inodeFlags": snapshot.inode_flags if inode_flags is None else inode_flags,
    }


def _decode_stored_file(value: object) -> FileSnapshot:
    if not isinstance(value, dict):
        raise GuardError(
            "invalid-journal", JOURNAL_PATH, "stored file is not an object"
        )
    name = value.get("name")
    if name not in CONFIG_FILES:
        raise GuardError("invalid-journal", JOURNAL_PATH, "stored file name is invalid")
    try:
        uid = int(value["uid"])
        gid = int(value["gid"])
        mode = int(value["mode"])
        atime_ns = int(value["atimeNs"])
        mtime_ns = int(value["mtimeNs"])
        data = base64.b64decode(str(value["data"]), validate=True)
        raw_xattrs = value["xattrs"]
        raw_flags = value.get("inodeFlags")
        inode_flags = None if raw_flags is None else int(raw_flags)
    except (KeyError, TypeError, ValueError, binascii.Error) as exc:
        raise GuardError(
            "invalid-journal", JOURNAL_PATH, "stored file metadata is invalid"
        ) from exc
    if len(data) > MAX_FILE_BYTES[str(name)]:
        raise GuardError(
            "invalid-journal", JOURNAL_PATH, "stored file exceeds its size cap"
        )
    if not isinstance(raw_xattrs, list):
        raise GuardError("invalid-journal", JOURNAL_PATH, "stored xattrs are invalid")
    xattrs: list[tuple[str, bytes]] = []
    for entry in raw_xattrs:
        if (
            not isinstance(entry, list)
            or len(entry) != 2
            or not isinstance(entry[0], str)
        ):
            raise GuardError("invalid-journal", JOURNAL_PATH, "stored xattr is invalid")
        try:
            xattrs.append((entry[0], base64.b64decode(str(entry[1]), validate=True)))
        except (ValueError, binascii.Error) as exc:
            raise GuardError(
                "invalid-journal", JOURNAL_PATH, "stored xattr is invalid"
            ) from exc
    if uid < 0 or gid < 0 or mode < 0 or mode > 0o7777 or atime_ns < 0 or mtime_ns < 0:
        raise GuardError(
            "invalid-journal", JOURNAL_PATH, "stored metadata is out of range"
        )
    return FileSnapshot(
        name=str(name),
        dev=0,
        ino=0,
        uid=uid,
        gid=gid,
        mode=mode,
        atime_ns=atime_ns,
        mtime_ns=mtime_ns,
        ctime_ns=0,
        size=len(data),
        data=data,
        xattrs=tuple(xattrs),
        inode_flags=inode_flags,
    )


def _directory_flags() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory = getattr(os, "O_DIRECTORY", 0)
    if not nofollow or not directory:
        raise GuardError(
            "unsupported-platform", "", "O_NOFOLLOW and O_DIRECTORY are required"
        )
    return os.O_RDONLY | nofollow | directory | getattr(os, "O_CLOEXEC", 0)


def _file_flags() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not nofollow:
        raise GuardError("unsupported-platform", "", "O_NOFOLLOW is required")
    # O_NONBLOCK prevents a stat->FIFO substitution from hanging the privileged
    # helper in open(2); the immediate fstat/inode checks still reject it.
    return (
        os.O_RDONLY
        | nofollow
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )


def _same_inode(first: os.stat_result, second: os.stat_result) -> bool:
    return first.st_dev == second.st_dev and first.st_ino == second.st_ino


def _stable_metadata(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        _same_inode(first, second)
        and first.st_size == second.st_size
        and first.st_mtime_ns == second.st_mtime_ns
        and first.st_ctime_ns == second.st_ctime_ns
    )


def _kind(st: os.stat_result) -> str:
    if stat.S_ISREG(st.st_mode):
        return "regular file"
    if stat.S_ISDIR(st.st_mode):
        return "directory"
    if stat.S_ISLNK(st.st_mode):
        return "symlink"
    if stat.S_ISFIFO(st.st_mode):
        return "FIFO"
    if stat.S_ISSOCK(st.st_mode):
        return "socket"
    if stat.S_ISCHR(st.st_mode):
        return "character device"
    if stat.S_ISBLK(st.st_mode):
        return "block device"
    return "special entry"


def _open_absolute_dir(path: str) -> int:
    if not posixpath.isabs(path):
        raise GuardError("invalid-config-path", path, "path must be absolute")
    fd = os.open("/", _directory_flags())
    try:
        for component in posixpath.normpath(path).split("/"):
            if not component:
                continue
            before = os.stat(component, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                raise GuardError(
                    "unsafe-path-component",
                    path,
                    f"path component {component!r} is a {_kind(before)}",
                )
            next_fd = os.open(component, _directory_flags(), dir_fd=fd)
            after = os.fstat(next_fd)
            if not _same_inode(before, after):
                os.close(next_fd)
                raise GuardError(
                    "entry-raced",
                    path,
                    f"path component {component!r} changed while opening",
                )
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


def _open_private_state_dir(
    state_dir: str, identity: Identity, create: bool
) -> int | None:
    parent_path = posixpath.dirname(state_dir)
    state_name = posixpath.basename(state_dir)
    parent_fd = _open_absolute_dir(parent_path)
    try:
        try:
            before = os.stat(state_name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            if not create:
                return None
            os.mkdir(state_name, 0o700, dir_fd=parent_fd)
            os.fsync(parent_fd)
            before = os.stat(state_name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(before.st_mode):
            raise GuardError(
                "unsafe-state-path", state_dir, "state parent is not a directory"
            )
        fd = os.open(state_name, _directory_flags(), dir_fd=parent_fd)
        actual = os.fstat(fd)
        if not _same_inode(before, actual):
            os.close(fd)
            raise GuardError(
                "entry-raced", state_dir, "state directory changed while opening"
            )
        if (
            actual.st_uid != identity.root_uid
            or actual.st_gid != identity.root_gid
            or stat.S_IMODE(actual.st_mode) & 0o022
        ):
            os.close(fd)
            raise GuardError(
                "unsafe-state-path",
                state_dir,
                "state directory must be root-owned and not group/world-writable",
            )
        return fd
    finally:
        os.close(parent_fd)


def _open_journal_dir(identity: Identity, create: bool) -> int | None:
    return _open_private_state_dir(posixpath.dirname(JOURNAL_PATH), identity, create)


def _read_fd_bounded(fd: int, maximum: int, path: str) -> bytes:
    os.lseek(fd, 0, os.SEEK_SET)
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = os.read(fd, min(COPY_BUFFER_BYTES, maximum + 1 - total))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > maximum:
            raise GuardError("state-too-large", path, "state file exceeds its size cap")
        chunks.append(chunk)


def _parse_process_start_time(raw: bytes) -> str | None:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    closing_paren = text.rfind(")")
    if closing_paren < 0:
        return None
    fields_after_comm = text[closing_paren + 2 :].split()
    if len(fields_after_comm) <= 19:
        return None
    return fields_after_comm[19]


def _open_proc_root() -> int:
    return os.open(
        PROC_ROOT,
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0),
    )


def _open_proc_pid(proc_root_fd: int, pid: int | str) -> int:
    return os.open(
        str(pid),
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0),
        dir_fd=proc_root_fd,
    )


def _read_proc_pid_file(
    proc_pid_fd: int, name: str, display_path: str
) -> bytes:
    fd = os.open(
        name,
        os.O_RDONLY
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0),
        dir_fd=proc_pid_fd,
    )
    try:
        return _read_fd_bounded(fd, 64 * 1024, display_path)
    finally:
        os.close(fd)


def _proc_pid_namespace_inode(proc_pid_fd: int) -> int | None:
    ns_fd = -1
    try:
        ns_fd = os.open(
            "ns",
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            dir_fd=proc_pid_fd,
        )
        inode = os.stat("pid", dir_fd=ns_fd, follow_symlinks=True).st_ino
        return inode if inode > 0 else None
    except OSError:
        return None
    finally:
        if ns_fd >= 0:
            os.close(ns_fd)


def _process_start_time(pid: int) -> str | None:
    proc_root_fd = -1
    proc_pid_fd = -1
    try:
        proc_root_fd = _open_proc_root()
        proc_pid_fd = _open_proc_pid(proc_root_fd, pid)
        raw = _read_proc_pid_file(proc_pid_fd, "stat", f"{PROC_ROOT}/{pid}/stat")
    except OSError:
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


def _open_mutex_file(identity: Identity) -> tuple[int, int]:
    parent_fd = _open_private_state_dir(posixpath.dirname(MUTEX_PATH), identity, True)
    if parent_fd is None:
        raise GuardError(
            "mutex-open-failed", MUTEX_PATH, "mutation mutex directory is missing"
        )
    name = posixpath.basename(MUTEX_PATH)
    flags = (
        os.O_RDWR
        | os.O_CREAT
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    fd = -1
    try:
        fd = os.open(name, flags, 0o600, dir_fd=parent_fd)
        actual = os.fstat(fd)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(actual.st_mode)
            or actual.st_nlink != 1
            or not _same_inode(actual, current)
            or actual.st_uid != identity.root_uid
            or actual.st_gid != identity.root_gid
            or stat.S_IMODE(actual.st_mode) != 0o600
            or actual.st_size > MAX_MUTEX_BYTES
        ):
            raise GuardError(
                "unsafe-mutation-mutex",
                MUTEX_PATH,
                "mutation mutex must be a private root-owned regular file",
            )
        os.fchown(fd, identity.root_uid, identity.root_gid)
        os.fchmod(fd, 0o600)
        os.fsync(parent_fd)
        return parent_fd, fd
    except Exception:
        if fd >= 0:
            os.close(fd)
        os.close(parent_fd)
        raise


def _mutex_owner_detail(fd: int) -> str:
    try:
        raw = _read_fd_bounded(fd, MAX_MUTEX_BYTES, MUTEX_PATH)
        owner = json.loads(raw.decode("utf-8")) if raw else {}
    except (GuardError, UnicodeDecodeError, json.JSONDecodeError):
        return "another guard process owns the mutation mutex"
    pid = owner.get("pid") if isinstance(owner, dict) else None
    action = owner.get("action") if isinstance(owner, dict) else None
    if isinstance(pid, int) and isinstance(action, str):
        return f"guard pid {pid} is still running action {action}"
    return "another guard process owns the mutation mutex"


def _acquire_mutation_mutex(
    action: Action, identity: Identity, *, exclusive: bool
) -> MutationMutex:
    parent_fd, fd = _open_mutex_file(identity)
    operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
    try:
        try:
            fcntl.flock(fd, operation | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise GuardError(
                "mutation-in-progress", MUTEX_PATH, _mutex_owner_detail(fd)
            ) from exc
        token = secrets.token_hex(32) if exclusive else ""
        if exclusive:
            owner = {
                "version": 1,
                "token": token,
                "action": action,
                "pid": os.getpid(),
                "pidStartTime": _process_start_time(os.getpid()),
            }
            payload = (
                json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n"
            ).encode("utf-8")
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, os.SEEK_SET)
            _write_all(fd, payload)
            os.fsync(fd)
        return MutationMutex(
            fd=fd,
            parent_fd=parent_fd,
            token=token,
            exclusive=exclusive,
        )
    except Exception:
        os.close(fd)
        os.close(parent_fd)
        raise


def _release_mutation_mutex(mutex: MutationMutex) -> None:
    try:
        if mutex.exclusive:
            raw = _read_fd_bounded(mutex.fd, MAX_MUTEX_BYTES, MUTEX_PATH)
            try:
                owner = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise GuardError(
                    "unsafe-mutation-mutex",
                    MUTEX_PATH,
                    "mutation mutex owner record is corrupt",
                ) from exc
            recorded = owner.get("token") if isinstance(owner, dict) else None
            if not isinstance(recorded, str) or not secrets.compare_digest(
                recorded, mutex.token
            ):
                raise GuardError(
                    "mutation-mutex-token-mismatch",
                    MUTEX_PATH,
                    "mutation mutex owner token changed before release",
                )
            os.ftruncate(mutex.fd, 0)
            os.fsync(mutex.fd)
        fcntl.flock(mutex.fd, fcntl.LOCK_UN)
    finally:
        mutex.close()


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
        raw = _read_proc_pid_file(proc_pid_fd, "cmdline", f"{PROC_ROOT}/1/cmdline")
    except (OSError, GuardError):
        return False
    finally:
        if proc_pid_fd >= 0:
            os.close(proc_pid_fd)
        if proc_root_fd >= 0:
            os.close(proc_root_fd)
    return _cmdline_is_nemoclaw_start(raw)


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
    except (OSError, GuardError):
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
    except (OSError, GuardError):
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
        # A readable inode proves whether the child shares the supervisor's PID
        # namespace. Landlock may hide one or both namespace links, so retain
        # stable equality as the fail-closed evidence available in that case.
        same_namespace_matches = (
            expected_namespace_inode is None
            and first_namespace_inode == second_namespace_inode
        ) or (
            expected_namespace_inode is not None
            and first_namespace_inode == expected_namespace_inode
            and second_namespace_inode == expected_namespace_inode
        )
        nested_namespace_matches = (
            first_namespace_inode == second_namespace_inode
            and (
                expected_namespace_inode is None
                or (
                    first_namespace_inode is not None
                    and first_namespace_inode != expected_namespace_inode
                )
            )
        )
        same_namespace_pid_matches = (
            first_status is not None
            and second_status is not None
            and first_status[1][-1] == numeric_pid
            and second_status[1][-1] == numeric_pid
        )
        nested_namespace_pid_matches = (
            first_status is not None
            and second_status is not None
            and first_status[1][-1] == 1
            and second_status[1][-1] == 1
        )
        # In a nested workload PID namespace, the direct child is kernel-owned
        # PID 1 there even though procfs names it by its outer numeric PID.
        # The remaining pinned start-time, UID, PPID, cmdline, and fd checks
        # apply identically to both supported topologies below.
        topology_matches = (
            same_namespace_matches and same_namespace_pid_matches
        ) or (nested_namespace_matches and nested_namespace_pid_matches)
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
            and first_cmdline == second_cmdline
            and _cmdline_is_nemoclaw_start(first_cmdline)
            and _cmdline_is_nemoclaw_start(second_cmdline)
            and topology_matches
            and pinned_before.st_dev == pinned_after.st_dev
            and pinned_before.st_ino == pinned_after.st_ino
        )
    except (OSError, GuardError, ValueError):
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


def _pid1_effective_uid() -> int | None:
    """Read PID 1's effective UID from a pinned procfs descriptor."""

    proc_root_fd = -1
    proc_pid_fd = -1
    try:
        proc_root_fd = _open_proc_root()
        proc_pid_fd = _open_proc_pid(proc_root_fd, 1)
        raw = _read_proc_pid_file(proc_pid_fd, "status", f"{PROC_ROOT}/1/status")
    except (OSError, GuardError):
        return None
    finally:
        if proc_pid_fd >= 0:
            os.close(proc_pid_fd)
        if proc_root_fd >= 0:
            os.close(proc_root_fd)
    for line in raw.splitlines():
        if not line.startswith(b"Uid:"):
            continue
        fields = line.removeprefix(b"Uid:").split()
        if len(fields) != 4:
            return None
        try:
            return int(fields[1], 10)
        except ValueError:
            return None
    return None


def _read_pid1_marker_identity(
    path: str, identity: Identity
) -> StartupIdentity | None:
    parent_fd = _open_private_state_dir(posixpath.dirname(path), identity, False)
    if parent_fd is None:
        return None
    fd = -1
    try:
        try:
            fd = os.open(
                posixpath.basename(path),
                _file_flags(),
                dir_fd=parent_fd,
            )
        except FileNotFoundError:
            return None
        before = os.fstat(fd)
        current = os.stat(
            posixpath.basename(path),
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or not _same_inode(before, current)
            or before.st_uid != identity.root_uid
            or before.st_gid != identity.root_gid
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_size > MAX_READY_BYTES
        ):
            return None
        raw = _read_fd_bounded(fd, MAX_READY_BYTES, path)
        after = os.fstat(fd)
        if not _stable_metadata(before, after):
            return None
        try:
            marker = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(marker, dict):
            return None
        version = marker.get("version")
        marker_pid = marker.get("pid")
        if (
            not isinstance(version, int)
            or isinstance(version, bool)
            or not isinstance(marker_pid, int)
            or isinstance(marker_pid, bool)
            or marker_pid != 1
            or not isinstance(marker.get("pidStartTime"), str)
        ):
            return None
        marker_start_time = marker["pidStartTime"]
        if version == 1:
            # Version 1 predates OpenShell's outer supervisor PID namespace.
            # Preserve it only when the helper still sees the entrypoint as its
            # own PID 1; accepting it after a namespace remap would authenticate
            # a starttime without the namespace identity needed for uniqueness.
            current_start_time = _process_start_time(1)
            namespace_inode = _process_namespace_inode(1)
            if (
                current_start_time is not None
                and namespace_inode is not None
                and _pid1_is_nemoclaw_start()
                and secrets.compare_digest(marker_start_time, current_start_time)
            ):
                return (1, marker_start_time, namespace_inode)
            return None
        namespace_inode = marker.get("pidNamespaceInode")
        if (
            version == 2
            and isinstance(namespace_inode, int)
            and not isinstance(namespace_inode, bool)
            and namespace_inode > 0
            and re.fullmatch(r"[0-9]+", marker_start_time)
        ):
            return (2, marker_start_time, namespace_inode)
        return None
    finally:
        if fd >= 0:
            os.close(fd)
        os.close(parent_fd)


def _startup_identity_is_live(
    startup_identity: StartupIdentity, identity: Identity
) -> bool:
    version, start_time, namespace_inode = startup_identity
    if version == 1:
        current_start_time = _process_start_time(1)
        return bool(
            current_start_time is not None
            and _process_namespace_inode(1) == namespace_inode
            and _pid1_is_nemoclaw_start()
            and secrets.compare_digest(start_time, current_start_time)
        )
    return _startup_process_identity_is_live(
        start_time, namespace_inode, identity.root_uid
    )


def _pid1_marker_matches(path: str, identity: Identity) -> bool:
    startup_identity = _read_pid1_marker_identity(path, identity)
    return bool(
        startup_identity is not None
        and _startup_identity_is_live(startup_identity, identity)
    )


def _startup_lease_state(identity: Identity) -> tuple[bool, bool]:
    capability_identity = _read_pid1_marker_identity(
        STARTUP_CAPABILITY_PATH, identity
    )
    ready_identity = _read_pid1_marker_identity(STARTUP_READY_PATH, identity)
    identities_match = bool(
        capability_identity is not None
        and ready_identity is not None
        and ready_identity == capability_identity
    )
    protocol_active = bool(
        capability_identity is not None
        and _startup_identity_is_live(capability_identity, identity)
    )
    capability_after = _read_pid1_marker_identity(
        STARTUP_CAPABILITY_PATH, identity
    )
    ready_after = _read_pid1_marker_identity(STARTUP_READY_PATH, identity)
    markers_stable = (
        capability_after == capability_identity and ready_after == ready_identity
    )
    protocol_active = protocol_active and markers_stable
    startup_ready = protocol_active and identities_match
    return protocol_active, startup_ready


def _startup_ready(identity: Identity) -> bool:
    return _startup_lease_state(identity)[1]


def _startup_protocol_active(identity: Identity) -> bool:
    return _pid1_marker_matches(STARTUP_CAPABILITY_PATH, identity)


def _startup_markers_absent(identity: Identity) -> bool:
    parent_fd = _open_private_state_dir(
        posixpath.dirname(STARTUP_READY_PATH), identity, False
    )
    if parent_fd is None:
        return True
    try:
        for path in (STARTUP_CAPABILITY_PATH, STARTUP_READY_PATH):
            try:
                os.stat(
                    posixpath.basename(path),
                    dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                continue
            return False
        return True
    finally:
        os.close(parent_fd)


def _write_pid1_marker(path: str, identity: Identity) -> None:
    start_time = _process_start_time(1)
    namespace_inode = _process_namespace_inode(1)
    if start_time is None or namespace_inode is None:
        raise GuardError(
            "startup-owner-unknown",
            path,
            "cannot identify PID 1 startup identity",
        )
    payload = (
        json.dumps(
            {
                "version": 2,
                "pid": 1,
                "pidStartTime": start_time,
                "pidNamespaceInode": namespace_inode,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")
    parent_fd = _open_private_state_dir(posixpath.dirname(path), identity, True)
    if parent_fd is None:
        raise GuardError(
            "startup-ready-failed",
            path,
            "startup readiness directory is missing",
        )
    name = posixpath.basename(path)
    temp = f".{name}.{secrets.token_hex(16)}.tmp"
    fd = -1
    try:
        fd = os.open(
            temp,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=parent_fd,
        )
        _write_all(fd, payload)
        os.fchown(fd, identity.root_uid, identity.root_gid)
        os.fchmod(fd, 0o600)
        os.fsync(fd)
        os.replace(temp, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temp = ""
        os.fsync(parent_fd)
    finally:
        if fd >= 0:
            os.close(fd)
        if temp:
            try:
                os.unlink(temp, dir_fd=parent_fd)
            except FileNotFoundError:
                # The atomic rename or an earlier cleanup already consumed it.
                pass
        os.close(parent_fd)


def _write_startup_ready(identity: Identity) -> None:
    if not _startup_protocol_active(identity):
        raise GuardError(
            "startup-capability-missing",
            STARTUP_CAPABILITY_PATH,
            "revoke-startup-ready must begin the PID 1 startup transaction",
        )
    _write_pid1_marker(STARTUP_READY_PATH, identity)


def _revoke_startup_ready(identity: Identity) -> None:
    # Publishing the capability sentinel opts this PID 1 instance into the
    # readiness protocol before the ready marker is removed. Old images with
    # the same nemoclaw-start cmdline never create it and retain compatibility.
    _write_pid1_marker(STARTUP_CAPABILITY_PATH, identity)
    parent_fd = _open_private_state_dir(
        posixpath.dirname(STARTUP_READY_PATH), identity, True
    )
    if parent_fd is None:
        return
    try:
        try:
            os.unlink(posixpath.basename(STARTUP_READY_PATH), dir_fd=parent_fd)
        except FileNotFoundError:
            return
        except IsADirectoryError as exc:
            raise GuardError(
                "unsafe-startup-ready",
                STARTUP_READY_PATH,
                "startup readiness path is an unexpected directory",
            ) from exc
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def _validate_action_readiness(
    action: Action, startup_owner: bool, identity: Identity
) -> None:
    startup_action = action in {"revoke-startup-ready", "publish-startup-ready"}
    if startup_action:
        if not _pid1_is_nemoclaw_start() or not startup_owner or os.getppid() != 1:
            raise GuardError(
                "startup-owner-required",
                STARTUP_READY_PATH,
                f"{action} is restricted to the PID 1 startup transaction",
            )
        return
    installed_current = os.path.realpath(__file__) == os.path.realpath(
        INSTALLED_HELPER_PATH
    )
    pid1_is_nemoclaw_start = _pid1_is_nemoclaw_start()
    if not pid1_is_nemoclaw_start and not installed_current:
        # A source helper injected into an older image, and the local unit
        # harness, retain their explicit compatibility path. Current images
        # use the installed helper and authenticate a namespace remap below.
        return
    protocol_active, startup_ready = _startup_lease_state(identity)
    if not pid1_is_nemoclaw_start and not protocol_active:
        if (
            installed_current
            and _startup_markers_absent(identity)
            and _openshell_supervised_nonroot_start_is_live(
                identity.root_uid, identity.sandbox_uid
            )
        ):
            # OpenShell is the container PID 1 and launches the configured
            # image command as one non-root child, either in the supervisor's
            # PID namespace or as PID 1 in a nested workload PID namespace.
            # When Landlock hides namespace inode links, the stable direct-child
            # and NSpid evidence selects the same two topologies. They cannot
            # publish root-owned readiness markers, so authenticate the stable
            # supervisor/child pair while refusing stale or malformed markers.
            return
        if installed_current:
            raise GuardError(
                "startup-not-ready",
                STARTUP_READY_PATH,
                "installed config guard requires NemoClaw PID 1",
            )
        return
    # Source injected into an older image retains compatibility until that
    # image explicitly opts in. The trusted installed helper requires the
    # protocol from its very first exec, closing the pre-revoke boot race.
    if not installed_current and not protocol_active:
        return
    if installed_current and not protocol_active:
        # The supported --user sandbox entrypoint cannot create a root-owned
        # readiness capability. It also explicitly disables gateway privilege
        # separation and privileged PID 1 control. Preserve host shields/config
        # compatibility only for that degraded mode. Root PID 1 never falls
        # through when the capability is missing or malformed, and any valid
        # capability opts even a non-root PID 1 into the strict lease below.
        pid1_euid = _pid1_effective_uid()
        if pid1_euid is not None and pid1_euid != identity.root_uid:
            return
    early_recover = action == "recover" and not startup_ready
    if early_recover:
        if not startup_owner or os.getppid() != 1:
            raise GuardError(
                "startup-owner-required",
                STARTUP_READY_PATH,
                f"{action} is restricted to the PID 1 startup transaction",
            )
        return
    if action in {
        "lock",
        "unlock",
        "write-config",
        "seal-restart",
        "unseal-restart",
    } and not startup_ready:
        raise GuardError(
            "startup-not-ready",
            STARTUP_READY_PATH,
            "OpenClaw startup is not ready for host config mutations",
        )


def _write_secondary_journal(record: dict[str, object], identity: Identity) -> None:
    payload = json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_JOURNAL_BYTES:
        raise GuardError(
            "journal-too-large", JOURNAL_PATH, "transaction journal is too large"
        )
    journal_fd = _open_journal_dir(identity, True)
    if journal_fd is None:
        raise GuardError(
            "journal-write-failed", JOURNAL_PATH, "journal directory is missing"
        )
    journal_name = posixpath.basename(JOURNAL_PATH)
    temp_name = f".{journal_name}.{secrets.token_hex(16)}.tmp"
    fd = -1
    try:
        fd = os.open(
            temp_name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=journal_fd,
        )
        _write_all(fd, payload)
        os.fchown(fd, identity.root_uid, identity.root_gid)
        os.fchmod(fd, 0o600)
        os.fsync(fd)
        os.replace(
            temp_name, journal_name, src_dir_fd=journal_fd, dst_dir_fd=journal_fd
        )
        temp_name = ""
        os.fsync(journal_fd)
    finally:
        if fd >= 0:
            os.close(fd)
        if temp_name:
            try:
                os.unlink(temp_name, dir_fd=journal_fd)
            except FileNotFoundError:
                # The atomic rename or an earlier cleanup already consumed it.
                pass
        os.close(journal_fd)


def _read_secondary_journal(identity: Identity) -> dict[str, object] | None:
    journal_fd = _open_journal_dir(identity, False)
    if journal_fd is None:
        return None
    journal_name = posixpath.basename(JOURNAL_PATH)
    fd = -1
    try:
        try:
            fd = os.open(journal_name, _file_flags(), dir_fd=journal_fd)
        except FileNotFoundError:
            return None
        before = os.fstat(fd)
        current = os.stat(journal_name, dir_fd=journal_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or not _same_inode(before, current)
            or before.st_uid != identity.root_uid
            or before.st_gid != identity.root_gid
            or stat.S_IMODE(before.st_mode) & 0o077
            or before.st_size > MAX_JOURNAL_BYTES
        ):
            raise GuardError(
                "unsafe-journal", JOURNAL_PATH, "journal metadata is not trusted"
            )
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, COPY_BUFFER_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_JOURNAL_BYTES:
                raise GuardError(
                    "journal-too-large", JOURNAL_PATH, "journal exceeds size cap"
                )
            chunks.append(chunk)
        after = os.fstat(fd)
        if not _stable_metadata(before, after):
            raise GuardError(
                "entry-raced", JOURNAL_PATH, "journal changed while reading"
            )
        try:
            value = json.loads(b"".join(chunks).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GuardError(
                "invalid-journal", JOURNAL_PATH, "journal JSON is invalid"
            ) from exc
        if not isinstance(value, dict):
            raise GuardError(
                "invalid-journal", JOURNAL_PATH, "journal is not an object"
            )
        return value
    finally:
        if fd >= 0:
            os.close(fd)
        os.close(journal_fd)


def _clear_secondary_journal(identity: Identity) -> None:
    journal_fd = _open_journal_dir(identity, False)
    if journal_fd is None:
        return
    try:
        try:
            os.unlink(posixpath.basename(JOURNAL_PATH), dir_fd=journal_fd)
        except FileNotFoundError:
            return
        os.fsync(journal_fd)
    finally:
        os.close(journal_fd)


def _open_config(config_path: str) -> OpenConfig:
    normalized = posixpath.normpath(config_path)
    parent_path = posixpath.dirname(normalized)
    config_name = posixpath.basename(normalized)
    if config_name != ".openclaw" or not parent_path:
        raise GuardError(
            "invalid-config-path",
            config_path,
            "config directory must be an absolute path ending in .openclaw",
        )
    parent_fd = _open_absolute_dir(parent_path)
    try:
        parent_stat = os.fstat(parent_fd)
        before = os.stat(config_name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(before.st_mode):
            raise GuardError(
                "unsafe-config-entry",
                normalized,
                f"config entry is a {_kind(before)}, expected directory",
            )
        config_fd = os.open(config_name, _directory_flags(), dir_fd=parent_fd)
        config_stat = os.fstat(config_fd)
        after = os.stat(config_name, dir_fd=parent_fd, follow_symlinks=False)
        if not _same_inode(before, config_stat) or not _same_inode(config_stat, after):
            os.close(config_fd)
            raise GuardError(
                "entry-raced", normalized, "config directory changed while opening"
            )
        if config_stat.st_dev != parent_stat.st_dev:
            os.close(config_fd)
            raise GuardError(
                "cross-device-entry",
                normalized,
                "config directory is on another filesystem",
            )
        return OpenConfig(
            config_path=normalized,
            parent_path=parent_path,
            config_name=config_name,
            parent_fd=parent_fd,
            config_fd=config_fd,
            parent_stat=parent_stat,
            config_stat=config_stat,
        )
    except Exception:
        os.close(parent_fd)
        raise


def _open_config_for_lock(config_path: str, identity: Identity) -> OpenConfig:
    """Pin /sandbox before resolving an attacker-controlled .openclaw name."""

    normalized = posixpath.normpath(config_path)
    parent_path = posixpath.dirname(normalized)
    config_name = posixpath.basename(normalized)
    if config_name != ".openclaw" or not parent_path:
        raise GuardError(
            "invalid-config-path",
            config_path,
            "config directory must be an absolute path ending in .openclaw",
        )
    parent_fd = _open_absolute_dir(parent_path)
    created = False
    try:
        original_parent = os.fstat(parent_fd)
        try:
            before = os.stat(config_name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            before = None
        already_protected = bool(
            original_parent.st_uid == identity.root_uid
            and original_parent.st_gid == identity.sandbox_gid
            and stat.S_IMODE(original_parent.st_mode) == 0o1775
            and before is not None
            and stat.S_ISDIR(before.st_mode)
            and before.st_uid == identity.root_uid
            and before.st_gid == identity.root_gid
            and stat.S_IMODE(before.st_mode) in {0o500, 0o755}
        )
        if (
            before is not None
            and stat.S_ISDIR(before.st_mode)
            and before.st_dev != original_parent.st_dev
        ):
            if not already_protected:
                os.fchown(parent_fd, identity.root_uid, identity.sandbox_gid)
                os.fchmod(parent_fd, 0o755)
                os.fsync(parent_fd)
            raise GuardError(
                "cross-device-entry",
                normalized,
                "refusing to mutate a cross-device .openclaw mount",
            )
        # This root-ownership transition is the fail-closed outer namespace
        # boundary. No later error returns /sandbox rename authority.
        if not already_protected:
            os.fchown(parent_fd, identity.root_uid, identity.sandbox_gid)
            os.fchmod(parent_fd, 0o755)
            os.fsync(parent_fd)
        try:
            before = os.stat(config_name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            before = None
        if (
            before is not None
            and stat.S_ISDIR(before.st_mode)
            and before.st_dev != original_parent.st_dev
        ):
            raise GuardError(
                "cross-device-entry",
                normalized,
                "refusing to mutate a cross-device .openclaw mount",
            )
        if before is not None and not stat.S_ISDIR(before.st_mode):
            os.rename(
                config_name,
                f".nemoclaw-rejected-openclaw-{secrets.token_hex(16)}",
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
            )
            os.fsync(parent_fd)
            before = None
        if before is None:
            os.mkdir(config_name, 0o700, dir_fd=parent_fd)
            os.fsync(parent_fd)
            before = os.stat(config_name, dir_fd=parent_fd, follow_symlinks=False)
            created = True
        config_fd = os.open(config_name, _directory_flags(), dir_fd=parent_fd)
        config_stat = os.fstat(config_fd)
        current = os.stat(config_name, dir_fd=parent_fd, follow_symlinks=False)
        if not _same_inode(before, config_stat) or not _same_inode(
            config_stat, current
        ):
            os.close(config_fd)
            raise GuardError(
                "entry-raced", normalized, "config directory changed while locking"
            )
        opened = OpenConfig(
            config_path=normalized,
            parent_path=parent_path,
            config_name=config_name,
            parent_fd=parent_fd,
            config_fd=config_fd,
            parent_stat=original_parent,
            config_stat=config_stat,
        )
        if created:
            placeholder = b"{}\n"
            digest = hashlib.sha256(placeholder).hexdigest()
            _force_replace_bytes(opened, "openclaw.json", placeholder, identity)
            _force_replace_bytes(
                opened,
                ".config-hash",
                f"{digest}  openclaw.json\n".encode("ascii"),
                identity,
            )
            _commit_locked_dirs(opened, identity)
        return opened
    except Exception:
        os.close(parent_fd)
        raise


def _journal_payload(record: dict[str, object]) -> bytes:
    payload = json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_JOURNAL_BYTES:
        raise GuardError(
            "journal-too-large", JOURNAL_PATH, "transaction journal is too large"
        )
    return payload


def _write_persistent_journal(
    opened: OpenConfig, record: dict[str, object], identity: Identity
) -> None:
    payload = _journal_payload(record)
    temp_name = f".{PERSISTENT_JOURNAL_NAME}.{secrets.token_hex(16)}.tmp"
    fd = -1
    try:
        fd = os.open(
            temp_name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=opened.config_fd,
        )
        _write_all(fd, payload)
        os.fchown(fd, identity.root_uid, identity.root_gid)
        os.fchmod(fd, 0o600)
        os.fsync(fd)
        try:
            existing = os.stat(
                PERSISTENT_JOURNAL_NAME,
                dir_fd=opened.config_fd,
                follow_symlinks=False,
            )
            if stat.S_ISDIR(existing.st_mode):
                _quarantine_untrusted_persistent_journal(opened, identity)
        except FileNotFoundError:
            # No planted persistent journal exists to quarantine before replace.
            pass
        os.replace(
            temp_name,
            PERSISTENT_JOURNAL_NAME,
            src_dir_fd=opened.config_fd,
            dst_dir_fd=opened.config_fd,
        )
        temp_name = ""
        os.fsync(opened.config_fd)
    finally:
        if fd >= 0:
            os.close(fd)
        if temp_name:
            try:
                os.unlink(temp_name, dir_fd=opened.config_fd)
            except FileNotFoundError:
                # The atomic rename or an earlier cleanup already consumed it.
                pass


def _read_persistent_journal(
    opened: OpenConfig, identity: Identity
) -> dict[str, object] | None:
    display = posixpath.join(opened.config_path, PERSISTENT_JOURNAL_NAME)
    fd = -1
    try:
        try:
            before = os.stat(
                PERSISTENT_JOURNAL_NAME,
                dir_fd=opened.config_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return None
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_uid != identity.root_uid
            or before.st_gid != identity.root_gid
            or stat.S_IMODE(before.st_mode) & 0o077
            or before.st_size > MAX_JOURNAL_BYTES
        ):
            raise GuardError(
                "unsafe-journal",
                display,
                "persistent journal metadata is not trusted",
            )
        fd = os.open(PERSISTENT_JOURNAL_NAME, _file_flags(), dir_fd=opened.config_fd)
        actual = os.fstat(fd)
        if not _same_inode(before, actual):
            raise GuardError(
                "entry-raced",
                display,
                "persistent journal changed while opening",
            )
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, COPY_BUFFER_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_JOURNAL_BYTES:
                raise GuardError(
                    "journal-too-large",
                    display,
                    "persistent journal exceeds size cap",
                )
            chunks.append(chunk)
        after = os.fstat(fd)
        if not _stable_metadata(before, after):
            raise GuardError(
                "entry-raced", display, "persistent journal changed while reading"
            )
        try:
            value = json.loads(b"".join(chunks).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GuardError(
                "invalid-journal", display, "persistent journal JSON is invalid"
            ) from exc
        if not isinstance(value, dict):
            raise GuardError(
                "invalid-journal", display, "persistent journal is not an object"
            )
        return value
    finally:
        if fd >= 0:
            os.close(fd)


def _write_journal(
    record: dict[str, object], identity: Identity, opened: OpenConfig | None = None
) -> None:
    _write_secondary_journal(record, identity)
    if opened is not None:
        _write_persistent_journal(opened, record, identity)


def _read_journal(
    identity: Identity, opened: OpenConfig | None = None
) -> dict[str, object] | None:
    secondary = _read_secondary_journal(identity)
    if opened is not None:
        try:
            persistent = _read_persistent_journal(opened, identity)
        except GuardError:
            if secondary is not None and (
                _is_mutable_dir_posture(opened, identity)
                or _is_partial_frozen_mutable_posture(opened, identity)
            ):
                return secondary
            raise
        if persistent is not None:
            if _is_mutable_dir_posture(
                opened, identity
            ) or _is_partial_frozen_mutable_posture(opened, identity):
                display = posixpath.join(opened.config_path, PERSISTENT_JOURNAL_NAME)
                if secondary is None:
                    raise GuardError(
                        "persistent-journal-without-secondary",
                        display,
                        "persistent journal is replayable after mutable handoff",
                    )
                if _journal_payload(persistent) != _journal_payload(secondary):
                    # The sandbox can replay a retained persistent inode after
                    # handoff; private rootfs state wins in mutable posture.
                    return secondary
            return persistent
    return secondary


def _clear_persistent_journal(opened: OpenConfig) -> None:
    try:
        current = os.stat(
            PERSISTENT_JOURNAL_NAME,
            dir_fd=opened.config_fd,
            follow_symlinks=False,
        )
        if stat.S_ISDIR(current.st_mode):
            os.rename(
                PERSISTENT_JOURNAL_NAME,
                f".nemoclaw-untrusted-journal-{secrets.token_hex(16)}",
                src_dir_fd=opened.config_fd,
                dst_dir_fd=opened.config_fd,
            )
        else:
            os.unlink(PERSISTENT_JOURNAL_NAME, dir_fd=opened.config_fd)
        os.fsync(opened.config_fd)
    except FileNotFoundError:
        # Clearing an already-absent journal is intentionally idempotent.
        pass


def _clear_journal(identity: Identity, opened: OpenConfig | None = None) -> None:
    if opened is not None:
        _clear_persistent_journal(opened)
    _clear_secondary_journal(identity)


def _commit_mutable_and_retire_journal(opened: OpenConfig, identity: Identity) -> None:
    # The persistent record must disappear while config is still root-owned;
    # otherwise sandbox can retain and replay its inode after handoff. The
    # private rootfs record remains authoritative until handoff completes.
    _clear_persistent_journal(opened)
    _commit_mutable_dirs(opened, identity)
    try:
        _clear_secondary_journal(identity)
    except (OSError, GuardError):
        # Visible mutable handoff is already durable; recovery can retire the
        # root-only secondary record idempotently on the next invocation.
        pass


def _quarantine_untrusted_persistent_journal(
    opened: OpenConfig, identity: Identity
) -> None:
    """Remove a sandbox-planted reserved entry only after the tree is frozen."""

    try:
        current = os.stat(
            PERSISTENT_JOURNAL_NAME,
            dir_fd=opened.config_fd,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        return
    sandbox_owned = (
        current.st_uid == identity.sandbox_uid
        and current.st_gid == identity.sandbox_gid
    )
    root_owned = (
        current.st_uid == identity.root_uid and current.st_gid == identity.root_gid
    )
    if not sandbox_owned and not root_owned:
        raise GuardError(
            "unsafe-journal",
            posixpath.join(opened.config_path, PERSISTENT_JOURNAL_NAME),
            "refusing to quarantine a reserved entry not owned by sandbox",
        )
    quarantine = f".nemoclaw-untrusted-journal-{secrets.token_hex(16)}"
    if stat.S_ISDIR(current.st_mode):
        fd = os.open(
            PERSISTENT_JOURNAL_NAME, _directory_flags(), dir_fd=opened.config_fd
        )
        try:
            actual = os.fstat(fd)
            if not _same_inode(current, actual):
                raise GuardError(
                    "entry-raced",
                    posixpath.join(opened.config_path, PERSISTENT_JOURNAL_NAME),
                    "reserved journal directory changed before quarantine",
                )
        finally:
            os.close(fd)
        os.rename(
            PERSISTENT_JOURNAL_NAME,
            quarantine,
            src_dir_fd=opened.config_fd,
            dst_dir_fd=opened.config_fd,
        )
    else:
        os.rename(
            PERSISTENT_JOURNAL_NAME,
            quarantine,
            src_dir_fd=opened.config_fd,
            dst_dir_fd=opened.config_fd,
        )
        os.unlink(quarantine, dir_fd=opened.config_fd)
    os.fsync(opened.config_fd)


def _mutable_reserved_entry_is_nonauthoritative(
    opened: OpenConfig, identity: Identity
) -> bool:
    if not _is_mutable_dir_posture(opened, identity):
        return False
    current_pair = _snapshot_raw_pair(opened)
    _verify_mutable_files(opened, current_pair, identity)
    try:
        entry = os.stat(
            PERSISTENT_JOURNAL_NAME,
            dir_fd=opened.config_fd,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        return False
    sandbox_owned = (
        entry.st_uid == identity.sandbox_uid and entry.st_gid == identity.sandbox_gid
    )
    retained_root_directory = stat.S_ISDIR(entry.st_mode) and (
        entry.st_uid == identity.root_uid and entry.st_gid == identity.root_gid
    )
    return sandbox_owned or retained_root_directory


def _assert_config_binding(opened: OpenConfig) -> None:
    current = os.stat(
        opened.config_name, dir_fd=opened.parent_fd, follow_symlinks=False
    )
    actual = os.fstat(opened.config_fd)
    if not stat.S_ISDIR(current.st_mode) or not _same_inode(current, actual):
        raise GuardError(
            "entry-raced", opened.config_path, "config directory binding changed"
        )


def _open_checked_file(opened: OpenConfig, name: str) -> tuple[int, os.stat_result]:
    display = posixpath.join(opened.config_path, name)
    try:
        before = os.stat(name, dir_fd=opened.config_fd, follow_symlinks=False)
    except OSError as exc:
        raise GuardError("stat-failed", display, f"stat failed: {exc}") from exc
    if not stat.S_ISREG(before.st_mode):
        raise GuardError(
            "unsafe-config-file",
            display,
            f"entry is a {_kind(before)}, expected regular file",
        )
    if before.st_nlink != 1:
        raise GuardError(
            "hardlinked-config-file",
            display,
            f"link count is {before.st_nlink}, expected 1",
        )
    max_bytes = MAX_FILE_BYTES[name]
    if before.st_size > max_bytes:
        raise GuardError(
            "config-file-too-large",
            display,
            f"file is {before.st_size} bytes, maximum is {max_bytes}",
        )
    if before.st_dev != opened.config_stat.st_dev:
        raise GuardError(
            "cross-device-entry", display, "config file is on another filesystem"
        )
    try:
        fd = os.open(name, _file_flags(), dir_fd=opened.config_fd)
    except OSError as exc:
        raise GuardError("open-failed", display, f"open failed: {exc}") from exc
    actual = os.fstat(fd)
    after = os.stat(name, dir_fd=opened.config_fd, follow_symlinks=False)
    if (
        not stat.S_ISREG(actual.st_mode)
        or actual.st_nlink != 1
        or not _same_inode(before, actual)
        or not _same_inode(actual, after)
        or not _stable_metadata(before, actual)
        or not _stable_metadata(actual, after)
    ):
        os.close(fd)
        raise GuardError(
            "entry-raced", display, "config file changed while it was being opened"
        )
    return fd, actual


def _read_xattrs(fd: int) -> tuple[tuple[str, bytes], ...]:
    listxattr = getattr(os, "listxattr", None)
    getxattr = getattr(os, "getxattr", None)
    if listxattr is None or getxattr is None:
        return ()
    try:
        return tuple((name, getxattr(fd, name)) for name in sorted(listxattr(fd)))
    except OSError as exc:
        if exc.errno in {errno.ENOTSUP, errno.ENOSYS}:
            return ()
        raise


def _get_inode_flags(fd: int) -> int | None:
    if not sys.platform.startswith("linux"):
        return None
    buffer = bytearray(struct.pack("I", 0))
    try:
        fcntl.ioctl(fd, FS_IOC_GETFLAGS, buffer, True)
    except OSError as exc:
        if exc.errno in {errno.ENOTTY, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EINVAL}:
            return None
        raise
    return struct.unpack("I", buffer)[0]


def _set_inode_flags(fd: int, flags: int | None) -> None:
    if flags is not None and sys.platform.startswith("linux"):
        fcntl.ioctl(fd, FS_IOC_SETFLAGS, struct.pack("I", flags))


def _snapshot_file(opened: OpenConfig, name: str) -> FileSnapshot:
    display = posixpath.join(opened.config_path, name)
    max_bytes = MAX_FILE_BYTES[name]
    for _attempt in range(STABLE_READ_ATTEMPTS):
        fd, before = _open_checked_file(opened, name)
        try:
            if before.st_size > max_bytes:
                raise GuardError(
                    "config-file-too-large",
                    display,
                    f"file is {before.st_size} bytes, maximum is {max_bytes}",
                )
            chunks: list[bytes] = []
            bytes_read = 0
            while True:
                chunk = os.read(fd, COPY_BUFFER_BYTES)
                if not chunk:
                    break
                bytes_read += len(chunk)
                if bytes_read > max_bytes:
                    raise GuardError(
                        "config-file-too-large",
                        display,
                        f"file grew beyond the {max_bytes}-byte maximum while reading",
                    )
                chunks.append(chunk)
            xattrs = _read_xattrs(fd)
            inode_flags = _get_inode_flags(fd)
            after = os.fstat(fd)
            current = os.stat(name, dir_fd=opened.config_fd, follow_symlinks=False)
            if _stable_metadata(before, after) and _same_inode(after, current):
                data = b"".join(chunks)
                if len(data) != before.st_size:
                    continue
                return FileSnapshot(
                    name=name,
                    dev=before.st_dev,
                    ino=before.st_ino,
                    uid=before.st_uid,
                    gid=before.st_gid,
                    mode=stat.S_IMODE(before.st_mode),
                    atime_ns=before.st_atime_ns,
                    mtime_ns=before.st_mtime_ns,
                    ctime_ns=before.st_ctime_ns,
                    size=before.st_size,
                    data=data,
                    xattrs=xattrs,
                    inode_flags=inode_flags,
                )
        finally:
            os.close(fd)
    raise GuardError(
        "unstable-config-file",
        display,
        f"file did not remain stable across {STABLE_READ_ATTEMPTS} reads",
    )


def _snapshot_is_current(opened: OpenConfig, snapshot: FileSnapshot) -> bool:
    try:
        current = os.stat(snapshot.name, dir_fd=opened.config_fd, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISREG(current.st_mode)
        and current.st_nlink == 1
        and current.st_dev == snapshot.dev
        and current.st_ino == snapshot.ino
        and current.st_size == snapshot.size
        and current.st_mtime_ns == snapshot.mtime_ns
        and current.st_ctime_ns == snapshot.ctime_ns
    )


def _validate_hash_record(
    opened: OpenConfig, config: FileSnapshot, hash_file: FileSnapshot
) -> None:
    display = posixpath.join(opened.config_path, hash_file.name)
    try:
        record = hash_file.data.decode("ascii")
    except UnicodeDecodeError as exc:
        raise GuardError(
            "invalid-config-hash", display, "hash record must be ASCII"
        ) from exc
    match = SHA256_RECORD.fullmatch(record)
    if not match:
        raise GuardError(
            "invalid-config-hash",
            display,
            "expected one canonical sha256sum record",
        )
    digest, _marker, recorded_path = match.groups()
    allowed_paths = {
        "openclaw.json",
        posixpath.join(opened.config_path, "openclaw.json"),
    }
    if recorded_path not in allowed_paths:
        raise GuardError(
            "invalid-config-hash-path",
            display,
            f"hash record path {recorded_path!r} is not an allowed OpenClaw config path",
        )
    actual = hashlib.sha256(config.data).hexdigest()
    if not secrets.compare_digest(digest.lower(), actual):
        raise GuardError(
            "config-hash-mismatch",
            display,
            "hash record does not match the captured openclaw.json bytes",
        )


def _snapshot_pair(opened: OpenConfig) -> tuple[FileSnapshot, FileSnapshot]:
    last_error: GuardError | None = None
    for _attempt in range(STABLE_READ_ATTEMPTS):
        try:
            config = _snapshot_file(opened, "openclaw.json")
            hash_file = _snapshot_file(opened, ".config-hash")
            if not _snapshot_is_current(opened, config) or not _snapshot_is_current(
                opened, hash_file
            ):
                raise GuardError(
                    "config-pair-raced",
                    opened.config_path,
                    "OpenClaw config/hash pair changed while it was captured",
                )
            _validate_hash_record(opened, config, hash_file)
            return config, hash_file
        except GuardError as exc:
            last_error = exc
    if last_error is not None:
        raise GuardError(
            last_error.code,
            last_error.path,
            f"{last_error.detail} after {STABLE_READ_ATTEMPTS} pair attempts",
        ) from last_error
    raise GuardError("config-pair-raced", opened.config_path, "pair capture failed")


def _snapshot_raw_pair(opened: OpenConfig) -> tuple[FileSnapshot, FileSnapshot]:
    last_error: GuardError | None = None
    for _attempt in range(STABLE_READ_ATTEMPTS):
        try:
            config = _snapshot_file(opened, "openclaw.json")
            hash_file = _snapshot_file(opened, ".config-hash")
            if not _snapshot_is_current(opened, config) or not _snapshot_is_current(
                opened, hash_file
            ):
                raise GuardError(
                    "config-pair-raced",
                    opened.config_path,
                    "OpenClaw config/hash pair changed while it was captured",
                )
            return config, hash_file
        except GuardError as exc:
            last_error = exc
    if last_error is not None:
        raise GuardError(
            last_error.code,
            last_error.path,
            f"{last_error.detail} after {STABLE_READ_ATTEMPTS} pair attempts",
        ) from last_error
    raise GuardError("config-pair-raced", opened.config_path, "pair capture failed")


def _validate_config_json(data: bytes, source: str) -> None:
    if not data:
        raise GuardError("invalid-config-json", source, "config is empty")
    try:
        decoded = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise GuardError("invalid-config-json", source, "config must be UTF-8") from exc

    def reject_constant(value: str) -> None:
        raise ValueError(f"non-standard JSON constant {value}")

    try:
        parsed = json.loads(decoded, parse_constant=reject_constant)
    except (json.JSONDecodeError, ValueError) as exc:
        raise GuardError(
            "invalid-config-json",
            source,
            "config must be strict JSON (JSON5 comments and trailing commas are unsupported)",
        ) from exc
    if not isinstance(parsed, dict):
        raise GuardError("invalid-config-json", source, "config must be a JSON object")


def _validate_runtime_config_json5(
    data: bytes, source: str, identity: Identity
) -> None:
    """Validate captured runtime bytes with the packaged root-owned JSON5 parser."""

    if not data:
        raise GuardError("invalid-config-json5", source, "config is empty")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise GuardError(
            "invalid-config-json5", source, "config must be UTF-8"
        ) from exc

    node_fd = -1
    parser_fd = -1
    try:
        node_fd = os.open(NODE_BINARY_PATH, _file_flags())
        node_st = os.fstat(node_fd)
        if (
            not stat.S_ISREG(node_st.st_mode)
            or node_st.st_uid != identity.root_uid
            or stat.S_IMODE(node_st.st_mode) & 0o022
        ):
            raise GuardError(
                "unsafe-json5-validator",
                NODE_BINARY_PATH,
                "Node validator must be a root-owned non-writable regular file",
            )
        parser_fd = _open_absolute_dir(JSON5_MODULE_PATH)
        parser_st = os.fstat(parser_fd)
        if (
            parser_st.st_uid != identity.root_uid
            or stat.S_IMODE(parser_st.st_mode) & 0o022
        ):
            raise GuardError(
                "unsafe-json5-validator",
                JSON5_MODULE_PATH,
                "JSON5 parser directory must be root-owned and not group/world-writable",
            )
    except FileNotFoundError as exc:
        raise GuardError(
            "json5-validator-missing",
            JSON5_MODULE_PATH,
            "fixed packaged JSON5 validator is unavailable",
        ) from exc
    finally:
        if node_fd >= 0:
            os.close(node_fd)
        if parser_fd >= 0:
            os.close(parser_fd)

    program = (
        "const fs=require('fs');"
        f"const JSON5=require({json.dumps(JSON5_MODULE_PATH)});"
        "const value=JSON5.parse(fs.readFileSync(0,'utf8'));"
        "if (!value || typeof value!=='object' || Array.isArray(value)) process.exit(4);"
    )
    try:
        result = subprocess.run(
            [NODE_BINARY_PATH, "--input-type=commonjs", "-e", program],
            input=data,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd="/",
            env={
                "PATH": "/usr/bin:/bin",
                "NODE_OPTIONS": "",
                "NODE_PATH": "",
            },
            close_fds=True,
            timeout=JSON5_VALIDATION_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GuardError(
            "json5-validator-failed", source, "fixed JSON5 validator failed to run"
        ) from exc
    if result.returncode != 0:
        raise GuardError(
            "invalid-config-json5", source, "config must be a JSON5 object"
        )


def _read_replacement_config() -> bytes:
    maximum = MAX_FILE_BYTES["openclaw.json"]
    data = sys.stdin.buffer.read(maximum + 1)
    if len(data) > maximum:
        raise GuardError(
            "config-file-too-large",
            "stdin",
            f"replacement config exceeds the {maximum}-byte maximum",
        )
    _validate_config_json(data, "stdin")
    return data


def _verify_mutable_files(
    opened: OpenConfig,
    snapshots: tuple[FileSnapshot, FileSnapshot],
    identity: Identity,
    *,
    allow_blocking_flags: bool = False,
) -> None:
    for snapshot in snapshots:
        if (
            snapshot.uid != identity.sandbox_uid
            or snapshot.gid != identity.sandbox_gid
            or snapshot.mode != 0o660
            or (
                not allow_blocking_flags
                and snapshot.inode_flags is not None
                and snapshot.inode_flags & (FS_IMMUTABLE_FL | FS_APPEND_FL)
            )
        ):
            raise GuardError(
                "config-not-mutable",
                posixpath.join(opened.config_path, snapshot.name),
                "write-config requires sandbox:sandbox 0660 without immutable/append flags",
            )


def _verify_mutable_posture(
    opened: OpenConfig, snapshots: tuple[FileSnapshot, FileSnapshot], identity: Identity
) -> None:
    try:
        _verify_dir_posture(
            opened.parent_fd,
            opened.parent_path,
            identity.sandbox_uid,
            identity.sandbox_gid,
            0o755,
        )
        _verify_dir_posture(
            opened.config_fd,
            opened.config_path,
            identity.sandbox_uid,
            identity.sandbox_gid,
            0o2770,
        )
    except GuardError as exc:
        raise GuardError(
            "config-not-mutable",
            exc.path,
            "write-config requires mutable sandbox-owned parent and config directories",
        ) from exc
    _verify_mutable_files(opened, snapshots, identity)


def _verify_expected_config(
    opened: OpenConfig, config: FileSnapshot, expected_sha256: str
) -> None:
    actual = hashlib.sha256(config.data).hexdigest()
    if not secrets.compare_digest(actual, expected_sha256.lower()):
        raise GuardError(
            "config-cas-mismatch",
            posixpath.join(opened.config_path, config.name),
            f"current config SHA-256 is {actual}, not the expected digest",
        )


def _replacement_records(
    originals: tuple[FileSnapshot, FileSnapshot],
    replacement_config: bytes,
    identity: Identity,
    commit_time_ns: int,
) -> tuple[list[dict[str, object]], str]:
    new_digest = hashlib.sha256(replacement_config).hexdigest()
    replacement_by_name = {
        "openclaw.json": replacement_config,
        ".config-hash": f"{new_digest}  openclaw.json\n".encode("ascii"),
    }
    records: list[dict[str, object]] = []
    for snapshot in originals:
        desired_inode_flags = (
            None
            if snapshot.inode_flags is None
            else snapshot.inode_flags & ~(FS_IMMUTABLE_FL | FS_APPEND_FL)
        )
        records.append(
            _stored_file(
                snapshot,
                data=replacement_by_name[snapshot.name],
                uid=identity.sandbox_uid,
                gid=identity.sandbox_gid,
                mode=0o660,
                mtime_ns=commit_time_ns,
                inode_flags=desired_inode_flags,
            )
        )
    return records, new_digest


def _canonical_targets(
    source: tuple[FileSnapshot, FileSnapshot],
    identity: Identity,
    *,
    locked: bool,
) -> tuple[tuple[FileSnapshot, FileSnapshot], str]:
    digest = hashlib.sha256(source[0].data).hexdigest()
    data_by_name = {
        "openclaw.json": source[0].data,
        ".config-hash": f"{digest}  openclaw.json\n".encode("ascii"),
    }
    uid = identity.root_uid if locked else identity.sandbox_uid
    gid = identity.root_gid if locked else identity.sandbox_gid
    mode = 0o444 if locked else 0o660
    targets: list[FileSnapshot] = []
    for snapshot in source:
        desired_flags = (
            None
            if snapshot.inode_flags is None
            else snapshot.inode_flags & ~(FS_IMMUTABLE_FL | FS_APPEND_FL)
        )
        targets.append(
            _decode_stored_file(
                _stored_file(
                    snapshot,
                    data=data_by_name[snapshot.name],
                    uid=uid,
                    gid=gid,
                    mode=mode,
                    inode_flags=desired_flags,
                )
            )
        )
    return (targets[0], targets[1]), digest


def _journal_record(
    phase: Literal["prepared", "applying", "committed"],
    originals: tuple[FileSnapshot, FileSnapshot],
    replacements: list[dict[str, object]],
    expected_sha256: str,
    new_digest: str,
) -> dict[str, object]:
    return {
        "version": 1,
        "action": "write-config",
        "phase": phase,
        "configDir": PRODUCTION_CONFIG_DIR,
        "expectedConfigSha256": expected_sha256.lower(),
        "newConfigSha256": new_digest,
        "original": [_stored_file(snapshot) for snapshot in originals],
        "replacement": replacements,
    }


def _decode_journal(
    record: dict[str, object],
) -> tuple[
    str, tuple[FileSnapshot, FileSnapshot], tuple[FileSnapshot, FileSnapshot], str
]:
    if (
        record.get("version") != 1
        or record.get("action") != "write-config"
        or record.get("configDir") != PRODUCTION_CONFIG_DIR
        or record.get("phase") not in {"prepared", "applying", "committed"}
    ):
        raise GuardError("invalid-journal", JOURNAL_PATH, "journal header is invalid")
    original_raw = record.get("original")
    replacement_raw = record.get("replacement")
    digest = record.get("newConfigSha256")
    if (
        not isinstance(original_raw, list)
        or not isinstance(replacement_raw, list)
        or len(original_raw) != 2
        or len(replacement_raw) != 2
        or not isinstance(digest, str)
        or not re.fullmatch(r"[0-9a-f]{64}", digest)
    ):
        raise GuardError("invalid-journal", JOURNAL_PATH, "journal payload is invalid")
    originals = tuple(_decode_stored_file(value) for value in original_raw)
    replacements = tuple(_decode_stored_file(value) for value in replacement_raw)
    if (
        tuple(item.name for item in originals) != CONFIG_FILES
        or tuple(item.name for item in replacements) != CONFIG_FILES
    ):
        raise GuardError("invalid-journal", JOURNAL_PATH, "journal file set is invalid")
    replacement_config = replacements[0]
    replacement_hash = replacements[1]
    actual_digest = hashlib.sha256(replacement_config.data).hexdigest()
    if not secrets.compare_digest(actual_digest, digest):
        raise GuardError(
            "invalid-journal", JOURNAL_PATH, "replacement digest is invalid"
        )
    # Reuse the strict record parser against a minimal trusted context later;
    # here the canonical bytes are deterministic and can be checked directly.
    if replacement_hash.data != f"{digest}  openclaw.json\n".encode("ascii"):
        raise GuardError(
            "invalid-journal", JOURNAL_PATH, "replacement hash record is invalid"
        )
    return (
        str(record["phase"]),
        (originals[0], originals[1]),
        (replacements[0], replacements[1]),
        digest,
    )


RESTART_PHASES = {
    "prepared",
    "applying",
    "sealed",
    "unsealing",
    "unseal-committed",
}


def _restart_journal_record(
    phase: str,
    original_locked: bool,
    originals: tuple[FileSnapshot, FileSnapshot],
    digest: str,
) -> dict[str, object]:
    if phase not in RESTART_PHASES:
        raise GuardError("invalid-journal", JOURNAL_PATH, "restart phase is invalid")
    return {
        "version": 1,
        "action": "restart-seal",
        "phase": phase,
        "configDir": PRODUCTION_CONFIG_DIR,
        "originalLocked": original_locked,
        "configSha256": digest,
        "original": [_stored_file(item) for item in originals],
    }


def _decode_restart_journal(
    record: dict[str, object], identity: Identity
) -> tuple[
    str,
    bool,
    tuple[FileSnapshot, FileSnapshot],
    tuple[FileSnapshot, FileSnapshot],
    tuple[FileSnapshot, FileSnapshot],
    str,
]:
    phase = record.get("phase")
    original_locked = record.get("originalLocked")
    digest = record.get("configSha256")
    if (
        record.get("version") != 1
        or record.get("action") != "restart-seal"
        or record.get("configDir") != PRODUCTION_CONFIG_DIR
        or phase not in RESTART_PHASES
        or not isinstance(original_locked, bool)
        or not isinstance(digest, str)
        or not re.fullmatch(r"[0-9a-f]{64}", digest)
    ):
        raise GuardError(
            "invalid-journal", JOURNAL_PATH, "restart journal header is invalid"
        )

    raw = record.get("original")
    if not isinstance(raw, list) or len(raw) != 2:
        raise GuardError(
            "invalid-journal", JOURNAL_PATH, "restart journal original pair is invalid"
        )
    items = tuple(_decode_stored_file(value) for value in raw)
    if tuple(item.name for item in items) != CONFIG_FILES:
        raise GuardError(
            "invalid-journal", JOURNAL_PATH, "restart journal file set is invalid"
        )
    originals = (items[0], items[1])
    if hashlib.sha256(originals[0].data).hexdigest() != digest:
        raise GuardError(
            "invalid-journal", JOURNAL_PATH, "restart config digest is invalid"
        )
    _validate_runtime_config_json5(originals[0].data, JOURNAL_PATH, identity)
    if original_locked:
        for item in originals:
            if (
                item.uid != identity.root_uid
                or item.gid != identity.root_gid
                or item.mode != 0o444
            ):
                raise GuardError(
                    "invalid-journal",
                    JOURNAL_PATH,
                    "locked restart original metadata is invalid",
                )
    else:
        _validate_recovery_posture(originals, identity)
    sealed, _ = _canonical_targets(originals, identity, locked=True)
    mutable, _ = _canonical_targets(originals, identity, locked=False)
    return (
        str(phase),
        original_locked,
        originals,
        sealed,
        mutable,
        digest,
    )


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError(errno.EIO, "short write")
        view = view[written:]


def _replace_from_snapshot(
    opened: OpenConfig,
    snapshot: FileSnapshot,
    uid: int,
    gid: int,
    mode: int,
    inode_flags: int | None,
    *,
    replacement_data: bytes | None = None,
    replacement_atime_ns: int | None = None,
    replacement_mtime_ns: int | None = None,
    replacement_xattrs: tuple[tuple[str, bytes], ...] | None = None,
) -> os.stat_result:
    temp_name = (
        f".nemoclaw-config-{snapshot.name.lstrip('.')}-{secrets.token_hex(16)}.tmp"
    )
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    fd = -1
    source_fd = -1
    source_flags: int | None = None
    replaced = False
    target_data = snapshot.data if replacement_data is None else replacement_data
    target_atime_ns = (
        snapshot.atime_ns if replacement_atime_ns is None else replacement_atime_ns
    )
    target_mtime_ns = (
        snapshot.mtime_ns if replacement_mtime_ns is None else replacement_mtime_ns
    )
    target_xattrs = (
        snapshot.xattrs if replacement_xattrs is None else replacement_xattrs
    )
    try:
        fd = os.open(temp_name, flags, 0o600, dir_fd=opened.config_fd)
        _write_all(fd, target_data)
        os.fchown(fd, uid, gid)
        setxattr = getattr(os, "setxattr", None)
        if setxattr is not None:
            for name, value in target_xattrs:
                setxattr(fd, name, value)
        os.fchmod(fd, mode)
        os.utime(fd, ns=(target_atime_ns, target_mtime_ns))
        os.fsync(fd)
        source_fd, current = _open_checked_file(opened, snapshot.name)
        if (
            current.st_dev != snapshot.dev
            or current.st_ino != snapshot.ino
            or current.st_nlink != 1
            or not stat.S_ISREG(current.st_mode)
            or current.st_size != snapshot.size
            or current.st_mtime_ns != snapshot.mtime_ns
            or current.st_ctime_ns != snapshot.ctime_ns
        ):
            raise GuardError(
                "entry-raced",
                posixpath.join(opened.config_path, snapshot.name),
                "config file changed before atomic replacement",
            )
        source_flags = _get_inode_flags(source_fd)
        if source_flags is not None:
            replace_flags = source_flags & ~(FS_IMMUTABLE_FL | FS_APPEND_FL)
            if replace_flags != source_flags:
                _set_inode_flags(source_fd, replace_flags)
        os.replace(
            temp_name,
            snapshot.name,
            src_dir_fd=opened.config_fd,
            dst_dir_fd=opened.config_fd,
        )
        replaced = True
        temp_name = ""
        os.fsync(opened.config_fd)
        if inode_flags is not None and _get_inode_flags(fd) is not None:
            _set_inode_flags(fd, inode_flags)
            os.fsync(fd)
            os.fsync(opened.config_fd)
        installed = os.stat(
            snapshot.name, dir_fd=opened.config_fd, follow_symlinks=False
        )
        return installed
    finally:
        if source_fd >= 0:
            if not replaced and source_flags is not None:
                try:
                    _set_inode_flags(source_fd, source_flags)
                except OSError:
                    # Preserve the primary replacement failure; callers keep
                    # the canonical directory frozen and fail closed.
                    pass
            os.close(source_fd)
        if fd >= 0:
            os.close(fd)
        if temp_name:
            try:
                os.unlink(temp_name, dir_fd=opened.config_fd)
            except FileNotFoundError:
                pass


def _force_replace_bytes(
    opened: OpenConfig,
    name: str,
    data: bytes,
    identity: Identity,
) -> None:
    """Fresh-publish bounded bytes after freeze without trusting the old inode."""

    if len(data) > MAX_FILE_BYTES[name]:
        raise GuardError(
            "config-file-too-large",
            posixpath.join(opened.config_path, name),
            "refusing oversized fail-closed replacement",
        )
    temp = f".nemoclaw-force-{name.lstrip('.')}-{secrets.token_hex(16)}.tmp"
    fd = -1
    try:
        fd = os.open(
            temp,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            0o400,
            dir_fd=opened.config_fd,
        )
        _write_all(fd, data)
        os.fchown(fd, identity.root_uid, identity.root_gid)
        os.fchmod(fd, 0o444)
        os.fsync(fd)
        try:
            target = os.stat(name, dir_fd=opened.config_fd, follow_symlinks=False)
            if stat.S_ISDIR(target.st_mode):
                os.rename(
                    name,
                    f".nemoclaw-rejected-{name.lstrip('.')}-{secrets.token_hex(16)}",
                    src_dir_fd=opened.config_fd,
                    dst_dir_fd=opened.config_fd,
                )
        except FileNotFoundError:
            # An absent target needs no quarantine before atomic replacement.
            pass
        os.replace(temp, name, src_dir_fd=opened.config_fd, dst_dir_fd=opened.config_fd)
        temp = ""
        os.fsync(opened.config_fd)
    finally:
        if fd >= 0:
            os.close(fd)
        if temp:
            try:
                os.unlink(temp, dir_fd=opened.config_fd)
            except FileNotFoundError:
                # The atomic rename or an earlier cleanup already consumed it.
                pass


def _set_dir(fd: int, uid: int, gid: int, mode: int, freeze_mode: int) -> None:
    os.fchmod(fd, freeze_mode)
    os.fchown(fd, uid, gid)
    os.fchmod(fd, mode)
    os.fsync(fd)


def _verify_dir_posture(fd: int, path: str, uid: int, gid: int, mode: int) -> None:
    current = os.fstat(fd)
    if (
        not stat.S_ISDIR(current.st_mode)
        or current.st_uid != uid
        or current.st_gid != gid
        or stat.S_IMODE(current.st_mode) != mode
    ):
        raise GuardError(
            "verification-failed",
            path,
            "directory owner or mode does not match the requested posture",
        )


def _dir_has_posture(fd: int, uid: int, gid: int, mode: int) -> bool:
    current = os.fstat(fd)
    return (
        stat.S_ISDIR(current.st_mode)
        and current.st_uid == uid
        and current.st_gid == gid
        and stat.S_IMODE(current.st_mode) == mode
    )


def _is_mutable_dir_posture(opened: OpenConfig, identity: Identity) -> bool:
    return _dir_has_posture(
        opened.parent_fd,
        identity.sandbox_uid,
        identity.sandbox_gid,
        0o755,
    ) and _dir_has_posture(
        opened.config_fd,
        identity.sandbox_uid,
        identity.sandbox_gid,
        0o2770,
    )


def _is_write_frozen_posture(opened: OpenConfig, identity: Identity) -> bool:
    return _dir_has_posture(
        opened.parent_fd,
        identity.root_uid,
        identity.sandbox_gid,
        0o755,
    ) and _dir_has_posture(
        opened.config_fd,
        identity.root_uid,
        identity.root_gid,
        0o700,
    )


def _has_locked_dir_posture(opened: OpenConfig, identity: Identity) -> bool:
    return _dir_has_posture(
        opened.parent_fd,
        identity.root_uid,
        identity.sandbox_gid,
        0o1775,
    ) and _dir_has_posture(
        opened.config_fd,
        identity.root_uid,
        identity.root_gid,
        0o755,
    )


def _has_clamped_locked_dir_posture(opened: OpenConfig, identity: Identity) -> bool:
    return _dir_has_posture(
        opened.parent_fd,
        identity.root_uid,
        identity.sandbox_gid,
        0o1775,
    ) and _dir_has_posture(
        opened.config_fd,
        identity.root_uid,
        identity.root_gid,
        0o500,
    )


def _verify_locked_files(
    opened: OpenConfig,
    snapshots: tuple[FileSnapshot, FileSnapshot],
    identity: Identity,
    *,
    allow_blocking_flags: bool = False,
) -> None:
    for snapshot in snapshots:
        if (
            snapshot.uid != identity.root_uid
            or snapshot.gid != identity.root_gid
            or snapshot.mode != 0o444
            or (
                not allow_blocking_flags
                and snapshot.inode_flags is not None
                and snapshot.inode_flags & (FS_IMMUTABLE_FL | FS_APPEND_FL)
            )
        ):
            raise GuardError(
                "config-not-locked",
                posixpath.join(opened.config_path, snapshot.name),
                "restart seal requires the exact shields-locked file posture",
            )


def _verify_locked_posture(
    opened: OpenConfig,
    snapshots: tuple[FileSnapshot, FileSnapshot],
    identity: Identity,
    *,
    allow_blocking_flags: bool = False,
) -> None:
    if not _has_locked_dir_posture(opened, identity):
        raise GuardError(
            "config-not-locked",
            opened.config_path,
            "restart seal requires the exact shields-locked directory posture",
        )
    _verify_locked_files(
        opened,
        snapshots,
        identity,
        allow_blocking_flags=allow_blocking_flags,
    )


def _is_partial_frozen_mutable_posture(opened: OpenConfig, identity: Identity) -> bool:
    """Recognize only pre-replacement freeze states with a root-owned marker.

    The legacy 0555/0500 modes cover a kill inside the older chmod-first freeze.
    A root-owned parent or config inode is mandatory, so an ordinary sandbox
    tree cannot impersonate an orphan transaction after rootfs-local state is
    lost during container recreation.
    """

    if _is_mutable_dir_posture(opened, identity):
        return False
    parent = os.fstat(opened.parent_fd)
    config = os.fstat(opened.config_fd)
    parent_mode = stat.S_IMODE(parent.st_mode)
    config_mode = stat.S_IMODE(config.st_mode)
    parent_known = (
        parent.st_uid == identity.root_uid
        and parent.st_gid == identity.sandbox_gid
        and parent_mode in {0o555, 0o755}
    ) or (
        parent.st_uid == identity.sandbox_uid
        and parent.st_gid == identity.sandbox_gid
        and parent_mode in {0o555, 0o755}
    )
    config_known = (
        config.st_uid == identity.root_uid
        and config.st_gid == identity.root_gid
        and config_mode in {0o000, 0o500, 0o700, 0o770}
    ) or (
        config.st_uid == identity.sandbox_uid
        and config.st_gid == identity.sandbox_gid
        and config_mode in {0o000, 0o500, 0o770, 0o2770}
    )
    has_root_marker = (
        parent.st_uid == identity.root_uid or config.st_uid == identity.root_uid
    )
    return parent_known and config_known and has_root_marker


def _capture_orphan_frozen_mutable(
    opened: OpenConfig, identity: Identity
) -> tuple[FileSnapshot, FileSnapshot] | None:
    if not _is_partial_frozen_mutable_posture(opened, identity):
        return None
    current = _snapshot_raw_pair(opened)
    _verify_mutable_files(opened, current, identity)
    return current


def _commit_mutable_dirs(opened: OpenConfig, identity: Identity) -> None:
    # Keep the parent root-owned until after config write access is granted.
    # Every pre-handoff crash therefore retains a durable root-owned orphan
    # discriminator; changing parent ownership last moves atomically into the
    # exact final mutable posture.
    os.fchown(opened.parent_fd, identity.root_uid, identity.sandbox_gid)
    os.fchmod(opened.parent_fd, 0o755)
    os.fsync(opened.parent_fd)
    os.fchmod(opened.config_fd, 0o000)
    os.fchown(opened.config_fd, identity.sandbox_uid, identity.sandbox_gid)
    # This chmod is the irreversible handoff: sandbox code can mutate paths
    # through an existing parent/config descriptor as soon as it succeeds.
    os.fchmod(opened.config_fd, 0o2770)
    try:
        os.fsync(opened.config_fd)
        os.fchown(opened.parent_fd, identity.sandbox_uid, identity.sandbox_gid)
        os.fchmod(opened.parent_fd, 0o755)
        os.fsync(opened.parent_fd)
        _assert_config_binding(opened)
        _verify_dir_posture(
            opened.config_fd,
            opened.config_path,
            identity.sandbox_uid,
            identity.sandbox_gid,
            0o2770,
        )
        _verify_dir_posture(
            opened.parent_fd,
            opened.parent_path,
            identity.sandbox_uid,
            identity.sandbox_gid,
            0o755,
        )
    except Exception as exc:
        raise MutableHandoffError(
            "mutable-handoff-incomplete",
            opened.config_path,
            f"sandbox write access was granted before final verification: {exc}",
        ) from exc


def _commit_locked_dirs(opened: OpenConfig, identity: Identity) -> None:
    _set_dir(
        opened.config_fd,
        identity.root_uid,
        identity.root_gid,
        0o755,
        0o500,
    )
    _set_dir(
        opened.parent_fd,
        identity.root_uid,
        identity.sandbox_gid,
        0o1775,
        0o555,
    )
    _assert_config_binding(opened)
    _verify_dir_posture(
        opened.config_fd,
        opened.config_path,
        identity.root_uid,
        identity.root_gid,
        0o755,
    )
    _verify_dir_posture(
        opened.parent_fd,
        opened.parent_path,
        identity.root_uid,
        identity.sandbox_gid,
        0o1775,
    )


def _freeze_parent(opened: OpenConfig, identity: Identity) -> None:
    # Ownership is the persistent orphan discriminator. Changing it first also
    # revokes sandbox writes atomically: once fchown returns, mode 0755 no longer
    # grants the former owner write access. This avoids an unmarked 0555 window
    # if the process is killed between chmod/chown syscalls.
    os.fchown(opened.parent_fd, identity.root_uid, identity.sandbox_gid)
    os.fsync(opened.parent_fd)
    os.fchmod(opened.parent_fd, 0o755)
    os.fsync(opened.parent_fd)


def _freeze_config(opened: OpenConfig, identity: Identity) -> None:
    # The root-owned parent now pins the .openclaw name. Root ownership of the
    # config inode revokes writes through already-open directory descriptors
    # before the final private mode is installed.
    os.fchown(opened.config_fd, identity.root_uid, identity.root_gid)
    os.fsync(opened.config_fd)
    os.fchmod(opened.config_fd, 0o700)
    os.fsync(opened.config_fd)


def _freeze(
    opened: OpenConfig,
    identity: Identity,
    *,
    quarantine_reserved: bool = False,
) -> None:
    # Parent first prevents a rename-swap of .openclaw; config next prevents
    # replacement of either exact top-level file.
    _freeze_parent(opened, identity)
    _assert_config_binding(opened)
    _freeze_config(opened, identity)
    _assert_config_binding(opened)
    if quarantine_reserved:
        _quarantine_untrusted_persistent_journal(opened, identity)


def _verify_file(
    opened: OpenConfig,
    name: str,
    uid: int,
    gid: int,
    mode: int,
    expected: FileSnapshot,
) -> None:
    snapshot = _snapshot_file(opened, name)
    mismatches: list[str] = []
    if snapshot.uid != uid:
        mismatches.append(f"uid={snapshot.uid} expected={uid}")
    if snapshot.gid != gid:
        mismatches.append(f"gid={snapshot.gid} expected={gid}")
    if snapshot.mode != mode:
        mismatches.append(f"mode={snapshot.mode:o} expected={mode:o}")
    if snapshot.data != expected.data:
        mismatches.append("bytes differ")
    # Reading for verification may itself advance atime on relatime filesystems.
    # Publication sets the requested atime, but it is not a stable post-read check.
    if snapshot.mtime_ns != expected.mtime_ns:
        mismatches.append(f"mtime_ns={snapshot.mtime_ns} expected={expected.mtime_ns}")
    if snapshot.xattrs != expected.xattrs:
        mismatches.append("xattrs differ")
    if snapshot.inode_flags is not None and snapshot.inode_flags != (
        expected.inode_flags or 0
    ):
        mismatches.append(
            f"inode_flags={snapshot.inode_flags} expected={expected.inode_flags or 0}"
        )
    if snapshot.ino <= 0:
        mismatches.append("invalid inode")
    if mismatches:
        raise GuardError(
            "verification-failed",
            posixpath.join(opened.config_path, name),
            "installed config metadata or bytes do not match the requested posture: "
            + "; ".join(mismatches),
        )


def _restore_originals(
    opened: OpenConfig,
    snapshots: tuple[FileSnapshot, ...],
    identity: Identity,
) -> list[str]:
    errors: list[str] = []
    for snapshot in snapshots:
        try:
            current = _snapshot_file(opened, snapshot.name)
            _replace_from_snapshot(
                opened,
                current,
                snapshot.uid,
                snapshot.gid,
                snapshot.mode,
                snapshot.inode_flags,
                replacement_data=snapshot.data,
                replacement_atime_ns=snapshot.atime_ns,
                replacement_mtime_ns=snapshot.mtime_ns,
                replacement_xattrs=snapshot.xattrs,
            )
        except Exception as exc:  # Best-effort rollback; force-lock follows.
            errors.append(f"{snapshot.name}: {exc}")
    try:
        _set_dir(
            opened.config_fd,
            opened.config_stat.st_uid,
            opened.config_stat.st_gid,
            stat.S_IMODE(opened.config_stat.st_mode),
            0o500,
        )
        _set_dir(
            opened.parent_fd,
            opened.parent_stat.st_uid,
            opened.parent_stat.st_gid,
            stat.S_IMODE(opened.parent_stat.st_mode),
            0o555,
        )
    except OSError as exc:
        errors.append(f"directory metadata: {exc}")
    if errors:
        try:
            for name in CONFIG_FILES:
                fd, _st = _open_checked_file(opened, name)
                try:
                    inode_flags = _get_inode_flags(fd)
                    if inode_flags is not None:
                        _set_inode_flags(
                            fd, inode_flags & ~(FS_IMMUTABLE_FL | FS_APPEND_FL)
                        )
                    os.fchown(fd, identity.root_uid, identity.root_gid)
                    os.fchmod(fd, 0o444)
                    os.fsync(fd)
                finally:
                    os.close(fd)
            _set_dir(
                opened.config_fd,
                identity.root_uid,
                identity.root_gid,
                0o755,
                0o500,
            )
            _set_dir(
                opened.parent_fd,
                identity.root_uid,
                identity.sandbox_gid,
                0o1775,
                0o555,
            )
        except Exception as exc:
            errors.append(f"fail-closed lock: {exc}")
    return errors


def _preflight(opened: OpenConfig) -> None:
    _assert_config_binding(opened)
    _snapshot_pair(opened)
    _assert_config_binding(opened)


def _preflight_restart(opened: OpenConfig, identity: Identity) -> None:
    _assert_config_binding(opened)
    if _is_mutable_dir_posture(opened, identity):
        config, hash_file = _snapshot_raw_pair(opened)
        _verify_mutable_files(opened, (config, hash_file), identity)
    elif _has_locked_dir_posture(opened, identity):
        config, hash_file = _snapshot_pair(opened)
        _verify_locked_files(opened, (config, hash_file), identity)
    else:
        raise GuardError(
            "invalid-restart-posture",
            opened.config_path,
            "restart preflight requires an exact mutable or shields-locked posture",
        )
    _validate_runtime_config_json5(
        config.data,
        posixpath.join(opened.config_path, "openclaw.json"),
        identity,
    )
    _assert_config_binding(opened)


def _force_fail_closed_lock(opened: OpenConfig, identity: Identity) -> list[str]:
    errors: list[str] = []
    targets: tuple[FileSnapshot, FileSnapshot] | None = None
    try:
        current = _snapshot_raw_pair(opened)
        targets, _digest = _canonical_targets(current, identity, locked=True)
        _install_stored_pair(opened, targets)
        _snapshot_pair(opened)
        try:
            _validate_runtime_config_json5(
                targets[0].data,
                posixpath.join(opened.config_path, "openclaw.json"),
                identity,
            )
        except Exception as validation_exc:
            # Containment succeeds even when the captured bytes are invalid.
            errors.append(f"config validation: {validation_exc}")
    except Exception as exc:
        errors.append(f"canonical pair: {exc}")
        if targets is not None:
            try:
                for target in targets:
                    _force_replace_bytes(opened, target.name, target.data, identity)
                _snapshot_pair(opened)
            except Exception as force_exc:
                errors.append(f"forced fresh pair: {force_exc}")
        else:
            # No bounded pair could be captured. Sever each canonical path
            # rather than retaining an attacker-held writable inode.
            for name in CONFIG_FILES:
                try:
                    os.rename(
                        name,
                        f".nemoclaw-rejected-{name.lstrip('.')}-{secrets.token_hex(16)}",
                        src_dir_fd=opened.config_fd,
                        dst_dir_fd=opened.config_fd,
                    )
                except FileNotFoundError:
                    # A concurrently absent canonical name is already severed.
                    pass
                except Exception as file_exc:
                    errors.append(f"{name}: {file_exc}")
            os.fsync(opened.config_fd)
    try:
        _commit_locked_dirs(opened, identity)
    except Exception as exc:
        errors.append(f"locked directories: {exc}")
    return errors


def _settle_pending_transaction_for_lock(
    opened: OpenConfig, identity: Identity
) -> None:
    """Resolve only rootfs-authenticated state while the mutable tree is frozen."""

    try:
        secondary = _read_secondary_journal(identity)
    except GuardError:
        secondary = None
    # A persistent record without the private rootfs peer is replayable after
    # mutable exposure and is therefore never authoritative for deadline lock.
    if secondary is not None:
        try:
            journal_action = secondary.get("action")
            if journal_action == "write-config":
                phase, originals, replacements, _digest = _decode_journal(secondary)
                if phase != "prepared":
                    targets = replacements if phase == "committed" else originals
                    _install_stored_pair(opened, targets)
            elif journal_action == "restart-seal":
                phase, original_locked, _originals, _sealed, mutable, _digest = (
                    _decode_restart_journal(secondary, identity)
                )
                if not original_locked and phase != "prepared":
                    _install_stored_pair(opened, mutable)
        except Exception:
            # Containment remains deterministic even if transaction recovery is
            # impossible: the current bounded config bytes are sealed below.
            pass
    try:
        _clear_journal(identity, opened)
    except (OSError, GuardError):
        # A path may be a sandbox-planted nonregular entry. Quarantine it under
        # the already-frozen descriptor and retry secondary cleanup.
        try:
            _quarantine_untrusted_persistent_journal(opened, identity)
        except (OSError, GuardError):
            # The directory is already frozen; sealing the bounded current
            # pair below remains the fail-closed containment authority.
            pass
        try:
            _clear_secondary_journal(identity)
        except (OSError, GuardError):
            # A stale root-only secondary record cannot weaken the frozen tree
            # and can be retired by a later idempotent recovery.
            pass


def _transition(
    action: Literal["lock", "unlock"],
    opened: OpenConfig,
    identity: Identity,
    *,
    quarantine_untrusted: bool = False,
) -> None:
    if action == "lock":
        if _has_clamped_locked_dir_posture(opened, identity):
            pair = _snapshot_pair(opened)
            _verify_locked_files(opened, pair, identity)
            return
        if _has_locked_dir_posture(opened, identity):
            # A restart journal may still need rootfs-authenticated cleanup.
            _settle_pending_transaction_for_lock(opened, identity)
            pair = _snapshot_pair(opened)
            _verify_locked_files(opened, pair, identity)
            return
        freeze_started = False
        try:
            freeze_started = True
            _freeze(opened, identity)
            _settle_pending_transaction_for_lock(opened, identity)
            source = _snapshot_raw_pair(opened)
            targets, _digest = _canonical_targets(source, identity, locked=True)
            _install_stored_pair(opened, targets)
            pair = _snapshot_pair(opened)
            _verify_locked_files(opened, pair, identity)
            _commit_locked_dirs(opened, identity)
            return
        except Exception as exc:
            fail_closed_errors = (
                _force_fail_closed_lock(opened, identity) if freeze_started else []
            )
            detail = str(exc)
            if fail_closed_errors:
                detail += "; fail-closed issues: " + "; ".join(fail_closed_errors)
            if isinstance(exc, GuardError):
                raise GuardError(exc.code, exc.path, detail) from exc
            raise GuardError("transition-failed", opened.config_path, detail) from exc

    pair = _snapshot_pair(opened)
    _verify_locked_posture(opened, pair, identity, allow_blocking_flags=True)
    snapshots: list[FileSnapshot] = []
    try:
        _freeze(opened, identity)
        snapshots.extend(_snapshot_pair(opened))
        targets, _digest = _canonical_targets(
            (snapshots[0], snapshots[1]), identity, locked=False
        )
        _install_stored_pair(opened, targets)
        _snapshot_pair(opened)
        _commit_mutable_dirs(opened, identity)
    except Exception as exc:
        rollback_errors = (
            []
            if isinstance(exc, MutableHandoffError)
            else _restore_originals(opened, tuple(snapshots), identity)
        )
        detail = str(exc)
        if rollback_errors:
            detail += "; rollback issues: " + "; ".join(rollback_errors)
        if isinstance(exc, GuardError):
            raise GuardError(exc.code, exc.path, detail) from exc
        raise GuardError("transition-failed", opened.config_path, detail) from exc


def _install_stored_pair(
    opened: OpenConfig, targets: tuple[FileSnapshot, FileSnapshot]
) -> None:
    current_pair = _snapshot_raw_pair(opened)
    normalized_targets: list[FileSnapshot] = []
    for current, target in zip(current_pair, targets, strict=True):
        installed = _replace_from_snapshot(
            opened,
            current,
            target.uid,
            target.gid,
            target.mode,
            target.inode_flags,
            replacement_data=target.data,
            replacement_atime_ns=target.atime_ns,
            replacement_mtime_ns=target.mtime_ns,
            replacement_xattrs=target.xattrs,
        )
        if installed.st_ino == current.ino:
            raise GuardError(
                "replacement-failed",
                posixpath.join(opened.config_path, current.name),
                "journal recovery did not fresh-replace the target",
            )
        normalized_targets.append(
            FileSnapshot(
                **{
                    **target.__dict__,
                    "atime_ns": installed.st_atime_ns,
                    "mtime_ns": installed.st_mtime_ns,
                }
            )
        )
    for target in normalized_targets:
        _verify_file(
            opened,
            target.name,
            target.uid,
            target.gid,
            target.mode,
            target,
        )


def _validate_recovery_posture(
    files: tuple[FileSnapshot, FileSnapshot], identity: Identity
) -> None:
    for stored in files:
        if (
            stored.uid != identity.sandbox_uid
            or stored.gid != identity.sandbox_gid
            or stored.mode != 0o660
            or (
                stored.inode_flags is not None
                and stored.inode_flags & (FS_IMMUTABLE_FL | FS_APPEND_FL)
            )
        ):
            raise GuardError(
                "invalid-journal",
                JOURNAL_PATH,
                "journal files do not describe the mutable OpenClaw posture",
            )


def _seal_restart(
    opened: OpenConfig,
    identity: Identity,
    *,
    quarantine_untrusted: bool = False,
) -> bool:
    if _has_locked_dir_posture(opened, identity):
        original = _snapshot_pair(opened)
        _verify_locked_files(opened, original, identity)
        _sealed, digest = _canonical_targets(original, identity, locked=True)
        record = _restart_journal_record("sealed", True, original, digest)
        # Recording the original posture does not alter either protected file
        # or any host-shields directory metadata.
        _write_journal(record, identity, opened)
        return True

    if not _is_mutable_dir_posture(opened, identity):
        raise GuardError(
            "invalid-restart-posture",
            opened.config_path,
            "restart seal requires exact mutable or shields-locked posture",
        )
    initial = _snapshot_raw_pair(opened)
    _verify_mutable_files(opened, initial, identity)
    _validate_runtime_config_json5(
        initial[0].data,
        posixpath.join(opened.config_path, "openclaw.json"),
        identity,
    )
    _initial_sealed, initial_digest = _canonical_targets(initial, identity, locked=True)
    _write_journal(
        _restart_journal_record(
            "prepared",
            False,
            initial,
            initial_digest,
        ),
        identity,
    )

    _freeze(opened, identity, quarantine_reserved=True)
    frozen = _snapshot_raw_pair(opened)
    _verify_mutable_files(opened, frozen, identity)
    _validate_runtime_config_json5(
        frozen[0].data,
        posixpath.join(opened.config_path, "openclaw.json"),
        identity,
    )
    sealed, digest = _canonical_targets(frozen, identity, locked=True)
    applying = _restart_journal_record("applying", False, frozen, digest)
    # No replacement begins until this record is durable both in rootfs state
    # and in the persistent /sandbox tree.
    _write_journal(applying, identity, opened)
    _install_stored_pair(opened, sealed)
    installed = _snapshot_pair(opened)
    _verify_locked_files(opened, installed, identity)
    sealed_record = _restart_journal_record("sealed", False, frozen, digest)
    _write_journal(sealed_record, identity, opened)
    _commit_locked_dirs(opened, identity)
    return False


def _unseal_restart(
    opened: OpenConfig,
    identity: Identity,
    record: dict[str, object] | None,
) -> bool:
    if record is None:
        if _has_locked_dir_posture(opened, identity):
            current = _snapshot_pair(opened)
            _verify_locked_files(opened, current, identity)
            return True
        if _is_mutable_dir_posture(opened, identity):
            current = _snapshot_raw_pair(opened)
            _verify_mutable_files(opened, current, identity)
            _validate_runtime_config_json5(
                current[0].data,
                posixpath.join(opened.config_path, "openclaw.json"),
                identity,
            )
            return False
        raise GuardError(
            "recovery-required",
            opened.config_path,
            "restart seal posture is incomplete and must be recovered",
        )

    (
        _phase,
        original_locked,
        originals,
        _sealed,
        mutable,
        digest,
    ) = _decode_restart_journal(record, identity)
    if original_locked:
        current = _snapshot_pair(opened)
        _verify_locked_posture(opened, current, identity)
        try:
            _clear_journal(identity, opened)
        except (OSError, GuardError):
            # The root-owned record remains an idempotent cleanup request.
            pass
        return True

    _freeze(opened, identity)
    unsealing = _restart_journal_record("unsealing", False, originals, digest)
    _write_journal(unsealing, identity, opened)
    _install_stored_pair(opened, mutable)
    installed = _snapshot_pair(opened)
    _verify_mutable_files(opened, installed, identity)
    committed = _restart_journal_record("unseal-committed", False, originals, digest)
    _write_journal(committed, identity, opened)
    _commit_mutable_and_retire_journal(opened, identity)
    return False


def _recover_restart(
    opened: OpenConfig,
    identity: Identity,
    record: dict[str, object],
) -> tuple[str, str | None, bool]:
    phase, original_locked, _originals, _sealed, mutable, digest = (
        _decode_restart_journal(record, identity)
    )
    if original_locked:
        current = _snapshot_pair(opened)
        _verify_locked_posture(opened, current, identity)
        try:
            _clear_journal(identity, opened)
        except (OSError, GuardError):
            # Locked posture is already verified; later recovery can retire an
            # idempotent stale journal without reopening mutation authority.
            pass
        return "restart-locked-preserved", digest, True

    if phase == "prepared":
        current = _snapshot_raw_pair(opened)
        _verify_mutable_files(opened, current, identity)
        _validate_runtime_config_json5(
            current[0].data,
            posixpath.join(opened.config_path, "openclaw.json"),
            identity,
        )
        if not _is_mutable_dir_posture(opened, identity):
            if not _is_partial_frozen_mutable_posture(opened, identity):
                raise GuardError(
                    "invalid-recovery-posture",
                    opened.config_path,
                    "prepared restart journal has an unexpected directory posture",
                )
            _commit_mutable_and_retire_journal(opened, identity)
        visible_digest = hashlib.sha256(current[0].data).hexdigest()
        try:
            _clear_journal(identity, opened)
        except (OSError, GuardError):
            # Mutable posture is already verified and committed; journal
            # retirement can be retried without changing visible bytes.
            pass
        return "restart-prepared-preserved", visible_digest, False

    if phase == "unseal-committed" and _is_mutable_dir_posture(opened, identity):
        current = _snapshot_raw_pair(opened)
        _verify_mutable_files(opened, current, identity)
        _validate_runtime_config_json5(
            current[0].data,
            posixpath.join(opened.config_path, "openclaw.json"),
            identity,
        )
        visible_digest = hashlib.sha256(current[0].data).hexdigest()
        try:
            _clear_journal(identity, opened)
        except (OSError, GuardError):
            # Mutable posture is already verified and committed; journal
            # retirement can be retried without changing visible bytes.
            pass
        return "restart-unseal-visible", visible_digest, False

    _freeze(opened, identity)
    _install_stored_pair(opened, mutable)
    installed = _snapshot_pair(opened)
    _verify_mutable_files(opened, installed, identity)
    _commit_mutable_and_retire_journal(opened, identity)
    return "restart-restored-mutable", digest, False


def _recover_write_config(
    opened: OpenConfig, identity: Identity
) -> tuple[str, str | None]:
    try:
        record = _read_journal(identity, opened)
    except GuardError as exc:
        if exc.code != "unsafe-journal" or not _is_partial_frozen_mutable_posture(
            opened, identity
        ):
            raise
        record = None
    if record is None:
        current = _capture_orphan_frozen_mutable(opened, identity)
        if current is None:
            return "none", None
        # Root ownership is the durable discriminator for any kill between the
        # parent/config freeze steps and persistent applying-journal publish.
        # No replacement begins before that publish.
        _commit_mutable_dirs(opened, identity)
        return "prepared-preserved", hashlib.sha256(current[0].data).hexdigest()
    phase, originals, replacements, new_digest = _decode_journal(record)
    _validate_recovery_posture(originals, identity)
    _validate_recovery_posture(replacements, identity)

    if phase == "committed" and _is_mutable_dir_posture(opened, identity):
        # The committed pair was already exposed. The gateway may have made a
        # later legitimate config+hash update before journal cleanup, so retain
        # the current coherent pair rather than reinstalling older bytes.
        current = _snapshot_raw_pair(opened)
        _verify_mutable_files(opened, current, identity)
        visible_digest = hashlib.sha256(current[0].data).hexdigest()
        _clear_journal(identity, opened)
        return "committed-visible", visible_digest

    # Journal presence proves write-config owned this transition. Freeze before
    # inspecting partial paths. A prepared journal precedes all replacements,
    # so preserve the current coherent pair (including legitimate gateway writes
    # after journal publication). Applying rolls back; committed finishes.
    _freeze(opened, identity)
    if phase == "prepared":
        current = _snapshot_raw_pair(opened)
        _verify_mutable_files(opened, current, identity)
        recovery = "prepared-preserved"
        recovered_digest = hashlib.sha256(current[0].data).hexdigest()
    else:
        targets = replacements if phase == "committed" else originals
        _install_stored_pair(opened, targets)
        recovery = "committed" if phase == "committed" else "rolled-back"
        recovered_digest = new_digest if phase == "committed" else None
    if phase == "committed":
        _snapshot_pair(opened)
    _commit_mutable_and_retire_journal(opened, identity)
    return recovery, recovered_digest


def _rollback_write_config_frozen(
    opened: OpenConfig,
    identity: Identity,
    originals: tuple[FileSnapshot, FileSnapshot],
) -> None:
    """Restore a failed write without exposing an applying-journal replay gap."""

    # Finish revocation if the original exception interrupted either freeze
    # step. No persistent journal is retired until both files are restored and
    # verified under root-owned directories.
    _freeze(opened, identity)
    _install_stored_pair(opened, originals)
    restored = _snapshot_raw_pair(opened)
    _verify_mutable_files(opened, restored, identity)
    for actual, expected in zip(restored, originals, strict=True):
        if actual.data != expected.data:
            raise GuardError(
                "rollback-verification-failed",
                posixpath.join(opened.config_path, actual.name),
                "restored rollback bytes do not match the frozen originals",
            )

    digest = hashlib.sha256(restored[0].data).hexdigest()
    preserve_records, _ = _replacement_records(
        restored, restored[0].data, identity, time.time_ns()
    )
    preserve = _journal_record(
        "prepared",
        restored,
        preserve_records,
        digest,
        digest,
    )
    # Prepared recovery preserves whatever stable raw pair is visible. Publish
    # that intent durably before retiring the applying/committed record.
    _write_journal(preserve, identity, opened)
    _commit_mutable_and_retire_journal(opened, identity)


def _write_config(
    opened: OpenConfig,
    identity: Identity,
    expected_sha256: str,
    replacement_config: bytes,
) -> str:
    initial = _snapshot_raw_pair(opened)
    _verify_mutable_posture(opened, initial, identity)
    _verify_expected_config(opened, initial[0], expected_sha256)

    commit_time_ns = time.time_ns()
    prepared_replacements, new_digest = _replacement_records(
        initial, replacement_config, identity, commit_time_ns
    )
    _write_journal(
        _journal_record(
            "prepared",
            initial,
            prepared_replacements,
            expected_sha256,
            new_digest,
        ),
        identity,
    )

    snapshots: list[FileSnapshot] = []
    try:
        _freeze(opened, identity, quarantine_reserved=True)
        frozen = _snapshot_raw_pair(opened)
        snapshots.extend(frozen)
        _verify_mutable_files(opened, frozen, identity)
        _verify_expected_config(opened, frozen[0], expected_sha256)

        replacement_records, new_digest = _replacement_records(
            frozen, replacement_config, identity, commit_time_ns
        )
        applying_record = _journal_record(
            "applying", frozen, replacement_records, expected_sha256, new_digest
        )
        _write_journal(applying_record, identity, opened)
        expected_installed = tuple(
            _decode_stored_file(value) for value in replacement_records
        )
        normalized_installed: list[FileSnapshot] = []
        for snapshot, expected in zip(frozen, expected_installed, strict=True):
            installed = _replace_from_snapshot(
                opened,
                snapshot,
                expected.uid,
                expected.gid,
                expected.mode,
                expected.inode_flags,
                replacement_data=expected.data,
                replacement_atime_ns=expected.atime_ns,
                replacement_mtime_ns=expected.mtime_ns,
                replacement_xattrs=expected.xattrs,
            )
            if installed.st_ino == snapshot.ino:
                raise GuardError(
                    "replacement-failed",
                    posixpath.join(opened.config_path, snapshot.name),
                    "fresh inode replacement did not change the inode",
                )
            normalized_installed.append(
                FileSnapshot(
                    **{
                        **expected.__dict__,
                        "atime_ns": installed.st_atime_ns,
                        "mtime_ns": installed.st_mtime_ns,
                    }
                )
            )

        for expected in normalized_installed:
            _verify_file(
                opened,
                expected.name,
                identity.sandbox_uid,
                identity.sandbox_gid,
                0o660,
                expected,
            )
        # Validate the exact pair that will become visible before returning
        # directory ownership to the sandbox.
        installed_pair = _snapshot_pair(opened)
        if installed_pair[0].data != replacement_config:
            raise GuardError(
                "verification-failed",
                posixpath.join(opened.config_path, "openclaw.json"),
                "installed config bytes changed before mutable commit",
            )
        committed_record = {
            **applying_record,
            "phase": "committed",
            "replacement": [_stored_file(item) for item in normalized_installed],
        }
        _write_journal(committed_record, identity, opened)
        _commit_mutable_and_retire_journal(opened, identity)
        return new_digest
    except Exception as exc:
        rollback_allowed = not isinstance(exc, MutableHandoffError)
        rollback_errors: list[str] = []
        if rollback_allowed:
            rollback_targets = (
                (snapshots[0], snapshots[1]) if len(snapshots) == 2 else initial
            )
            try:
                _rollback_write_config_frozen(opened, identity, rollback_targets)
            except Exception as rollback_exc:
                rollback_errors.append(str(rollback_exc))
                rollback_errors.extend(_force_fail_closed_lock(opened, identity))
        detail = str(exc)
        if rollback_errors:
            detail += "; rollback issues: " + "; ".join(rollback_errors)
        if isinstance(exc, GuardError):
            raise GuardError(exc.code, exc.path, detail) from exc
        raise GuardError("write-config-failed", opened.config_path, detail) from exc


def _recover_any_transaction(
    opened: OpenConfig,
    identity: Identity,
    pending: dict[str, object] | None,
) -> tuple[str, str | None, bool | None]:
    if pending is None:
        if _has_clamped_locked_dir_posture(opened, identity):
            current = _snapshot_pair(opened)
            _verify_locked_files(opened, current, identity)
            return (
                "clamped-lock-preserved",
                hashlib.sha256(current[0].data).hexdigest(),
                True,
            )
        if _is_partial_frozen_mutable_posture(opened, identity):
            partial = _snapshot_raw_pair(opened)
            mutable_files = all(
                item.uid == identity.sandbox_uid
                and item.gid == identity.sandbox_gid
                and item.mode == 0o660
                for item in partial
            )
            if mutable_files:
                _commit_mutable_dirs(opened, identity)
                return (
                    "orphan-freeze-restored",
                    hashlib.sha256(partial[0].data).hexdigest(),
                    False,
                )
            targets, digest = _canonical_targets(partial, identity, locked=True)
            _install_stored_pair(opened, targets)
            _commit_locked_dirs(opened, identity)
            return "orphan-lock-completed", digest, True
        if _has_locked_dir_posture(opened, identity):
            current = _snapshot_pair(opened)
            _verify_locked_files(opened, current, identity)
            return "none", hashlib.sha256(current[0].data).hexdigest(), True
        return "none", None, False
    journal_action = pending.get("action")
    if journal_action == "restart-seal":
        return _recover_restart(opened, identity, pending)
    if journal_action == "write-config":
        recovery, digest = _recover_write_config(opened, identity)
        return recovery, digest, False
    raise GuardError(
        "invalid-journal", JOURNAL_PATH, "journal action is not recognized"
    )


def _clear_untrusted_mutable_reserved_entry(
    opened: OpenConfig, identity: Identity
) -> tuple[str, str]:
    _freeze(opened, identity)
    _quarantine_untrusted_persistent_journal(opened, identity)
    current = _snapshot_raw_pair(opened)
    _verify_mutable_files(opened, current, identity)
    _commit_mutable_dirs(opened, identity)
    return "untrusted-journal-cleared", hashlib.sha256(current[0].data).hexdigest()


def _contain_partial_replay(opened: OpenConfig, identity: Identity) -> tuple[str, str]:
    _freeze(opened, identity)
    _quarantine_untrusted_persistent_journal(opened, identity)
    _force_fail_closed_lock(opened, identity)
    if not _has_locked_dir_posture(opened, identity):
        raise GuardError(
            "fail-closed-incomplete",
            opened.config_path,
            "could not contain ambiguous persistent journal replay",
        )
    current = _snapshot_pair(opened)
    return "ambiguous-replay-locked", hashlib.sha256(current[0].data).hexdigest()


def _production_identity() -> Identity:
    try:
        sandbox_user = pwd.getpwnam("sandbox")
        sandbox_group = grp.getgrnam("sandbox")
    except KeyError as exc:
        raise GuardError(
            "identity-missing", "", "sandbox user and group must exist"
        ) from exc
    return Identity(
        root_uid=0,
        root_gid=0,
        sandbox_uid=sandbox_user.pw_uid,
        sandbox_gid=sandbox_group.gr_gid,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=(
            "preflight",
            "preflight-restart",
            "lock",
            "unlock",
            "seal-restart",
            "unseal-restart",
            "revoke-startup-ready",
            "publish-startup-ready",
            "write-config",
            "recover",
        ),
    )
    parser.add_argument("--config-dir", default=PRODUCTION_CONFIG_DIR)
    parser.add_argument("--expected-config-sha256", default="")
    parser.add_argument("--startup-owner", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    action: Action = args.action
    if os.geteuid() != 0:
        error = GuardError("root-required", args.config_dir, "helper must run as root")
        print(json.dumps(error.as_json(), sort_keys=True))
        print(
            json.dumps(
                {"type": "result", "action": action, "status": "failed"},
                sort_keys=True,
            )
        )
        return 1

    opened: OpenConfig | None = None
    mutex: MutationMutex | None = None
    try:
        normalized_config = posixpath.normpath(args.config_dir)
        if normalized_config != PRODUCTION_CONFIG_DIR:
            raise GuardError(
                "invalid-config-path",
                args.config_dir,
                f"helper is restricted to {PRODUCTION_CONFIG_DIR}",
            )
        identity = _production_identity()
        _validate_action_readiness(action, args.startup_owner, identity)
        read_only = action in {"preflight", "preflight-restart"}
        mutex = _acquire_mutation_mutex(action, identity, exclusive=not read_only)

        if action in {"revoke-startup-ready", "publish-startup-ready"}:
            if action == "revoke-startup-ready":
                _revoke_startup_ready(identity)
            else:
                _write_startup_ready(identity)
            print(
                json.dumps(
                    {
                        "type": "result",
                        "action": action,
                        "status": "ok",
                        "configDir": normalized_config,
                    },
                    sort_keys=True,
                )
            )
            return 0

        replacement_config: bytes | None = None
        if action == "write-config":
            if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expected_config_sha256):
                raise GuardError(
                    "invalid-expected-sha256",
                    "--expected-config-sha256",
                    "write-config requires exactly 64 hexadecimal characters",
                )
            replacement_config = _read_replacement_config()

        opened = (
            _open_config_for_lock(args.config_dir, identity)
            if action == "lock"
            else _open_config(args.config_dir)
        )
        untrusted_reserved_entry = False
        if action == "lock":
            # Lock freezes both namespace levels before journal inspection so
            # a last-moment sandbox swap cannot veto containment.
            pending_journal = None
        else:
            try:
                pending_journal = _read_journal(identity, opened)
            except GuardError as exc:
                persistent_display = posixpath.join(
                    opened.config_path, PERSISTENT_JOURNAL_NAME
                )
                # Never reinterpret a bad /etc journal. Only an unsafe persistent
                # entry in the exact mutable tree, with no trusted secondary, is a
                # sandbox-planted nonauthority.
                if exc.path != persistent_display:
                    raise
                secondary = _read_secondary_journal(identity)
                replay_without_secondary = (
                    exc.code == "persistent-journal-without-secondary"
                    and secondary is None
                    and (
                        _is_mutable_dir_posture(opened, identity)
                        or _is_partial_frozen_mutable_posture(opened, identity)
                    )
                )
                if secondary is not None or not (
                    replay_without_secondary
                    or _mutable_reserved_entry_is_nonauthoritative(opened, identity)
                ):
                    raise
                pending_journal = None
                untrusted_reserved_entry = True

        if action == "lock" and pending_journal is not None:
            # Deadline/manual relock cannot be vetoed by an interrupted config
            # write or restart seal. Recover under this same mutex, then seal.
            _recover_any_transaction(opened, identity, pending_journal)
            pending_journal = None
        elif (
            action not in {"recover", "unseal-restart"} and pending_journal is not None
        ):
            raise GuardError(
                "recovery-required",
                JOURNAL_PATH,
                "an interrupted config transaction must be recovered first",
            )

        if read_only and _is_partial_frozen_mutable_posture(opened, identity):
            raise GuardError(
                "recovery-required",
                opened.config_path,
                "a partially frozen config transaction must be recovered first",
            )

        recovery: str | None = None
        original_locked: bool | None = None
        if action == "preflight":
            _preflight(opened)
            new_digest = None
        elif action == "preflight-restart":
            _preflight_restart(opened, identity)
            new_digest = None
        elif action == "seal-restart":
            original_locked = _seal_restart(
                opened,
                identity,
                quarantine_untrusted=untrusted_reserved_entry,
            )
            new_digest = hashlib.sha256(
                _snapshot_file(opened, "openclaw.json").data
            ).hexdigest()
        elif action == "unseal-restart":
            if (
                pending_journal is not None
                and pending_journal.get("action") != "restart-seal"
            ):
                raise GuardError(
                    "recovery-required",
                    JOURNAL_PATH,
                    "non-restart transaction must be recovered before unseal",
                )
            original_locked = _unseal_restart(opened, identity, pending_journal)
            new_digest = hashlib.sha256(
                _snapshot_file(opened, "openclaw.json").data
            ).hexdigest()
        elif action == "write-config":
            if replacement_config is None:  # Narrow the optional type.
                raise GuardError(
                    "invalid-config-json", "stdin", "replacement config is missing"
                )
            new_digest = _write_config(
                opened,
                identity,
                args.expected_config_sha256,
                replacement_config,
            )
            recovery = None
        elif action == "recover":
            if untrusted_reserved_entry:
                if _is_partial_frozen_mutable_posture(opened, identity):
                    recovery, new_digest = _contain_partial_replay(opened, identity)
                    original_locked = True
                else:
                    recovery, new_digest = _clear_untrusted_mutable_reserved_entry(
                        opened, identity
                    )
                    original_locked = False
            else:
                recovery, new_digest, original_locked = _recover_any_transaction(
                    opened, identity, pending_journal
                )
        else:
            _transition(
                action,
                opened,
                identity,
                quarantine_untrusted=untrusted_reserved_entry,
            )
            new_digest = None
            recovery = None
        if action in {"preflight", "preflight-restart"}:
            recovery = None
        print(
            json.dumps(
                {
                    "type": "result",
                    "action": action,
                    "status": "ok",
                    "configDir": opened.config_path,
                    "files": list(CONFIG_FILES),
                    "chattrApplied": False,
                    **({"configSha256": new_digest} if new_digest is not None else {}),
                    **({"recovery": recovery} if recovery is not None else {}),
                    **(
                        {"originalLocked": original_locked}
                        if original_locked is not None
                        else {}
                    ),
                },
                sort_keys=True,
            )
        )
        return 0
    except GuardError as exc:
        print(json.dumps(exc.as_json(), sort_keys=True))
        print(
            json.dumps(
                {"type": "result", "action": action, "status": "failed"},
                sort_keys=True,
            )
        )
        return 1
    except OSError as exc:
        error = GuardError("operation-failed", args.config_dir, str(exc))
        print(json.dumps(error.as_json(), sort_keys=True))
        print(
            json.dumps(
                {"type": "result", "action": action, "status": "failed"},
                sort_keys=True,
            )
        )
        return 1
    finally:
        if opened is not None:
            opened.close()
        if mutex is not None:
            try:
                _release_mutation_mutex(mutex)
            except (OSError, GuardError):
                pass


if __name__ == "__main__":
    raise SystemExit(main())
