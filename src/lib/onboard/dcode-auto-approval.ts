// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ManagedSandboxFeature,
  managedSandboxFeatureHasDrift,
  resolveManagedSandboxFeature,
} from "./managed-sandbox-feature";
import { DCODE_AGENT_NAME, isDcodeAgent } from "./observability-policy-presets";

export const DCODE_AUTO_APPROVAL_MODES = ["disabled", "thread-opt-in"] as const;
export type DcodeAutoApprovalMode = (typeof DCODE_AUTO_APPROVAL_MODES)[number];

export const DEFAULT_DCODE_AUTO_APPROVAL_MODE: DcodeAutoApprovalMode = "disabled";
export const DCODE_AUTO_APPROVAL_BUILD_ARG = "NEMOCLAW_DCODE_AUTO_APPROVAL";

export function isDcodeAutoApprovalMode(value: unknown): value is DcodeAutoApprovalMode {
  return value === "disabled" || value === "thread-opt-in";
}

/** Normalize untrusted input to the closed, non-auto-approving posture. */
export function normalizeDcodeAutoApprovalMode(value: unknown): DcodeAutoApprovalMode {
  return isDcodeAutoApprovalMode(value) ? value : DEFAULT_DCODE_AUTO_APPROVAL_MODE;
}

/** Missing legacy state is valid and means disabled; any other unknown value is malformed. */
export function invalidRecordedDcodeAutoApprovalMode(value: unknown): boolean {
  return value !== undefined && value !== null && !isDcodeAutoApprovalMode(value);
}

export const DCODE_AUTO_APPROVAL_FEATURE: ManagedSandboxFeature<DcodeAutoApprovalMode> = {
  id: "dcode-auto-approval",
  defaultValue: DEFAULT_DCODE_AUTO_APPROVAL_MODE,
  isValue: isDcodeAutoApprovalMode,
  isEnabled: (value) => value === "thread-opt-in",
  supportsAgent: isDcodeAgent,
};

export function resolveDcodeAutoApprovalRequest(input: {
  agent: string | null | undefined;
  requestedMode: DcodeAutoApprovalMode | null | undefined;
  recordedMode: unknown;
}): { mode: DcodeAutoApprovalMode; error: string | null } {
  if (invalidRecordedDcodeAutoApprovalMode(input.recordedMode)) {
    return {
      mode: DEFAULT_DCODE_AUTO_APPROVAL_MODE,
      error:
        "  Recorded DCode auto-approval mode is invalid. Refusing to enable or reuse the sandbox; repair the recorded state to 'disabled' before retrying.",
    };
  }
  const resolution = resolveManagedSandboxFeature(DCODE_AUTO_APPROVAL_FEATURE, {
    agent: input.agent,
    requested: input.requestedMode,
    registryValue: isDcodeAutoApprovalMode(input.recordedMode) ? input.recordedMode : null,
  });
  const error =
    resolution.issue === "unsupported-request"
      ? "  --dcode-auto-approval thread-opt-in is supported only with the managed --agent langchain-deepagents-code image."
      : resolution.issue === "recorded-state-on-unsupported-agent"
        ? "  Recorded DCode auto-approval belongs to the existing Deep Agents Code sandbox. Pass --dcode-auto-approval disabled explicitly when switching agents."
        : null;
  return { mode: resolution.value, error };
}

export function hasDcodeAutoApprovalDrift(options: {
  liveExists: boolean;
  managedDcodeAgent: boolean;
  hasRegistryEntry: boolean;
  recordedDcodeAutoApprovalMode: unknown;
  requestedDcodeAutoApprovalMode: unknown;
}): boolean {
  if (invalidRecordedDcodeAutoApprovalMode(options.recordedDcodeAutoApprovalMode)) {
    return true;
  }
  return managedSandboxFeatureHasDrift(DCODE_AUTO_APPROVAL_FEATURE, {
    liveExists: options.liveExists,
    hasRegistryEntry: options.hasRegistryEntry,
    agent: options.managedDcodeAgent ? DCODE_AGENT_NAME : null,
    // A legacy managed image has the same closed behavior as an explicit
    // disabled mode, so absence alone does not force a migration rebuild.
    recordedValue: normalizeDcodeAutoApprovalMode(options.recordedDcodeAutoApprovalMode),
    desiredValue: normalizeDcodeAutoApprovalMode(options.requestedDcodeAutoApprovalMode),
  });
}

export function hasRegisteredDcodeAutoApprovalDrift(
  liveExists: boolean,
  managedDcodeAgent: boolean,
  registryEntry: { dcodeAutoApprovalMode?: unknown } | null,
  requestedDcodeAutoApprovalMode: unknown,
): boolean {
  return hasDcodeAutoApprovalDrift({
    liveExists,
    managedDcodeAgent,
    hasRegistryEntry: registryEntry !== null,
    recordedDcodeAutoApprovalMode: registryEntry?.dcodeAutoApprovalMode,
    requestedDcodeAutoApprovalMode,
  });
}

export function prepareDcodeAutoApprovalCreatePlan(
  input: {
    sandboxName: string;
    liveExists: boolean;
    managedDcodeAgent: boolean;
    registryEntry: { dcodeAutoApprovalMode?: unknown } | null;
    requestedMode: unknown;
  },
  deps: { error(message: string): void; exitProcess(code: number): never } = {
    error: console.error,
    exitProcess: (code) => process.exit(code),
  },
): { mode: DcodeAutoApprovalMode; hasDrift: boolean; rebuildFlag: string } {
  if (input.liveExists && input.managedDcodeAgent && !input.registryEntry) {
    deps.error(
      `  Sandbox '${input.sandboxName}' is live but missing its NemoClaw registry record; refusing unverified DCode reuse or recreation.`,
    );
    deps.error(
      "  Choose a different sandbox name, or remove the orphan explicitly with OpenShell.",
    );
    deps.exitProcess(1);
  }
  if (invalidRecordedDcodeAutoApprovalMode(input.registryEntry?.dcodeAutoApprovalMode)) {
    deps.error(
      "  Recorded DCode auto-approval mode is invalid. Refusing to enable or reuse the sandbox; repair the recorded state to 'disabled' before retrying.",
    );
    deps.exitProcess(1);
  }
  const mode = normalizeDcodeAutoApprovalMode(input.requestedMode);
  return {
    mode,
    hasDrift: hasRegisteredDcodeAutoApprovalDrift(
      input.liveExists,
      input.managedDcodeAgent,
      input.registryEntry,
      mode,
    ),
    rebuildFlag: input.managedDcodeAgent ? ` --dcode-auto-approval ${mode}` : "",
  };
}
