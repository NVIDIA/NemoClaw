// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import type { ChannelHookPhase, SandboxMessagingPlan } from "../manifest";
import { parseSandboxMessagingPlan } from "../plan-validation";
import {
  applyAgentConfigAtOpenShell as applyAgentConfigPlanAtOpenShell,
  listHookRequests as listPlanHookRequests,
} from "./agent-config";
import {
  applyHealthChecks as applyPlanHealthChecks,
  applyMessagingHooksForPhase as applyPlanHooksForPhase,
  applyPreEnableChecks as applyPlanPreEnableChecks,
  type MessagingHookPhaseOptions,
} from "./hook-phases";
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
    return Buffer.from(JSON.stringify(plan), "utf8").toString("base64");
  }

  static decodePlan(encoded: string): SandboxMessagingPlan {
    const raw = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    const plan = parseSandboxMessagingPlan(parsed);
    if (!plan) {
      throw new Error("Expected a serializable SandboxMessagingPlan.");
    }
    return plan;
  }

  static writePlanToEnv(plan: SandboxMessagingPlan, options: MessagingSetupEnvOptions = {}): void {
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
    return listPlanHookRequests(plan, phase);
  }

  static listPreEnableChecks(plan: SandboxMessagingPlan): MessagingHookApplyRequest[] {
    return listPlanHookRequests(plan, "pre-enable");
  }

  static listHealthChecks(plan: SandboxMessagingPlan): MessagingHookApplyRequest[] {
    return listPlanHookRequests(plan, "health-check");
  }

  static applyHooksForPhase(
    plan: SandboxMessagingPlan,
    phase: ChannelHookPhase,
    options: MessagingHookPhaseOptions = {},
  ): ReturnType<typeof applyPlanHooksForPhase> {
    return applyPlanHooksForPhase(plan, phase, options);
  }

  static applyPreEnableChecks(
    plan: SandboxMessagingPlan,
    options: MessagingHookPhaseOptions = {},
  ): ReturnType<typeof applyPlanPreEnableChecks> {
    return applyPlanPreEnableChecks(plan, options);
  }

  static applyHealthChecks(
    plan: SandboxMessagingPlan,
    options: MessagingHookPhaseOptions = {},
  ): ReturnType<typeof applyPlanHealthChecks> {
    return applyPlanHealthChecks(plan, options);
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
    return applyAgentConfigPlanAtOpenShell(plan, options);
  }

  static applyCredentialsAtOpenShell(
    plan: SandboxMessagingPlan,
    options: MessagingCredentialApplyOptions,
  ): MessagingCredentialApplyResult {
    return applyCredentialsPlanAtOpenShell(plan, options);
  }

  static applyPolicyAtOpenShell(
    plan: SandboxMessagingPlan,
    options: MessagingPolicyApplyOptions,
  ): MessagingPolicyApplyResult {
    return applyPolicyPlanAtOpenShell(plan, options);
  }
}
