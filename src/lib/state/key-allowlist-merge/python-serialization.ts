// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Python helpers that serialize deterministically and atomically replace the fresh config. */
export const KEY_ALLOWLIST_SERIALIZATION_PYTHON = String.raw`
def sorted_deep(value):
    if isinstance(value, dict):
        return {key: sorted_deep(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [sorted_deep(item) for item in value]
    return value


def render_merged_config(merged, header_lines):
    try:
        rendered = tomli_w.dumps(sorted_deep(merged))
    except Exception:
        fail("merged config could not be serialized safely")
    if not isinstance(rendered, str):
        fail("merged config serializer returned invalid output")
    if header_lines:
        text = "\n".join(header_lines) + "\n\n" + rendered.rstrip() + "\n"
    else:
        text = rendered.rstrip() + "\n"
    payload = text.encode("utf-8")
    if len(payload) > MAX_CONFIG_BYTES:
        fail("merged config exceeds the restore size limit")
    return payload


def same_file_version(expected, actual):
    return (
        stat.S_ISREG(actual.st_mode)
        and actual.st_nlink == 1
        and (
            actual.st_dev,
            actual.st_ino,
            actual.st_size,
            actual.st_mtime_ns,
            actual.st_ctime_ns,
        )
        == (
            expected.st_dev,
            expected.st_ino,
            expected.st_size,
            expected.st_mtime_ns,
            expected.st_ctime_ns,
        )
    )


def create_staged_file(parent_fd):
    flags = (
        os.O_RDWR
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    for _attempt in range(100):
        staged_name = f".nemoclaw-restore-merged.{secrets.token_hex(16)}"
        try:
            fd = os.open(staged_name, flags, 0o600, dir_fd=parent_fd)
        except FileExistsError:
            continue
        except OSError:
            fail("config staging file could not be created safely")
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            os.close(fd)
            fail("config staging file is not a single regular file")
        return staged_name, fd
    fail("config staging file could not be created safely")


def unlink_staged_if_owned(parent_fd, staged_name, staged_metadata):
    if staged_metadata is None:
        return
    try:
        latest = os.stat(staged_name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return
    if (latest.st_dev, latest.st_ino) != (staged_metadata.st_dev, staged_metadata.st_ino):
        return
    try:
        os.unlink(staged_name, dir_fd=parent_fd)
    except OSError:
        pass


def write_staged_and_replace(parent_fd, current_name, current_metadata, payload):
    staged_name = ""
    staged_fd = -1
    staged_metadata = None
    installed = False
    try:
        staged_name, staged_fd = create_staged_file(parent_fd)
        try:
            written = 0
            while written < len(payload):
                written += os.write(staged_fd, payload[written:])
            os.fchmod(staged_fd, 0o660)
            os.fsync(staged_fd)
            staged_metadata = os.fstat(staged_fd)
        finally:
            if staged_metadata is None and staged_fd >= 0:
                staged_metadata = os.fstat(staged_fd)

        try:
            latest_current = os.stat(current_name, dir_fd=parent_fd, follow_symlinks=False)
        except OSError:
            fail("current config changed before atomic restore")
        if not same_file_version(current_metadata, latest_current):
            fail("current config changed before atomic restore")

        try:
            latest_staged = os.stat(staged_name, dir_fd=parent_fd, follow_symlinks=False)
        except OSError:
            fail("config staging file changed before atomic restore")
        if staged_metadata is None or not same_file_version(staged_metadata, latest_staged):
            fail("config staging file changed before atomic restore")

        os.replace(staged_name, current_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        installed = True
        os.fsync(parent_fd)
    finally:
        if staged_fd >= 0:
            os.close(staged_fd)
        if not installed and staged_name:
            unlink_staged_if_owned(parent_fd, staged_name, staged_metadata)
`.trim();
