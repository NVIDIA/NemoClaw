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
   * `isStale` is only meaningful when `verificationFailed` is `false`. When
   * `verificationFailed` is `true` (probe failure or scheme mismatch), the
   * check could not determine staleness and callers must not read
   * `isStale === false` as "verified current".
   */
  isStale: boolean;
  /**
   * True whenever the check could not confirm the sandbox is at the expected
   * version — probe failed, no expected version, opted-out probing, or the
   * runtime and expected versions use different schemes. Callers should
   * render an "unable to verify" state rather than treat `isStale === false`
   * as a positive signal.
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
   * (semver vs calendar). In that case `isStale` is forced to `false` because
   * the two values cannot be compared numerically; treat this as "unable to
   * verify" rather than "current".
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

// Classify versions by their surface shape: a `YYYY.M.D` tag with a
// four-digit year in 2000–9999 is treated as calendar, everything else as
// semver. The lower bound of 2000 keeps semvers with a large four-digit
// major (e.g. `1000.0.0`) from being misclassified as calendar; the upper
// bound is only limited by the regex character class, giving future or
// intentionally-future test fixtures (`9999.12.31`) the same calendar shape.
// If an agent ever needs a third scheme, add an explicit `version_scheme`
// field to the manifest rather than teaching this regex a new shape.
const CALENDAR_VERSION_PATTERN = /^[2-9]\d{3}\.\d+\.\d+/;

function isCalendarVersion(value: string): boolean {
  return CALENDAR_VERSION_PATTERN.test(String(value));
}

function versionsComparable(left: string, right: string): boolean {
  return isCalendarVersion(left) === isCalendarVersion(right);
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
    action: "staleness_check_skipped",
  });
  process.stderr.write(
    `warning: sandbox '${sandboxName}' agent version ${sandboxVersion} and expected version ${expectedVersion} use different schemes; staleness check skipped. ${payload}\n`,
  );
}

// Cross-scheme staleness is silenced deliberately: comparing a semver runtime
// (e.g. `0.17.0`) against a calendar manifest pin (e.g. `2026.6.19`) with
// `versionGte` would let the calendar year dominate and every sandbox would
// look stale (see #6049). Silencing here means a genuine update is missed
// only until both sides align on the same scheme again, which the Hermes
// updater now enforces via `HERMES_SEMVER`. A stderr warning with a
// structured JSON payload surfaces the mismatch so operators and log
// pipelines can detect when a check has been skipped rather than silently
// trusting a cached calendar version.
interface StalenessVerdict {
  isStale: boolean;
  schemeMismatch: boolean;
}

function evaluateStaleness(
  sandboxName: string,
  sandboxVersion: string,
  expectedVersion: string,
): StalenessVerdict {
  if (!versionsComparable(sandboxVersion, expectedVersion)) {
    warnSchemeMismatch(sandboxName, sandboxVersion, expectedVersion);
    return { isStale: false, schemeMismatch: true };
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

  let sb = registry.getSandbox(sandboxName);

  // Fast path: version already cached in registry. A scheme mismatch here
  // means the cached value predates the current expected-version scheme
  // (e.g. a calendar tag left over before Hermes moved to semver, #6049)
  // rather than an actual version disagreement. Invalidate the entry and
  // fall through to the SSH probe so the current runtime version — which is
  // guaranteed to share the manifest scheme once the sandbox is rebuilt or
  // reprobed — replaces it. This closes the fail-open path where a stale
  // cross-scheme cache would otherwise remain forever without triggering a
  // rebuild.
  if (sb?.agentVersion && !opts?.forceProbe) {
    const verdict = evaluateStaleness(sandboxName, sb.agentVersion, expectedVersion);
    if (!verdict.schemeMismatch) {
      return {
        sandboxVersion: sb.agentVersion,
        expectedVersion,
        isStale: verdict.isStale,
        verificationFailed: false,
        detectionMethod: "registry",
      };
    }
    registry.updateSandbox(sandboxName, { agentVersion: null });
    sb = registry.getSandbox(sandboxName);
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

  const verdict = evaluateStaleness(sandboxName, probed, expectedVersion);
  return {
    sandboxVersion: probed,
    expectedVersion,
    isStale: verdict.isStale,
    verificationFailed: verdict.schemeMismatch,
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
