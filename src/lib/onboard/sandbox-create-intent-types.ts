// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BaselineExclusionEntry } from "../state/registry";
import type { DockerGpuRoutePlan } from "./docker-gpu-route";
import type { InitialSandboxPolicy } from "./initial-policy";
import type { MessagingTokenDef } from "./messaging-prep";
import type { MessagingChannel } from "./messaging-state";
import type { SandboxGpuCreateConfig } from "./sandbox-gpu-create";

type PrepareInitialSandboxCreatePolicy =
  typeof import("./initial-policy").prepareInitialSandboxCreatePolicy;

export type SandboxCreateMessagingProviderRequest = {
  readonly name: string;
  readonly envKey: string;
  readonly providerType?: string;
  readonly credentialConfigured: boolean;
  readonly channel: string | null;
};

export type SandboxCreatePolicyRequest = {
  readonly basePolicyPath: string;
  readonly activeMessagingChannels: readonly string[];
  readonly options: {
    readonly directGpu: boolean;
    readonly additionalPresets: readonly string[];
    readonly agentName?: string | null;
    readonly policyTier: string | null;
    readonly baselineExclusions: readonly BaselineExclusionEntry[];
  };
};

/**
 * Serializable intent for the create-time sandbox contributions. When built
 * through `prepareSandboxCreatePlan`, messaging credential values are
 * represented only by their logical environment-key bindings and presence.
 *
 * This is deliberately separate from the execution plan, which contains
 * temporary paths and cleanup callbacks. Its serializable shape is for
 * internal inspection and testing only; it is not a persistence,
 * machine-event, or public API contract.
 */
export type SandboxCreateIntent = {
  readonly sandboxName: string;
  readonly inferenceProvider: string | null;
  readonly activeMessagingChannels: readonly string[];
  readonly messagingProviderRequests: readonly SandboxCreateMessagingProviderRequest[];
  readonly reusableMessagingProviders: readonly string[];
  readonly extraProviders: readonly string[];
  readonly staleExtraProviders: readonly string[];
  readonly hermesToolGateways: readonly string[];
  readonly policy: SandboxCreatePolicyRequest;
  readonly gpuCreateArgs: readonly string[];
  readonly resourceCreateArgs: readonly string[];
  readonly gpuRoutePlan: DockerGpuRoutePlan;
  readonly sandboxGpuLogMessage: string | null;
  readonly disabledChannelNames: readonly string[];
  readonly extraPlaceholderKeys: readonly string[];
};

export type ResolveSandboxCreateIntentInput = {
  basePolicyPath: string;
  sandboxName: string;
  inferenceProvider?: string | null;
  channels: readonly MessagingChannel[];
  enabledChannels: string[] | null;
  disabledChannelNames: ReadonlySet<string>;
  messagingProviderRequests: readonly SandboxCreateMessagingProviderRequest[];
  primaryMessagingCredentialEnvKeys: readonly string[];
  reusableMessagingChannels: readonly string[];
  reusableMessagingProviders: readonly string[];
  extraProviders?: readonly string[];
  staleExtraProviders?: readonly string[];
  hermesToolGateways: readonly string[];
  sandboxGpuConfig: SandboxGpuCreateConfig;
  gpuCreateArgs: readonly string[];
  resourceCreateArgs?: readonly string[];
  gpuRoutePlan: DockerGpuRoutePlan;
  sandboxGpuLogMessage: string | null;
  extraPlaceholderKeys?: readonly string[];
  agentName?: string | null;
  policyTier: string | null;
  baselineExclusions?: readonly BaselineExclusionEntry[];
};

export type MaterializeSandboxCreatePlanInput = {
  intent: SandboxCreateIntent;
  buildCtx: string;
  messagingTokenDefs: MessagingTokenDef[];
  runProviderPreDeleteCleanup(): void;
  upsertMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    options: { replaceExisting: true },
  ): string[];
  getHermesToolGatewayProviderName(sandboxName: string): string;
  discloseInitialSandboxPolicy?(policy: InitialSandboxPolicy): void;
  prepareInitialSandboxCreatePolicy?: PrepareInitialSandboxCreatePolicy;
};
