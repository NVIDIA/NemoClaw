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
} from "../adapters/openshell/client.js";
import { resolveOpenshell } from "../adapters/openshell/resolve.js";
import { openshellSandboxSshHost } from "../adapters/openshell/sandbox-ssh-host.js";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts.js";
import { loadAgent } from "../agent/defs.js";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding.js";
import * as registry from "../state/registry.js";
import { createTempSshConfig } from "./temp-ssh-config.js";
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
 * Probe the live agent version inside a sandbox via SSH.
 * Returns the parsed version string or null on failure.
 */
export function probeAgentVersion(sandboxName: string, gatewayName?: string): string | null {
  const agent = resolveAgentForSandbox(sandboxName);

  // Scope the lookup to the sandbox's own gateway. Without it OpenShell
  // resolves `sandbox get`/`ssh-config` against its mutable current selection,
  // so a sandbox bound to a sibling gateway is reported missing and its
  // version renders as `v?` (#7429).
  //
  // Resolved before the binary lookup: a rejected binding must not fall back to
  // the ambient gateway (the case `resolveSandboxGatewayName` fails closed on,
  // because a same-named sandbox on another gateway would be probed and its
  // version cached onto this row), and there is no reason to shell out to
  // `command -v openshell` only to discard the result. A caller that already
  // resolved the binding passes it in rather than re-reading the registry.
  const probeGatewayName = gatewayName ?? resolveProbeGatewayName(sandboxName);
  if (probeGatewayName === null) return null;

  const openshellBinary = resolveOpenshell();
  if (!openshellBinary) return null;

  const sshConfigResult = captureSandboxSshConfigCommand(openshellBinary, sandboxName, {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    gatewayName: probeGatewayName,
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
        openshellSandboxSshHost(sandboxName),
        agent.versionCommand,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
    );
    if (result.status !== 0) return null;
    return parseVersionFromText(result.stdout, agent.versionCommand);
  } catch {
    return null;
  } finally {
    tmpSshConfig.cleanup();
  }
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

  // Slow path: SSH exec into sandbox
  const probed = probeAgentVersion(sandboxName, probeGatewayName);
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
