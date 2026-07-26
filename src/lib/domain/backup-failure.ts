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

/** Render failed items with any known per-directory cause. */
export function formatFailedBackupItems(
  failedItems: readonly string[],
  reasons: Readonly<Record<string, string>> | undefined,
): string {
  return failedItems
    .map((item) => (reasons?.[item] ? `${item} (${reasons[item]})` : item))
    .join(", ");
}
