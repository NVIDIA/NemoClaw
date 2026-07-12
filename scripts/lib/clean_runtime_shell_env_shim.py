# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Remove the legacy runtime shell-env shim from a sandbox user's rc file.

Older base images and earlier entrypoints wrote a two-line stanza into
.bashrc/.profile that sourced /tmp/nemoclaw-proxy-env.sh. The startup
entrypoint now exports those variables in-process, so the legacy stanza is
deleted before lock_rc_files makes the rc files read-only again.

The script intentionally exits 0 in a small number of "leave-it-in-place"
cases that are not safe to rewrite from a non-root entrypoint:

* The rc file is not owned by the current uid (e.g. root-owned .bashrc in a
  non-root sandbox). Rewriting it would need CAP_FOWNER, which the entrypoint
  no longer has after process-capability drops. The leftover stanza only
  sources /tmp/nemoclaw-proxy-env.sh if that file exists; that file's
  permissions are hardened elsewhere in the startup sequence.

* The rc file contents are already clean (no shim line).

Invocation (from nemoclaw-start.sh):
    python3 clean_runtime_shell_env_shim.py <rc_path> <shim_text> <uid>

Source-of-truth: this script is a backwards-compatibility skip path. The
invalid state it tolerates is "legacy base image planted a runtime shim into
an rc file owned by a different uid than the entrypoint currently runs as".
The preferred source boundary is the base image build: newer base images
either own the rc file as the entrypoint user or do not plant the shim at
all. Previously shipped sandboxes already have the mismatched-owner rc
files on disk; crashing the entrypoint with exit code 1 on them is strictly
worse than logging and skipping. Regression tests cover the direct fixture
skip path and the composed startup invariant asserting
/tmp/nemoclaw-proxy-env.sh stays mode 444. Removal condition: when no
supported release ships a base image that plants the legacy shim AND every
reachable sandbox has been rebuilt off a newer base image, drop the
mismatched-owner branch and have the script exit 1 on EPERM again.
"""

import errno
import os
import stat
import sys
import tempfile


def same_file(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def rewrite_open_rc_file(read_fd, original_stat, cleaned_lines, uid):
    # The runtime test image can make /sandbox non-writable while leaving
    # legacy shims in the rc files. In that case atomic rename into /sandbox
    # fails, so rewrite the already-validated inode through /proc/self/fd
    # instead.
    final_mode = stat.S_IMODE(original_stat.st_mode)
    if uid == 0:
        os.fchown(read_fd, 0, 0)
    os.fchmod(read_fd, 0o600)
    write_fd = os.open(
        f"/proc/self/fd/{read_fd}",
        os.O_WRONLY | os.O_TRUNC | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        if not same_file(original_stat, os.fstat(write_fd)):
            raise RuntimeError("rc file descriptor target changed during cleanup")
        with os.fdopen(write_fd, "w", encoding="utf-8", errors="surrogateescape") as handle:
            write_fd = None
            handle.writelines(cleaned_lines)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        if write_fd is not None:
            os.close(write_fd)
        os.fchmod(read_fd, final_mode)


def rewrite_by_rename(rc_path, original_stat, cleaned_lines, uid, tmp_paths):
    tmp_fd, tmp_path = tempfile.mkstemp(prefix="nemoclaw-rc-clean.", dir="/tmp", text=True)
    tmp_paths.append(tmp_path)
    with os.fdopen(tmp_fd, "w", encoding="utf-8", errors="surrogateescape") as handle:
        handle.writelines(cleaned_lines)
        handle.flush()
        os.fsync(handle.fileno())
    if uid == 0:
        os.chown(tmp_path, 0, 0)
    # Mirror the original rc file's mode bits rather than fixing a permissive
    # default. The pre-cleanup file's mode is the user-visible source of truth;
    # widening it here would silently change rc file permissions.
    os.chmod(tmp_path, stat.S_IMODE(original_stat.st_mode))
    os.replace(tmp_path, rc_path)
    tmp_paths.pop()


def main(argv):
    if len(argv) != 4:
        print(
            "[SECURITY] clean_runtime_shell_env_shim: expected <rc_path> <shim> <uid>",
            file=sys.stderr,
        )
        return 1
    rc_path = argv[1]
    shim = argv[2]
    uid = int(argv[3])
    fd = None
    tmp_paths = []

    try:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(rc_path, flags)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                print(
                    f"[SECURITY] refusing symlinked rc file during cleanup: {rc_path}",
                    file=sys.stderr,
                )
            else:
                print(
                    f"[SECURITY] could not open rc file for cleanup: {rc_path}: {exc}",
                    file=sys.stderr,
                )
            return 1

        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            print(
                f"[SECURITY] refusing non-regular rc file during cleanup: {rc_path}",
                file=sys.stderr,
            )
            return 1
        with os.fdopen(os.dup(fd), "r", encoding="utf-8", errors="surrogateescape") as handle:
            lines = handle.readlines()

        cleaned = []
        index = 0
        while index < len(lines):
            line = lines[index]
            bare = line.rstrip("\n")
            if bare == "# Source runtime proxy config":
                if index + 1 < len(lines):
                    next_line = lines[index + 1]
                    next_bare = next_line.rstrip("\n")
                    if next_bare == shim or "/tmp/nemoclaw-proxy-env.sh" in next_line:
                        index += 2
                        continue
                    cleaned.append(line)
                    cleaned.append(next_line)
                    index += 2
                    continue
            if bare == shim or "/tmp/nemoclaw-proxy-env.sh" in line:
                index += 1
                continue
            cleaned.append(line)
            index += 1

        if any(
            line.rstrip("\n") == shim or "/tmp/nemoclaw-proxy-env.sh" in line
            for line in cleaned
        ):
            print(
                f"[SECURITY] runtime env shim still present after cleanup: {rc_path}",
                file=sys.stderr,
            )
            return 1
        if cleaned == lines:
            return 0

        # When the rc file is not owned by us (and we are not root) we cannot
        # safely rewrite it: fchmod would raise EPERM without CAP_FOWNER, and
        # the in-place reopen via /proc/self/fd would fail anyway.
        #
        # Threat model: the legacy shim line we would have removed is still an
        # active trust-boundary hook. It sources /tmp/nemoclaw-proxy-env.sh on
        # every shell start and pulls in the proxy and gateway-token exports
        # from that file. That file is written exclusively via
        # `emit_sandbox_sourced_file` in scripts/lib/sandbox-init.sh, which
        # forces mode 444 (and root ownership when the entrypoint runs as
        # root) before placing the file. The startup sequence validates that
        # invariant via `validate_tmp_permissions` before launching services.
        # The composed test in test/service-env.test.ts proves the file stays
        # at mode 444 through this skip path. As long as the proxy-env file
        # remains non-user-writable, the leftover shim does not widen the
        # sandbox's trust boundary; crashing the container under errexit
        # (which the original code did) was the strictly worse outcome. A
        # later root-mode boot can finish the cleanup.
        if uid != 0 and st.st_uid != uid:
            print(
                f"[SECURITY] skipping rc cleanup for {rc_path}: not owned by uid={uid} "
                f"(file uid={st.st_uid}); legacy shim left in place",
                file=sys.stderr,
            )
            return 0

        try:
            rewrite_open_rc_file(fd, st, cleaned, uid)
        except OSError as exc:
            if exc.errno != errno.ENOENT:
                raise
            rewrite_by_rename(rc_path, st, cleaned, uid, tmp_paths)
    except Exception as exc:
        print(
            f"[SECURITY] could not safely clean runtime env shim from {rc_path}: {exc}",
            file=sys.stderr,
        )
        return 1
    finally:
        if fd is not None:
            os.close(fd)
        for tmp_path in tmp_paths:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                # The successful path in `rewrite_by_rename` removes the tmp
                # path from `tmp_paths` before this finally block runs, so
                # arriving here means the rename happened or the OS already
                # reaped the file. Nothing left to clean up.
                pass

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
