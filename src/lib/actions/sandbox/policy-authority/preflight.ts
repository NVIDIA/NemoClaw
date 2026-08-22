// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import {
  assertExternalPolicyRequirements,
  assertRecordedPolicyAuthority,
  inspectGlobalPolicyAuthority,
  inspectSandboxPolicyAuthority,
  type SandboxPolicyAuthority,
  type SandboxPolicyAuthorityInspection,
} from "../../../adapters/openshell/policy-authority";
import { isPresetPolicyMap, parseNetworkPolicies } from "../../../policy/preset-parsing";
import * as registry from "../../../policy/policy-registry";
import { getPersistedSandboxTargetGatewayName } from "../gateway-target";

export { isPolicyAuthorityRefusalError } from "../../../adapters/openshell/policy-authority";

interface SandboxPolicyAuthorityPreflightOptions {
  readonly externalPolicy: "verify" | "refuse";
  readonly operation: string;
  readonly requiredPolicyContents?: readonly string[];
  readonly sandboxName: string;
}

export type RequiredPolicy = Record<string, unknown>;

export interface PolicyAuthorityInspectionDeps {
  readonly inspectGlobalPolicyAuthority?: typeof inspectGlobalPolicyAuthority;
  readonly inspectSandboxPolicyAuthority?: typeof inspectSandboxPolicyAuthority;
}

export interface PolicyAuthorityInspectionOptions {
  readonly gatewayName: string;
  readonly inspectLiveSource: boolean;
  readonly operation: string;
  readonly recordedAuthority: unknown;
  readonly requiredPolicies: readonly RequiredPolicy[];
  readonly sandboxName: string;
  readonly verifyGlobalCreatePolicy: boolean;
}

export function parseRequiredPolicyDocument(content: string, operation: string): RequiredPolicy {
  try {
    const parsed: unknown = YAML.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as RequiredPolicy;
    }
  } catch {
    // The common refusal below owns invalid policy document errors.
  }
  throw new Error(`Refusing to ${operation}: a required network policy document is invalid.`);
}

/** Inspect live and create policy authority, then verify requirements after the caller records it. */
export function inspectPolicyAuthorityRequirements(
  options: PolicyAuthorityInspectionOptions,
  deps: PolicyAuthorityInspectionDeps = {},
) {
  const inspections: SandboxPolicyAuthorityInspection[] = [];
  if (options.inspectLiveSource) {
    inspections.push(
      (deps.inspectSandboxPolicyAuthority ?? inspectSandboxPolicyAuthority)({
        sandboxName: options.sandboxName,
        gatewayName: options.gatewayName,
      }),
    );
  }
  if (options.verifyGlobalCreatePolicy) {
    inspections.push(
      (deps.inspectGlobalPolicyAuthority ?? inspectGlobalPolicyAuthority)({
        gatewayName: options.gatewayName,
      }),
    );
  }
  const [inspection, ...additionalInspections] = inspections;
  if (!inspection) {
    throw new Error(`Refusing to ${options.operation}: policy authority could not be inspected.`);
  }
  const { authority } = inspection;
  if (options.recordedAuthority !== undefined) {
    assertRecordedPolicyAuthority(options.recordedAuthority, authority, options.operation);
  }
  for (const additional of additionalInspections) {
    assertRecordedPolicyAuthority(authority, additional.authority, options.operation);
  }
  return {
    authority,
    liveInspection: options.inspectLiveSource ? inspection : null,
    verifyRequirements: () => assertPolicyAuthorityRequirements(options, inspections),
  };
}

function assertPolicyAuthorityRequirements(
  options: PolicyAuthorityInspectionOptions,
  inspections: readonly SandboxPolicyAuthorityInspection[],
): void {
  for (const inspection of inspections) {
    for (const requiredPolicy of options.requiredPolicies) {
      assertExternalPolicyRequirements({
        inspection,
        requiredPolicy,
        operation: options.operation,
        sandboxName: options.sandboxName,
      });
    }
  }
}

export function assertManagedMcpPolicyRequirementsUnchanged(
  current: readonly RequiredPolicy[],
  qualified: readonly RequiredPolicy[],
  operation: string,
  timing: string,
): void {
  if (isDeepStrictEqual(current, qualified)) return;
  throw new Error(`Refusing to ${operation}: managed MCP policy requirements changed ${timing}.`);
}

function operationLabel(operation: string): string {
  return operation.trim() || "continue the policy-dependent operation";
}

function persistObservedAuthority(
  sandboxName: string,
  authority: SandboxPolicyAuthority,
  operation: string,
): void {
  const current = registry.getSandbox(sandboxName);
  if (!current) {
    throw new Error(`Refusing to ${operation}: sandbox '${sandboxName}' is not registered.`);
  }
  if (current.policyAuthority !== undefined) {
    assertRecordedPolicyAuthority(current.policyAuthority, authority, operation);
    return;
  }
  if (registry.updateSandbox(sandboxName, { policyAuthority: authority })) return;
  throw new Error(
    `Refusing to ${operation}: the observed policy authority could not be recorded for sandbox '${sandboxName}'.`,
  );
}

/** Inspect and persist policy authority before a policy-dependent lifecycle mutation. */
export function preflightSandboxPolicyAuthority({
  externalPolicy,
  operation,
  requiredPolicyContents = [],
  sandboxName,
}: SandboxPolicyAuthorityPreflightOptions): SandboxPolicyAuthority {
  const label = operationLabel(operation);
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) {
    throw new Error(`Refusing to ${label}: sandbox '${sandboxName}' is not registered.`);
  }
  const requiredPolicies = requiredPolicyContents.map((content) => {
    const networkPolicies = parseNetworkPolicies(content);
    if (!networkPolicies || !isPresetPolicyMap(networkPolicies)) {
      throw new Error(`Refusing to ${label}: a required network policy document is invalid.`);
    }
    return { network_policies: networkPolicies };
  });
  const authorityOptions = {
    gatewayName: getPersistedSandboxTargetGatewayName(sandbox),
    inspectLiveSource: true,
    operation: label,
    recordedAuthority: sandbox.policyAuthority,
    requiredPolicies,
    sandboxName,
    verifyGlobalCreatePolicy: false,
  };
  const inspection = inspectPolicyAuthorityRequirements(authorityOptions);
  persistObservedAuthority(sandboxName, inspection.authority, label);

  if (inspection.authority === "externally-managed") {
    if (externalPolicy === "refuse") {
      throw new Error(
        `Refusing to ${label}: this sandbox policy is externally managed. Ask the external policy authority to remove this policy-dependent capability.`,
      );
    }
    if (requiredPolicyContents.length === 0) {
      throw new Error(
        `Refusing to ${label}: no required network policy entries were supplied for external verification.`,
      );
    }
    inspection.verifyRequirements();
  }

  return inspection.authority;
}
