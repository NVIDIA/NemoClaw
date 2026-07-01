// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Sandbox version staleness detection.
//
// Compares the agent version running inside a sandbox against the version
// this NemoClaw release was built for. Two code paths:
//   Fast: registry lookup (no SSH, used when agentVersion is already cached)
//   Slow: SSH exec into sandbox, run version_command, cache result in registry

import { spawnSync } from "child_process";

import {
  captureSandboxSshConfigCommand,
  parseVersionFromText,
  versionGte,
} from "../adapters/openshell/client.js";
import { resolveOpenshell } from "../adapters/openshell/resolve.js";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts.js";
import { loadAgent } from "../agent/defs.js";
import * as registry from "../state/registry.js";
import { createTempSshConfig } from "./temp-ssh-config.js";

export interface VersionCheckResult {
  sandboxVersion: string | null;
  expectedVersion: string | null;
  /**
   * True when the sandbox should be rebuilt. This includes scheme-mismatch
   * cases, which are fail-closed: an incomparable pair is treated as stale so
   * the rebuild flow realigns the runtime and cache.
   */
  isStale: boolean;
  /**
   * True whenever the check could not observe a runtime version — probe
   * failed, no expected version, or opted-out probing. Callers should render
   * an "unable to verify" state rather than treat `isStale === false` as a
   * positive signal. Scheme mismatches do NOT set this: they set
   * `schemeMismatch` and `isStale`.
   */
  verificationFailed: boolean;
  /**
   * How the staleness verdict was reached.
   * - `"registry"` / `"ssh-exec"`: `isStale` is authoritative for this sandbox
   *   as long as `verificationFailed` is `false`.
   * - `"unavailable"`: no staleness check was attempted (missing expected
   *   version, or the caller opted out of probing).
   * - `"unknown"`: a probe was attempted but the runtime version could not be
   *   inspected — callers should treat this as "unable to verify", not
   *   "verified current".
   */
  detectionMethod: "registry" | "ssh-exec" | "unavailable" | "unknown";
  /**
   * `true` when the runtime and expected versions use different schemes
   * (semver vs calendar). In that case `isStale` is forced to `true` so the
   * normal rebuild flow realigns the runtime with the current manifest; the
   * flag lets callers distinguish this fail-closed path from a numeric
   * comparison that observed a genuinely older version.
   */
  schemeMismatch?: boolean;
  /** Categorises why the result could not be computed, so callers can surface a distinct state. */
  unavailableReason?: "no-expected-version" | "skip-probe" | "probe-failed";
}

/**
 * Controls whether version checks may use cached metadata or must inspect the sandbox runtime.
 */
export interface VersionCheckOptions {
  forceProbe?: boolean;
  skipProbe?: boolean;
}

/**
 * Resolve the agent definition for a sandbox.
 * Falls back to "openclaw" when the sandbox has no agent set.
 */
function resolveAgentForSandbox(sandboxName: string): ReturnType<typeof loadAgent> {
  const sb = registry.getSandbox(sandboxName);
  const agentName = sb?.agent || "openclaw";
  return loadAgent(agentName);
}

/**
 * Probe the live agent version inside a sandbox via SSH.
 * Returns the parsed version string or null on failure.
 */
export function probeAgentVersion(sandboxName: string): string | null {
  const agent = resolveAgentForSandbox(sandboxName);

  const openshellBinary = resolveOpenshell();
  if (!openshellBinary) return null;

  const sshConfigResult = captureSandboxSshConfigCommand(openshellBinary, sandboxName, {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (sshConfigResult.status !== 0) return null;
  if (!sshConfigResult.output.trim()) return null;

  const tmpSshConfig = createTempSshConfig(sshConfigResult.output, "nemoclaw-ver-");
  try {
    const result = spawnSync(
      "ssh",
      [
        "-F",
        tmpSshConfig.file,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "LogLevel=ERROR",
        `openshell-${sandboxName}`,
        agent.versionCommand,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
    );
    if (result.status !== 0) return null;
    return parseVersionFromText(result.stdout);
  } catch {
    return null;
  } finally {
    tmpSshConfig.cleanup();
  }
}

// Classify versions by their surface shape: a `YYYY.M.D` tag with a year in
// 2020–2099 or 3000–9999 is treated as calendar; everything else is semver.
// The lower bound of 2020 excludes semvers whose major happens to be a small
// four-digit number (e.g. `2000.0.0`, `1000.0.0`) — no NemoClaw agent ships
// a calendar tag from before 2020, so nothing real is lost, and it stops the
// heuristic from misclassifying legitimate semvers just because their major
// looks like a year. The upper `3000–9999` alternative keeps intentionally
// future-dated test fixtures (`9999.12.31`) recognisable.
const CALENDAR_VERSION_PATTERN = /^(20[2-9]\d|[3-9]\d{3})\.\d+\.\d+/;

function classifyVersionShape(value: string): "calendar" | "semver" {
  return CALENDAR_VERSION_PATTERN.test(String(value)) ? "calendar" : "semver";
}

// The observed sandbox version is always classified by its actual shape, so
// a legacy calendar cache under a `semver` manifest still surfaces as a
// mismatch instead of being coerced into agreement with the declared scheme.
// The expected value prefers the manifest declaration and falls back to the
// shape classifier when no scheme is declared.
function classifyObservedVersion(value: string): "calendar" | "semver" {
  return classifyVersionShape(value);
}

function classifyExpectedVersion(
  agentScheme: "semver" | "calendar" | null,
  value: string,
): "semver" | "calendar" {
  return agentScheme ?? classifyVersionShape(value);
}

function versionsComparable(
  agentScheme: "semver" | "calendar" | null,
  observed: string,
  expected: string,
): boolean {
  return classifyObservedVersion(observed) === classifyExpectedVersion(agentScheme, expected);
}

const warnedSchemeMismatchKeys = new Set<string>();

function warnSchemeMismatch(
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

// #6049 fixed the primary bug — the manifest and Hermes runtime now share
// the semver scheme — but stale cross-scheme cache entries can still be
// observed on sandboxes that predate the migration. `evaluateStaleness`
// treats any residual mismatch as stale and lets the normal rebuild flow
// realign the runtime and cache; a structured stderr warning surfaces the
// event so operators and log pipelines can trace which sandboxes tripped
// the fail-closed path.
interface StalenessVerdict {
  isStale: boolean;
  schemeMismatch: boolean;
}

function evaluateStaleness(
  sandboxName: string,
  agentScheme: "semver" | "calendar" | null,
  sandboxVersion: string,
  expectedVersion: string,
): StalenessVerdict {
  if (!versionsComparable(agentScheme, sandboxVersion, expectedVersion)) {
    warnSchemeMismatch(sandboxName, sandboxVersion, expectedVersion);
    // Fail-closed on scheme mismatch: the runtime and manifest cannot be
    // compared numerically, so the sandbox is treated as stale and routed
    // through the normal rebuild flow. A stale calendar cache from before
    // the semver migration self-heals — the rebuild upgrades the runtime
    // and repopulates the cache with a matching-scheme value.
    return { isStale: true, schemeMismatch: true };
  }
  return { isStale: !versionGte(sandboxVersion, expectedVersion), schemeMismatch: false };
}

/**
 * Check whether a sandbox is running an outdated agent version.
 *
 * Fast path: compare registry.agentVersion against manifest expected_version.
 * Slow path: SSH into sandbox, run version_command, cache result in registry.
 */
export function checkAgentVersion(
  sandboxName: string,
  opts?: VersionCheckOptions,
): VersionCheckResult {
  const agent = resolveAgentForSandbox(sandboxName);
  const expectedVersion = agent.expectedVersion;

  if (!expectedVersion) {
    return {
      sandboxVersion: null,
      expectedVersion: null,
      isStale: false,
      verificationFailed: true,
      detectionMethod: "unavailable",
      unavailableReason: "no-expected-version",
    };
  }

  const sb = registry.getSandbox(sandboxName);

  // Fast path: version already cached in registry. A scheme mismatch here
  // means the cached value predates the current expected-version scheme
  // (e.g. a calendar tag left over before Hermes moved to semver, #6049).
  // `evaluateStaleness` fails closed with `isStale: true` in that case, so
  // the sandbox is routed through the normal rebuild flow — no cache write
  // and no follow-up probe race — and the rebuild itself repopulates the
  // cache with a matching-scheme value.
  if (sb?.agentVersion && !opts?.forceProbe) {
    const verdict = evaluateStaleness(
      sandboxName,
      agent.versionScheme ?? null,
      sb.agentVersion,
      expectedVersion,
    );
    return {
      sandboxVersion: sb.agentVersion,
      expectedVersion,
      isStale: verdict.isStale,
      verificationFailed: false,
      detectionMethod: "registry",
      schemeMismatch: verdict.schemeMismatch,
    };
  }

  if (opts?.skipProbe && !opts.forceProbe) {
    return {
      sandboxVersion: null,
      expectedVersion,
      isStale: false,
      verificationFailed: true,
      detectionMethod: "unavailable",
      unavailableReason: "skip-probe",
    };
  }

  // Slow path: SSH exec into sandbox
  const probed = probeAgentVersion(sandboxName);
  if (probed && sb) {
    // Cache for future fast-path lookups
    registry.updateSandbox(sandboxName, { agentVersion: probed });
  }

  if (!probed) {
    return {
      sandboxVersion: null,
      expectedVersion,
      isStale: false,
      verificationFailed: true,
      detectionMethod: "unknown",
      unavailableReason: "probe-failed",
    };
  }

  const verdict = evaluateStaleness(
    sandboxName,
    agent.versionScheme ?? null,
    probed,
    expectedVersion,
  );
  return {
    sandboxVersion: probed,
    expectedVersion,
    isStale: verdict.isStale,
    verificationFailed: false,
    detectionMethod: "ssh-exec",
    schemeMismatch: verdict.schemeMismatch,
  };
}

/**
 * Format a user-facing staleness warning for console output.
 */
export function formatStalenessWarning(sandboxName: string, result: VersionCheckResult): string[] {
  const agentName = resolveAgentForSandbox(sandboxName).displayName;
  return [
    "",
    `  \u26a0 Sandbox '${sandboxName}' is running ${agentName} ${result.sandboxVersion} (current: ${result.expectedVersion})`,
    `    Run: nemoclaw ${sandboxName} rebuild`,
    "",
  ];
}
