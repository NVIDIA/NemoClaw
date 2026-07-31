// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared helpers for the shields-up content seal. Centralised so the lock
// path that writes the seal and the status path that re-checks it share
// the same input contract (sha256sum output shape, hex normalisation).

// Single source of truth for the SHA-256 hex shape used across the
// shields module: by the verifier, the lock-time seal capture, and the
// `ShieldsState.fileHashes` schema guard.
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_RE.test(value);
}

export function parseSha256Output(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const token = trimmed.split(/\s+/, 1)[0];
  return isSha256Hex(token) ? token.toLowerCase() : null;
}

// Issue-string prefixes the verifier emits for hash-related failures.
// Used by callers that need to classify whether drift is launderable
// (perms-only) or non-launderable (any hash-verification failure).
export const HASH_ISSUE_PATTERNS: readonly string[] = [
  "content drifted",
  "sha256sum failed",
  "sha256sum output unparsable",
  "no seal recorded",
];

export function isHashVerificationIssue(entry: string): boolean {
  return HASH_ISSUE_PATTERNS.some((p) => entry.includes(p));
}

export const CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT = String.raw`
import errno
import grp
import hashlib
import os
import stat
import sys

HASH_NAME = ".config-hash"
MAX_HASH_BYTES = 1024

def die(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(1)

def required_flag(name):
    value = getattr(os, name, None)
    if not isinstance(value, int) or value == 0:
        die("required open flag is unavailable: " + name)
    return value

O_NOFOLLOW = required_flag("O_NOFOLLOW")

def open_checked(path, want_dir, dir_fd=None):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | O_NOFOLLOW
    if want_dir:
        flags |= getattr(os, "O_DIRECTORY", 0)
    else:
        flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags, dir_fd=dir_fd)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            die("refusing symlink path: " + path)
        die("open failed for %s: %s" % (path, exc))
    opened = os.fstat(fd)
    mode = opened.st_mode
    if want_dir and not stat.S_ISDIR(mode):
        os.close(fd)
        die("not a directory: " + path)
    if not want_dir and not stat.S_ISREG(mode):
        os.close(fd)
        die("not a regular file: " + path)
    if not want_dir and opened.st_nlink != 1:
        os.close(fd)
        die("refusing multiply linked file: " + path)
    return fd

def config_child_name(config_dir, path):
    normalized_dir = os.path.normpath(config_dir)
    normalized_path = os.path.normpath(path)
    if os.path.dirname(normalized_path) != normalized_dir:
        die("refusing config path outside config dir: " + path)
    name = os.path.basename(normalized_path)
    if name in ("", ".", ".."):
        die("refusing invalid config path: " + path)
    return name

def hash_fd(fd):
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 1 << 16)
        if not chunk:
            break
        digest.update(chunk)
    return digest.hexdigest()

def read_limited(fd, path):
    chunks = []
    total = 0
    while True:
        chunk = os.read(fd, 1 << 10)
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > MAX_HASH_BYTES:
            die("config hash is too large: " + path)
        chunks.append(chunk)

def same_inode(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino

def inspect_hash_record(dir_fd, config_dir):
    try:
        existing = os.stat(HASH_NAME, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(existing.st_mode):
        die("not a regular file: " + config_dir + "/" + HASH_NAME)
    if existing.st_nlink != 1:
        die("refusing multiply linked file: " + config_dir + "/" + HASH_NAME)
    return existing

config_dir = os.path.normpath(sys.argv[1])
config_name = config_child_name(config_dir, sys.argv[2])
parent_dir = os.path.dirname(config_dir)
config_dir_name = os.path.basename(config_dir)
if parent_dir in ("", config_dir) or config_dir_name in ("", ".", ".."):
    die("refusing invalid config dir: " + config_dir)

parent_fd = open_checked(parent_dir, True)
parent_stat = os.fstat(parent_fd)
parent_mode = stat.S_IMODE(parent_stat.st_mode)
test_protect_parent = len(sys.argv) == 4 and sys.argv[3] == "--test-protect-parent"
if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and not test_protect_parent):
    os.close(parent_fd)
    die("unsupported config hash repair arguments")
protect_parent = parent_dir == "/sandbox" or test_protect_parent
if protect_parent:
    sandbox_gid = (
        os.getegid()
        if test_protect_parent
        else grp.getgrnam("sandbox").gr_gid
    )
else:
    sandbox_gid = None
    if parent_stat.st_uid != os.geteuid():
        os.close(parent_fd)
        die("config parent is not owned by the privileged repair identity: " + parent_dir)
    if (parent_mode & 0o022) and not (parent_mode & stat.S_ISVTX):
        os.close(parent_fd)
        die("refusing writable config parent without sticky protection: " + parent_dir)

dir_fd = None
dir_initial = None
created_hash = False
body_error = None
restore_errors = []
try:
    if protect_parent:
        # /sandbox is mutable by the agent in the normal posture. Freeze it
        # before resolving the config child so the canonical directory cannot
        # be renamed while privileged repair is in progress.
        os.fchown(parent_fd, os.geteuid(), os.getegid())
        os.fchmod(parent_fd, 0o755)

    dir_fd = open_checked(config_dir_name, True, dir_fd=parent_fd)
    dir_initial = os.fstat(dir_fd)

    # Revoke path mutation before inspecting or creating the record. The
    # parent is either already protected or frozen above, so the now-privileged
    # directory cannot be replaced after this descriptor transition.
    os.fchown(dir_fd, os.geteuid(), os.getegid())
    os.fchmod(dir_fd, 0o700)
    current_dir = os.stat(config_dir_name, dir_fd=parent_fd, follow_symlinks=False)
    if not same_inode(current_dir, dir_initial):
        die("config directory changed during repair: " + config_dir)

    existing = inspect_hash_record(dir_fd, config_dir)
    config_fd = open_checked(config_name, False, dir_fd=dir_fd)
    try:
        if existing is None:
            digest = hash_fd(config_fd)
    finally:
        os.close(config_fd)

    if existing is None:
        record = ("%s  %s\n" % (digest, config_name)).encode("ascii")
        create_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | O_NOFOLLOW
        )
        try:
            record_fd = os.open(HASH_NAME, create_flags, 0o444, dir_fd=dir_fd)
            created_hash = True
        except FileExistsError:
            raced = inspect_hash_record(dir_fd, config_dir)
            if raced is None:
                die("config hash changed during repair: " + config_dir + "/" + HASH_NAME)
            raced_fd = open_checked(HASH_NAME, False, dir_fd=dir_fd)
            try:
                opened = os.fstat(raced_fd)
                if not same_inode(raced, opened):
                    die("config hash changed during repair: " + config_dir + "/" + HASH_NAME)
                if read_limited(raced_fd, config_dir + "/" + HASH_NAME) != record:
                    die("competing config hash has unexpected content: " + config_dir + "/" + HASH_NAME)
            finally:
                os.close(raced_fd)
        else:
            try:
                written = 0
                while written < len(record):
                    count = os.write(record_fd, record[written:])
                    if count <= 0:
                        die("short write while creating " + config_dir + "/" + HASH_NAME)
                    written += count
                os.fchown(record_fd, os.geteuid(), os.getegid())
                os.fchmod(record_fd, 0o444)
                os.fsync(record_fd)
            finally:
                os.close(record_fd)

    # Publish a path-stable locked root before returning to the caller's
    # remaining lock operations. The sticky parent still permits ordinary
    # /sandbox use by the sandbox group, but not replacement of this
    # privileged config directory.
    os.fchown(dir_fd, os.geteuid(), os.getegid())
    os.fchmod(dir_fd, 0o755)
    os.fsync(dir_fd)
    if protect_parent:
        os.fchown(parent_fd, os.geteuid(), sandbox_gid)
        os.fchmod(parent_fd, 0o1775)
        os.fsync(parent_fd)
except BaseException as exc:
    body_error = exc
finally:
    if dir_fd is not None:
        if body_error is not None and created_hash:
            try:
                os.unlink(HASH_NAME, dir_fd=dir_fd)
            except OSError as exc:
                restore_errors.append("config hash cleanup: %s" % (exc,))
        if body_error is not None and dir_initial is not None:
            try:
                os.fchown(dir_fd, dir_initial.st_uid, dir_initial.st_gid)
                os.fchmod(dir_fd, stat.S_IMODE(dir_initial.st_mode))
            except OSError as exc:
                restore_errors.append("config dir: %s" % (exc,))
        os.close(dir_fd)
    if body_error is not None and protect_parent:
        try:
            os.fchown(parent_fd, parent_stat.st_uid, parent_stat.st_gid)
            os.fchmod(parent_fd, parent_mode)
        except OSError as exc:
            restore_errors.append("config parent: %s" % (exc,))
    os.close(parent_fd)

if restore_errors:
    die("config hash repair rollback failed: " + "; ".join(restore_errors))
if body_error is not None:
    raise body_error
`;

export function buildConfigHashRepairCommand(configDir: string, configPath: string): string[] {
  return ["python3", "-I", "-c", CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT, configDir, configPath];
}
