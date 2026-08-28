// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import {
  assertExternalPolicyRequirements,
  assertObservedPolicyRequirements,
  assertRecordedPolicyAuthority,
  inspectActiveGlobalPolicy,
  inspectOpenShellSandboxIdentityFingerprint,
  inspectSandboxPolicyAuthority,
  assertOpenShellGatewayPortBinding,
  type SandboxPolicyAuthority,
  type SandboxPolicyAuthorityInspection,
} from "../../../adapters/openshell/policy-authority";
import {
  qualifyGlobalPolicyAuthority,
  qualifySandboxPolicyAuthority,
} from "../../../onboard/policy-authority/preflight";
import { parseOpenShellPolicy } from "../../../policy/merge";
import { isPresetPolicyMap, parseNetworkPolicies } from "../../../policy/preset-parsing";
import * as registry from "../../../state/registry";
import { getPersistedSandboxTargetGatewayName } from "../gateway-target";

export { isPolicyAuthorityRefusalError } from "../../../adapters/openshell/policy-authority";

interface SandboxPolicyAuthorityPreflightOptions {
  readonly externalPolicy: "verify" | "refuse";
  readonly operation: string;
  readonly requiredPolicyContents?: readonly string[];
  readonly sandboxName: string;
}

export type RequiredPolicy = Record<string, unknown>;
export type RecordedPolicyAuthority = Exclude<SandboxPolicyAuthority, "owner-unknown">;

export interface PolicyAuthorityInspectionDeps {
  readonly assertOpenShellGatewayPortBinding?: typeof assertOpenShellGatewayPortBinding;
  readonly inspectActiveGlobalPolicy?: typeof inspectActiveGlobalPolicy;
  readonly inspectOpenShellSandboxIdentityFingerprint?: typeof inspectOpenShellSandboxIdentityFingerprint;
  readonly inspectSandboxPolicyAuthority?: typeof inspectSandboxPolicyAuthority;
}

export interface PolicyAuthorityInspectionOptions {
  readonly gatewayName: string;
  readonly inspectLiveSource: boolean;
  readonly operation: string;
  readonly recordedAuthority: SandboxPolicyAuthority | null | undefined;
  readonly requiredPolicies: readonly RequiredPolicy[];
  readonly sandboxName: string;
  readonly verifyGlobalCreatePolicy: boolean;
}

export function parseRequiredPolicyDocument(content: string, operation: string): RequiredPolicy {
  try {
    return parseOpenShellPolicy(content).policy;
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
  const authorities: RecordedPolicyAuthority[] = [];
  let liveInspection: SandboxPolicyAuthorityInspection | null = null;
  const preparedRequirement = {
    appliedPresets: [],
    policyPath: "",
    sourceBytes: Buffer.from(
      YAML.stringify(options.requiredPolicies[0] ?? { version: 1, network_policies: {} }),
    ),
  };
  if (options.inspectLiveSource) {
    const observed = (deps.inspectSandboxPolicyAuthority ?? inspectSandboxPolicyAuthority)({
      sandboxName: options.sandboxName,
      gatewayName: options.gatewayName,
    });
    if (observed.authority !== "owner-unknown") {
      liveInspection = observed;
      authorities.push(observed.authority);
      if (observed.authority === "externally-managed") inspections.push(observed);
    } else {
      const recordedSandbox = registry.getSandbox(options.sandboxName);
      const qualified = qualifySandboxPolicyAuthority(
        {
          sandboxName: options.sandboxName,
          gatewayName: options.gatewayName,
          liveExists: true,
          recordedAuthorities: [options.recordedAuthority],
          recordedSandbox,
          readRecordedSandbox: registry.getSandbox,
          prepareRequiredPolicy: () => preparedRequirement,
          operation: options.operation,
        },
        deps,
      );
      liveInspection =
        qualified.authority === "externally-managed" ? qualified.inspection : observed;
      authorities.push(qualified.authority);
      if (qualified.authority === "externally-managed") inspections.push(qualified.inspection);
    }
  }
  if (options.verifyGlobalCreatePolicy) {
    const qualified = qualifyGlobalPolicyAuthority(
      {
        gatewayName: options.gatewayName,
        recordedAuthority: options.inspectLiveSource ? undefined : options.recordedAuthority,
        operation: options.operation,
      },
      deps,
    );
    authorities.push(qualified.authority);
    if (qualified.authority === "externally-managed") inspections.push(qualified.inspection);
  }
  const [authority, ...additionalAuthorities] = authorities;
  if (!authority) {
    throw new Error(`Refusing to ${options.operation}: policy authority could not be inspected.`);
  }
  if (options.recordedAuthority !== undefined && options.recordedAuthority !== null) {
    assertRecordedPolicyAuthority(options.recordedAuthority, authority, options.operation);
  }
  for (const additional of additionalAuthorities) {
    assertRecordedPolicyAuthority(authority, additional, options.operation);
  }
  return {
    authority,
    liveInspection,
    verifyRequirements: () => assertPolicyAuthorityRequirements(options, inspections),
  };
}

function assertPolicyAuthorityRequirements(
  options: PolicyAuthorityInspectionOptions,
  inspections: readonly SandboxPolicyAuthorityInspection[],
): void {
  for (const inspection of inspections) {
    for (const requiredPolicy of options.requiredPolicies) {
      const assertRequirements =
        inspection.authority === "owner-unknown"
          ? assertObservedPolicyRequirements
          : assertExternalPolicyRequirements;
      assertRequirements({
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
  authority: RecordedPolicyAuthority,
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
}: SandboxPolicyAuthorityPreflightOptions): RecordedPolicyAuthority {
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
