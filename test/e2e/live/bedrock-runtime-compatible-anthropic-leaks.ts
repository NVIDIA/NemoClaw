// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const SNAPSHOT_PROBE_PID_PREFIX = "@@NEMOCLAW_E2E_PROBE_PID@@ ";
const SNAPSHOT_FILE_PREFIX = "@@NEMOCLAW_E2E_FILE@@ ";
const PID_PATTERN = /^[1-9][0-9]*$/u;

export interface ForbiddenLeakPattern {
  name: string;
  value: string;
  allowInSnapshotProbeEnvironment?: boolean;
}

function isSnapshotProbeEnvironment(location: string, probePid: string | undefined): boolean {
  return probePid !== undefined && location === `/proc/${probePid}/environ`;
}

/**
 * Find forbidden values while distinguishing the one-shot snapshot process
 * from the sandbox workloads it observes. OpenShell intentionally projects a
 * provider credential placeholder into each newly executed child, so the
 * probe sees the provider environment-variable name in its own environment.
 * Only patterns explicitly marked for that exact PID/environment location are
 * exempt; raw token values and every match in other files or processes still
 * fail the scan.
 */
export function findForbiddenLeaks(
  text: string,
  label: string,
  patterns: readonly ForbiddenLeakPattern[],
): string[] {
  const locations: string[] = [];
  let current = label;
  let probePid: string | undefined;
  let firstNonEmptyLineSeen = false;

  for (const line of text.split("\n")) {
    if (!firstNonEmptyLineSeen && line.length > 0) {
      firstNonEmptyLineSeen = true;
      if (line.startsWith(SNAPSHOT_PROBE_PID_PREFIX)) {
        const candidate = line.slice(SNAPSHOT_PROBE_PID_PREFIX.length);
        if (PID_PATTERN.test(candidate)) probePid = candidate;
        continue;
      }
    }
    if (line.startsWith(SNAPSHOT_FILE_PREFIX)) {
      current = line.slice(SNAPSHOT_FILE_PREFIX.length);
      continue;
    }
    for (const pattern of patterns) {
      if (!pattern.value || !line.includes(pattern.value)) continue;
      if (
        pattern.allowInSnapshotProbeEnvironment &&
        isSnapshotProbeEnvironment(current, probePid)
      ) {
        continue;
      }
      locations.push(`${pattern.name}: ${current}`);
    }
  }
  return [...new Set(locations)].sort();
}
