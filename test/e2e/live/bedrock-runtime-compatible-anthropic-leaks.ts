// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const SNAPSHOT_PROBE_PID_PREFIX = "@@NEMOCLAW_E2E_PROBE_PID@@ ";
export const SNAPSHOT_FILE_PREFIX = "@@NEMOCLAW_E2E_FILE@@ ";
export const SNAPSHOT_DATA_PREFIX = "@@NEMOCLAW_E2E_DATA@@ ";
const PID_PATTERN = /^[1-9][0-9]*$/u;

export interface ForbiddenLeakPattern {
  name: string;
  value: string;
  allowInSnapshotProbeEnvironment?: boolean;
}

export interface ForbiddenLeakScan {
  leaks: string[];
  snapshotProbeEnvironmentExemptions: Array<{ name: string; location: string }>;
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

function isSnapshotProbeEnvironment(location: string, probePid: string | undefined): boolean {
  return probePid !== undefined && location === `/proc/${probePid}/environ`;
}

/**
 * Find forbidden values while distinguishing the one-shot snapshot process
 * from the sandbox workloads it observes. `src/lib/onboard/bedrock-runtime.ts`
 * registers the adapter credential as an attached generic OpenShell provider.
 * OpenShell, outside this repository, projects that provider's placeholder
 * name into an ad-hoc `sandbox exec` child, so the observer sees the name in
 * its own environment. Only patterns explicitly marked for that exact
 * PID/environment location are exempt; raw token values and every match in
 * other files or processes still fail the scan.
 *
 * The live test requires this exemption to be observed. Remove the flag, that
 * assertion, and this exception when OpenShell stops projecting attached
 * provider placeholders into inspection children or offers provider-free
 * sandbox inspection.
 */
export function scanForbiddenLeaks(
  text: string,
  label: string,
  patterns: readonly ForbiddenLeakPattern[],
): ForbiddenLeakScan {
  const locations: string[] = [];
  const exemptions: Array<{ name: string; location: string }> = [];
  let current: string | undefined;
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
    if (!line.startsWith(SNAPSHOT_DATA_PREFIX)) continue;
    const data = line.slice(SNAPSHOT_DATA_PREFIX.length);
    const location = current ?? label;
    for (const pattern of patterns) {
      if (!pattern.value || !data.includes(pattern.value)) continue;
      if (
        pattern.allowInSnapshotProbeEnvironment &&
        isSnapshotProbeEnvironment(location, probePid)
      ) {
        exemptions.push({ name: pattern.name, location });
        continue;
      }
      locations.push(`${pattern.name}: ${location}`);
    }
  }
  return {
    leaks: [...new Set(locations)].sort(),
    snapshotProbeEnvironmentExemptions: exemptions.filter(
      (entry, index, entries) =>
        entries.findIndex(
          (candidate) => candidate.name === entry.name && candidate.location === entry.location,
        ) === index,
    ),
  };
}

export function findForbiddenLeaks(
  text: string,
  label: string,
  patterns: readonly ForbiddenLeakPattern[],
): string[] {
  return scanForbiddenLeaks(text, label, patterns).leaks;
}
