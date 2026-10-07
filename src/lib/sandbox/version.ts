// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Sandbox version staleness detection.
//
// Compares the agent version running inside a sandbox against the version
// this NemoClaw release was built for. Two code paths:
//   Fast: registry lookup (no execution, used when agentVersion is already cached)
//   Slow: OpenShell exec into sandbox, run version_command, cache result in registry

import { parseVersionFromText } from "../adapters/openshell/client.js";
import {
  executeOrdinarySandboxCommand,
  SandboxCommandTransportError,
} from "../adapters/sandbox/ordinary-command.js";
import { loadAgent } from "../agent/defs.js";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding.js";
import * as registry from "../state/registry.js";
import { evaluateStaleness } from "./version-scheme.js";

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
   * - `"registry"` / `"openshell-exec"`: `isStale` is authoritative for this sandbox
   *   as long as `verificationFailed` is `false`.
   * - `"unavailable"`: no staleness check was attempted (missing expected
   *   version, or the caller opted out of probing).
   * - `"unknown"`: a probe was attempted but the runtime version could not be
   *   inspected — callers should treat this as "unable to verify", not
   *   "verified current".
   */
  detectionMethod: "registry" | "openshell-exec" | "unavailable" | "unknown";
  /**
   * `true` when the runtime and expected versions use different schemes
   * (semver vs calendar). In that case `isStale` is forced to `true` so the
   * normal rebuild flow realigns the runtime with the current manifest; the
   * flag lets callers distinguish this fail-closed path from a numeric
   * comparison that observed a genuinely older version.
   */
  schemeMismatch?: boolean;
  /** Categorises why the result could not be computed, so callers can surface a distinct state. */
  unavailableReason?:
    | "no-expected-version"
    | "skip-probe"
    | "probe-failed"
    | "invalid-gateway-binding";
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
 * Gateway to scope the probe to, or null when the persisted binding was
 * rejected. An entry with no binding fields resolves to the canonical default
 * gateway, so null here means the row is corrupted — never that scoping is
 * unnecessary.
 */
function resolveProbeGatewayName(sandboxName: string): string | null {
  try {
    return resolveSandboxGatewayName(registry.getSandbox(sandboxName));
  } catch {
    return null;
  }
}

/**
 * Probe the live agent version inside a sandbox via OpenShell.
 * Returns the parsed version string or null on failure.
 */
export async function probeAgentVersion(
  sandboxName: string,
  gatewayName?: string,
): Promise<string | null> {
  const agent = resolveAgentForSandbox(sandboxName);

  // Reject corrupt bindings before execution. An ambient gateway could resolve
  // a different sandbox with the same name and poison this row's version cache.
  const probeGatewayName = gatewayName ?? resolveProbeGatewayName(sandboxName);
  if (probeGatewayName === null) return null;

  try {
    const result = await executeOrdinarySandboxCommand(sandboxName, agent.versionCommand, 15000, {
      gatewayName: probeGatewayName,
      honorCallerTimeout: true,
    });
    return result.status === 0 ? parseVersionFromText(result.stdout, agent.versionCommand) : null;
  } catch (error) {
    if (error instanceof SandboxCommandTransportError) return null;
    throw error;
  }
}

/**
 * Check whether a sandbox is running an outdated agent version.
 *
 * Fast path: compare registry.agentVersion against manifest expected_version.
 * Slow path: OpenShell exec into sandbox, run version_command, cache result in registry.
 */
export async function checkAgentVersion(
  sandboxName: string,
  opts?: VersionCheckOptions,
): Promise<VersionCheckResult> {
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

  // A rejected gateway binding means no probe is attempted at all, which the
  // result contract distinguishes from a probe that ran and failed: report
  // `unavailable` rather than `unknown`/`probe-failed` so an operator can tell
  // a corrupted registry row from an unreachable sandbox.
  const probeGatewayName = resolveProbeGatewayName(sandboxName);
  if (probeGatewayName === null) {
    return {
      sandboxVersion: null,
      expectedVersion,
      isStale: false,
      verificationFailed: true,
      detectionMethod: "unavailable",
      unavailableReason: "invalid-gateway-binding",
    };
  }

  // Slow path: OpenShell exec into sandbox
  const probed = await probeAgentVersion(sandboxName, probeGatewayName);
  if (probed && sb) {
    // Registry persistence preserves any disk-only legacy ownership evidence.
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
    detectionMethod: "openshell-exec",
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
