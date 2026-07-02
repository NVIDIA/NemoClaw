#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Normalize mutable OpenClaw config permissions through pinned descriptors."""

from __future__ import annotations

import array
import grp
import hashlib
import os
import pwd
import secrets
import socket
import stat
import struct
import subprocess
import sys

MAX_BASELINE_BYTES = 16 * 1024 * 1024
READY_NORMAL = b"NEMOCLAW_CONFIG_FD_READY:0"
READY_CAPTURE_EMPTY = b"NEMOCLAW_CONFIG_FD_READY:1"
READY_CAPTURE_SOURCE = b"NEMOCLAW_CONFIG_FD_READY:2"
READY_MESSAGE_SIZE = len(READY_NORMAL)
FIXED_FILES = ("openclaw.json", ".config-hash")
BASELINE_NAME = "openclaw.json.nemoclaw-baseline"
CONFIG_NAME = "openclaw.json"
HASH_NAME = ".config-hash"
LAST_GOOD_NAME = "openclaw.json.last-good"

JSON5_VALIDATOR = r"""
const fs = require("fs");

let JSON5;
try {
  JSON5 = require(process.argv[1]);
} catch {
  process.exit(2);
}
if (!JSON5 || typeof JSON5.parse !== "function") process.exit(2);
try {
  JSON5.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(3);
}
"""


class UnsafeTree(Exception):
    """The mutable tree changed identity or violated its ownership contract."""


def inode_key(metadata: os.stat_result) -> tuple[int, int, int]:
    return metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode)


def stable_file_key(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        *inode_key(metadata),
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def directory_flags() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not nofollow:
        raise UnsafeTree()
    return os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | nofollow


def file_flags() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not nofollow:
        raise UnsafeTree()
    return os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK | nofollow


def open_pinned(
    parent_fd: int,
    name: str,
    flags: int,
    expected: os.stat_result,
) -> tuple[int, os.stat_result]:
    try:
        child_fd = os.open(name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise UnsafeTree() from exc
    opened = os.fstat(child_fd)
    if inode_key(opened) != inode_key(expected):
        os.close(child_fd)
        raise UnsafeTree()
    return child_fd, opened


def verify_still_linked(
    parent_fd: int,
    name: str,
    opened: os.stat_result,
) -> None:
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as exc:
        raise UnsafeTree() from exc
    if inode_key(current) != inode_key(opened):
        raise UnsafeTree()


def set_mode(child_fd: int, mode: int, *, required: bool = False) -> None:
    try:
        os.fchmod(child_fd, mode)
    except PermissionError:
        if required:
            raise


def normalize_dir(directory_fd: int, *, top_level: bool = False) -> None:
    with os.scandir(directory_fd) as entries:
        names = sorted(entry.name for entry in entries)
    for name in names:
        try:
            before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except OSError as exc:
            raise UnsafeTree() from exc
        if stat.S_ISLNK(before.st_mode):
            if top_level and (name in FIXED_FILES or name == BASELINE_NAME):
                raise UnsafeTree()
            continue
        if stat.S_ISDIR(before.st_mode):
            child_fd, opened = open_pinned(
                directory_fd, name, directory_flags(), before
            )
            try:
                normalize_dir(child_fd)
                current_mode = stat.S_IMODE(os.fstat(child_fd).st_mode)
                set_mode(child_fd, (current_mode | 0o2070) & ~0o007)
                verify_still_linked(directory_fd, name, opened)
            finally:
                os.close(child_fd)
            continue
        if not stat.S_ISREG(before.st_mode):
            continue
        if top_level and name == BASELINE_NAME and before.st_uid == 0:
            # The owner phase cannot open a root-only baseline. The root
            # supervisor validates it through the pinned directory descriptor.
            continue
        child_fd, opened = open_pinned(directory_fd, name, file_flags(), before)
        try:
            current_mode = stat.S_IMODE(opened.st_mode)
            if top_level and name in FIXED_FILES:
                root_metadata = os.fstat(directory_fd)
                if (
                    stable_file_key(opened) != stable_file_key(before)
                    or opened.st_dev != root_metadata.st_dev
                    or opened.st_uid != os.geteuid()
                    or opened.st_gid != os.getegid()
                    or opened.st_nlink != 1
                ):
                    raise UnsafeTree()
                set_mode(child_fd, 0o660, required=True)
            elif top_level and name == BASELINE_NAME:
                if opened.st_uid == os.geteuid():
                    # Root promotes multiply-linked content through a fresh
                    # inode. Do not change an external alias in this phase.
                    if opened.st_nlink == 1:
                        set_mode(child_fd, 0o440, required=True)
                elif opened.st_uid != 0:
                    raise UnsafeTree()
            else:
                set_mode(child_fd, (current_mode | 0o060) & ~0o007)
            verify_still_linked(directory_fd, name, opened)
        finally:
            os.close(child_fd)


def config_dir_matches(
    root_fd: int,
    config_dir: str,
    expected_uid: int,
    expected_gid: int,
) -> bool:
    opened = os.fstat(root_fd)
    try:
        current = os.stat(config_dir, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISDIR(opened.st_mode)
        and inode_key(current) == inode_key(opened)
        and opened.st_uid == expected_uid
        and opened.st_gid == expected_gid
        and current.st_uid == expected_uid
        and current.st_gid == expected_gid
        and stat.S_IMODE(opened.st_mode) == 0o2770
        and stat.S_IMODE(current.st_mode) == 0o2770
    )


def verify_fixed_files(
    root_fd: int,
    expected_uid: int,
    expected_gid: int,
    *,
    expected_mode: int | None = 0o660,
) -> None:
    root_metadata = os.fstat(root_fd)
    for name in FIXED_FILES:
        try:
            before = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise UnsafeTree() from exc
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_dev != root_metadata.st_dev
            or before.st_uid != expected_uid
            or before.st_gid != expected_gid
            or (
                expected_mode is not None
                and stat.S_IMODE(before.st_mode) != expected_mode
            )
            or before.st_nlink != 1
        ):
            raise UnsafeTree()
        child_fd, opened = open_pinned(root_fd, name, file_flags(), before)
        try:
            if stable_file_key(opened) != stable_file_key(before):
                raise UnsafeTree()
            current = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
            if stable_file_key(current) != stable_file_key(opened):
                raise UnsafeTree()
        finally:
            os.close(child_fd)


def validate_json5(
    content: bytes,
    node_binary: str,
    json5_module: str,
    *,
    drop_uid: int | None = None,
    drop_gid: int | None = None,
) -> bool:
    if not os.path.isabs(node_binary) or not os.path.isabs(json5_module):
        raise UnsafeTree()
    try:
        demote = None
        if drop_uid is not None or drop_gid is not None:
            if drop_uid is None or drop_gid is None or os.geteuid() != 0:
                raise UnsafeTree()

            def demote() -> None:
                drop_to_owner(drop_uid, drop_gid)

        result = subprocess.run(
            [node_binary, "-e", JSON5_VALIDATOR, json5_module],
            input=content,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            close_fds=True,
            timeout=15,
            preexec_fn=demote,
            env={
                "HOME": "/sandbox",
                "NODE_OPTIONS": "",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
            },
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(
            "[config] ERROR: JSON5 baseline validator failed for openclaw.json",
            file=sys.stderr,
        )
        raise UnsafeTree() from exc
    if result.returncode == 0:
        return True
    if result.returncode == 3:
        return False
    print(
        "[config] ERROR: JSON5 baseline validator failed for openclaw.json",
        file=sys.stderr,
    )
    raise UnsafeTree()


def open_baseline_capture_source(
    root_fd: int,
    config_dir: str,
    expected_uid: int,
    expected_gid: int,
    node_binary: str,
    json5_module: str,
) -> int | None:
    root_metadata = os.fstat(root_fd)
    existing_baseline: os.stat_result | None = None
    try:
        existing_baseline = os.stat(
            BASELINE_NAME, dir_fd=root_fd, follow_symlinks=False
        )
    except FileNotFoundError:
        # The baseline is optional until the first successful capture.
        pass
    except OSError as exc:
        raise UnsafeTree() from exc

    if existing_baseline is not None:
        if (
            not stat.S_ISREG(existing_baseline.st_mode)
            or existing_baseline.st_dev != root_metadata.st_dev
            or existing_baseline.st_gid != expected_gid
        ):
            raise UnsafeTree()
        if existing_baseline.st_uid == 0:
            if (
                stat.S_IMODE(existing_baseline.st_mode) != 0o440
                or existing_baseline.st_nlink != 1
                or existing_baseline.st_size <= 0
                or existing_baseline.st_size > MAX_BASELINE_BYTES
            ):
                raise UnsafeTree()
            existing_fd, opened_existing = open_pinned(
                root_fd, BASELINE_NAME, file_flags(), existing_baseline
            )
            try:
                current_existing = os.stat(
                    BASELINE_NAME, dir_fd=root_fd, follow_symlinks=False
                )
                if (
                    stable_file_key(opened_existing)
                    != stable_file_key(existing_baseline)
                    or stable_file_key(current_existing)
                    != stable_file_key(opened_existing)
                ):
                    raise UnsafeTree()
            finally:
                os.close(existing_fd)
            return None
        if existing_baseline.st_uid != expected_uid:
            raise UnsafeTree()

    try:
        before = os.stat(CONFIG_NAME, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        if existing_baseline is not None:
            raise UnsafeTree()
        return None
    except OSError as exc:
        raise UnsafeTree() from exc
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_dev != root_metadata.st_dev
        or before.st_uid != expected_uid
        or before.st_gid != expected_gid
        or stat.S_IMODE(before.st_mode) != 0o660
        or before.st_nlink != 1
        or before.st_size > MAX_BASELINE_BYTES
    ):
        raise UnsafeTree()

    config_fd, opened = open_pinned(root_fd, CONFIG_NAME, file_flags(), before)
    try:
        if stable_file_key(opened) != stable_file_key(before):
            raise UnsafeTree()
        remaining = opened.st_size
        content = bytearray()
        while remaining:
            chunk = os.read(config_fd, min(1024 * 1024, remaining))
            if not chunk:
                raise UnsafeTree()
            content.extend(chunk)
            remaining -= len(chunk)
        if os.read(config_fd, 1):
            raise UnsafeTree()
        if not bytes(content).strip() or not validate_json5(
            bytes(content), node_binary, json5_module
        ):
            if existing_baseline is not None:
                raise UnsafeTree()
            return None
        final_source = os.fstat(config_fd)
        current_source = os.stat(
            CONFIG_NAME, dir_fd=root_fd, follow_symlinks=False
        )
        if (
            stable_file_key(final_source) != stable_file_key(opened)
            or stable_file_key(current_source) != stable_file_key(opened)
            or not config_dir_matches(
                root_fd, config_dir, expected_uid, expected_gid
            )
        ):
            raise UnsafeTree()
        os.lseek(config_fd, 0, os.SEEK_SET)
        result_fd = config_fd
        config_fd = -1
        return result_fd
    finally:
        if config_fd >= 0:
            os.close(config_fd)


def read_stable_content(
    root_fd: int,
    name: str,
    root_metadata: os.stat_result,
    allowed_uids: tuple[int, ...],
    expected_gid: int,
    *,
    expected_mode: int | None = None,
) -> tuple[bytes, os.stat_result] | None:
    try:
        before = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise UnsafeTree() from exc
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_dev != root_metadata.st_dev
        or before.st_uid not in allowed_uids
        or before.st_gid != expected_gid
        or before.st_nlink != 1
        or before.st_size > MAX_BASELINE_BYTES
        or (
            expected_mode is not None
            and stat.S_IMODE(before.st_mode) != expected_mode
        )
    ):
        raise UnsafeTree()

    opened_fd, opened = open_pinned(root_fd, name, file_flags(), before)
    try:
        if stable_file_key(opened) != stable_file_key(before):
            raise UnsafeTree()
        remaining = opened.st_size
        content = bytearray()
        while remaining:
            chunk = os.read(opened_fd, min(1024 * 1024, remaining))
            if not chunk:
                raise UnsafeTree()
            content.extend(chunk)
            remaining -= len(chunk)
        if os.read(opened_fd, 1):
            raise UnsafeTree()
        final = os.fstat(opened_fd)
        current = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        if (
            stable_file_key(final) != stable_file_key(opened)
            or stable_file_key(current) != stable_file_key(opened)
        ):
            raise UnsafeTree()
        return bytes(content), opened
    finally:
        os.close(opened_fd)


def stage_owner_file(
    root_fd: int,
    target_name: str,
    content: bytes,
    expected_uid: int,
    expected_gid: int,
    mode: int,
) -> tuple[int, str, tuple[int, int, int]]:
    temp_name = f".{target_name}.nemoclaw-{secrets.token_hex(12)}.tmp"
    temp_fd = os.open(
        temp_name,
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | os.O_CLOEXEC
        | getattr(os, "O_NOFOLLOW", 0),
        0o600,
        dir_fd=root_fd,
    )
    try:
        identity = inode_key(os.fstat(temp_fd))
        write_all(temp_fd, content)
        os.fchmod(temp_fd, mode)
        os.fsync(temp_fd)
        opened = os.fstat(temp_fd)
        current = os.stat(temp_name, dir_fd=root_fd, follow_symlinks=False)
        if (
            inode_key(opened) != identity
            or inode_key(current) != identity
            or opened.st_uid != expected_uid
            or opened.st_gid != expected_gid
            or stat.S_IMODE(opened.st_mode) != mode
            or opened.st_nlink != 1
        ):
            raise UnsafeTree()
        return temp_fd, temp_name, identity
    except Exception:
        try:
            os.close(temp_fd)
        finally:
            try:
                current = os.stat(
                    temp_name, dir_fd=root_fd, follow_symlinks=False
                )
                if inode_key(current) == identity:
                    os.unlink(temp_name, dir_fd=root_fd)
            except (OSError, UnboundLocalError):
                # Preserve the primary staging error; an unmatched temp is never unlinked.
                pass
        raise


def cleanup_staged_file(
    root_fd: int,
    temp_fd: int,
    temp_name: str | None,
    identity: tuple[int, int, int] | None,
) -> None:
    if temp_name is not None and identity is not None:
        try:
            opened = os.fstat(temp_fd)
            current = os.stat(temp_name, dir_fd=root_fd, follow_symlinks=False)
            if (
                inode_key(opened) == identity
                and inode_key(current) == identity
                and opened.st_nlink == 1
            ):
                os.unlink(temp_name, dir_fd=root_fd)
                os.fsync(root_fd)
        except OSError:
            # Best-effort cleanup must not replace the operation's primary failure.
            pass
    if temp_fd >= 0:
        os.close(temp_fd)


def recover_empty_config(
    root_fd: int,
    config_dir: str,
    expected_uid: int,
    expected_gid: int,
) -> None:
    root_metadata = os.fstat(root_fd)
    active = read_stable_content(
        root_fd,
        CONFIG_NAME,
        root_metadata,
        (expected_uid,),
        expected_gid,
        expected_mode=0o660,
    )
    if active is None or active[0].strip():
        return

    source_name: str | None = None
    source_content: bytes | None = None
    last_good = read_stable_content(
        root_fd,
        LAST_GOOD_NAME,
        root_metadata,
        (expected_uid,),
        expected_gid,
    )
    if last_good is not None and last_good[0].strip():
        source_name = LAST_GOOD_NAME
        source_content = last_good[0]
    else:
        baseline = read_stable_content(
            root_fd,
            BASELINE_NAME,
            root_metadata,
            (0, expected_uid),
            expected_gid,
        )
        if baseline is not None:
            baseline_content, baseline_metadata = baseline
            if baseline_metadata.st_uid == 0 and stat.S_IMODE(
                baseline_metadata.st_mode
            ) != 0o440:
                raise UnsafeTree()
            if baseline_content.strip():
                source_name = BASELINE_NAME
                source_content = baseline_content

    if source_name is None or source_content is None:
        print(
            f"[config] ERROR: openclaw.json is empty ({config_dir}/{CONFIG_NAME}). "
            "No baseline available; restart cannot recover. See issue #3118.",
            file=sys.stderr,
        )
        raise UnsafeTree()

    config_temp_fd = -1
    config_temp_name: str | None = None
    config_temp_identity: tuple[int, int, int] | None = None
    hash_temp_fd = -1
    hash_temp_name: str | None = None
    hash_temp_identity: tuple[int, int, int] | None = None
    try:
        config_temp_fd, config_temp_name, config_temp_identity = stage_owner_file(
            root_fd,
            CONFIG_NAME,
            source_content,
            expected_uid,
            expected_gid,
            0o660,
        )
        digest = hashlib.sha256(source_content).hexdigest()
        hash_content = f"{digest}  {CONFIG_NAME}\n".encode("ascii")
        hash_temp_fd, hash_temp_name, hash_temp_identity = stage_owner_file(
            root_fd,
            HASH_NAME,
            hash_content,
            expected_uid,
            expected_gid,
            0o660,
        )

        current_active = os.stat(
            CONFIG_NAME, dir_fd=root_fd, follow_symlinks=False
        )
        current_config_temp = os.stat(
            config_temp_name, dir_fd=root_fd, follow_symlinks=False
        )
        current_hash_temp = os.stat(
            hash_temp_name, dir_fd=root_fd, follow_symlinks=False
        )
        if (
            stable_file_key(current_active) != stable_file_key(active[1])
            or inode_key(current_config_temp) != config_temp_identity
            or inode_key(current_hash_temp) != hash_temp_identity
            or not config_dir_matches(
                root_fd, config_dir, expected_uid, expected_gid
            )
        ):
            raise UnsafeTree()

        os.replace(
            config_temp_name,
            CONFIG_NAME,
            src_dir_fd=root_fd,
            dst_dir_fd=root_fd,
        )
        config_temp_name = None
        os.replace(
            hash_temp_name,
            HASH_NAME,
            src_dir_fd=root_fd,
            dst_dir_fd=root_fd,
        )
        hash_temp_name = None
        os.fsync(root_fd)
        verify_fixed_files(root_fd, expected_uid, expected_gid)
        installed_config = os.stat(
            CONFIG_NAME, dir_fd=root_fd, follow_symlinks=False
        )
        installed_hash = os.stat(
            HASH_NAME, dir_fd=root_fd, follow_symlinks=False
        )
        if (
            inode_key(installed_config) != inode_key(os.fstat(config_temp_fd))
            or inode_key(installed_hash) != inode_key(os.fstat(hash_temp_fd))
            or not config_dir_matches(
                root_fd, config_dir, expected_uid, expected_gid
            )
        ):
            raise UnsafeTree()
    finally:
        cleanup_staged_file(
            root_fd,
            config_temp_fd,
            config_temp_name,
            config_temp_identity,
        )
        cleanup_staged_file(
            root_fd,
            hash_temp_fd,
            hash_temp_name,
            hash_temp_identity,
        )
    print(
        f"[config] openclaw.json restored from {config_dir}/{source_name} "
        "(was empty — see #3118)",
        file=sys.stderr,
    )


def normalize_owner_tree(
    config_dir: str,
    expected_uid: int,
    expected_gid: int,
    *,
    capture_baseline: bool = False,
    recover_config: bool = False,
    node_binary: str = "",
    json5_module: str = "",
) -> tuple[int, int | None]:
    root_fd = -1
    capture_source_fd: int | None = None
    try:
        root_fd = os.open(config_dir, directory_flags())
        root_metadata = os.fstat(root_fd)
        if (
            not stat.S_ISDIR(root_metadata.st_mode)
            or root_metadata.st_uid != expected_uid
            or root_metadata.st_gid != expected_gid
        ):
            raise UnsafeTree()
        # Reject unsafe fixed-file metadata before recursive normalization can
        # mutate an earlier nonfixed alias of the same inode.
        verify_fixed_files(
            root_fd,
            expected_uid,
            expected_gid,
            expected_mode=None,
        )
        normalize_dir(root_fd, top_level=True)
        set_mode(root_fd, 0o2770, required=True)
        verify_fixed_files(root_fd, expected_uid, expected_gid)
        if recover_config:
            recover_empty_config(
                root_fd,
                config_dir,
                expected_uid,
                expected_gid,
            )
        if capture_baseline:
            capture_source_fd = open_baseline_capture_source(
                root_fd,
                config_dir,
                expected_uid,
                expected_gid,
                node_binary,
                json5_module,
            )
        if not config_dir_matches(root_fd, config_dir, expected_uid, expected_gid):
            raise UnsafeTree()
        return root_fd, capture_source_fd
    except Exception:
        if capture_source_fd is not None:
            os.close(capture_source_fd)
        if root_fd >= 0:
            os.close(root_fd)
        raise


def read_capabilities() -> dict[str, int]:
    values: dict[str, int] = {}
    with open("/proc/self/status", encoding="ascii") as status_file:
        for line in status_file:
            label, separator, value = line.partition(":")
            if separator and label in {"CapEff", "CapPrm", "CapAmb"}:
                values[label] = int(value.strip(), 16)
    if values.keys() != {"CapEff", "CapPrm", "CapAmb"}:
        raise UnsafeTree()
    return values


def drop_to_owner(expected_uid: int, expected_gid: int) -> None:
    try:
        os.setgroups([expected_gid])
        os.setresgid(expected_gid, expected_gid, expected_gid)
        os.setresuid(expected_uid, expected_uid, expected_uid)
    except PermissionError as exc:
        print(
            "[SECURITY] CAP_SETGID and CAP_SETUID are required for sandbox-owned config repair",
            file=sys.stderr,
        )
        raise UnsafeTree() from exc
    if (
        os.getresuid() != (expected_uid, expected_uid, expected_uid)
        or os.getresgid() != (expected_gid, expected_gid, expected_gid)
        or os.getgroups() != [expected_gid]
        or any(read_capabilities().values())
    ):
        raise UnsafeTree()


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError()
        view = view[written:]


def lock_recovery_baseline(
    root_fd: int,
    config_dir: str,
    sandbox_uid: int,
    sandbox_gid: int,
) -> None:
    root_metadata = os.fstat(root_fd)
    baseline_fd = -1
    temp_fd = -1
    temp_name: str | None = None
    temp_identity: tuple[int, int, int] | None = None
    locked_baseline_fd = -1
    try:
        if not config_dir_matches(root_fd, config_dir, sandbox_uid, sandbox_gid):
            raise UnsafeTree()
        verify_fixed_files(root_fd, sandbox_uid, sandbox_gid)
        try:
            before = os.stat(
                BASELINE_NAME, dir_fd=root_fd, follow_symlinks=False
            )
        except FileNotFoundError:
            # Expected before the first successful post-override capture. There
            # is no recovery source to lock yet, and normal startup must remain
            # quiet; capture mode creates the baseline through a fresh inode.
            before = None

        if before is not None:
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_dev != root_metadata.st_dev
            ):
                raise UnsafeTree()
            baseline_fd = os.open(BASELINE_NAME, file_flags(), dir_fd=root_fd)
            opened = os.fstat(baseline_fd)
            if stable_file_key(opened) != stable_file_key(before):
                raise UnsafeTree()

            if opened.st_uid == 0:
                if (
                    opened.st_gid != sandbox_gid
                    or stat.S_IMODE(opened.st_mode) != 0o440
                    or opened.st_nlink != 1
                    or opened.st_size <= 0
                    or opened.st_size > MAX_BASELINE_BYTES
                ):
                    raise UnsafeTree()
                current = os.stat(
                    BASELINE_NAME, dir_fd=root_fd, follow_symlinks=False
                )
                if stable_file_key(current) != stable_file_key(opened):
                    raise UnsafeTree()
                locked_baseline_fd = baseline_fd
            elif opened.st_uid == sandbox_uid:
                if (
                    opened.st_gid != sandbox_gid
                    or opened.st_size <= 0
                    or opened.st_size > MAX_BASELINE_BYTES
                ):
                    raise UnsafeTree()

                temp_name = (
                    f".{BASELINE_NAME}.nemoclaw-{secrets.token_hex(12)}.tmp"
                )
                temp_fd = os.open(
                    temp_name,
                    os.O_WRONLY
                    | os.O_CREAT
                    | os.O_EXCL
                    | os.O_CLOEXEC
                    | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                    dir_fd=root_fd,
                )
                temp_identity = inode_key(os.fstat(temp_fd))

                remaining = opened.st_size
                while remaining:
                    chunk = os.read(baseline_fd, min(1024 * 1024, remaining))
                    if not chunk:
                        raise UnsafeTree()
                    write_all(temp_fd, chunk)
                    remaining -= len(chunk)
                if os.read(baseline_fd, 1):
                    raise UnsafeTree()

                after_read = os.fstat(baseline_fd)
                current = os.stat(
                    BASELINE_NAME, dir_fd=root_fd, follow_symlinks=False
                )
                if (
                    stable_file_key(after_read) != stable_file_key(opened)
                    or stable_file_key(current) != stable_file_key(opened)
                    or not config_dir_matches(
                        root_fd, config_dir, sandbox_uid, sandbox_gid
                    )
                ):
                    raise UnsafeTree()
                os.fchown(temp_fd, 0, sandbox_gid)
                os.fchmod(temp_fd, 0o440)
                os.fsync(temp_fd)
                staged = os.fstat(temp_fd)
                if (
                    staged.st_dev != root_metadata.st_dev
                    or staged.st_uid != 0
                    or staged.st_gid != sandbox_gid
                    or stat.S_IMODE(staged.st_mode) != 0o440
                    or staged.st_nlink != 1
                ):
                    raise UnsafeTree()

                final_source = os.fstat(baseline_fd)
                current = os.stat(
                    BASELINE_NAME, dir_fd=root_fd, follow_symlinks=False
                )
                if (
                    stable_file_key(final_source) != stable_file_key(opened)
                    or stable_file_key(current) != stable_file_key(opened)
                    or not config_dir_matches(
                        root_fd, config_dir, sandbox_uid, sandbox_gid
                    )
                ):
                    raise UnsafeTree()

                os.replace(
                    temp_name,
                    BASELINE_NAME,
                    src_dir_fd=root_fd,
                    dst_dir_fd=root_fd,
                )
                temp_name = None
                os.fsync(root_fd)
                replacement_fd_metadata = os.fstat(temp_fd)
                replacement_path_metadata = os.stat(
                    BASELINE_NAME, dir_fd=root_fd, follow_symlinks=False
                )
                if (
                    inode_key(replacement_path_metadata)
                    != inode_key(replacement_fd_metadata)
                    or replacement_fd_metadata.st_uid != 0
                    or replacement_fd_metadata.st_gid != sandbox_gid
                    or stat.S_IMODE(replacement_fd_metadata.st_mode) != 0o440
                    or replacement_fd_metadata.st_nlink != 1
                ):
                    raise UnsafeTree()
                locked_baseline_fd = temp_fd
            else:
                raise UnsafeTree()

        if locked_baseline_fd >= 0:
            final_baseline = os.fstat(locked_baseline_fd)
            current_baseline = os.stat(
                BASELINE_NAME, dir_fd=root_fd, follow_symlinks=False
            )
            if (
                inode_key(current_baseline) != inode_key(final_baseline)
                or final_baseline.st_dev != root_metadata.st_dev
                or final_baseline.st_uid != 0
                or final_baseline.st_gid != sandbox_gid
                or stat.S_IMODE(final_baseline.st_mode) != 0o440
                or final_baseline.st_nlink != 1
            ):
                raise UnsafeTree()
        verify_fixed_files(root_fd, sandbox_uid, sandbox_gid)
        if not config_dir_matches(root_fd, config_dir, sandbox_uid, sandbox_gid):
            raise UnsafeTree()
    finally:
        if baseline_fd >= 0:
            os.close(baseline_fd)
        if (
            temp_name is not None
            and temp_fd >= 0
            and temp_identity is not None
        ):
            try:
                opened_temp = os.fstat(temp_fd)
                current_temp = os.stat(
                    temp_name, dir_fd=root_fd, follow_symlinks=False
                )
                if (
                    inode_key(opened_temp) == temp_identity
                    and inode_key(current_temp) == temp_identity
                    and opened_temp.st_nlink == 1
                ):
                    os.unlink(temp_name, dir_fd=root_fd)
                    os.fsync(root_fd)
            except OSError:
                # Best-effort cleanup must not replace the operation's primary failure.
                pass
        if temp_fd >= 0:
            os.close(temp_fd)


def capture_recovery_baseline(
    root_fd: int,
    config_dir: str,
    sandbox_uid: int,
    sandbox_gid: int,
    source_fd: int | None,
    node_binary: str,
    json5_module: str,
) -> None:
    if source_fd is None:
        verify_fixed_files(root_fd, sandbox_uid, sandbox_gid)
        if not config_dir_matches(root_fd, config_dir, sandbox_uid, sandbox_gid):
            raise UnsafeTree()
        return

    root_metadata = os.fstat(root_fd)
    pinned_source_fd = os.dup(source_fd)
    temp_fd = -1
    temp_name: str | None = None
    temp_identity: tuple[int, int, int] | None = None
    try:
        source = os.fstat(pinned_source_fd)
        current_source = os.stat(
            CONFIG_NAME, dir_fd=root_fd, follow_symlinks=False
        )
        if (
            not stat.S_ISREG(source.st_mode)
            or source.st_dev != root_metadata.st_dev
            or source.st_uid != sandbox_uid
            or source.st_gid != sandbox_gid
            or stat.S_IMODE(source.st_mode) != 0o660
            or source.st_nlink != 1
            or source.st_size <= 0
            or source.st_size > MAX_BASELINE_BYTES
            or stable_file_key(current_source) != stable_file_key(source)
        ):
            raise UnsafeTree()

        temp_name = f".{BASELINE_NAME}.nemoclaw-{secrets.token_hex(12)}.tmp"
        temp_fd = os.open(
            temp_name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_CLOEXEC
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=root_fd,
        )
        temp_identity = inode_key(os.fstat(temp_fd))

        os.lseek(pinned_source_fd, 0, os.SEEK_SET)
        remaining = source.st_size
        content = bytearray()
        while remaining:
            chunk = os.read(pinned_source_fd, min(1024 * 1024, remaining))
            if not chunk:
                raise UnsafeTree()
            content.extend(chunk)
            write_all(temp_fd, chunk)
            remaining -= len(chunk)
        if os.read(pinned_source_fd, 1):
            raise UnsafeTree()

        after_read = os.fstat(pinned_source_fd)
        current_source = os.stat(
            CONFIG_NAME, dir_fd=root_fd, follow_symlinks=False
        )
        if (
            stable_file_key(after_read) != stable_file_key(source)
            or stable_file_key(current_source) != stable_file_key(source)
            or not config_dir_matches(
                root_fd, config_dir, sandbox_uid, sandbox_gid
            )
            or not validate_json5(
                bytes(content),
                node_binary,
                json5_module,
                drop_uid=sandbox_uid,
                drop_gid=sandbox_gid,
            )
        ):
            raise UnsafeTree()

        os.fchown(temp_fd, 0, sandbox_gid)
        os.fchmod(temp_fd, 0o440)
        os.fsync(temp_fd)
        staged = os.fstat(temp_fd)
        current_temp = os.stat(
            temp_name, dir_fd=root_fd, follow_symlinks=False
        )
        final_source = os.fstat(pinned_source_fd)
        current_source = os.stat(
            CONFIG_NAME, dir_fd=root_fd, follow_symlinks=False
        )
        if (
            inode_key(staged) != temp_identity
            or inode_key(current_temp) != temp_identity
            or staged.st_dev != root_metadata.st_dev
            or staged.st_uid != 0
            or staged.st_gid != sandbox_gid
            or stat.S_IMODE(staged.st_mode) != 0o440
            or staged.st_nlink != 1
            or stable_file_key(final_source) != stable_file_key(source)
            or stable_file_key(current_source) != stable_file_key(source)
            or not config_dir_matches(
                root_fd, config_dir, sandbox_uid, sandbox_gid
            )
        ):
            raise UnsafeTree()

        os.replace(
            temp_name,
            BASELINE_NAME,
            src_dir_fd=root_fd,
            dst_dir_fd=root_fd,
        )
        temp_name = None
        os.fsync(root_fd)
        installed = os.fstat(temp_fd)
        current_installed = os.stat(
            BASELINE_NAME, dir_fd=root_fd, follow_symlinks=False
        )
        if (
            inode_key(current_installed) != inode_key(installed)
            or installed.st_uid != 0
            or installed.st_gid != sandbox_gid
            or stat.S_IMODE(installed.st_mode) != 0o440
            or installed.st_nlink != 1
        ):
            raise UnsafeTree()
        verify_fixed_files(root_fd, sandbox_uid, sandbox_gid)
        if not config_dir_matches(root_fd, config_dir, sandbox_uid, sandbox_gid):
            raise UnsafeTree()
    finally:
        os.close(pinned_source_fd)
        if (
            temp_name is not None
            and temp_fd >= 0
            and temp_identity is not None
        ):
            try:
                opened_temp = os.fstat(temp_fd)
                current_temp = os.stat(
                    temp_name, dir_fd=root_fd, follow_symlinks=False
                )
                if (
                    inode_key(opened_temp) == temp_identity
                    and inode_key(current_temp) == temp_identity
                    and opened_temp.st_nlink == 1
                ):
                    os.unlink(temp_name, dir_fd=root_fd)
                    os.fsync(root_fd)
            except OSError:
                # Best-effort cleanup must not replace the operation's primary failure.
                pass
        if temp_fd >= 0:
            os.close(temp_fd)


def close_fds(fds: list[int]) -> None:
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            # Rejecting malformed ancillary data may encounter duplicate closed FDs.
            pass


def receive_owner_fd(
    parent_socket: socket.socket,
    child_pid: int,
    expected_uid: int,
    expected_gid: int,
    *,
    capture_baseline: bool,
) -> tuple[int, int | None]:
    fd_size = array.array("i").itemsize
    credentials_size = struct.calcsize("3i")
    ancillary_size = socket.CMSG_SPACE(2 * fd_size) + socket.CMSG_SPACE(
        credentials_size
    )
    message, ancillary, flags, _address = parent_socket.recvmsg(
        READY_MESSAGE_SIZE,
        ancillary_size,
        getattr(socket, "MSG_CMSG_CLOEXEC", 0),
    )
    received_fds: list[int] = []
    credentials: list[tuple[int, int, int]] = []
    rights_records = 0
    credentials_records = 0
    try:
        for level, kind, data in ancillary:
            if level != socket.SOL_SOCKET:
                raise UnsafeTree()
            if kind == socket.SCM_RIGHTS:
                rights_records += 1
                values = array.array("i")
                usable = len(data) - (len(data) % fd_size)
                values.frombytes(data[:usable])
                received_fds.extend(values)
                if len(data) not in {fd_size, 2 * fd_size}:
                    raise UnsafeTree()
            elif kind == socket.SCM_CREDENTIALS:
                credentials_records += 1
                if len(data) != credentials_size:
                    raise UnsafeTree()
                credentials.append(struct.unpack("3i", data))
            else:
                raise UnsafeTree()
        if capture_baseline:
            if message == READY_CAPTURE_SOURCE:
                expected_fd_count = 2
            elif message == READY_CAPTURE_EMPTY:
                expected_fd_count = 1
            else:
                raise UnsafeTree()
        else:
            if message != READY_NORMAL:
                raise UnsafeTree()
            expected_fd_count = 1
        if (
            len(message) != READY_MESSAGE_SIZE
            or (
                flags
                & (
                    getattr(socket, "MSG_TRUNC", 0)
                    | getattr(socket, "MSG_CTRUNC", 0)
                )
            )
            or rights_records != 1
            or credentials_records != 1
            or len(received_fds) != expected_fd_count
            or credentials != [(child_pid, expected_uid, expected_gid)]
        ):
            raise UnsafeTree()
        for received_fd in received_fds:
            os.set_inheritable(received_fd, False)
        root_fd = received_fds[0]
        capture_source_fd = received_fds[1] if expected_fd_count == 2 else None
        received_fds.clear()
        return root_fd, capture_source_fd
    finally:
        close_fds(received_fds)


def run_root_supervisor(
    config_dir: str,
    sandbox_uid: int,
    sandbox_gid: int,
    *,
    capture_baseline: bool = False,
    recover_config: bool = False,
    node_binary: str = "",
    json5_module: str = "",
) -> None:
    try:
        if os.getgroups() != [sandbox_gid]:
            os.setgroups([sandbox_gid])
    except PermissionError as exc:
        print(
            "[SECURITY] CAP_SETGID is required for sandbox-owned config repair",
            file=sys.stderr,
        )
        raise UnsafeTree() from exc
    if os.getgroups() != [sandbox_gid]:
        raise UnsafeTree()

    parent_socket, child_socket = socket.socketpair(
        socket.AF_UNIX, socket.SOCK_SEQPACKET
    )
    try:
        parent_socket.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        child_pid = os.fork()
    except Exception:
        parent_socket.close()
        child_socket.close()
        raise
    if child_pid == 0:
        parent_socket.close()
        root_fd = -1
        capture_source_fd: int | None = None
        try:
            drop_to_owner(sandbox_uid, sandbox_gid)
            root_fd, capture_source_fd = normalize_owner_tree(
                config_dir,
                sandbox_uid,
                sandbox_gid,
                capture_baseline=capture_baseline,
                recover_config=recover_config,
                node_binary=node_binary,
                json5_module=json5_module,
            )
            rights_fds = [root_fd]
            if capture_baseline:
                if capture_source_fd is None:
                    ready_message = READY_CAPTURE_EMPTY
                else:
                    ready_message = READY_CAPTURE_SOURCE
                    rights_fds.append(capture_source_fd)
            else:
                if capture_source_fd is not None:
                    raise UnsafeTree()
                ready_message = READY_NORMAL
            rights = array.array("i", rights_fds)
            sent = child_socket.sendmsg(
                [ready_message],
                [(socket.SOL_SOCKET, socket.SCM_RIGHTS, rights)],
            )
            if sent != len(ready_message):
                raise UnsafeTree()
            exit_code = 0
        except (KeyError, OSError, UnsafeTree):
            exit_code = 1
        finally:
            if capture_source_fd is not None:
                os.close(capture_source_fd)
            if root_fd >= 0:
                os.close(root_fd)
            child_socket.close()
        os._exit(exit_code)

    child_socket.close()
    root_fd = -1
    capture_source_fd: int | None = None
    child_reaped = False
    try:
        try:
            root_fd, capture_source_fd = receive_owner_fd(
                parent_socket,
                child_pid,
                sandbox_uid,
                sandbox_gid,
                capture_baseline=capture_baseline,
            )
        finally:
            parent_socket.close()
        waited_pid, child_status = os.waitpid(child_pid, 0)
        child_reaped = True
        if (
            waited_pid != child_pid
            or not os.WIFEXITED(child_status)
            or os.WEXITSTATUS(child_status) != 0
        ):
            raise UnsafeTree()
        if not config_dir_matches(root_fd, config_dir, sandbox_uid, sandbox_gid):
            raise UnsafeTree()
        verify_fixed_files(root_fd, sandbox_uid, sandbox_gid)
        if capture_baseline:
            capture_recovery_baseline(
                root_fd,
                config_dir,
                sandbox_uid,
                sandbox_gid,
                capture_source_fd,
                node_binary,
                json5_module,
            )
        else:
            lock_recovery_baseline(
                root_fd,
                config_dir,
                sandbox_uid,
                sandbox_gid,
            )
    finally:
        if not child_reaped:
            try:
                os.waitpid(child_pid, 0)
            except ChildProcessError:
                # The child was already reaped while handling the primary failure.
                pass
        if root_fd >= 0:
            os.close(root_fd)
        if capture_source_fd is not None:
            os.close(capture_source_fd)


def main() -> int:
    if len(sys.argv) not in {4, 5, 7}:
        return 1
    config_dir = sys.argv[1]
    try:
        expected_uid = int(sys.argv[2])
        expected_gid = int(sys.argv[3])
    except ValueError:
        return 1
    capture_baseline = len(sys.argv) == 7
    recover_config = len(sys.argv) == 5
    if capture_baseline:
        if sys.argv[4] != "capture":
            return 1
        node_binary = sys.argv[5]
        json5_module = sys.argv[6]
    elif recover_config:
        if sys.argv[4] != "recover":
            return 1
        node_binary = ""
        json5_module = ""
    else:
        node_binary = ""
        json5_module = ""

    try:
        if os.geteuid() == 0:
            sandbox_uid = pwd.getpwnam("sandbox").pw_uid
            sandbox_gid = grp.getgrnam("sandbox").gr_gid
            if (expected_uid, expected_gid) != (sandbox_uid, sandbox_gid):
                raise UnsafeTree()
            run_root_supervisor(
                config_dir,
                sandbox_uid,
                sandbox_gid,
                capture_baseline=capture_baseline,
                recover_config=recover_config,
                node_binary=node_binary,
                json5_module=json5_module,
            )
        else:
            if (expected_uid, expected_gid) != (os.geteuid(), os.getegid()):
                raise UnsafeTree()
            root_fd, capture_source_fd = normalize_owner_tree(
                config_dir,
                expected_uid,
                expected_gid,
                capture_baseline=capture_baseline,
                recover_config=recover_config,
                node_binary=node_binary,
                json5_module=json5_module,
            )
            try:
                verify_fixed_files(root_fd, expected_uid, expected_gid)
                if not config_dir_matches(
                    root_fd, config_dir, expected_uid, expected_gid
                ):
                    raise UnsafeTree()
            finally:
                if capture_source_fd is not None:
                    os.close(capture_source_fd)
                os.close(root_fd)
    except (AttributeError, KeyError, OSError, UnsafeTree):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
