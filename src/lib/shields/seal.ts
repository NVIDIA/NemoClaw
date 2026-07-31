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
import hashlib
import os
import stat
import sys

HASH_NAME = ".config-hash"

def die(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(1)

def open_checked(path, want_dir, dir_fd=None):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
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
    mode = os.fstat(fd).st_mode
    if want_dir and not stat.S_ISDIR(mode):
        os.close(fd)
        die("not a directory: " + path)
    if not want_dir and not stat.S_ISREG(mode):
        os.close(fd)
        die("not a regular file: " + path)
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

def read_all(fd):
    chunks = []
    while True:
        chunk = os.read(fd, 1 << 16)
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)

config_dir = os.path.normpath(sys.argv[1])
config_name = config_child_name(config_dir, sys.argv[2])

dir_fd = open_checked(config_dir, True)
try:
    try:
        existing = os.stat(HASH_NAME, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if not stat.S_ISREG(existing.st_mode):
            die("not a regular file: " + config_dir + "/" + HASH_NAME)
        raise SystemExit(0)

    config_fd = open_checked(config_name, False, dir_fd=dir_fd)
    try:
        digest = hashlib.sha256(read_all(config_fd)).hexdigest()
    finally:
        os.close(config_fd)

    record = ("%s  %s\n" % (digest, config_name)).encode("ascii")
    create_flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        hash_fd = os.open(HASH_NAME, create_flags, 0o444, dir_fd=dir_fd)
    except FileExistsError:
        raise SystemExit(0)
    try:
        written = 0
        while written < len(record):
            written += os.write(hash_fd, record[written:])
        os.fchmod(hash_fd, 0o444)
    finally:
        os.close(hash_fd)
finally:
    os.close(dir_fd)
`;

export function buildConfigHashRepairCommand(configDir: string, configPath: string): string[] {
  return ["python3", "-I", "-c", CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT, configDir, configPath];
}
