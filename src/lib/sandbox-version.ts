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
import fs from "fs";
import os from "os";
import path from "path";

import { parseVersionFromText, versionGte } from "./openshell.js";
import * as registry from "./registry.js";
import { loadAgent } from "./agent-defs.js";
import { resolveOpenshell } from "./resolve-openshell.js";
import { captureOpenshellCommand } from "./openshell.js";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./openshell-timeouts.js";

export interface VersionCheckResult {
  sandboxVersion: string | null;
  expectedVersion: string | null;
  isStale: boolean;
  detectionMethod: "registry" | "ssh-exec" | "unavailable";
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

  const sshConfigResult = captureOpenshellCommand(
    openshellBinary,
    ["sandbox", "ssh-config", sandboxName],
    { ignoreError: true, timeout: OPENSHELL_PROBE_TIMEOUT_MS },
  );
  if (sshConfigResult.status !== 0) return null;

  const tmpFile = path.join(os.tmpdir(), `nemoclaw-ver-${process.pid}-${Date.now()}.conf`);
  fs.writeFileSync(tmpFile, sshConfigResult.output, { mode: 0o600 });
  try {
    const result = spawnSync(
      "ssh",
      [
        "-F", tmpFile,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=5",
        "-o", "LogLevel=ERROR",
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
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
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
  opts?: { forceProbe?: boolean; skipProbe?: boolean },
): VersionCheckResult {
  const agent = resolveAgentForSandbox(sandboxName);
  const expectedVersion = agent.expectedVersion;

  if (!expectedVersion) {
    return { sandboxVersion: null, expectedVersion: null, isStale: false, detectionMethod: "unavailable" };
  }

  const sb = registry.getSandbox(sandboxName);

  // Fast path: version already cached in registry
  if (sb?.agentVersion && !opts?.forceProbe) {
    const isStale = !versionGte(sb.agentVersion, expectedVersion);
    return {
      sandboxVersion: sb.agentVersion,
      expectedVersion,
      isStale,
      detectionMethod: "registry",
    };
  }

  if (opts?.skipProbe && !opts.forceProbe) {
    return { sandboxVersion: null, expectedVersion, isStale: false, detectionMethod: "unavailable" };
  }

  // Slow path: SSH exec into sandbox
  const probed = probeAgentVersion(sandboxName);
  if (probed && sb) {
    // Cache for future fast-path lookups
    registry.updateSandbox(sandboxName, { agentVersion: probed });
  }

  if (!probed) {
    return { sandboxVersion: null, expectedVersion, isStale: false, detectionMethod: "unavailable" };
  }

  const isStale = !versionGte(probed, expectedVersion);
  return {
    sandboxVersion: probed,
    expectedVersion,
    isStale,
    detectionMethod: "ssh-exec",
  };
}

/**
 * Format a user-facing staleness warning for console output.
 */
export function formatStalenessWarning(
  sandboxName: string,
  result: VersionCheckResult,
): string[] {
  const agentName = resolveAgentForSandbox(sandboxName).displayName;
  return [
    "",
    `  \u26a0 Sandbox '${sandboxName}' is running ${agentName} ${result.sandboxVersion} (current: ${result.expectedVersion})`,
    `    Run: nemoclaw ${sandboxName} rebuild`,
    "",
  ];
}
