// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type MessagingCredentialMetadata,
  listMessagingCredentialMetadata,
} from "../messaging/channels";
import type { InitialSandboxPolicy } from "./initial-policy";
import type { MessagingChannel } from "./messaging-state";
import { resolveQrSelectedChannels } from "./messaging-state";
import { buildSandboxGpuCreateArgs, type SandboxGpuCreateConfig } from "./sandbox-gpu-create";

// Known canonical policy tier names. Kept inline so the create-time path
// validates the env value without pulling `../policy/tiers` (which transitively
// requires `runner.ts` and breaks vitest source resolution for this module's
// tests). The list mirrors `nemoclaw-blueprint/policies/tiers.yaml`; adding a
// tier there requires updating this set so an explicit tier env value reaches
// the create-time policy decision.
const KNOWN_POLICY_TIER_NAMES = new Set(["restricted", "balanced", "open"]);

function readPolicyTierEnv(): string | null {
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

type MessagingTokenDef = {
  name?: string;
  envKey: string;
  token: string | null;
};

type ResolveDockerGpuSandboxCreatePlan =
  typeof import("./docker-gpu-sandbox-create").resolveDockerGpuSandboxCreatePlan;
type PrepareInitialSandboxCreatePolicy =
  typeof import("./initial-policy").prepareInitialSandboxCreatePolicy;

export type SandboxCreatePlanDeps = {
  resolveDockerGpuSandboxCreatePlan?: ResolveDockerGpuSandboxCreatePlan;
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
  hermesToolGateways: string[];
  sandboxGpuConfig: SandboxGpuCreateConfig;
  dockerDriverGateway: boolean;
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

export type SandboxCreatePlan = {
  activeMessagingChannels: string[];
  initialSandboxPolicy: InitialSandboxPolicy;
  createArgs: string[];
  messagingProviders: string[];
  useDockerGpuPatch: boolean;
  sandboxGpuLogMessage: string | null;
};

function getDockerGpuSandboxCreatePlan(
  ...args: Parameters<ResolveDockerGpuSandboxCreatePlan>
): ReturnType<ResolveDockerGpuSandboxCreatePlan> {
  const { resolveDockerGpuSandboxCreatePlan } =
    require("./docker-gpu-sandbox-create") as typeof import("./docker-gpu-sandbox-create");
  return resolveDockerGpuSandboxCreatePlan(...args);
}

function getInitialSandboxCreatePolicy(
  ...args: Parameters<PrepareInitialSandboxCreatePolicy>
): ReturnType<PrepareInitialSandboxCreatePolicy> {
  const { prepareInitialSandboxCreatePolicy } =
    require("./initial-policy") as typeof import("./initial-policy");
  return prepareInitialSandboxCreatePolicy(...args);
}

function filterEnabledChannelNames(
  channelNames: readonly string[],
  disabledChannelNames: ReadonlySet<string>,
): string[] {
  return channelNames.filter((channelName) => !disabledChannelNames.has(channelName));
}

function filterMessagingTokenDefsByEnabledChannel(
  messagingTokenDefs: MessagingTokenDef[],
  disabledChannelNames: ReadonlySet<string>,
  getMessagingChannelForEnvKey: (envKey: string) => string | null,
): MessagingTokenDef[] {
  return messagingTokenDefs.filter(({ envKey }) => {
    const channel = getMessagingChannelForEnvKey(envKey);
    return !channel || !disabledChannelNames.has(channel);
  });
}

function resolveTokenProviderChannelMap(
  messagingTokenDefs: MessagingTokenDef[],
  getMessagingChannelForEnvKey: (envKey: string) => string | null,
): Map<string, string> {
  const providerChannels = new Map<string, string>();
  for (const { envKey, name } of messagingTokenDefs) {
    if (!name) continue;
    const channel = getMessagingChannelForEnvKey(envKey);
    if (channel) providerChannels.set(name, channel);
  }
  return providerChannels;
}

function filterMessagingProvidersByEnabledChannel(
  providerNames: string[],
  providerChannels: ReadonlyMap<string, string>,
  disabledChannelNames: ReadonlySet<string>,
): string[] {
  return providerNames.filter((providerName) => {
    const channel = providerChannels.get(providerName);
    return !channel || !disabledChannelNames.has(channel);
  });
}

function resolveActiveMessagingChannels({
  channels,
  disabledChannelNames,
  enabledChannels,
  getMessagingChannelForEnvKey,
  messagingTokenDefs,
  reusableMessagingChannels,
}: Pick<
  PrepareSandboxCreatePlanInput,
  | "channels"
  | "disabledChannelNames"
  | "enabledChannels"
  | "getMessagingChannelForEnvKey"
  | "messagingTokenDefs"
  | "reusableMessagingChannels"
>): string[] {
  const primaryCredentialEnvKeys = getPrimaryCredentialEnvKeys();
  const qrSelectedChannels = resolveQrSelectedChannels(
    channels,
    enabledChannels,
    disabledChannelNames,
  );
  return filterEnabledChannelNames(
    [
      ...new Set([
        ...messagingTokenDefs
          .filter(({ token }) => !!token)
          .flatMap(({ envKey }) => {
            const channel = getMessagingChannelForEnvKey(envKey);
            return channel && primaryCredentialEnvKeys.has(envKey) ? [channel] : [];
          }),
        ...reusableMessagingChannels,
        ...qrSelectedChannels,
      ]),
    ],
    disabledChannelNames,
  );
}

function getPrimaryCredentialEnvKeys(): Set<string> {
  const credentialsByChannel = new Map<string, MessagingCredentialMetadata[]>();
  for (const credential of listMessagingCredentialMetadata()) {
    const credentials = credentialsByChannel.get(credential.channelId) ?? [];
    credentials.push(credential);
    credentialsByChannel.set(credential.channelId, credentials);
  }

  const envKeys = new Set<string>();
  for (const credentials of credentialsByChannel.values()) {
    const primary =
      credentials.find((credential) => credential.primary) ??
      [...credentials].sort(compareCredentialsForPrimarySelection)[0];
    if (primary) envKeys.add(primary.providerEnvKey);
  }
  return envKeys;
}

function compareCredentialsForPrimarySelection(
  left: MessagingCredentialMetadata,
  right: MessagingCredentialMetadata,
): number {
  return (
    left.credentialId.localeCompare(right.credentialId) ||
    left.providerEnvKey.localeCompare(right.providerEnvKey)
  );
}

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
  hermesToolGateways,
  sandboxGpuConfig,
  dockerDriverGateway,
  appendResourceFlags,
  runProviderPreDeleteCleanup,
  upsertMessagingProviders,
  getMessagingChannelForEnvKey,
  getHermesToolGatewayProviderName,
  agentName,
  policyTier = readPolicyTierEnv(),
  deps = {},
}: PrepareSandboxCreatePlanInput): SandboxCreatePlan {
  const enabledMessagingTokenDefs = filterMessagingTokenDefsByEnabledChannel(
    messagingTokenDefs,
    disabledChannelNames,
    getMessagingChannelForEnvKey,
  );
  const providerChannels = resolveTokenProviderChannelMap(
    messagingTokenDefs,
    getMessagingChannelForEnvKey,
  );
  const activeMessagingChannels = resolveActiveMessagingChannels({
    channels,
    disabledChannelNames,
    enabledChannels,
    getMessagingChannelForEnvKey,
    messagingTokenDefs: enabledMessagingTokenDefs,
    reusableMessagingChannels,
  });
  const { useDockerGpuPatch, logMessage: sandboxGpuLogMessage } = (
    deps.resolveDockerGpuSandboxCreatePlan ?? getDockerGpuSandboxCreatePlan
  )(sandboxGpuConfig, { dockerDriverGateway });
  const initialSandboxPolicy = (
    deps.prepareInitialSandboxCreatePolicy ?? getInitialSandboxCreatePolicy
  )(basePolicyPath, activeMessagingChannels, {
    directGpu: sandboxGpuConfig.sandboxGpuEnabled,
    dockerGpuPatch: useDockerGpuPatch,
    additionalPresets: hermesToolGateways,
    agentName,
    policyTier,
  });
  const createArgs = [
    "--from",
    `${buildCtx}/Dockerfile`,
    "--name",
    sandboxName,
    "--policy",
    initialSandboxPolicy.policyPath,
    ...(deps.buildSandboxGpuCreateArgs ?? buildSandboxGpuCreateArgs)(sandboxGpuConfig, {
      suppressGpuFlag: useDockerGpuPatch,
    }),
  ];

  appendResourceFlags(createArgs);
  runProviderPreDeleteCleanup();
  const messagingProviders = filterMessagingProvidersByEnabledChannel(
    [
      ...new Set([
        ...upsertMessagingProviders(enabledMessagingTokenDefs, { replaceExisting: true }),
        ...reusableMessagingProviders,
      ]),
    ],
    providerChannels,
    disabledChannelNames,
  );
  for (const provider of messagingProviders) {
    createArgs.push("--provider", provider);
  }
  if (hermesToolGateways.length > 0) {
    createArgs.push("--provider", getHermesToolGatewayProviderName(sandboxName));
  }

  return {
    activeMessagingChannels,
    initialSandboxPolicy,
    createArgs,
    messagingProviders,
    useDockerGpuPatch,
    sandboxGpuLogMessage,
  };
}
