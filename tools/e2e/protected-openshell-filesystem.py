#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Bind protected-workspace file operations to opened, non-link directory chains."""

import contextlib
import json
import os
import stat
import sys

MAX_BYTES = 1024 * 1024
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


def identity(metadata):
    """Compare directory authority by inode and device, never by pathname alone."""
    return metadata.st_dev, metadata.st_ino


@contextlib.contextmanager
def parent_directory(root, path):
    """Keep the root and every parent open for one bounded file operation."""
    components = path.split("/")
    if not os.path.isabs(root) or any(part in ("", ".", "..") for part in components):
        raise ValueError("Invalid protected path")
    with contextlib.ExitStack() as stack:
        root_fd = os.open(root, DIRECTORY_FLAGS)
        stack.callback(os.close, root_fd)
        chain = [(None, root, root_fd)]
        parent = root_fd
        for part in components[:-1]:
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=parent)
            stack.callback(os.close, child)
            chain.append((parent, part, child))
            parent = child

        def attached():
            """Reject detached descriptors even though they still reference valid directories."""
            for directory, name, descriptor in chain:
                entry = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if not stat.S_ISDIR(entry.st_mode) or identity(entry) != identity(os.fstat(descriptor)):
                    raise ValueError("Protected source directory changed")

        attached()
        yield parent, components[-1], attached


def read_file(directory, name):
    """Read bounded UTF-8 bytes from the same validated regular-file descriptor."""
    descriptor = os.open(name, FILE_FLAGS, dir_fd=directory)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_BYTES:
            raise ValueError("Invalid protected file")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            data = source.read(MAX_BYTES + 1)
        after = os.fstat(descriptor)
        if (
            len(data) > MAX_BYTES
            or identity(before) != identity(after)
            or (before.st_mtime_ns, before.st_ctime_ns, before.st_size, before.st_nlink)
            != (after.st_mtime_ns, after.st_ctime_ns, after.st_size, after.st_nlink)
        ):
            raise ValueError("Protected source changed during read")
        return data.decode("utf-8", errors="strict"), stat.S_IMODE(after.st_mode)
    finally:
        os.close(descriptor)


def replace_file(directory, name, request, attached):
    """Publish through a pinned parent; retain no temporary file after failure."""
    source = request["source"].encode("utf-8")
    mode = request["mode"]
    if len(source) > MAX_BYTES or mode not in (0o600, 0o644, 0o755):
        raise ValueError("Invalid protected replacement")
    expected = request.get("expectedSource")
    if expected is not None and read_file(directory, name)[0] != expected:
        raise ValueError("Protected source changed before replacement")
    temporary = name + ".openshell-projection-" + os.urandom(16).hex()
    attached()
    descriptor = os.open(
        temporary,
        os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=directory,
    )
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as output:
            output.write(source)
            output.flush()
        os.fchmod(descriptor, mode)
        staged = os.fstat(descriptor)
        entry = os.stat(temporary, dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1 or identity(entry) != identity(staged):
            raise ValueError("Protected staging file changed")
        if expected is not None and read_file(directory, name)[0] != expected:
            raise ValueError("Protected source changed before publication")
        attached()
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        attached()
    finally:
        os.close(descriptor)
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=directory)


def main():
    """Emit a result only after the descriptor chain passes its final check."""
    request = json.load(sys.stdin)
    with parent_directory(request["root"], request["path"]) as (directory, name, attached):
        if request["operation"] == "read":
            source, mode = read_file(directory, name)
            attached()
            print(json.dumps({"source": source, "mode": mode}))
        elif request["operation"] == "replace":
            replace_file(directory, name, request, attached)
            print("{}")
        else:
            raise ValueError("Invalid protected filesystem operation")


if __name__ == "__main__":
    main()
