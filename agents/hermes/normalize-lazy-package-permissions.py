# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Make sandbox-installed Hermes lazy packages readable by the gateway group."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path


DIRECTORY_MODE = 0o750
REGULAR_FILE_MODE = 0o640
EXECUTABLE_FILE_MODE = 0o750
MAX_ENTRIES = 200_000
MAX_DEPTH = 128
TARGET_ENV = "HERMES_LAZY_INSTALL_TARGET"


class PermissionNormalizationError(RuntimeError):
    """The lazy-package tree could not be normalized without broadening trust."""


def _open_flags(*, directory: bool) -> int:
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    if directory:
        flags |= os.O_DIRECTORY
    return flags


def _assert_owned_entry(entry: os.stat_result, root: os.stat_result, relative: str) -> None:
    if entry.st_dev != root.st_dev:
        raise PermissionNormalizationError(f"cross-filesystem entry: {relative}")
    if entry.st_uid != root.st_uid or entry.st_gid != root.st_gid:
        raise PermissionNormalizationError(f"foreign-owned entry: {relative}")


def _normalize_directory(
    directory_fd: int,
    root: os.stat_result,
    relative: str,
    depth: int,
    budget: list[int],
) -> None:
    if depth > MAX_DEPTH:
        raise PermissionNormalizationError(f"lazy-package tree exceeds depth limit: {relative}")

    before = os.fstat(directory_fd)
    _assert_owned_entry(before, root, relative)
    if not stat.S_ISDIR(before.st_mode):
        raise PermissionNormalizationError(f"expected directory: {relative}")

    names: list[str] = []
    with os.scandir(directory_fd) as entries:
        for entry in entries:
            budget[0] += 1
            if budget[0] > MAX_ENTRIES:
                raise PermissionNormalizationError(
                    "lazy-package tree exceeds entry limit"
                )
            names.append(entry.name)
    names.sort()

    for name in names:
        child_relative = name if relative == "." else f"{relative}/{name}"
        observed = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISLNK(observed.st_mode):
            # Package symlinks are left untouched. Their in-tree targets are
            # normalized through their real directory entries; an external
            # target never gains permissions through this operation.
            continue

        is_directory = stat.S_ISDIR(observed.st_mode)
        if not is_directory and not stat.S_ISREG(observed.st_mode):
            raise PermissionNormalizationError(f"unsupported entry type: {child_relative}")
        child_fd = os.open(name, _open_flags(directory=is_directory), dir_fd=directory_fd)
        try:
            opened = os.fstat(child_fd)
            if (
                opened.st_dev != observed.st_dev
                or opened.st_ino != observed.st_ino
                or stat.S_IFMT(opened.st_mode) != stat.S_IFMT(observed.st_mode)
            ):
                raise PermissionNormalizationError(
                    f"entry changed during normalization: {child_relative}"
                )
            _assert_owned_entry(opened, root, child_relative)
            if is_directory:
                _normalize_directory(child_fd, root, child_relative, depth + 1, budget)
            else:
                if opened.st_nlink != 1:
                    raise PermissionNormalizationError(f"hardlinked file: {child_relative}")
                mode = (
                    EXECUTABLE_FILE_MODE
                    if stat.S_IMODE(opened.st_mode) & 0o111
                    else REGULAR_FILE_MODE
                )
                os.fchmod(child_fd, mode)
        finally:
            os.close(child_fd)

    after = os.fstat(directory_fd)
    if after.st_mtime_ns != before.st_mtime_ns:
        raise PermissionNormalizationError(f"directory changed during normalization: {relative}")
    os.fchmod(directory_fd, DIRECTORY_MODE)


def normalize_lazy_package_permissions(target: Path) -> None:
    """Normalize one sandbox-owned lazy target without following path links."""

    if os.geteuid() == 0:
        raise PermissionNormalizationError("refusing privileged permission normalization")

    configured = os.environ.get(TARGET_ENV, "")
    if not configured or not os.path.isabs(configured):
        raise PermissionNormalizationError(f"{TARGET_ENV} must name an absolute path")
    configured_path = os.path.normpath(configured)
    requested_path = os.path.normpath(os.fspath(target))
    if requested_path != configured_path:
        raise PermissionNormalizationError("requested target does not match managed lazy target")

    root_fd = os.open(requested_path, _open_flags(directory=True))
    try:
        root = os.fstat(root_fd)
        if root.st_uid != os.geteuid() or root.st_gid != os.getegid():
            raise PermissionNormalizationError("lazy target is not owned by the installer identity")
        _normalize_directory(root_fd, root, ".", 0, [0])
    finally:
        os.close(root_fd)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} TARGET", file=sys.stderr)
        return 2
    try:
        normalize_lazy_package_permissions(Path(argv[1]))
    except (OSError, PermissionNormalizationError) as error:
        print(f"[SECURITY] Hermes lazy-package permission normalization failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
