// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const SNAPSHOT_PROBE_PID_PREFIX = "@@NEMOCLAW_E2E_PROBE_PID@@ ";
export const SNAPSHOT_FILE_PREFIX = "@@NEMOCLAW_E2E_FILE@@ ";
// Keep this per-line tag compact so null-heavy snapshots stay within the bounded capture guard.
export const SNAPSHOT_DATA_PREFIX = "D ";

export interface ForbiddenLeakPattern {
  name: string;
  value: string;
}

export function frameSnapshotFile(location: string, contents: string): string {
  if (!location || /[\r\n]/u.test(location)) {
    throw new Error("snapshot file location must be a non-empty single line");
  }
  return [
    `${SNAPSHOT_FILE_PREFIX}${location}`,
    ...contents.split("\n").map((line) => `${SNAPSHOT_DATA_PREFIX}${line}`),
  ].join("\n");
}

/**
 * Find forbidden values in framed snapshot files. OpenShell 0.0.106 no longer
 * projects attached provider placeholders into ad-hoc sandbox exec children,
 * so every matching file or process is a leak.
 */
export function findForbiddenLeaks(
  text: string,
  label: string,
  patterns: readonly ForbiddenLeakPattern[],
): string[] {
  const locations: string[] = [];
  let current: string | undefined;

  for (const line of text.split("\n")) {
    if (line.startsWith(SNAPSHOT_FILE_PREFIX)) {
      current = line.slice(SNAPSHOT_FILE_PREFIX.length);
      continue;
    }
    if (!line.startsWith(SNAPSHOT_DATA_PREFIX)) continue;
    const data = line.slice(SNAPSHOT_DATA_PREFIX.length);
    const location = current ?? label;
    for (const pattern of patterns) {
      if (!pattern.value || !data.includes(pattern.value)) continue;
      locations.push(`${pattern.name}: ${location}`);
    }
  }
  return [...new Set(locations)].sort();
}
