// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  assertPolicyRequirementContainment,
  buildOpenShellSandboxPolicyInspectionArgs,
  buildOpenShellSandboxPolicyReadArgs,
  buildOpenShellSandboxPolicyRevisionReadArgs,
  classifyOpenShellGlobalPolicyHistory,
  parseActiveGlobalPolicyMetadata,
  parseOpenShellPolicy,
  parseSandboxPolicyMetadata,
  stripProviderComposedPolicies,
  type ActiveGlobalPolicyInspection,
  type OpenShellGlobalPolicyHistoryState,
  type OpenShellPolicyIdentity,
  type OpenShellPolicyInspection,
  withoutProviderComposedPolicies,
} from "../adapters/openshell/policy-boundary";

// sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// policy compatibility facade is compiled. Keep this file implementation-free.
