// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertPolicyRequirementContainment as assertCanonicalPolicyRequirementContainment,
  buildOpenShellSandboxPolicyInspectionArgs as buildCanonicalOpenShellSandboxPolicyInspectionArgs,
  buildOpenShellSandboxPolicyReadArgs as buildCanonicalOpenShellSandboxPolicyReadArgs,
  buildOpenShellSandboxPolicyRevisionReadArgs as buildCanonicalOpenShellSandboxPolicyRevisionReadArgs,
  classifyOpenShellGlobalPolicyHistory as classifyCanonicalOpenShellGlobalPolicyHistory,
  parseActiveGlobalPolicyMetadata as parseCanonicalActiveGlobalPolicyMetadata,
  parseOpenShellPolicy as parseCanonicalOpenShellPolicy,
  parseSandboxPolicyMetadata as parseCanonicalSandboxPolicyMetadata,
  stripProviderComposedPolicies as stripCanonicalProviderComposedPolicies,
  type ActiveGlobalPolicyInspection,
  type OpenShellGlobalPolicyHistoryState,
  type OpenShellPolicyIdentity,
  type OpenShellPolicyInspection,
  withoutProviderComposedPolicies as withoutCanonicalProviderComposedPolicies,
} from "../../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";

import type { JsonObject } from "../../core/json-types";

// sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// adapter boundary is compiled. Keep this file implementation-free.
export const parseOpenShellPolicy = parseCanonicalOpenShellPolicy;
export const classifyOpenShellGlobalPolicyHistory = classifyCanonicalOpenShellGlobalPolicyHistory;
export const parseActiveGlobalPolicyMetadata = parseCanonicalActiveGlobalPolicyMetadata;
export const stripProviderComposedPolicies = stripCanonicalProviderComposedPolicies;
export const parseSandboxPolicyMetadata = parseCanonicalSandboxPolicyMetadata;
export const assertPolicyRequirementContainment = assertCanonicalPolicyRequirementContainment;
export const buildOpenShellSandboxPolicyReadArgs = buildCanonicalOpenShellSandboxPolicyReadArgs;
export const buildOpenShellSandboxPolicyInspectionArgs =
  buildCanonicalOpenShellSandboxPolicyInspectionArgs;
export const buildOpenShellSandboxPolicyRevisionReadArgs =
  buildCanonicalOpenShellSandboxPolicyRevisionReadArgs;
export type {
  ActiveGlobalPolicyInspection,
  OpenShellGlobalPolicyHistoryState,
  OpenShellPolicyIdentity,
  OpenShellPolicyInspection,
};

export function withoutProviderComposedPolicies(policies: JsonObject): JsonObject {
  return withoutCanonicalProviderComposedPolicies(policies) as JsonObject;
}
