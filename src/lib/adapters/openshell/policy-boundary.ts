// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  assertPolicyRequirementContainment as assertCanonicalPolicyRequirementContainment,
  buildOpenShellSandboxPolicyInspectionArgs as buildCanonicalOpenShellSandboxPolicyInspectionArgs,
  buildOpenShellSandboxPolicyReadArgs as buildCanonicalOpenShellSandboxPolicyReadArgs,
  buildOpenShellSandboxPolicyRevisionReadArgs as buildCanonicalOpenShellSandboxPolicyRevisionReadArgs,
  buildOpenShellSandboxPolicySetArgs as buildCanonicalOpenShellSandboxPolicySetArgs,
  classifyOpenShellGlobalPolicyHistory as classifyCanonicalOpenShellGlobalPolicyHistory,
  classifyOpenShellSandboxPolicySetResult as classifyCanonicalOpenShellSandboxPolicySetResult,
  parseActiveGlobalPolicyMetadata as parseCanonicalActiveGlobalPolicyMetadata,
  parseOpenShellPolicy as parseCanonicalOpenShellPolicy,
  parseOpenShellSandboxPolicyRead as parseCanonicalOpenShellSandboxPolicyRead,
  parseSandboxPolicyMetadata as parseCanonicalSandboxPolicyMetadata,
  stripProviderComposedPolicies as stripCanonicalProviderComposedPolicies,
  type ActiveGlobalPolicyInspection,
  type OpenShellGlobalPolicyHistoryState,
  type OpenShellPolicyIdentity,
  type OpenShellPolicyInspection,
  type OpenShellSandboxPolicyRead,
  type OpenShellSandboxPolicySetCommandResult,
  type OpenShellSandboxPolicySetOutcome,
  type OpenShellSandboxPolicySetSubmission,
  withoutProviderComposedPolicies as withoutCanonicalProviderComposedPolicies,
} from "../../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";

import type { JsonObject } from "../../core/json-types";
import { stripCredentials } from "../../security/credential-filter";

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
export const buildOpenShellSandboxPolicySetArgs = buildCanonicalOpenShellSandboxPolicySetArgs;
export const parseOpenShellSandboxPolicyRead = parseCanonicalOpenShellSandboxPolicyRead;
export const classifyOpenShellSandboxPolicySetResult =
  classifyCanonicalOpenShellSandboxPolicySetResult;
export type {
  ActiveGlobalPolicyInspection,
  OpenShellGlobalPolicyHistoryState,
  OpenShellPolicyIdentity,
  OpenShellPolicyInspection,
  OpenShellSandboxPolicyRead,
  OpenShellSandboxPolicySetCommandResult,
  OpenShellSandboxPolicySetOutcome,
  OpenShellSandboxPolicySetSubmission,
};

/** Reject a root CLI policy handoff whenever credential filtering changes it. */
export function isOpenShellSandboxPolicyCredentialFree(content: string): boolean {
  const policy = parseCanonicalOpenShellPolicy(content).policy;
  return isDeepStrictEqual(stripCredentials(policy), policy);
}

export function withoutProviderComposedPolicies(policies: JsonObject): JsonObject {
  return withoutCanonicalProviderComposedPolicies(policies) as JsonObject;
}
