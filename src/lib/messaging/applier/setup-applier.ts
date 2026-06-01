// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import type { ChannelHookPhase, SandboxMessagingPlan } from "../manifest";
import {
  applyAgentConfigAtOpenShell as applyAgentConfigPlanAtOpenShell,
  listHookRequests as listPlanHookRequests,
} from "./agent-config";
import { applyCredentialsAtOpenShell as applyCredentialsPlanAtOpenShell } from "./openshell-provider";
import { applyPolicyAtOpenShell as applyPolicyPlanAtOpenShell } from "./policy";
import {
  MESSAGING_SETUP_APPLIER_ENV_KEY,
  type MessagingCredentialApplyOptions,
  type MessagingCredentialApplyResult,
  type MessagingHookApplyRequest,
  type MessagingHookApplyRunner,
  type MessagingOpenShellRunner,
  type MessagingPolicyApplyOptions,
  type MessagingPolicyApplyResult,
  type MessagingSetupEnvOptions,
} from "./types";

export class MessagingSetupApplier {
  static encodePlan(plan: SandboxMessagingPlan): string {
    assertSandboxMessagingPlan(plan);
    assertJsonSerializable(plan);
    return Buffer.from(JSON.stringify(plan), "utf8").toString("base64");
  }

  static decodePlan(encoded: string): SandboxMessagingPlan {
    const raw = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    assertSandboxMessagingPlan(parsed);
    return parsed;
  }

  static writePlanToEnv(
    plan: SandboxMessagingPlan,
    options: MessagingSetupEnvOptions = {},
  ): void {
    const env = options.env ?? process.env;
    env[options.envKey ?? MESSAGING_SETUP_APPLIER_ENV_KEY] = this.encodePlan(plan);
  }

  static readPlanFromEnv(options: MessagingSetupEnvOptions = {}): SandboxMessagingPlan | null {
    const env = options.env ?? process.env;
    const value = env[options.envKey ?? MESSAGING_SETUP_APPLIER_ENV_KEY];
    return value ? this.decodePlan(value) : null;
  }

  static requirePlanFromEnv(options: MessagingSetupEnvOptions = {}): SandboxMessagingPlan {
    const plan = this.readPlanFromEnv(options);
    if (!plan) {
      throw new Error(`${options.envKey ?? MESSAGING_SETUP_APPLIER_ENV_KEY} is not set.`);
    }
    return plan;
  }

  static clearPlanEnv(options: MessagingSetupEnvOptions = {}): void {
    const env = options.env ?? process.env;
    delete env[options.envKey ?? MESSAGING_SETUP_APPLIER_ENV_KEY];
  }

  static listHookRequests(
    plan: SandboxMessagingPlan,
    phase?: ChannelHookPhase,
  ): MessagingHookApplyRequest[] {
    assertSandboxMessagingPlan(plan);
    return listPlanHookRequests(plan, phase);
  }

  static async applyAgentConfigAtOpenShell(
    plan: SandboxMessagingPlan,
    options: {
      readonly runOpenshell: MessagingOpenShellRunner;
      readonly runHook?: MessagingHookApplyRunner;
    },
  ): Promise<{
    readonly appliedTargets: readonly string[];
    readonly appliedHooks: readonly string[];
    readonly unresolvedTemplateRefs: readonly string[];
  }> {
    assertSandboxMessagingPlan(plan);
    return applyAgentConfigPlanAtOpenShell(plan, options);
  }

  static applyCredentialsAtOpenShell(
    plan: SandboxMessagingPlan,
    options: MessagingCredentialApplyOptions,
  ): MessagingCredentialApplyResult {
    assertSandboxMessagingPlan(plan);
    return applyCredentialsPlanAtOpenShell(plan, options);
  }

  static applyPolicyAtOpenShell(
    plan: SandboxMessagingPlan,
    options: MessagingPolicyApplyOptions,
  ): MessagingPolicyApplyResult {
    assertSandboxMessagingPlan(plan);
    return applyPolicyPlanAtOpenShell(plan, options);
  }
}

function assertSandboxMessagingPlan(value: unknown): asserts value is SandboxMessagingPlan {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sandboxName !== "string" ||
    typeof value.agent !== "string" ||
    typeof value.workflow !== "string" ||
    !Array.isArray(value.channels) ||
    !Array.isArray(value.disabledChannels) ||
    !Array.isArray(value.credentialBindings) ||
    !isObject(value.networkPolicy) ||
    !Array.isArray(value.agentRender) ||
    !Array.isArray(value.buildSteps) ||
    !Array.isArray(value.stateUpdates) ||
    !Array.isArray(value.healthChecks)
  ) {
    throw new Error("Expected a serializable SandboxMessagingPlan.");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonSerializable(
  value: unknown,
  path = "$",
  visiting: Set<object> = new Set(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    assertAcyclicObject(value, path, visiting, () => {
      value.forEach((entry, index) =>
        assertJsonSerializable(entry, `${path}[${index}]`, visiting),
      );
    });
    return;
  }
  if (typeof value === "object") {
    assertAcyclicObject(value, path, visiting, () => {
      for (const [key, entry] of Object.entries(value)) {
        assertJsonSerializable(entry, `${path}.${key}`, visiting);
      }
    });
    return;
  }
  throw new Error(`Messaging setup plan is not JSON-serializable at ${path}.`);
}

function assertAcyclicObject(
  value: object,
  path: string,
  visiting: Set<object>,
  visit: () => void,
): void {
  if (visiting.has(value)) {
    throw new Error(`Messaging setup plan contains a cycle at ${path}.`);
  }
  visiting.add(value);
  try {
    visit();
  } finally {
    visiting.delete(value);
  }
}
