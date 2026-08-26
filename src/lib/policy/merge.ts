// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertExternalPolicyRequirementContainment as assertCanonicalExternalPolicyRequirementContainment,
  assertMatchingPolicyAuthority as assertCanonicalMatchingPolicyAuthority,
  parseOpenShellPolicy as parseCanonicalOpenShellPolicy,
  parseSandboxPolicyAuthorityMetadata as parseCanonicalSandboxPolicyAuthorityMetadata,
  stripProviderComposedPolicies as stripCanonicalProviderComposedPolicies,
  type OpenShellPolicyAuthority,
  type SandboxPolicyAuthorityInspection,
  withoutProviderComposedPolicies as withoutCanonicalProviderComposedPolicies,
} from "../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";

import type { JsonObject } from "../core/json-types";

// sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// CommonJS wrapper is compiled. Keep this file implementation-free.
export const parseOpenShellPolicy = parseCanonicalOpenShellPolicy;
export const stripProviderComposedPolicies = stripCanonicalProviderComposedPolicies;
export const parseSandboxPolicyAuthorityMetadata =
  parseCanonicalSandboxPolicyAuthorityMetadata;
export const assertMatchingPolicyAuthority = assertCanonicalMatchingPolicyAuthority;
export const assertExternalPolicyRequirementContainment =
  assertCanonicalExternalPolicyRequirementContainment;
export type { OpenShellPolicyAuthority, SandboxPolicyAuthorityInspection };

export function withoutProviderComposedPolicies(policies: JsonObject): JsonObject {
  return withoutCanonicalProviderComposedPolicies(policies) as JsonObject;
}
