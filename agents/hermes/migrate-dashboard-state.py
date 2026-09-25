#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Retire Hermes' legacy dashboard homes without losing agent-owned state.

The dashboard now uses the native Hermes home. Older images wrote durable
state below ``dashboard-home`` or ``profiles/dashboard-home``. Merge those
trees into the native home only when every path is a real directory or a
single-link regular file and every destination collision is byte-identical.
Generated shadow configuration is deliberately removed rather than allowed to
replace the native configuration.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import os
import stat
import sys
from dataclasses import dataclass


MANAGED_SHADOW_FILES = frozenset(
    {
        ".config-hash",
        ".env-hash",
        ".runtime-config-state.json",
        "gateway_state.json",
    }
)
LEGACY_PATHS = ("dashboard-home", "profiles/dashboard-home")
DEFAULT_MAX_ENTRIES = 100_000
DEFAULT_MAX_DEPTH = 64
DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024


class MigrationError(Exception):
    """A legacy tree cannot be migrated without guessing or following links."""


@dataclass(frozen=True)
class EntryIdentity:
    device: int
    inode: int
    mode: int
    links: int
    size: int


@dataclass
class MigrationBudget:
    max_entries: int
    max_depth: int
    max_bytes: int
    entries: int = 0
    total_bytes: int = 0

    def consume(self, entry: EntryIdentity, display: str, depth: int) -> None:
        if depth > self.max_depth:
            raise MigrationError(
                f"legacy dashboard state exceeds maximum depth {self.max_depth} at {display}"
            )
        self.entries += 1
        if self.entries > self.max_entries:
            raise MigrationError(
                f"legacy dashboard state exceeds maximum entry count {self.max_entries}"
            )
        if stat.S_ISREG(entry.mode):
            self.total_bytes += entry.size
            if self.total_bytes > self.max_bytes:
                raise MigrationError(
                    f"legacy dashboard state exceeds maximum byte count {self.max_bytes}"
                )


def _identity(parent_fd: int, name: str, display: str) -> EntryIdentity:
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as exc:
        raise MigrationError(f"{display} could not be inspected: {exc.strerror}") from exc
    if stat.S_ISLNK(current.st_mode):
        raise MigrationError(f"{display} is a symbolic link")
    if not stat.S_ISDIR(current.st_mode) and not stat.S_ISREG(current.st_mode):
        raise MigrationError(f"{display} is not a regular file or directory")
    if stat.S_ISREG(current.st_mode) and current.st_nlink != 1:
        raise MigrationError(f"{display} has hard-link count {current.st_nlink}")
    return EntryIdentity(
        current.st_dev,
        current.st_ino,
        current.st_mode,
        current.st_nlink,
        current.st_size,
    )


def _open_dir(parent_fd: int, name: str, display: str) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    flags |= getattr(os, "O_CLOEXEC", 0)
    try:
        return os.open(name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise MigrationError(f"{display} is not a safe directory: {exc.strerror}") from exc


def _open_file(parent_fd: int, name: str, display: str) -> int:
    flags = os.O_RDONLY | os.O_NOFOLLOW
    flags |= getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise MigrationError(f"{display} is not a safe regular file: {exc.strerror}") from exc
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise MigrationError(f"{display} is not a single-link regular file")
    except BaseException:
        os.close(fd)
        raise
    return fd


def _same_file(
    source_fd: int,
    source_name: str,
    source_display: str,
    target_fd: int,
    target_name: str,
    target_display: str,
) -> bool:
    left = _open_file(source_fd, source_name, source_display)
    try:
        right = _open_file(target_fd, target_name, target_display)
        try:
            if os.fstat(left).st_size != os.fstat(right).st_size:
                return False
            while True:
                left_chunk = os.read(left, 64 * 1024)
                right_chunk = os.read(right, 64 * 1024)
                if left_chunk != right_chunk:
                    return False
                if not left_chunk:
                    return True
        finally:
            os.close(right)
    finally:
        os.close(left)


def _entries(fd: int) -> list[str]:
    try:
        return sorted(os.listdir(fd))
    except OSError as exc:
        raise MigrationError(f"legacy dashboard state could not be listed: {exc.strerror}") from exc


def _lookup(parent_fd: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def _preflight_tree(
    source_fd: int,
    source_display: str,
    target_fd: int,
    target_display: str,
    budget: MigrationBudget,
    depth: int,
) -> None:
    for name in _entries(source_fd):
        source_path = f"{source_display}/{name}"
        target_path = f"{target_display}/{name}"
        source = _identity(source_fd, name, source_path)
        budget.consume(source, source_path, depth)
        if source_display.rsplit("/", 1)[-1] == "dashboard-home" and name in MANAGED_SHADOW_FILES:
            if not stat.S_ISREG(source.mode):
                raise MigrationError(f"generated shadow path {source_path} is not a regular file")
            continue
        target = _lookup(target_fd, name)
        if target is None:
            if stat.S_ISDIR(source.mode):
                child = _open_dir(source_fd, name, source_path)
                try:
                    _preflight_tree(child, source_path, child, source_path, budget, depth + 1)
                finally:
                    os.close(child)
            continue
        target_identity = _identity(target_fd, name, target_path)
        if stat.S_ISDIR(source.mode) and stat.S_ISDIR(target_identity.mode):
            source_child = _open_dir(source_fd, name, source_path)
            try:
                target_child = _open_dir(target_fd, name, target_path)
                try:
                    _preflight_tree(
                        source_child,
                        source_path,
                        target_child,
                        target_path,
                        budget,
                        depth + 1,
                    )
                finally:
                    os.close(target_child)
            finally:
                os.close(source_child)
            continue
        if stat.S_ISREG(source.mode) and stat.S_ISREG(target_identity.mode):
            if _same_file(source_fd, name, source_path, target_fd, name, target_path):
                continue
            raise MigrationError(
                f"legacy dashboard state conflicts with native state at {target_path}"
            )
        raise MigrationError(f"legacy dashboard state has a type conflict at {target_path}")


def _rename_no_replace(
    source_fd: int, name: str, target_fd: int, target_name: str | None = None
) -> None:
    import ctypes

    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename_no_replace = getattr(libc, "renameatx_np", None)
        flag = 0x00000004
        unavailable = "renameatx_np is unavailable"
    else:
        rename_no_replace = getattr(libc, "renameat2", None)
        flag = 1
        unavailable = "renameat2 is unavailable"
    if rename_no_replace is None:
        raise OSError(errno.ENOSYS, unavailable)
    rename_no_replace.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    rename_no_replace.restype = ctypes.c_int
    encoded_source = os.fsencode(name)
    encoded_target = os.fsencode(target_name if target_name is not None else name)
    if rename_no_replace(source_fd, encoded_source, target_fd, encoded_target, flag) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))


def _matches(identity: EntryIdentity, current: os.stat_result) -> bool:
    return (
        (current.st_dev, current.st_ino) == (identity.device, identity.inode)
        and stat.S_IFMT(current.st_mode) == stat.S_IFMT(identity.mode)
        and (not stat.S_ISREG(current.st_mode) or current.st_nlink == 1)
    )


def _move_no_replace_verified(
    source_fd: int,
    name: str,
    source_display: str,
    target_fd: int,
    target_display: str,
) -> None:
    before = _identity(source_fd, name, source_display)
    try:
        _rename_no_replace(source_fd, name, target_fd)
    except OSError as exc:
        raise MigrationError(f"{source_display} could not be moved safely: {exc.strerror}") from exc
    try:
        moved = os.stat(name, dir_fd=target_fd, follow_symlinks=False)
    except OSError as exc:
        raise MigrationError(
            f"{target_display} disappeared after migration: {exc.strerror}"
        ) from exc
    if _matches(before, moved):
        return
    try:
        _rename_no_replace(target_fd, name, source_fd)
    except OSError as rollback:
        raise MigrationError(
            f"{source_display} changed during migration and rollback failed: {rollback.strerror}"
        ) from rollback
    raise MigrationError(f"{source_display} changed during migration")


def _unlink_verified(parent_fd: int, name: str, display: str) -> None:
    before = _identity(parent_fd, name, display)
    if not stat.S_ISREG(before.mode):
        raise MigrationError(f"{display} is not a regular file")
    quarantine = ".nemoclaw-dashboard-migration-" + hashlib.sha256(
        os.fsencode(name)
    ).hexdigest()[:24]
    try:
        _rename_no_replace(parent_fd, name, parent_fd, quarantine)
    except OSError as exc:
        raise MigrationError(f"{display} could not be quarantined safely: {exc.strerror}") from exc
    moved = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
    if not _matches(before, moved):
        try:
            _rename_no_replace(parent_fd, quarantine, parent_fd, name)
        except OSError as rollback:
            raise MigrationError(
                f"{display} changed while it was quarantined and rollback failed: "
                f"{rollback.strerror}"
            ) from rollback
        raise MigrationError(f"{display} changed while it was quarantined")
    os.unlink(quarantine, dir_fd=parent_fd)


def _remove_generated_file(parent_fd: int, name: str, display: str) -> None:
    _unlink_verified(parent_fd, name, display)


def _merge_tree(
    source_fd: int,
    source_display: str,
    target_fd: int,
    target_display: str,
    budget: MigrationBudget,
    depth: int,
) -> None:
    for name in _entries(source_fd):
        source_path = f"{source_display}/{name}"
        target_path = f"{target_display}/{name}"
        source = _identity(source_fd, name, source_path)
        budget.consume(source, source_path, depth)
        if source_display.rsplit("/", 1)[-1] == "dashboard-home" and name in MANAGED_SHADOW_FILES:
            _remove_generated_file(source_fd, name, source_path)
            continue
        target = _lookup(target_fd, name)
        if target is None:
            if stat.S_ISDIR(source.mode):
                os.mkdir(name, stat.S_IMODE(source.mode), dir_fd=target_fd)
                created = _identity(target_fd, name, target_path)
                source_child = _open_dir(source_fd, name, source_path)
                try:
                    target_child = _open_dir(target_fd, name, target_path)
                    try:
                        if not _matches(source, os.fstat(source_child)):
                            raise MigrationError(f"{source_path} changed before migration")
                        if not _matches(created, os.fstat(target_child)):
                            raise MigrationError(f"{target_path} changed while it was created")
                        _merge_tree(
                            source_child,
                            source_path,
                            target_child,
                            target_path,
                            budget,
                            depth + 1,
                        )
                        os.fchmod(target_child, stat.S_IMODE(source.mode))
                    finally:
                        os.close(target_child)
                finally:
                    os.close(source_child)
                os.rmdir(name, dir_fd=source_fd)
            else:
                _move_no_replace_verified(source_fd, name, source_path, target_fd, target_path)
            continue
        target_identity = _identity(target_fd, name, target_path)
        if stat.S_ISDIR(source.mode) and stat.S_ISDIR(target_identity.mode):
            source_child = _open_dir(source_fd, name, source_path)
            try:
                target_child = _open_dir(target_fd, name, target_path)
                try:
                    _merge_tree(
                        source_child,
                        source_path,
                        target_child,
                        target_path,
                        budget,
                        depth + 1,
                    )
                finally:
                    os.close(target_child)
            finally:
                os.close(source_child)
            os.rmdir(name, dir_fd=source_fd)
            continue
        if stat.S_ISREG(source.mode) and stat.S_ISREG(target_identity.mode) and _same_file(
            source_fd, name, source_path, target_fd, name, target_path
        ):
            _unlink_verified(source_fd, name, source_path)
            continue
        raise MigrationError(
            f"legacy dashboard state changed after migration preflight at {source_path}"
        )


def _open_relative_directory(root_fd: int, relative: str) -> int | None:
    current_fd = os.dup(root_fd)
    try:
        for component in relative.split("/"):
            child = _lookup(current_fd, component)
            if child is None:
                os.close(current_fd)
                return None
            next_fd = _open_dir(current_fd, component, relative)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise


def migrate(
    hermes_dir: str,
    *,
    max_entries: int = DEFAULT_MAX_ENTRIES,
    max_depth: int = DEFAULT_MAX_DEPTH,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> bool:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    flags |= getattr(os, "O_CLOEXEC", 0)
    try:
        root_fd = os.open(hermes_dir, flags)
    except OSError as exc:
        raise MigrationError(
            f"native Hermes home {hermes_dir} is not a safe directory: {exc.strerror}"
        ) from exc
    try:
        sources: list[tuple[str, int]] = []
        try:
            for relative in LEGACY_PATHS:
                source_fd = _open_relative_directory(root_fd, relative)
                if source_fd is not None:
                    try:
                        sources.append((relative, source_fd))
                    except BaseException:
                        os.close(source_fd)
                        raise
            populated = [(name, fd) for name, fd in sources if _entries(fd)]
            if len(populated) > 1:
                raise MigrationError(
                    "both legacy dashboard homes contain state; refusing an ambiguous merge"
                )
            preflight_budget = MigrationBudget(max_entries, max_depth, max_bytes)
            for relative, source_fd in sources:
                _preflight_tree(
                    source_fd,
                    f"{hermes_dir}/{relative}",
                    root_fd,
                    hermes_dir,
                    preflight_budget,
                    1,
                )
            merge_budget = MigrationBudget(max_entries, max_depth, max_bytes)
            for relative, source_fd in sources:
                _merge_tree(
                    source_fd,
                    f"{hermes_dir}/{relative}",
                    root_fd,
                    hermes_dir,
                    merge_budget,
                    1,
                )
                parent_relative, name = (
                    relative.rsplit("/", 1) if "/" in relative else ("", relative)
                )
                parent_fd = (
                    root_fd
                    if not parent_relative
                    else _open_relative_directory(root_fd, parent_relative)
                )
                if parent_fd is None:
                    raise MigrationError(f"legacy dashboard parent {parent_relative} disappeared")
                try:
                    os.rmdir(name, dir_fd=parent_fd)
                finally:
                    if parent_fd != root_fd:
                        os.close(parent_fd)
            return bool(sources)
        finally:
            for _, source_fd in sources:
                os.close(source_fd)
    finally:
        os.close(root_fd)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-dir", default="/sandbox/.hermes")
    parser.add_argument("--max-entries", type=int, default=DEFAULT_MAX_ENTRIES)
    parser.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    args = parser.parse_args(argv[1:])
    if args.max_entries < 1 or args.max_depth < 1 or args.max_bytes < 0:
        parser.error("migration limits must be positive (max-bytes may be zero)")
    try:
        changed = migrate(
            args.hermes_dir,
            max_entries=args.max_entries,
            max_depth=args.max_depth,
            max_bytes=args.max_bytes,
        )
    except MigrationError as exc:
        print(
            f"[SECURITY] Refusing legacy Hermes dashboard-state migration: {exc}",
            file=sys.stderr,
        )
        return 1
    if changed:
        print(
            "[dashboard] migrated legacy dashboard state into the native Hermes home",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
