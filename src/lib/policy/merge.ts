// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertPolicyRequirementContainment as assertCanonicalPolicyRequirementContainment,
  buildOpenShellSandboxPolicyInspectionArgs as buildCanonicalOpenShellSandboxPolicyInspectionArgs,
  buildOpenShellSandboxPolicyReadArgs as buildCanonicalOpenShellSandboxPolicyReadArgs,
  buildOpenShellSandboxPolicyRevisionReadArgs as buildCanonicalOpenShellSandboxPolicyRevisionReadArgs,
  buildOpenShellSandboxPolicySetArgs as buildCanonicalOpenShellSandboxPolicySetArgs,
  classifyOpenShellSandboxPolicySetResult as classifyCanonicalOpenShellSandboxPolicySetResult,
  classifyOpenShellGlobalPolicyHistory as classifyCanonicalOpenShellGlobalPolicyHistory,
  parseActiveGlobalPolicyMetadata as parseCanonicalActiveGlobalPolicyMetadata,
  parseOpenShellPolicy as parseCanonicalOpenShellPolicy,
  parseOpenShellSandboxPolicyRead as parseCanonicalOpenShellSandboxPolicyRead,
  parseSandboxPolicyMetadata as parseCanonicalSandboxPolicyMetadata,
  rebaseOpenShellPolicyDocument as rebaseCanonicalOpenShellPolicyDocument,
  stripProviderComposedPolicies as stripCanonicalProviderComposedPolicies,
  type ActiveGlobalPolicyInspection,
  type OpenShellPolicyIdentity,
  type OpenShellGlobalPolicyHistoryState,
  type OpenShellPolicyInspection,
  type OpenShellSandboxPolicySetOutcome,
  withoutProviderComposedPolicies as withoutCanonicalProviderComposedPolicies,
} from "../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";

import type { JsonObject } from "../core/json-types";

// sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// CommonJS wrapper is compiled. Keep this file implementation-free.
export const parseOpenShellPolicy = parseCanonicalOpenShellPolicy;
export const parseOpenShellSandboxPolicyRead = parseCanonicalOpenShellSandboxPolicyRead;
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
export const buildOpenShellSandboxPolicySetArgs = buildCanonicalOpenShellSandboxPolicySetArgs;
export const classifyOpenShellSandboxPolicySetResult =
  classifyCanonicalOpenShellSandboxPolicySetResult;
export const rebaseOpenShellPolicyDocument = rebaseCanonicalOpenShellPolicyDocument;
export type {
  ActiveGlobalPolicyInspection,
  OpenShellPolicyIdentity,
  OpenShellGlobalPolicyHistoryState,
  OpenShellPolicyInspection,
  OpenShellSandboxPolicySetOutcome,
};

export function withoutProviderComposedPolicies(policies: JsonObject): JsonObject {
  return withoutCanonicalProviderComposedPolicies(policies) as JsonObject;
}
