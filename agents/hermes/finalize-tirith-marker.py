#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
import stat
import sys
from collections.abc import Callable
from pathlib import Path

UNCHANGED = 10
UNSAFE = 11
FAILED = 12


def finalize_marker(marker: Path, before_revalidate: Callable[[], None] | None = None) -> int:
    """Remove one unchanged regular download_failed marker without following links."""
    try:
        directory_fd = os.open(marker.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    except OSError:
        return FAILED
    try:
        try:
            marker_fd = os.open(
                marker.name,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=directory_fd,
            )
        except FileNotFoundError:
            return UNCHANGED
        except OSError:
            return UNSAFE

        try:
            opened = os.fstat(marker_fd)
            if not stat.S_ISREG(opened.st_mode):
                return UNSAFE
            reason = os.read(marker_fd, 4096).splitlines()[0:1]
        finally:
            os.close(marker_fd)

        if reason != [b"download_failed"]:
            return UNCHANGED
        if before_revalidate is not None:
            before_revalidate()

        try:
            current = os.stat(marker.name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            return UNCHANGED
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_dev != opened.st_dev
            or current.st_ino != opened.st_ino
        ):
            return UNSAFE

        # unlinkat removes only this directory entry and never follows a replacement symlink.
        os.unlink(marker.name, dir_fd=directory_fd)
        return 0
    except OSError:
        return FAILED
    finally:
        os.close(directory_fd)


def main() -> int:
    """Run marker finalization for the path supplied by the Hermes entrypoint."""
    return finalize_marker(Path(sys.argv[1])) if len(sys.argv) == 2 else FAILED


if __name__ == "__main__":
    raise SystemExit(main())
