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
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { evaluateStaleness } from "../sandbox/version-scheme";
import type { AgentDefinition } from "./defs";

type RunCaptureOpenshell = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => string | { output?: string | null } | null;

export interface TerminalAgentVersionStale {
  status: "stale";
  installedVersion: string;
  expectedVersion: string;
  schemeMismatch: boolean;
}

export interface TerminalAgentVersionUnverified {
  status: "unverified";
  installedVersion: null;
  expectedVersion: string;
  reason: "probe-failed" | "unparseable-output";
}

export type TerminalAgentVersionFailure =
  | TerminalAgentVersionStale
  | TerminalAgentVersionUnverified;

export type TerminalAgentVersionCheck =
  | { status: "not-required"; installedVersion: null; expectedVersion: null }
  | {
      status: "current";
      installedVersion: string;
      expectedVersion: string;
      schemeMismatch: false;
    }
  | TerminalAgentVersionFailure;

/**
 * Probe the installed terminal-agent version via the injected runner and
 * compare it to the manifest's `expected_version`.
 *
 * Returns an explicit state so onboarding can distinguish current, stale, and
 * unverifiable runtimes. Probe failures are contained and returned as
 * `unverified`; they never silently pass the version gate.
 */
export function checkTerminalAgentVersion(
  sandboxName: string,
  agent: AgentDefinition,
  runCaptureOpenshell: RunCaptureOpenshell,
): TerminalAgentVersionCheck {
  const expectedVersion = agent.expectedVersion;
  if (!expectedVersion) {
    return { status: "not-required", installedVersion: null, expectedVersion: null };
  }

  try {
    // `version_command` is shell-form input from repository-shipped agent
    // manifests. Keep this boundary aligned with terminal-smoke.ts; convert it
    // to an argv-form allowlist before accepting custom/user manifests here.
    // The timeout prevents a hung command from wedging onboarding.
    const result = runCaptureOpenshell(
      ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", agent.versionCommand],
      { ignoreError: true, timeout: OPENSHELL_PROBE_TIMEOUT_MS },
    );
    const output = typeof result === "string" ? result : (result?.output ?? null);
    if (!output) {
      return {
        status: "unverified",
        installedVersion: null,
        expectedVersion,
        reason: "probe-failed",
      };
    }

    // Prefer the version associated with the manifest command's executable.
    // Some CLIs include build/runtime versions in the same output, and the
    // shared fallback parser intentionally returns the first numeric triplet.
    const installedVersion = parseVersionFromText(output, agent.versionCommand);
    if (!installedVersion) {
      return {
        status: "unverified",
        installedVersion: null,
        expectedVersion,
        reason: "unparseable-output",
      };
    }

    const verdict = evaluateStaleness(
      sandboxName,
      agent.versionScheme ?? null,
      installedVersion,
      expectedVersion,
    );
    if (!verdict.isStale) {
      return {
        status: "current",
        installedVersion,
        expectedVersion,
        schemeMismatch: false,
      };
    }

    return {
      status: "stale",
      installedVersion,
      expectedVersion,
      schemeMismatch: verdict.schemeMismatch,
    };
  } catch {
    return {
      status: "unverified",
      installedVersion: null,
      expectedVersion,
      reason: "probe-failed",
    };
  }
}

/**
 * Describe why a terminal runtime cannot satisfy the manifest version gate.
 */
export function formatTerminalAgentVersionFailure(
  agent: AgentDefinition,
  failure: TerminalAgentVersionFailure,
): string {
  if (failure.status === "unverified") {
    return (
      `${agent.displayName} version could not be verified against required version ` +
      failure.expectedVersion
    );
  }
  if (failure.schemeMismatch) {
    return (
      `${agent.displayName} version ${failure.installedVersion} uses a different version scheme ` +
      `than required version ${failure.expectedVersion}`
    );
  }
  return (
    `${agent.displayName} version ${failure.installedVersion} is below required minimum ` +
    failure.expectedVersion
  );
}
