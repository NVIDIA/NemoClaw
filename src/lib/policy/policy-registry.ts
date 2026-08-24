// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Registry operations owned by policy authority and attribution flows. */
export {
  addBaselineExclusion,
  addCustomPolicy,
  beginBaselineExclusionTransition,
  clearBaselineExclusionTransition,
  commitBaselineExclusionTransition,
  getBaselineExclusions,
  getBaselineExclusionTransition,
  getConfiguredMessagingChannelsFromEntry,
  getCustomPolicies,
  getDisabledMessagingChannelsFromEntry,
  getSandbox,
  normalizeSandboxPolicyAttribution,
  removeBaselineExclusion,
  removeCustomPolicyByName,
  updateSandbox,
} from "../state/registry";

export type {
  BaselineExclusionEntry,
  BaselineExclusionTransition,
  BaselineExclusionTransitionOperation,
  SandboxEntry,
} from "../state/registry";

export {
  assertExternalPolicyRequirements,
  assertRecordedPolicyAuthority,
  inspectSandboxPolicyAuthority,
  isPolicyAuthorityRefusalError,
  PolicyAuthorityRefusalError,
} from "../adapters/openshell/policy-authority";
export type {
  SandboxPolicyAuthority,
  SandboxPolicyAuthorityInspection,
} from "../adapters/openshell/policy-authority";
