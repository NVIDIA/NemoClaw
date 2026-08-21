// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertExternalPolicyRequirements,
  assertRecordedPolicyAuthority,
  inspectSandboxPolicyAuthority,
  type SandboxPolicyAuthority,
} from "../../../adapters/openshell/policy-authority";
import { isPresetPolicyMap, parseNetworkPolicies } from "../../../policy/preset-parsing";
import * as registry from "../../../policy/policy-registry";
import { getPersistedSandboxTargetGatewayName } from "../gateway-target";

interface SandboxPolicyAuthorityPreflightOptions {
  readonly externalPolicy: "verify" | "refuse";
  readonly operation: string;
  readonly requiredPolicyContents?: readonly string[];
  readonly sandboxName: string;
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
  const inspection = inspectSandboxPolicyAuthority({
    sandboxName,
    gatewayName: getPersistedSandboxTargetGatewayName(sandbox),
  });
  if (sandbox.policyAuthority !== undefined) {
    assertRecordedPolicyAuthority(sandbox.policyAuthority, inspection.authority, label);
  }
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
    for (const requiredPolicy of requiredPolicies) {
      assertExternalPolicyRequirements({
        inspection,
        requiredPolicy,
        operation: label,
        sandboxName,
      });
    }
  }

  return inspection.authority;
}
