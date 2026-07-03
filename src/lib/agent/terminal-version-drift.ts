// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Terminal-agent version-drift detection for the onboard/rebuild smoke step.
//
// The [7/8] terminal smoke only asserts the agent binary runs (exit 0), so a
// binary older than the manifest's `expected_version` slips through silently —
// even though `nemoclaw status` flags the same drift (#6193). This probes the
// installed version through the caller's OpenShell runner and reuses the exact
// staleness contract `status` uses (`evaluateStaleness`), so both surfaces agree.

import { parseVersionFromText } from "../adapters/openshell/client";
import { evaluateStaleness } from "../sandbox/version-scheme";
import type { AgentDefinition } from "./defs";

type RunCaptureOpenshell = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => string | { output?: string | null } | null;

export interface TerminalAgentVersionDrift {
  installedVersion: string;
  expectedVersion: string;
  schemeMismatch: boolean;
}

/**
 * Probe the installed terminal-agent version via the injected runner and
 * compare it to the manifest's `expected_version`. Returns drift details when
 * the installed version is below expected (or scheme-incomparable), or `null`
 * when it is current, unknown, or no expected version is declared.
 *
 * Never throws and never blocks onboarding: a missing expected version, a
 * failed probe, or unparseable output all yield `null` so a benign hiccup can
 * not spuriously flag drift. Drift is surfaced as an advisory (mirroring
 * `status`), not a hard failure — the runtime is still usable.
 */
export function detectTerminalAgentVersionDrift(
  sandboxName: string,
  agent: AgentDefinition,
  runCaptureOpenshell: RunCaptureOpenshell,
): TerminalAgentVersionDrift | null {
  const expectedVersion = agent.expectedVersion;
  if (!expectedVersion) return null;

  const result = runCaptureOpenshell(
    ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", agent.versionCommand],
    { ignoreError: true },
  );
  const output = typeof result === "string" ? result : (result?.output ?? null);
  const installedVersion = output ? parseVersionFromText(output) : null;
  if (!installedVersion) return null;

  const verdict = evaluateStaleness(
    sandboxName,
    agent.versionScheme ?? null,
    installedVersion,
    expectedVersion,
  );
  if (!verdict.isStale) return null;

  return { installedVersion, expectedVersion, schemeMismatch: verdict.schemeMismatch };
}

/**
 * One-line advisory shown during the terminal smoke when the installed version
 * is behind the manifest's expected version.
 */
export function formatTerminalAgentVersionDriftWarning(
  agent: AgentDefinition,
  drift: TerminalAgentVersionDrift,
): string {
  return (
    `  ⚠ ${agent.displayName} ${drift.installedVersion} is below the expected version ` +
    `${drift.expectedVersion}; the runtime is usable but older than this NemoClaw release targets.`
  );
}
