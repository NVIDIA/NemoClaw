// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_SANDBOX_HOST_BRIDGE } from "../private-networks";
import { isPolicyObject, type PolicyObject, parseNetworkPolicies } from "./preset-parsing";
import {
  type SemanticFinding,
  splitSemanticFindings,
  validatePolicySemantics,
} from "./semantic-validation";
import { isTrustedPrivatePolicyPinCapability } from "./trusted-private-endpoints";

export interface CustomPolicyContentValidation {
  hasRestrictedAllowedIps: boolean;
  semanticErrors: SemanticFinding[];
  semanticWarnings: SemanticFinding[];
  trustedPrivatePinAuthorityProvided: boolean;
  trustedPrivatePinAuthorityValid: boolean;
}

function endpointHostIsGatewayBridge(endpoint: PolicyObject): boolean {
  const host = (endpoint as { host?: unknown }).host;
  return (
    typeof host === "string" &&
    host.replace(/\.$/, "").toLowerCase() === OPENSHELL_SANDBOX_HOST_BRIDGE
  );
}

/** Return true when a policy contains pins outside the reviewed host-gateway exception. */
export function networkPoliciesHasAllowedIps(networkPolicies: PolicyObject): boolean {
  for (const policyValue of Object.values(networkPolicies)) {
    if (!isPolicyObject(policyValue)) continue;
    // Object-level `allowed_ips` has no endpoint host context and is never a
    // legitimate shape. Include inherited properties so a prototype cannot
    // bypass the guard.
    if ("allowed_ips" in policyValue) return true;
    const endpoints = policyValue.endpoints;
    if (!Array.isArray(endpoints)) continue;
    for (const endpoint of endpoints) {
      if (!isPolicyObject(endpoint) || !("allowed_ips" in endpoint)) continue;
      if (endpointHostIsGatewayBridge(endpoint)) continue;
      return true;
    }
  }
  return false;
}

/** Inspect custom policy content without granting or mutating policy authority. */
export function inspectCustomPolicyContent(
  content: string,
  trustedPrivatePinAuthority?: unknown,
): CustomPolicyContentValidation {
  const networkPolicies = parseNetworkPolicies(content);
  const hasRestrictedAllowedIps =
    networkPolicies !== null && networkPoliciesHasAllowedIps(networkPolicies);
  const trustedPrivatePinAuthorityProvided = trustedPrivatePinAuthority !== undefined;
  const trustedPrivatePinAuthorityValid = isTrustedPrivatePolicyPinCapability(
    content,
    trustedPrivatePinAuthority,
  );
  const { errors: semanticErrors, warnings: semanticWarnings } = splitSemanticFindings(
    validatePolicySemantics({ network_policies: networkPolicies }),
  );
  return {
    hasRestrictedAllowedIps,
    semanticErrors,
    semanticWarnings,
    trustedPrivatePinAuthorityProvided,
    trustedPrivatePinAuthorityValid,
  };
}
