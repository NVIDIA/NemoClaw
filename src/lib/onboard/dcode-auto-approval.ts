// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ManagedSandboxFeature,
  managedSandboxFeatureHasDrift,
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

export function dcodeAutoApprovalModeOrDefault(value: unknown): DcodeAutoApprovalMode {
  return normalizeDcodeAutoApprovalMode(value);
}

export const DCODE_AUTO_APPROVAL_FEATURE: ManagedSandboxFeature<DcodeAutoApprovalMode> = {
  id: "dcode-auto-approval",
  defaultValue: DEFAULT_DCODE_AUTO_APPROVAL_MODE,
  isValue: isDcodeAutoApprovalMode,
  isEnabled: (value) => value === "thread-opt-in",
  supportsAgent: isDcodeAgent,
};

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
    recordedValue: dcodeAutoApprovalModeOrDefault(options.recordedDcodeAutoApprovalMode),
    desiredValue: dcodeAutoApprovalModeOrDefault(options.requestedDcodeAutoApprovalMode),
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
