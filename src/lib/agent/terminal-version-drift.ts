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
// A stale base image can create the invalid runtime/manifest pairing; image
// build and promotion are a separate pipeline boundary. This gate remains a
// defense-in-depth invariant until that pipeline can atomically prove the
// promoted image and every resumed sandbox satisfy the active manifest.

import { parseVersionFromText } from "../adapters/openshell/client";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { evaluateStaleness } from "../sandbox/version-scheme";
import type { AgentDefinition } from "./defs";

export type RunCaptureOpenshell = (
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

function unverifiedResult(
  sandboxName: string,
  expectedVersion: string,
  reason: TerminalAgentVersionUnverified["reason"],
): TerminalAgentVersionUnverified {
  console.debug(
    `  Terminal-agent version verification failed for sandbox '${sandboxName}' ` +
      `(expected ${expectedVersion}; reason: ${reason}).`,
  );
  return { status: "unverified", installedVersion: null, expectedVersion, reason };
}

/**
 * Probe the installed terminal-agent version via the injected runner and
 * compare it to the manifest's `expected_version`.
 *
 * @returns `not-required` when no version is declared; `current` when the
 * installed version satisfies the manifest; `stale` when it does not or its
 * version scheme differs; and `unverified` with `probe-failed` or
 * `unparseable-output` when the runtime cannot be verified. Unverified probes
 * never silently pass the version gate.
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

  let result: ReturnType<RunCaptureOpenshell>;
  try {
    // `version_command` is shell-form input from repository-shipped agent
    // manifests. Keep this boundary aligned with terminal-smoke.ts; convert it
    // to an argv-form allowlist before accepting custom/user manifests here.
    // The timeout prevents a hung command from wedging onboarding.
    result = runCaptureOpenshell(
      ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", agent.versionCommand],
      { ignoreError: true, timeout: OPENSHELL_PROBE_TIMEOUT_MS },
    );
  } catch {
    return unverifiedResult(sandboxName, expectedVersion, "probe-failed");
  }

  const output = typeof result === "string" ? result : (result?.output ?? null);
  if (!output) {
    return unverifiedResult(sandboxName, expectedVersion, "probe-failed");
  }

  // Prefer the version associated with the manifest command's executable.
  // Some CLIs include build/runtime versions in the same output, and the
  // shared fallback parser intentionally returns the first numeric triplet.
  const installedVersion = parseVersionFromText(output, agent.versionCommand);
  if (!installedVersion) {
    return unverifiedResult(sandboxName, expectedVersion, "unparseable-output");
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
}

/**
 * Describe why a terminal runtime cannot satisfy the manifest version gate.
 */
export function formatTerminalAgentVersionFailure(
  agent: AgentDefinition,
  failure: TerminalAgentVersionFailure,
): string {
  if (failure.status === "unverified") {
    const detail =
      failure.reason === "probe-failed"
        ? "the version probe failed or returned no output"
        : "the version command returned no attributable version";
    return (
      `${agent.displayName} version could not be verified against required version ` +
      `${failure.expectedVersion}: ${detail}`
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
