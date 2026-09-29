// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Failure cause: tar reported "Permission denied" while reading the dir. */
export const BACKUP_FAILURE_PERMISSION_DENIED = "permission denied";
/** Failure cause: tar reported other read errors for the dir. */
export const BACKUP_FAILURE_TAR_READ_ERROR = "tar read error";
/** Failure cause: tar succeeded but the dir never materialized on the host. */
export const BACKUP_FAILURE_ABSENT_AFTER_EXTRACTION = "absent after extraction";

export function classifyFailedDirsFromTarStderr(
  stderr: string,
  existingDirs: readonly string[],
): Map<string, string> {
  const failed = new Map<string, string>();
  const dirs = [...existingDirs].sort((a, b) => b.length - a.length);
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("tar: ")) continue;
    const message = line.slice("tar: ".length);
    for (const dirName of dirs) {
      if (
        message === dirName ||
        message.startsWith(`${dirName}:`) ||
        message.startsWith(`${dirName}/`)
      ) {
        // "permission denied" is the more actionable cause — keep it even if
        // other read errors were attributed to the same dir first.
        const reason = message.includes("Permission denied")
          ? BACKUP_FAILURE_PERMISSION_DENIED
          : BACKUP_FAILURE_TAR_READ_ERROR;
        if (reason === BACKUP_FAILURE_PERMISSION_DENIED || !failed.has(dirName)) {
          failed.set(dirName, reason);
        }
        break;
      }
    }
  }
  return failed;
}

/**
 * Record a failed backup directory once. Keep the first known reason when
 * the audit path and a later tar-error path both report the same directory.
 */
export function recordFailedBackupDir(
  failedDirs: string[],
  name: string,
  failedDirReasons?: Record<string, string>,
  reason?: string,
): void {
  if (!failedDirs.includes(name)) failedDirs.push(name);
  if (failedDirReasons !== undefined && reason !== undefined) {
    failedDirReasons[name] ??= reason;
  }
}

/** Render failed items with any known per-directory cause. */
export function formatFailedBackupItems(
  failedItems: readonly string[],
  reasons: Readonly<Record<string, string>> | undefined,
): string {
  return failedItems
    .map((item) => (reasons?.[item] ? `${item} (${reasons[item]})` : item))
    .join(", ");
}

/**
 * Map an absolute pre-backup audit path onto a backup-relative directory.
 * Accepts a path only when it equals a declared directory or is nested under
 * one at a path boundary. Rejects undeclared paths, traversal, and absolute leftovers.
 */
export function relativeFailedBackupDir(
  absPath: string,
  dirPrefix: string,
  existingDirs: readonly string[],
): string | null {
  if (!absPath || absPath.includes("\0")) return null;
  const relative =
    dirPrefix && absPath.startsWith(dirPrefix) ? absPath.slice(dirPrefix.length) : absPath;
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith("../") ||
    relative.includes("/../") ||
    relative.endsWith("/..")
  ) {
    return null;
  }
  const declared = existingDirs.some(
    (dirName) => relative === dirName || relative.startsWith(`${dirName}/`),
  );
  return declared ? relative : null;
}
