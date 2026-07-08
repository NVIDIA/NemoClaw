// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Version-scheme classification and staleness evaluation for sandbox agent
// versions. Extracted from `version.ts` so the probe/caching orchestration
// stays focused on how the runtime is observed, while the "is this pair
// comparable, and if so, is it stale?" contract lives here with its own
// tests (#6049).

import { versionGte } from "../adapters/openshell/client.js";

export type VersionScheme = "semver" | "calendar";

// Classify versions by their surface shape: a `YYYY.M.D` tag with a year in
// 2020–2099 or 3000–9999 is treated as calendar; everything else is semver.
// The lower bound of 2020 excludes semvers whose major happens to be a small
// four-digit number (e.g. `2000.0.0`, `1000.0.0`) — no NemoClaw agent ships
// a calendar tag from before 2020, so nothing real is lost, and it stops the
// heuristic from misclassifying legitimate semvers just because their major
// looks like a year. The upper `3000–9999` alternative keeps intentionally
// future-dated test fixtures (`9999.12.31`) recognisable.
export const CALENDAR_VERSION_PATTERN = /^(20[2-9]\d|[3-9]\d{3})\.\d+\.\d+/;

export function classifyVersionShape(value: string): VersionScheme {
  return CALENDAR_VERSION_PATTERN.test(String(value)) ? "calendar" : "semver";
}

// The observed sandbox version is always classified by its actual shape, so
// a legacy calendar cache under a `semver` manifest still surfaces as a
// mismatch instead of being coerced into agreement with the declared scheme.
// The expected value prefers the manifest declaration and falls back to the
// shape classifier when no scheme is declared.
export function classifyObservedVersion(value: string): VersionScheme {
  return classifyVersionShape(value);
}

export function classifyExpectedVersion(
  agentScheme: VersionScheme | null,
  value: string,
): VersionScheme {
  return agentScheme ?? classifyVersionShape(value);
}

export function versionsComparable(
  agentScheme: VersionScheme | null,
  observed: string,
  expected: string,
): boolean {
  return classifyObservedVersion(observed) === classifyExpectedVersion(agentScheme, expected);
}

const warnedSchemeMismatchKeys = new Set<string>();

export function warnSchemeMismatch(
  sandboxName: string,
  sandboxVersion: string,
  expectedVersion: string,
): void {
  const key = `${sandboxName}|${sandboxVersion}|${expectedVersion}`;
  if (warnedSchemeMismatchKeys.has(key)) return;
  warnedSchemeMismatchKeys.add(key);
  const payload = JSON.stringify({
    event: "sandbox_version_scheme_mismatch",
    sandbox: sandboxName,
    sandboxVersion,
    expectedVersion,
    action: "flagged_as_stale",
  });
  process.stderr.write(
    `warning: sandbox '${sandboxName}' agent version ${sandboxVersion} and expected version ${expectedVersion} use different schemes; flagging as stale so a rebuild aligns them. ${payload}\n`,
  );
}

export interface StalenessVerdict {
  isStale: boolean;
  schemeMismatch: boolean;
}

// #6049 fixed the primary bug — the manifest and Hermes runtime now share
// the semver scheme — but stale cross-scheme cache entries can still be
// observed on sandboxes that predate the migration. `evaluateStaleness`
// treats any residual mismatch as stale and lets the normal rebuild flow
// realign the runtime and cache; a structured stderr warning surfaces the
// event so operators and log pipelines can trace which sandboxes tripped
// the fail-closed path.
export function evaluateStaleness(
  sandboxName: string,
  agentScheme: VersionScheme | null,
  sandboxVersion: string,
  expectedVersion: string,
): StalenessVerdict {
  if (!versionsComparable(agentScheme, sandboxVersion, expectedVersion)) {
    warnSchemeMismatch(sandboxName, sandboxVersion, expectedVersion);
    return { isStale: true, schemeMismatch: true };
  }
  return { isStale: !versionGte(sandboxVersion, expectedVersion), schemeMismatch: false };
}
