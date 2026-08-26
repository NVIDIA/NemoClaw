// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compatibility exports for policy callers that predate the canonical
 * OpenShell authority boundary. New policy operations import the adapter
 * directly; keeping this module prevents lifecycle handlers from acquiring a
 * second implementation of the authority checks.
 */
export {
  assertExternalPolicyRequirements,
  assertObservedPolicyRequirements,
  assertOpenShellGatewayPortBinding,
  assertRecordedPolicyAuthority,
  captureSandboxBasePolicy,
  inspectActiveGlobalPolicy,
  inspectOpenShellSandboxIdentityFingerprint,
  inspectSandboxPolicyAuthority,
  isExternalPolicyAuthorityRefusalError,
  isPolicyAuthorityRefusalError,
  PolicyAuthorityRefusalError,
} from "../adapters/openshell/policy-authority";
export type {
  ActiveGlobalPolicyInspection,
  SandboxPolicyAuthority,
  SandboxPolicyAuthorityInspection,
} from "../adapters/openshell/policy-authority";
