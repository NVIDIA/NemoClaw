// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type DockerGpuRoutePlan } from "./docker-gpu-route";
import type { MessagingTokenDef } from "./messaging-prep";
import type { MessagingChannel } from "./messaging-state";
import {
  resolvePrimaryMessagingCredentialEnvKeys,
  resolveSandboxCreateIntent,
  resolveSandboxCreateMessagingProviderRequests,
} from "./sandbox-create-intent";
import {
  materializeSandboxCreatePlan,
  type SandboxCreatePlan,
} from "./sandbox-create-plan-materialization";
import { buildSandboxGpuCreateArgs, type SandboxGpuCreateConfig } from "./sandbox-gpu-create";

export {
  resolvePrimaryMessagingCredentialEnvKeys,
  resolveSandboxCreateIntent,
  resolveSandboxCreateMessagingProviderRequests,
} from "./sandbox-create-intent";
export type {
  MaterializeSandboxCreatePlanInput,
  ResolveSandboxCreateIntentInput,
  SandboxCreateIntent,
  SandboxCreateMessagingProviderRequest,
  SandboxCreatePolicyRequest,
} from "./sandbox-create-intent-types";
export type { SandboxCreatePlan } from "./sandbox-create-plan-materialization";
export {
  materializeSandboxCreatePlan,
  validateSandboxCreateIntentBindings,
} from "./sandbox-create-plan-materialization";

// Known canonical policy tier names. Kept inline so the create-time path
// validates the env value without pulling `../policy/tiers` (which transitively
// requires `runner.ts` and breaks vitest source resolution for this module's
// tests). The list mirrors `nemoclaw-blueprint/policies/tiers.yaml`; adding a
// tier there requires updating this set so an explicit tier env value reaches
// the create-time policy decision.
const KNOWN_POLICY_TIER_NAMES = new Set(["restricted", "balanced", "open"]);

export function resolveSandboxCreatePolicyTier(
  authoritativePolicyTier?: string | null,
): string | null {
  if (authoritativePolicyTier !== undefined) return authoritativePolicyTier;
  // Only trust the env value in non-interactive mode. Interactive flows let the
  // operator override the tier via the selector after sandbox creation; if the
  // env said balanced but the operator picks restricted, an interactive trust
  // of the env would have already let create-time OTEL through. Fail closed:
  // interactive mode returns null so the OTEL preset is deferred to the
  // post-boot policy step.
  const isNonInteractive = process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  if (!isNonInteractive) return null;
  const raw = process.env.NEMOCLAW_POLICY_TIER;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return KNOWN_POLICY_TIER_NAMES.has(trimmed) ? trimmed : null;
}

type PrepareInitialSandboxCreatePolicy =
  typeof import("./initial-policy").prepareInitialSandboxCreatePolicy;

export type SandboxCreatePlanDeps = {
  prepareInitialSandboxCreatePolicy?: PrepareInitialSandboxCreatePolicy;
  buildSandboxGpuCreateArgs?: typeof buildSandboxGpuCreateArgs;
};

export type PrepareSandboxCreatePlanInput = {
  basePolicyPath: string;
  buildCtx: string;
  sandboxName: string;
  channels: MessagingChannel[];
  enabledChannels: string[] | null;
  disabledChannelNames: ReadonlySet<string>;
  messagingTokenDefs: MessagingTokenDef[];
  reusableMessagingChannels: string[];
  reusableMessagingProviders: string[];
  extraProviders?: readonly string[];
  hermesToolGateways: string[];
  sandboxGpuConfig: SandboxGpuCreateConfig;
  gpuRoutePlan: DockerGpuRoutePlan;
  sandboxGpuLogMessage: string | null;
  appendResourceFlags(createArgs: string[]): void;
  runProviderPreDeleteCleanup(): void;
  upsertMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    options: { replaceExisting: true },
  ): string[];
  getMessagingChannelForEnvKey(envKey: string): string | null;
  getHermesToolGatewayProviderName(sandboxName: string): string;
  agentName?: string | null;
  policyTier?: string | null;
  deps?: SandboxCreatePlanDeps;
};

export function prepareSandboxCreatePlan({
  basePolicyPath,
  buildCtx,
  sandboxName,
  channels,
  enabledChannels,
  disabledChannelNames,
  messagingTokenDefs,
  reusableMessagingChannels,
  reusableMessagingProviders,
  extraProviders,
  hermesToolGateways,
  sandboxGpuConfig,
  gpuRoutePlan,
  sandboxGpuLogMessage,
  appendResourceFlags,
  runProviderPreDeleteCleanup,
  upsertMessagingProviders,
  getMessagingChannelForEnvKey,
  getHermesToolGatewayProviderName,
  agentName,
  policyTier = resolveSandboxCreatePolicyTier(),
  deps = {},
}: PrepareSandboxCreatePlanInput): SandboxCreatePlan {
  const gpuCreateArgs = (deps.buildSandboxGpuCreateArgs ?? buildSandboxGpuCreateArgs)(
    sandboxGpuConfig,
  );
  const resourceCreateArgs: string[] = [];
  appendResourceFlags(resourceCreateArgs);
  const messagingProviderRequests = resolveSandboxCreateMessagingProviderRequests(
    messagingTokenDefs,
    getMessagingChannelForEnvKey,
  );
  const intent = resolveSandboxCreateIntent({
    basePolicyPath,
    sandboxName,
    channels,
    enabledChannels,
    disabledChannelNames,
    messagingProviderRequests,
    primaryMessagingCredentialEnvKeys: resolvePrimaryMessagingCredentialEnvKeys(),
    reusableMessagingChannels,
    reusableMessagingProviders,
    extraProviders,
    hermesToolGateways,
    sandboxGpuConfig,
    gpuCreateArgs,
    resourceCreateArgs,
    gpuRoutePlan,
    sandboxGpuLogMessage,
    agentName,
    policyTier,
  });

  return materializeSandboxCreatePlan({
    intent,
    buildCtx,
    messagingTokenDefs,
    runProviderPreDeleteCleanup,
    upsertMessagingProviders,
    getHermesToolGatewayProviderName,
    ...(deps.prepareInitialSandboxCreatePolicy
      ? { prepareInitialSandboxCreatePolicy: deps.prepareInitialSandboxCreatePolicy }
      : {}),
  });
}
