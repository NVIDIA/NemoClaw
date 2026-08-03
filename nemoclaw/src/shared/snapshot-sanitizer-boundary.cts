// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const HELPER_TIMEOUT_MS = 60_000;
const HELPER_MAX_BUFFER_BYTES = 48 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BASE64_LENGTH = Math.ceil(MAX_SNAPSHOT_FILE_BYTES / 3) * 4;
const TRUSTED_PYTHON_LOCATIONS = [
  "/usr/bin/python3",
  "/usr/local/bin/python3",
  "/opt/homebrew/bin/python3",
  "/opt/local/bin/python3",
] as const;
let snapshotSanitizerPythonPathForTest: string | null | undefined;

function isTrustedAbsoluteExecutable(candidate: string): string | null {
  try {
    const canonical = realpathSync(candidate);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    let inspected = canonical;
    while (true) {
      const metadata = statSync(inspected);
      if ((metadata.mode & 0o022) !== 0) return null;
      if (currentUid !== null && metadata.uid !== 0 && metadata.uid !== currentUid) return null;
      const parent = path.dirname(inspected);
      if (parent === inspected) break;
      inspected = parent;
    }
    const executable = statSync(canonical);
    if (!executable.isFile()) return null;
    accessSync(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

/** Resolve a verified interpreter without consulting attacker-controlled PATH entries. */
export function resolveTrustedSnapshotSanitizerPythonPath(): string | null {
  const candidates: string[] = [...TRUSTED_PYTHON_LOCATIONS];
  try {
    candidates.push(path.join(path.dirname(realpathSync(process.execPath)), "python3"));
  } catch {
    // The fixed system locations remain authoritative when Node cannot be canonicalized.
  }
  for (const candidate of new Set(candidates)) {
    const trusted = isTrustedAbsoluteExecutable(candidate);
    if (trusted !== null) return trusted;
  }
  return null;
}

/** @visibleForTesting Install an explicit helper substitute without weakening production lookup. */
export function setSnapshotSanitizerPythonPathForTest(
  pythonPath: string | null | undefined,
): void {
  if (process.env.VITEST !== "true") {
    throw new Error("Snapshot sanitizer Python substitution is only available under Vitest");
  }
  if (typeof pythonPath === "string" && !path.isAbsolute(pythonPath)) {
    throw new Error("Snapshot sanitizer test Python path must be absolute");
  }
  snapshotSanitizerPythonPathForTest = pythonPath;
}

function snapshotSanitizerPythonPath(): string | null {
  if (process.env.VITEST === "true" && snapshotSanitizerPythonPathForTest !== undefined) {
    return snapshotSanitizerPythonPathForTest;
  }
  return resolveTrustedSnapshotSanitizerPythonPath();
}

export interface SnapshotFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly nlink: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface SnapshotScannedFile {
  readonly path: string;
  readonly metadata: SnapshotFileIdentity;
  readonly content?: string;
}

export interface DescriptorSnapshotScan {
  readonly root: SnapshotFileIdentity;
  readonly directories: Readonly<Record<string, SnapshotFileIdentity>>;
  readonly files: readonly SnapshotScannedFile[];
}

export interface SnapshotSanitizationAction {
  readonly kind: "remove" | "replace";
  readonly path: string;
  readonly metadata: SnapshotFileIdentity;
  readonly content?: string;
}

export interface DescriptorSnapshotRoot {
  readonly canonicalPath: string;
  readonly identity: SnapshotFileIdentity;
}

/**
 * Descriptor-relative filesystem helper for copied snapshot sanitization.
 *
 * The plugin package publishes compiled JavaScript only, so the helper is
 * passed as immutable source to an isolated Python interpreter. Every path
 * component is opened relative to an already-pinned directory descriptor,
 * and every mutation revalidates the exact inode version observed by the
 * read pass before replacing or unlinking it.
 */
const SNAPSHOT_SANITIZER_PYTHON = String.raw`
import base64
import hashlib
import json
import os
import secrets
import stat
import sys

MAX_FILE_BYTES = ${MAX_SNAPSHOT_FILE_BYTES}
MAX_FILE_BASE64_LENGTH = ((MAX_FILE_BYTES + 2) // 3) * 4
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_ENTRIES = 100_000
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def require_descriptor_support():
    if not O_DIRECTORY or not O_NOFOLLOW:
        fail("descriptor-relative no-follow operations are unavailable")
    supports = getattr(os, "supports_dir_fd", set())
    required = (os.open, os.stat, os.unlink, os.rename)
    if any(operation not in supports for operation in required):
        fail("descriptor-relative filesystem operations are unavailable")


def dir_flags():
    return os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC


def file_flags():
    return os.O_RDONLY | O_NOFOLLOW | O_CLOEXEC


def metadata(value):
    return {
        "dev": str(value.st_dev),
        "ino": str(value.st_ino),
        "mode": str(value.st_mode),
        "nlink": str(value.st_nlink),
        "size": str(value.st_size),
        "mtimeNs": str(value.st_mtime_ns),
        "ctimeNs": str(value.st_ctime_ns),
    }


def same_version(expected, actual):
    return expected == metadata(actual)


def same_identity(expected, actual):
    return expected.get("dev") == str(actual.st_dev) and expected.get("ino") == str(actual.st_ino)


def validate_name(name):
    if (
        not isinstance(name, str)
        or not name
        or name in (".", "..")
        or os.sep in name
        or (os.altsep is not None and os.altsep in name)
    ):
        fail("snapshot entry name is unsafe")
    return name


def validate_relative_path(value):
    if not isinstance(value, str) or not value or os.path.isabs(value) or "\\" in value:
        fail("snapshot relative path is unsafe")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        fail("snapshot relative path is unsafe")
    for part in parts:
        validate_name(part)
    return parts


def open_absolute_dir_no_follow(value):
    if not isinstance(value, str) or not os.path.isabs(value):
        fail("snapshot root must be absolute")
    normalized = os.path.normpath(value)
    parts = [part for part in normalized.split(os.sep) if part]
    fd = os.open(os.sep, dir_flags())
    try:
        for part in parts:
            next_fd = os.open(validate_name(part), dir_flags(), dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


def verify_opened_at(parent_fd, name, opened_fd, expected=None):
    opened = os.fstat(opened_fd)
    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
        fail("snapshot entry changed while it was opened")
    if expected is not None and not same_identity(expected, opened):
        fail("snapshot entry changed before sanitization")
    return opened


def read_regular_file_at(parent_fd, name, observed):
    fd = os.open(name, file_flags(), dir_fd=parent_fd)
    try:
        expected_observed = metadata(observed)
        opened = verify_opened_at(parent_fd, name, fd, expected_observed)
        if not same_version(expected_observed, opened):
            fail("snapshot artifact changed before it was read")
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            fail("snapshot artifact is not a single regular file")
        if opened.st_size > MAX_FILE_BYTES:
            fail("snapshot artifact exceeds the sanitization size limit")
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_FILE_BYTES:
                fail("snapshot artifact exceeds the sanitization size limit")
            chunks.append(chunk)
        final = os.fstat(fd)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        expected = metadata(opened)
        if not same_version(expected, final) or not same_version(expected, current):
            fail("snapshot artifact changed while it was read")
        return b"".join(chunks), expected
    finally:
        os.close(fd)


def should_read(name, sensitive_names):
    lower = name.lower()
    return (
        lower in sensitive_names
        or lower.endswith(".json")
        or lower.endswith(".yaml")
        or lower.endswith(".yml")
        or lower == ".env"
        or lower.endswith(".env")
    )


def scan_directory(dir_fd, relative_dir, directories, files, state, sensitive_names):
    with os.scandir(dir_fd) as entries:
        for entry in entries:
            name = validate_name(entry.name)
            state["entries"] += 1
            if state["entries"] > MAX_ENTRIES:
                fail("snapshot tree exceeds the sanitization entry limit")
            try:
                observed = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            except FileNotFoundError:
                fail("snapshot entry changed during sanitization")
            relative_path = name if not relative_dir else relative_dir + "/" + name
            if stat.S_ISLNK(observed.st_mode):
                continue
            if stat.S_ISDIR(observed.st_mode):
                child_fd = os.open(name, dir_flags(), dir_fd=dir_fd)
                try:
                    opened = verify_opened_at(dir_fd, name, child_fd, metadata(observed))
                    opened_metadata = metadata(opened)
                    directories[relative_path] = opened_metadata
                    scan_directory(
                        child_fd,
                        relative_path,
                        directories,
                        files,
                        state,
                        sensitive_names,
                    )
                    final = os.fstat(child_fd)
                    current = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
                    if not same_version(opened_metadata, final) or not same_version(
                        opened_metadata, current
                    ):
                        fail("snapshot directory changed while it was scanned")
                finally:
                    os.close(child_fd)
                continue
            if not stat.S_ISREG(observed.st_mode) or not should_read(name, sensitive_names):
                continue
            lower = name.lower()
            if lower in sensitive_names:
                files.append({"path": relative_path, "metadata": metadata(observed)})
                continue
            payload, file_metadata = read_regular_file_at(dir_fd, name, observed)
            state["bytes"] += len(payload)
            if state["bytes"] > MAX_TOTAL_BYTES:
                fail("snapshot artifacts exceed the sanitization size limit")
            files.append(
                {
                    "path": relative_path,
                    "metadata": file_metadata,
                    "content": base64.b64encode(payload).decode("ascii"),
                }
            )


def scan(root_path, expected_root, target_name, sensitive_names):
    root_fd = open_absolute_dir_no_follow(root_path)
    try:
        root_metadata = metadata(os.fstat(root_fd))
        if root_metadata != expected_root:
            fail("snapshot root changed before sanitization")
        directories = {}
        files = []
        state = {"entries": 0, "bytes": 0}
        if target_name is None:
            scan_directory(root_fd, "", directories, files, state, sensitive_names)
        else:
            name = validate_name(target_name)
            observed = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
            if stat.S_ISLNK(observed.st_mode) or not stat.S_ISREG(observed.st_mode):
                fail("required snapshot artifact is not a regular file")
            payload, file_metadata = read_regular_file_at(root_fd, name, observed)
            files.append(
                {
                    "path": name,
                    "metadata": file_metadata,
                    "content": base64.b64encode(payload).decode("ascii"),
                }
            )
        if not same_version(root_metadata, os.fstat(root_fd)):
            fail("snapshot root changed while it was scanned")
        print(
            json.dumps(
                {
                    "root": root_metadata,
                    "directories": directories,
                    "files": files,
                },
                separators=(",", ":"),
            )
        )
    finally:
        os.close(root_fd)


def read_plan():
    payload = sys.stdin.buffer.read(MAX_TOTAL_BYTES * 2 + 1)
    if len(payload) > MAX_TOTAL_BYTES * 2:
        fail("snapshot sanitization plan exceeds the size limit")
    try:
        parsed = json.loads(payload)
    except (TypeError, ValueError, UnicodeDecodeError):
        fail("snapshot sanitization plan is invalid")
    if not isinstance(parsed, dict):
        fail("snapshot sanitization plan is invalid")
    return parsed


def open_parent(root_fd, relative_path, directories):
    parts = validate_relative_path(relative_path)
    fd = os.dup(root_fd)
    try:
        traversed = []
        for part in parts[:-1]:
            traversed.append(part)
            key = "/".join(traversed)
            expected = directories.get(key)
            if not isinstance(expected, dict):
                fail("snapshot sanitization plan omits a parent identity")
            next_fd = os.open(part, dir_flags(), dir_fd=fd)
            verify_opened_at(fd, part, next_fd, expected)
            os.close(fd)
            fd = next_fd
        return fd, parts[-1]
    except Exception:
        os.close(fd)
        raise


def create_staged_file(parent_fd):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC
    for _attempt in range(100):
        name = ".nemoclaw-sanitize." + secrets.token_hex(16)
        try:
            fd = os.open(name, flags, 0o600, dir_fd=parent_fd)
        except FileExistsError:
            continue
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            os.close(fd)
            fail("snapshot staging file is unsafe")
        return name, fd, metadata(opened)
    fail("snapshot staging file could not be created")


def install_file(root_path, plan):
    root = plan.get("root")
    target_name = validate_name(plan.get("name"))
    raw = plan.get("content")
    if not isinstance(root, dict) or not isinstance(raw, str):
        fail("snapshot install plan is invalid")
    try:
        payload = base64.b64decode(raw, validate=True)
    except ValueError:
        fail("snapshot install content is invalid")
    if len(payload) > MAX_FILE_BYTES:
        fail("snapshot install content exceeds the size limit")
    expected_digest = hashlib.sha256(payload).digest()

    root_fd = open_absolute_dir_no_follow(root_path)
    target_fd = -1
    target_metadata = None
    installed = False
    try:
        if not same_version(root, os.fstat(root_fd)):
            fail("snapshot root changed before output was installed")
        try:
            os.stat(target_name, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            fail("snapshot install target already exists")

        flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC
        target_fd = os.open(target_name, flags, 0o600, dir_fd=root_fd)
        opened = os.fstat(target_fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            fail("snapshot install target is unsafe")
        target_metadata = metadata(opened)

        written = 0
        while written < len(payload):
            written += os.write(target_fd, payload[written:])
        os.fchmod(target_fd, 0o600)
        os.fsync(target_fd)

        verified_before = os.fstat(target_fd)
        target_metadata = metadata(verified_before)
        if (
            not stat.S_ISREG(verified_before.st_mode)
            or verified_before.st_nlink != 1
            or verified_before.st_size != len(payload)
        ):
            fail("snapshot install target became unsafe while it was written")

        os.lseek(target_fd, 0, os.SEEK_SET)
        observed_digest = hashlib.sha256()
        remaining = len(payload)
        while remaining:
            chunk = os.read(target_fd, min(64 * 1024, remaining))
            if not chunk:
                fail("snapshot install target became incomplete while it was verified")
            observed_digest.update(chunk)
            remaining -= len(chunk)

        verified_after = os.fstat(target_fd)
        verified_metadata = metadata(verified_before)
        target_metadata = metadata(verified_after)
        if not same_version(verified_metadata, verified_after):
            fail("snapshot install target changed while its content was verified")
        if not secrets.compare_digest(observed_digest.digest(), expected_digest):
            fail("snapshot install target content changed while it was written")

        current = os.stat(target_name, dir_fd=root_fd, follow_symlinks=False)
        if not same_version(target_metadata, current):
            fail("snapshot install target changed while it was written")
        os.fsync(root_fd)
        installed = True
    finally:
        if target_fd >= 0:
            os.close(target_fd)
        if not installed:
            unlink_staged_if_owned(root_fd, target_name, target_metadata)
        os.close(root_fd)


def unlink_staged_if_owned(parent_fd, name, expected):
    if not name or expected is None:
        return
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if same_version(expected, current):
            os.unlink(name, dir_fd=parent_fd)
    except OSError:
        pass


def verify_current_file(parent_fd, name, expected):
    fd = os.open(name, file_flags(), dir_fd=parent_fd)
    try:
        opened = verify_opened_at(parent_fd, name, fd, expected)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            fail("snapshot artifact is no longer a single regular file")
        if not same_version(expected, opened):
            fail("snapshot artifact changed before sanitization")
        return metadata(opened)
    finally:
        os.close(fd)


def replace_file(parent_fd, name, expected, payload):
    verify_current_file(parent_fd, name, expected)
    staged_name = ""
    staged_fd = -1
    staged_metadata = None
    installed = False
    try:
        staged_name, staged_fd, staged_metadata = create_staged_file(parent_fd)
        written = 0
        while written < len(payload):
            written += os.write(staged_fd, payload[written:])
        os.fchmod(staged_fd, 0o600)
        os.fsync(staged_fd)
        staged_metadata = metadata(os.fstat(staged_fd))
        verify_current_file(parent_fd, name, expected)
        staged_current = os.stat(staged_name, dir_fd=parent_fd, follow_symlinks=False)
        if not same_version(staged_metadata, staged_current):
            fail("snapshot staging file changed before replacement")
        os.rename(staged_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        installed = True
        os.fsync(parent_fd)
    finally:
        if staged_fd >= 0:
            os.close(staged_fd)
        if not installed:
            unlink_staged_if_owned(parent_fd, staged_name, staged_metadata)


def remove_file(parent_fd, name, expected):
    verify_current_file(parent_fd, name, expected)
    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not same_version(expected, current):
        fail("snapshot artifact changed before removal")
    os.unlink(name, dir_fd=parent_fd)
    os.fsync(parent_fd)


def apply(root_path, plan):
    root = plan.get("root")
    directories = plan.get("directories")
    actions = plan.get("actions")
    if not isinstance(root, dict) or not isinstance(directories, dict) or not isinstance(actions, list):
        fail("snapshot sanitization plan is invalid")
    root_fd = open_absolute_dir_no_follow(root_path)
    try:
        if not same_version(root, os.fstat(root_fd)):
            fail("snapshot root changed before sanitized output was installed")
        for action in actions:
            if not isinstance(action, dict):
                fail("snapshot sanitization action is invalid")
            expected = action.get("metadata")
            if not isinstance(expected, dict):
                fail("snapshot sanitization action omits a file identity")
            parent_fd, name = open_parent(root_fd, action.get("path"), directories)
            try:
                kind = action.get("kind")
                if kind == "remove":
                    remove_file(parent_fd, name, expected)
                elif kind == "replace":
                    raw = action.get("content")
                    if not isinstance(raw, str):
                        fail("snapshot replacement content is invalid")
                    if len(raw) > MAX_FILE_BASE64_LENGTH:
                        fail("snapshot replacement content exceeds the encoded size limit")
                    try:
                        payload = base64.b64decode(raw, validate=True)
                    except ValueError:
                        fail("snapshot replacement content is invalid")
                    if base64.b64encode(payload).decode("ascii") != raw:
                        fail("snapshot replacement content is not canonical base64")
                    if len(payload) > MAX_FILE_BYTES:
                        fail("snapshot replacement content exceeds the size limit")
                    replace_file(parent_fd, name, expected, payload)
                else:
                    fail("snapshot sanitization action is invalid")
            finally:
                os.close(parent_fd)
    finally:
        os.close(root_fd)


def main():
    require_descriptor_support()
    if len(sys.argv) < 3:
        fail("snapshot sanitizer arguments are invalid")
    mode = sys.argv[1]
    root_path = sys.argv[2]
    if mode in ("scan-tree", "scan-file"):
        if len(sys.argv) != 6:
            fail("snapshot sanitizer scan arguments are invalid")
        try:
            expected_root = json.loads(sys.argv[3])
            sensitive_names = set(json.loads(sys.argv[5]))
        except (TypeError, ValueError):
            fail("snapshot sanitizer scan arguments are invalid")
        target_name = None if mode == "scan-tree" else sys.argv[4]
        scan(root_path, expected_root, target_name, sensitive_names)
        return
    if mode == "apply" and len(sys.argv) == 3:
        apply(root_path, read_plan())
        return
    if mode == "install" and len(sys.argv) == 3:
        install_file(root_path, read_plan())
        return
    fail("snapshot sanitizer mode is invalid")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        fail(str(error))
`.trim();

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileIdentity(value: unknown): value is SnapshotFileIdentity {
  if (!isObjectRecord(value)) return false;
  return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
    (key) => typeof value[key] === "string",
  );
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || path.isAbsolute(value)) return false;
  if (value.includes("\\")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function parseScanResult(stdout: string): DescriptorSnapshotScan | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isObjectRecord(parsed) || !isFileIdentity(parsed.root)) return null;
    if (!isObjectRecord(parsed.directories) || !Array.isArray(parsed.files)) return null;

    const directories: Record<string, SnapshotFileIdentity> = {};
    for (const [relativePath, identity] of Object.entries(parsed.directories)) {
      if (!isSafeRelativePath(relativePath) || !isFileIdentity(identity)) return null;
      directories[relativePath] = identity;
    }

    const files: SnapshotScannedFile[] = [];
    for (const value of parsed.files) {
      if (!isObjectRecord(value) || !isSafeRelativePath(value.path)) return null;
      if (!isFileIdentity(value.metadata)) return null;
      if (value.content !== undefined && typeof value.content !== "string") return null;
      files.push({
        path: value.path,
        metadata: value.metadata,
        ...(typeof value.content === "string" ? { content: value.content } : {}),
      });
    }
    return { root: parsed.root, directories, files };
  } catch {
    return null;
  }
}

/** Resolve and pin one snapshot root without accepting a final-component symlink. */
export function inspectDescriptorSnapshotRoot(rootPath: string): DescriptorSnapshotRoot | null {
  let observed: ReturnType<typeof lstatSync>;
  try {
    observed = lstatSync(rootPath, { bigint: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw new Error(`Snapshot root is not a safe directory: ${rootPath}`);
  }
  const canonicalPath = realpathSync(rootPath);
  const canonical = lstatSync(canonicalPath, { bigint: true });
  if (canonical.dev !== observed.dev || canonical.ino !== observed.ino) {
    throw new Error(`Snapshot root changed while it was resolved: ${rootPath}`);
  }
  return {
    canonicalPath,
    identity: {
      dev: String(observed.dev),
      ino: String(observed.ino),
      mode: String(observed.mode),
      nlink: String(observed.nlink),
      size: String(observed.size),
      mtimeNs: String(observed.mtimeNs),
      ctimeNs: String(observed.ctimeNs),
    },
  };
}

/** Read a bounded snapshot tree through pinned directory descriptors. */
export function scanDescriptorSnapshot(
  root: DescriptorSnapshotRoot,
  sensitiveNames: ReadonlySet<string>,
  targetName?: string,
): DescriptorSnapshotScan | null {
  const mode = targetName === undefined ? "scan-tree" : "scan-file";
  const pythonPath = snapshotSanitizerPythonPath();
  if (pythonPath === null) return null;
  const result = spawnSync(
    pythonPath,
    [
      "-I",
      "-c",
      SNAPSHOT_SANITIZER_PYTHON,
      mode,
      root.canonicalPath,
      JSON.stringify(root.identity),
      targetName ?? "",
      JSON.stringify([...sensitiveNames]),
    ],
    {
      encoding: "utf-8",
      env: {},
      maxBuffer: HELPER_MAX_BUFFER_BYTES,
      timeout: HELPER_TIMEOUT_MS,
    },
  );
  if (result.status !== 0 || result.error) return null;
  return parseScanResult(result.stdout);
}

/** Install or remove sanitized artifacts through their pinned parent descriptors. */
export function applyDescriptorSnapshotActions(
  root: DescriptorSnapshotRoot,
  scan: DescriptorSnapshotScan,
  actions: readonly SnapshotSanitizationAction[],
): boolean {
  if (actions.length === 0) return true;
  const pythonPath = snapshotSanitizerPythonPath();
  if (pythonPath === null) return false;
  const result = spawnSync(
    pythonPath,
    ["-I", "-c", SNAPSHOT_SANITIZER_PYTHON, "apply", root.canonicalPath],
    {
      encoding: "utf-8",
      env: {},
      input: JSON.stringify({ root: scan.root, directories: scan.directories, actions }),
      maxBuffer: HELPER_MAX_BUFFER_BYTES,
      timeout: HELPER_TIMEOUT_MS,
    },
  );
  return result.status === 0 && !result.error;
}

/** Create one direct child through a pinned directory descriptor without replacing an entry. */
export function installDescriptorSnapshotFile(
  root: DescriptorSnapshotRoot,
  targetName: string,
  content: string,
): boolean {
  if (!isSafeRelativePath(targetName) || targetName.includes("/")) return false;
  const pythonPath = snapshotSanitizerPythonPath();
  if (pythonPath === null) return false;
  const result = spawnSync(
    pythonPath,
    ["-I", "-c", SNAPSHOT_SANITIZER_PYTHON, "install", root.canonicalPath],
    {
      encoding: "utf-8",
      env: {},
      input: JSON.stringify({
        root: root.identity,
        name: targetName,
        content: Buffer.from(content, "utf-8").toString("base64"),
      }),
      maxBuffer: HELPER_MAX_BUFFER_BYTES,
      timeout: HELPER_TIMEOUT_MS,
    },
  );
  return result.status === 0 && !result.error;
}

/** Decode one helper payload and reject non-canonical base64 or invalid UTF-8. */
export function decodeDescriptorSnapshotContent(content: string | undefined): string | null {
  if (
    content === undefined ||
    content.length % 4 !== 0 ||
    content.length > MAX_SNAPSHOT_FILE_BASE64_LENGTH
  ) {
    return null;
  }
  const paddingLength = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const unpaddedLength = content.length - paddingLength;
  for (let index = 0; index < unpaddedLength; index += 1) {
    const code = content.charCodeAt(index);
    if (
      !(
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x30 && code <= 0x39) ||
        code === 0x2b ||
        code === 0x2f
      )
    ) {
      return null;
    }
  }
  for (let index = unpaddedLength; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 0x3d) return null;
  }
  const decoded = Buffer.from(content, "base64");
  if (decoded.length > MAX_SNAPSHOT_FILE_BYTES) return null;
  if (decoded.toString("base64") !== content) return null;
  const utf8 = decoded.toString("utf-8");
  if (!Buffer.from(utf8, "utf-8").equals(decoded)) return null;
  return utf8;
}
