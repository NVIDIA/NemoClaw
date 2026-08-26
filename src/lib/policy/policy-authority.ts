// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertOpenShellGatewayPortBinding,
  captureSandboxBasePolicy,
  inspectActiveGlobalPolicy,
  inspectOpenShellSandboxIdentityFingerprint,
  inspectSandboxPolicyAuthority,
  isExternalPolicyAuthorityRefusalError,
  isPolicyAuthorityRefusalError,
  PolicyAuthorityRefusalError,
  type ActiveGlobalPolicyInspection,
  type SandboxPolicyAuthority,
  type SandboxPolicyAuthorityInspection,
} from "../adapters/openshell/policy-authority";
import {
  assertExternalPolicyRequirementContainment,
  assertMatchingPolicyAuthority,
  assertPolicyRequirementContainment,
} from "./merge";

type JsonObject = Record<string, unknown>;

export {
  assertOpenShellGatewayPortBinding,
  captureSandboxBasePolicy,
  inspectActiveGlobalPolicy,
  inspectOpenShellSandboxIdentityFingerprint,
  inspectSandboxPolicyAuthority,
  isExternalPolicyAuthorityRefusalError,
  isPolicyAuthorityRefusalError,
  PolicyAuthorityRefusalError,
};
export type {
  ActiveGlobalPolicyInspection,
  SandboxPolicyAuthority,
  SandboxPolicyAuthorityInspection,
};

function operationLabel(operation: string): string {
  return typeof operation === "string" && operation.trim().length > 0
    ? operation.trim()
    : "continue the policy-dependent operation";
}

/** Refuse a lifecycle operation when its durable and observed authority disagree. */
export function assertRecordedPolicyAuthority(
  recorded: unknown,
  observed: unknown,
  operation: string,
): void {
  const label = operationLabel(operation);
  try {
    assertMatchingPolicyAuthority(recorded, observed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "policy authority is invalid";
    const observedAuthority =
      observed === "nemoclaw-managed" || observed === "externally-managed" ? observed : undefined;
    throw new PolicyAuthorityRefusalError(`Refusing to ${label}: ${detail}.`, observedAuthority);
  }
}

/**
 * Verify that an externally supplied policy contains each required entry and
 * section without claiming ownership. Unrelated external entries are allowed.
 */
export function assertExternalPolicyRequirements({
  inspection,
  requiredPolicy,
  operation,
  sandboxName,
}: {
  readonly inspection: SandboxPolicyAuthorityInspection;
  readonly requiredPolicy: JsonObject;
  readonly operation: string;
  readonly sandboxName?: string;
}): void {
  const label = operationLabel(operation);
  const target = sandboxName ? ` for sandbox ${JSON.stringify(sandboxName)}` : "";
  try {
    assertExternalPolicyRequirementContainment(inspection, requiredPolicy);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the policy requirement is invalid";
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${label}${target}: ${detail}. Ask the external policy authority to supply the exact required entries.`,
    );
  }
}

/** Verify required entries without assigning ownership to a sandbox-scoped policy. */
export function assertObservedPolicyRequirements({
  inspection,
  requiredPolicy,
  operation,
  sandboxName,
}: {
  readonly inspection: SandboxPolicyAuthorityInspection;
  readonly requiredPolicy: JsonObject;
  readonly operation: string;
  readonly sandboxName?: string;
}): void {
  const label = operationLabel(operation);
  const target = sandboxName ? ` for sandbox ${JSON.stringify(sandboxName)}` : "";
  try {
    assertPolicyRequirementContainment(inspection, requiredPolicy);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the policy requirement is invalid";
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${label}${target}: ${detail}. The verified policy must supply the exact required entries.`,
    );
  }
}
