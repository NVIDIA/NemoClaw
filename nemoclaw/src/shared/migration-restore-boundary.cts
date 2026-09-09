// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { resolveTrustedSnapshotSanitizerPythonPath } from "./snapshot-sanitizer-boundary.cjs";

const HELPER_TIMEOUT_MS = 120_000;
const HELPER_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export interface DescriptorRestoreModeOverride {
  readonly relativePath: string;
  readonly mode: number;
}

export interface DescriptorRestoreReplacement {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly label: string;
  readonly kind: "directory" | "file";
  readonly mode?: number;
  readonly modeOverrides?: readonly DescriptorRestoreModeOverride[];
}

export interface DescriptorRestoreResult {
  readonly ok: boolean;
  readonly phase: "prerequisite" | "staging" | "commit" | "cleanup";
  readonly message: string;
  readonly rollbackFailures: readonly string[];
  readonly retainedArchives: readonly string[];
  readonly cleanupFailures: readonly string[];
}

// Keep this helper inline because the plugin package publishes compiled files only. The
// isolated interpreter pins every traversed directory with O_NOFOLLOW and performs the
// complete transaction through dir_fd operations, so a pathname swap cannot redirect a
// restore after validation.
const MIGRATION_RESTORE_PYTHON = String.raw`
import json
import errno
import os
import secrets
import stat
import sys

MAX_REPLACEMENTS = 256
MAX_PATH_DEPTH = 256
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
DIR_FLAGS = os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | O_NOFOLLOW | O_CLOEXEC


def fail(message):
    raise RuntimeError(message)


def require_descriptor_support():
    if not O_DIRECTORY or not O_NOFOLLOW:
        fail("descriptor-relative no-follow operations are unavailable")
    required = (os.open, os.stat, os.mkdir, os.rename, os.unlink, os.rmdir)
    supports = getattr(os, "supports_dir_fd", set())
    if any(operation not in supports for operation in required):
        fail("descriptor-relative filesystem operations are unavailable")


def validate_name(name):
    if (
        not isinstance(name, str)
        or not name
        or name in (".", "..")
        or os.sep in name
        or (os.altsep is not None and os.altsep in name)
    ):
        fail("restore entry name is unsafe")
    return name


def absolute_parts(value):
    if not isinstance(value, str) or not os.path.isabs(value) or "\0" in value:
        fail("restore path must be absolute")
    normalized = os.path.normpath(value)
    parts = [validate_name(part) for part in normalized.split(os.sep) if part]
    if not parts or len(parts) > MAX_PATH_DEPTH:
        fail("restore path depth is invalid")
    return normalized, parts


def identity(value):
    return {"dev": str(value.st_dev), "ino": str(value.st_ino)}


def same_identity(expected, actual):
    return expected == identity(actual)


def version(value):
    return {
        **identity(value),
        "mode": str(value.st_mode),
        "nlink": str(value.st_nlink),
        "size": str(value.st_size),
        "mtimeNs": str(value.st_mtime_ns),
        "ctimeNs": str(value.st_ctime_ns),
    }


def same_version(expected, actual):
    return expected == version(actual)


def verify_opened_at(parent_fd, name, opened_fd):
    opened = os.fstat(opened_fd)
    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
        fail("restore path changed while it was opened")
    return opened


def open_absolute_dir_no_follow(value):
    _normalized, parts = absolute_parts(value)
    fd = os.open(os.sep, DIR_FLAGS)
    try:
        for part in parts:
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            verify_opened_at(fd, part, next_fd)
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


def open_parent_no_follow(value, created_directories=None):
    normalized, parts = absolute_parts(value)
    fd = os.open(os.sep, DIR_FLAGS)
    traversed = []
    try:
        for part in parts[:-1]:
            traversed.append(part)
            try:
                next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if created_directories is None:
                    raise
                os.mkdir(part, 0o700, dir_fd=fd)
                next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
                created_directories.append(
                    {
                        "path": os.sep + os.path.join(*traversed),
                        "identity": identity(os.fstat(next_fd)),
                    }
                )
            verify_opened_at(fd, part, next_fd)
            os.close(fd)
            fd = next_fd
        return fd, parts[-1], os.path.dirname(normalized)
    except Exception:
        os.close(fd)
        raise


def lstat_at(parent_fd, name):
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def verify_parent_path(item):
    current_fd = open_absolute_dir_no_follow(item["parentPath"])
    try:
        if not same_identity(item["parentIdentity"], os.fstat(current_fd)):
            fail(item["label"] + ": restore target parent changed")
    finally:
        os.close(current_fd)


def create_unique_name(parent_fd, purpose, kind):
    for _attempt in range(100):
        name = ".nemoclaw-" + purpose + "-" + secrets.token_hex(16)
        try:
            if kind == "directory":
                os.mkdir(name, 0o700, dir_fd=parent_fd)
                child_fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
            else:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC
                child_fd = os.open(name, flags, 0o600, dir_fd=parent_fd)
        except FileExistsError:
            continue
        opened = verify_opened_at(parent_fd, name, child_fd)
        return name, child_fd, identity(opened)
    fail("restore staging entry could not be reserved")


def validate_relative_path(value):
    if not isinstance(value, str) or not value or os.path.isabs(value) or "\\" in value:
        fail("restore mode override path is unsafe")
    parts = value.split("/")
    if len(parts) > MAX_PATH_DEPTH:
        fail("restore mode override path is too deep")
    return "/".join(validate_name(part) for part in parts)


def mode_overrides(value):
    if value is None:
        return {}
    if not isinstance(value, list) or len(value) > 256:
        fail("restore mode overrides are invalid")
    result = {}
    for entry in value:
        if not isinstance(entry, dict):
            fail("restore mode override is invalid")
        relative_path = validate_relative_path(entry.get("relativePath"))
        mode = entry.get("mode")
        if not isinstance(mode, int) or isinstance(mode, bool) or mode < 0 or mode > 0o777:
            fail("restore mode override is invalid")
        if relative_path in result:
            fail("restore mode override is duplicated")
        result[relative_path] = mode
    return result


def copy_regular_file(source_parent_fd, source_name, destination_parent_fd, destination_name, mode):
    observed = os.stat(source_name, dir_fd=source_parent_fd, follow_symlinks=False)
    if not stat.S_ISREG(observed.st_mode):
        fail("restore source contains an unsupported file type")
    source_fd = os.open(source_name, FILE_FLAGS, dir_fd=source_parent_fd)
    destination_fd = -1
    destination_identity = None
    completed = False
    try:
        opened = verify_opened_at(source_parent_fd, source_name, source_fd)
        observed_version = version(observed)
        if not same_version(observed_version, opened):
            fail("restore source file changed before it was copied")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC
        destination_fd = os.open(destination_name, flags, 0o600, dir_fd=destination_parent_fd)
        destination_identity = identity(os.fstat(destination_fd))
        while True:
            chunk = os.read(source_fd, 64 * 1024)
            if not chunk:
                break
            written = 0
            while written < len(chunk):
                written += os.write(destination_fd, chunk[written:])
        final_source = os.fstat(source_fd)
        current_source = os.stat(source_name, dir_fd=source_parent_fd, follow_symlinks=False)
        if not same_version(observed_version, final_source) or not same_version(
            observed_version, current_source
        ):
            fail("restore source file changed while it was copied")
        os.fchmod(destination_fd, mode)
        os.fsync(destination_fd)
        completed = True
    finally:
        if destination_fd >= 0:
            os.close(destination_fd)
        if not completed and destination_identity is not None:
            current_destination = lstat_at(destination_parent_fd, destination_name)
            if current_destination is not None and same_identity(
                destination_identity, current_destination
            ):
                os.unlink(destination_name, dir_fd=destination_parent_fd)
        os.close(source_fd)


def copy_directory(source_fd, destination_fd, overrides, relative_prefix="", observed_overrides=None):
    if observed_overrides is None:
        observed_overrides = set()
    with os.scandir(source_fd) as entries:
        names = sorted(validate_name(entry.name) for entry in entries)
    for name in names:
        observed = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        relative_path = name if not relative_prefix else relative_prefix + "/" + name
        override_mode = overrides.get(relative_path)
        if stat.S_ISLNK(observed.st_mode):
            if override_mode is not None:
                fail("restore mode override names a symbolic link")
            target = os.readlink(name, dir_fd=source_fd)
            if not same_version(version(observed), os.stat(name, dir_fd=source_fd, follow_symlinks=False)):
                fail("restore source link changed while it was copied")
            os.symlink(target, name, dir_fd=destination_fd)
        elif stat.S_ISDIR(observed.st_mode):
            if override_mode is not None:
                fail("restore mode override names a directory")
            source_child = os.open(name, DIR_FLAGS, dir_fd=source_fd)
            try:
                verify_opened_at(source_fd, name, source_child)
                observed_version = version(observed)
                if not same_version(observed_version, os.fstat(source_child)):
                    fail("restore source directory changed before it was copied")
                safe_mode = stat.S_IMODE(observed.st_mode) & 0o777
                os.mkdir(name, safe_mode, dir_fd=destination_fd)
                destination_child = os.open(name, DIR_FLAGS, dir_fd=destination_fd)
                try:
                    copy_directory(
                        source_child,
                        destination_child,
                        overrides,
                        relative_path,
                        observed_overrides,
                    )
                    os.fchmod(destination_child, safe_mode)
                finally:
                    os.close(destination_child)
                if not same_version(observed_version, os.fstat(source_child)) or not same_version(
                    observed_version,
                    os.stat(name, dir_fd=source_fd, follow_symlinks=False),
                ):
                    fail("restore source directory changed while it was copied")
            finally:
                os.close(source_child)
        elif stat.S_ISREG(observed.st_mode):
            copy_regular_file(
                source_fd,
                name,
                destination_fd,
                name,
                override_mode
                if override_mode is not None
                else stat.S_IMODE(observed.st_mode) & 0o777,
            )
            if override_mode is not None:
                observed_overrides.add(relative_path)
        else:
            fail("restore source contains an unsupported file type")


def remove_entry_at(parent_fd, name, expected):
    observed = lstat_at(parent_fd, name)
    if observed is None:
        return True
    if not same_identity(expected, observed):
        return False
    if stat.S_ISDIR(observed.st_mode):
        child_fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
        try:
            verify_opened_at(parent_fd, name, child_fd)
            with os.scandir(child_fd) as entries:
                child_names = [validate_name(entry.name) for entry in entries]
            for child_name in child_names:
                child = os.stat(child_name, dir_fd=child_fd, follow_symlinks=False)
                if not remove_entry_at(child_fd, child_name, identity(child)):
                    return False
        finally:
            os.close(child_fd)
        current = lstat_at(parent_fd, name)
        if current is None:
            return True
        if not same_identity(expected, current):
            return False
        os.rmdir(name, dir_fd=parent_fd)
        return True
    os.unlink(name, dir_fd=parent_fd)
    return True


def remove_created_directories(created_directories, failures):
    for created in reversed(created_directories):
        try:
            parent_fd, name, _parent_path = open_parent_no_follow(created["path"])
            try:
                observed = lstat_at(parent_fd, name)
                if observed is None:
                    continue
                if not same_identity(created["identity"], observed):
                    failures.append(created["path"] + ": directory identity changed")
                    continue
                os.rmdir(name, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
        except OSError as error:
            if error.errno not in (errno.ENOTEMPTY, errno.ENOENT):
                failures.append(created["path"] + ": " + str(error))
        except Exception as error:
            failures.append(created["path"] + ": " + str(error))


def cleanup_stages(items, failures):
    for item in reversed(items):
        stage_name = item.get("stageName")
        stage_identity = item.get("stageIdentity")
        if not stage_name or not stage_identity:
            continue
        try:
            if not remove_entry_at(item["parentFd"], stage_name, stage_identity):
                failures.append(item["label"] + ": staging entry identity changed")
        except Exception as error:
            failures.append(item["label"] + ": " + str(error))


def rollback(items, created_directories):
    failures = []
    for item in reversed(items):
        try:
            if item.get("installed"):
                if not remove_entry_at(item["parentFd"], item["targetName"], item["stageIdentity"]):
                    failures.append(item["label"] + ": installed target identity changed")
                    continue
            archive_name = item.get("archiveName")
            if archive_name:
                if lstat_at(item["parentFd"], item["targetName"]) is not None:
                    failures.append(item["label"] + ": restore target was recreated")
                    continue
                archive = lstat_at(item["parentFd"], archive_name)
                if archive is None or not same_identity(item["archiveIdentity"], archive):
                    failures.append(item["label"] + ": archive identity changed")
                    continue
                os.rename(
                    archive_name,
                    item["targetName"],
                    src_dir_fd=item["parentFd"],
                    dst_dir_fd=item["parentFd"],
                )
                item["archiveName"] = None
        except Exception as error:
            failures.append(item["label"] + ": " + str(error))
    cleanup_stages(items, failures)
    remove_created_directories(created_directories, failures)
    return failures


def retained_archives(items):
    return [
        os.path.join(item["parentPath"], item["archiveName"])
        for item in items
        if item.get("archiveName")
    ]


def stage_replacement(replacement, created_directories):
    source_path = replacement.get("sourcePath")
    target_path = replacement.get("targetPath")
    label = replacement.get("label")
    kind = replacement.get("kind")
    if not isinstance(label, str) or not label or kind not in ("directory", "file"):
        fail("restore replacement is invalid")
    parent_fd, target_name, parent_path = open_parent_no_follow(target_path, created_directories)
    item = {
        "label": label,
        "parentFd": parent_fd,
        "parentPath": parent_path,
        "parentIdentity": identity(os.fstat(parent_fd)),
        "targetName": target_name,
        "stageName": None,
        "stageIdentity": None,
        "archiveName": None,
        "archiveIdentity": None,
        "installed": False,
    }
    try:
        if kind == "directory":
            stage_name, stage_fd, stage_identity = create_unique_name(parent_fd, "staging", kind)
            item["stageName"] = stage_name
            item["stageIdentity"] = stage_identity
            try:
                source_fd = open_absolute_dir_no_follow(source_path)
                try:
                    source_version = version(os.fstat(source_fd))
                    overrides = mode_overrides(replacement.get("modeOverrides"))
                    observed_overrides = set()
                    copy_directory(
                        source_fd,
                        stage_fd,
                        overrides,
                        observed_overrides=observed_overrides,
                    )
                    if observed_overrides != set(overrides):
                        fail("restore mode override target is missing")
                    if not same_version(source_version, os.fstat(source_fd)):
                        fail("restore source directory changed while it was copied")
                finally:
                    os.close(source_fd)
            finally:
                os.close(stage_fd)
        else:
            source_parent_fd, source_name, _source_parent = open_parent_no_follow(source_path)
            try:
                mode = replacement.get("mode", 0o600)
                if not isinstance(mode, int) or isinstance(mode, bool) or mode < 0 or mode > 0o777:
                    fail("restore file mode is invalid")
                for _attempt in range(100):
                    stage_name = ".nemoclaw-staging-" + secrets.token_hex(16)
                    item["stageName"] = stage_name
                    try:
                        copy_regular_file(source_parent_fd, source_name, parent_fd, stage_name, mode)
                        break
                    except FileExistsError:
                        continue
                else:
                    fail("restore staging entry could not be reserved")
            finally:
                os.close(source_parent_fd)
        item["stageIdentity"] = identity(
            os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False)
        )
        return item
    except Exception:
        cleanup_stages([item], [])
        os.close(parent_fd)
        raise


def run_transaction(plan):
    replacements = plan.get("replacements") if isinstance(plan, dict) else None
    if not isinstance(replacements, list) or not replacements or len(replacements) > MAX_REPLACEMENTS:
        fail("restore replacement plan is invalid")
    items = []
    created_directories = []
    try:
        try:
            for replacement in replacements:
                if not isinstance(replacement, dict):
                    fail("restore replacement is invalid")
                items.append(stage_replacement(replacement, created_directories))
        except Exception as error:
            failures = []
            cleanup_stages(items, failures)
            remove_created_directories(created_directories, failures)
            return {
                "ok": False,
                "phase": "staging",
                "message": str(error),
                "rollbackFailures": failures,
                "retainedArchives": [],
                "cleanupFailures": [],
            }

        try:
            for item in items:
                verify_parent_path(item)
                current = lstat_at(item["parentFd"], item["targetName"])
                if current is not None:
                    archive_name = ".nemoclaw-archived-" + secrets.token_hex(16)
                    if lstat_at(item["parentFd"], archive_name) is not None:
                        fail("restore archive entry already exists")
                    item["archiveIdentity"] = identity(current)
                    os.rename(
                        item["targetName"],
                        archive_name,
                        src_dir_fd=item["parentFd"],
                        dst_dir_fd=item["parentFd"],
                    )
                    item["archiveName"] = archive_name
                os.rename(
                    item["stageName"],
                    item["targetName"],
                    src_dir_fd=item["parentFd"],
                    dst_dir_fd=item["parentFd"],
                )
                item["stageName"] = None
                item["installed"] = True
            for item in items:
                verify_parent_path(item)
        except Exception as error:
            failures = rollback(items, created_directories)
            return {
                "ok": False,
                "phase": "commit",
                "message": str(error),
                "rollbackFailures": failures,
                "retainedArchives": retained_archives(items),
                "cleanupFailures": [],
            }

        cleanup_failures = []
        for item in items:
            archive_name = item.get("archiveName")
            if not archive_name:
                continue
            try:
                if remove_entry_at(item["parentFd"], archive_name, item["archiveIdentity"]):
                    item["archiveName"] = None
                else:
                    cleanup_failures.append(item["label"] + ": archive identity changed")
            except Exception as error:
                cleanup_failures.append(item["label"] + ": " + str(error))
        return {
            "ok": True,
            "phase": "cleanup" if cleanup_failures else "commit",
            "message": "restore transaction committed",
            "rollbackFailures": [],
            "retainedArchives": retained_archives(items),
            "cleanupFailures": cleanup_failures,
        }
    finally:
        for item in items:
            try:
                os.close(item["parentFd"])
            except OSError:
                pass


def main():
    require_descriptor_support()
    raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        fail("restore replacement plan exceeds the size limit")
    try:
        plan = json.loads(raw)
    except (TypeError, ValueError, UnicodeDecodeError):
        fail("restore replacement plan is invalid")
    print(json.dumps(run_transaction(plan), separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
`.trim();

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function parseRestoreResult(stdout: string): DescriptorRestoreResult | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const rollbackFailures = stringArray(record.rollbackFailures);
    const retainedArchives = stringArray(record.retainedArchives);
    const cleanupFailures = stringArray(record.cleanupFailures);
    if (
      typeof record.ok !== "boolean" ||
      typeof record.message !== "string" ||
      !new Set(["staging", "commit", "cleanup"]).has(String(record.phase)) ||
      !rollbackFailures ||
      !retainedArchives ||
      !cleanupFailures
    ) {
      return null;
    }
    return {
      ok: record.ok,
      phase: record.phase as DescriptorRestoreResult["phase"],
      message: record.message,
      rollbackFailures,
      retainedArchives,
      cleanupFailures,
    };
  } catch {
    return null;
  }
}

/** Restore a validated replacement set without returning to mutable parent pathnames. */
export function restoreDescriptorSnapshotReplacements(
  replacements: readonly DescriptorRestoreReplacement[],
): DescriptorRestoreResult {
  const pythonPath = resolveTrustedSnapshotSanitizerPythonPath();
  if (pythonPath === null) {
    return {
      ok: false,
      phase: "prerequisite",
      message:
        "python3 is required for descriptor-safe snapshot restore; install python3 and rerun",
      rollbackFailures: [],
      retainedArchives: [],
      cleanupFailures: [],
    };
  }
  if (replacements.length === 0) {
    return {
      ok: false,
      phase: "staging",
      message: "restore replacement plan is invalid",
      rollbackFailures: [],
      retainedArchives: [],
      cleanupFailures: [],
    };
  }
  if (
    replacements.some(
      (replacement) =>
        !path.isAbsolute(replacement.sourcePath) || !path.isAbsolute(replacement.targetPath),
    )
  ) {
    return {
      ok: false,
      phase: "staging",
      message: "restore replacement paths must be absolute",
      rollbackFailures: [],
      retainedArchives: [],
      cleanupFailures: [],
    };
  }
  const result = spawnSync(pythonPath, ["-I", "-c", MIGRATION_RESTORE_PYTHON], {
    encoding: "utf-8",
    env: {},
    input: JSON.stringify({ replacements }),
    maxBuffer: HELPER_MAX_BUFFER_BYTES,
    timeout: HELPER_TIMEOUT_MS,
  });
  const parsed = parseRestoreResult(result.stdout);
  if (result.status === 0 && !result.error && parsed) return parsed;
  const detail = result.error?.message || result.stderr.trim() || "descriptor-safe helper failed";
  return {
    ok: false,
    phase: "staging",
    message: detail,
    rollbackFailures: [],
    retainedArchives: [],
    cleanupFailures: [],
  };
}
