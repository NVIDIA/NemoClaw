// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInChannelManifestRegistry } from "../channels";
import { BUILT_IN_MESSAGING_HOOK_REGISTRY } from "../hooks";
import type { SandboxMessagingPlan } from "../manifest";
import { fail } from "./assertions";
import { validateCredentialBindings, validateNetworkPolicy } from "./credentials-policy";
import {
  assertPlanEnvelope,
  validateChannelInputs,
  validateChannels,
  validateDisabledChannels,
} from "./envelope-channel";
import { validateChannelHooks, validateHealthChecks } from "./hooks-health";
import {
  validateAgentRender,
  validateBuildSteps,
  validateStateUpdates,
} from "./render-build-state";
import type { SandboxMessagingPlanValidationOptions } from "./types";

export type { SandboxMessagingPlanValidationOptions } from "./types";

export function parseValidSandboxMessagingPlan(
  value: unknown,
  options: SandboxMessagingPlanValidationOptions = {},
): SandboxMessagingPlan | null {
  try {
    assertValidSandboxMessagingPlan(value, options);
    return value;
  } catch {
    return null;
  }
}

export function validateSandboxMessagingPlan(
  value: unknown,
  options: SandboxMessagingPlanValidationOptions = {},
): value is SandboxMessagingPlan {
  return parseValidSandboxMessagingPlan(value, options) !== null;
}

export function assertValidSandboxMessagingPlan(
  value: unknown,
  options: SandboxMessagingPlanValidationOptions = {},
): asserts value is SandboxMessagingPlan {
  const plan = assertPlanEnvelope(value);
  if (options.sandboxName !== undefined && plan.sandboxName !== options.sandboxName) {
    fail("$.sandboxName", `expected '${options.sandboxName}'`);
  }
  if (options.agent !== undefined && plan.agent !== options.agent) {
    fail("$.agent", `expected '${options.agent}'`);
  }

  const registry = options.registry ?? createBuiltInChannelManifestRegistry();
  const hooks = options.hooks ?? BUILT_IN_MESSAGING_HOOK_REGISTRY;
  const manifests = validateChannels(plan, registry, options.supportedChannelIds);
  validateDisabledChannels(plan, manifests);
  validateChannelInputs(plan, manifests);
  validateChannelHooks(plan, manifests, hooks);
  validateCredentialBindings(plan, manifests);
  validateNetworkPolicy(plan, manifests);
  validateAgentRender(plan, manifests);
  validateBuildSteps(plan, manifests, hooks);
  validateStateUpdates(plan, manifests);
  validateHealthChecks(plan, manifests, hooks);
}
