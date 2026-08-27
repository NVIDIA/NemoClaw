// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertExternalPolicyRequirementContainment as assertCanonicalExternalPolicyRequirementContainment,
  assertPolicyRequirementContainment as assertCanonicalPolicyRequirementContainment,
  assertMatchingPolicyAuthority as assertCanonicalMatchingPolicyAuthority,
  assertNemoClawPolicyCreationReceiptMatches as assertCanonicalNemoClawPolicyCreationReceiptMatches,
  classifyOpenShellGlobalPolicyHistory as classifyCanonicalOpenShellGlobalPolicyHistory,
  parseActiveGlobalPolicyAuthorityMetadata as parseCanonicalActiveGlobalPolicyAuthorityMetadata,
  parseNemoClawPolicyCreationReceipt as parseCanonicalNemoClawPolicyCreationReceipt,
  parseOpenShellPolicy as parseCanonicalOpenShellPolicy,
  parseSandboxPolicyAuthorityMetadata as parseCanonicalSandboxPolicyAuthorityMetadata,
  stripProviderComposedPolicies as stripCanonicalProviderComposedPolicies,
  type NemoClawPolicyCreationReceipt,
  type ActiveGlobalPolicyInspection,
  type OpenShellPolicyAuthority,
  type OpenShellPolicyIdentity,
  type OpenShellGlobalPolicyHistoryState,
  type SandboxPolicyAuthorityInspection,
  withoutProviderComposedPolicies as withoutCanonicalProviderComposedPolicies,
} from "../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";

import type { JsonObject } from "../core/json-types";

// sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// CommonJS wrapper is compiled. Keep this file implementation-free.
export const parseOpenShellPolicy = parseCanonicalOpenShellPolicy;
export const classifyOpenShellGlobalPolicyHistory = classifyCanonicalOpenShellGlobalPolicyHistory;
export const parseNemoClawPolicyCreationReceipt = parseCanonicalNemoClawPolicyCreationReceipt;
export const parseActiveGlobalPolicyAuthorityMetadata =
  parseCanonicalActiveGlobalPolicyAuthorityMetadata;
export const assertNemoClawPolicyCreationReceiptMatches =
  assertCanonicalNemoClawPolicyCreationReceiptMatches;
export const stripProviderComposedPolicies = stripCanonicalProviderComposedPolicies;
export const parseSandboxPolicyAuthorityMetadata = parseCanonicalSandboxPolicyAuthorityMetadata;
export const assertMatchingPolicyAuthority = assertCanonicalMatchingPolicyAuthority;
export const assertExternalPolicyRequirementContainment =
  assertCanonicalExternalPolicyRequirementContainment;
export const assertPolicyRequirementContainment = assertCanonicalPolicyRequirementContainment;
export type {
  ActiveGlobalPolicyInspection,
  NemoClawPolicyCreationReceipt,
  OpenShellPolicyAuthority,
  OpenShellPolicyIdentity,
  OpenShellGlobalPolicyHistoryState,
  SandboxPolicyAuthorityInspection,
};

export function withoutProviderComposedPolicies(policies: JsonObject): JsonObject {
  return withoutCanonicalProviderComposedPolicies(policies) as JsonObject;
}
