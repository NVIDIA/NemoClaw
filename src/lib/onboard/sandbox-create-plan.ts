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

type MessagingTokenDef = {
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
  return [
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
  ];
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
  deps = {},
}: PrepareSandboxCreatePlanInput): SandboxCreatePlan {
  const activeMessagingChannels = resolveActiveMessagingChannels({
    channels,
    disabledChannelNames,
    enabledChannels,
    getMessagingChannelForEnvKey,
    messagingTokenDefs,
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
  const messagingProviders = [
    ...new Set([
      ...upsertMessagingProviders(messagingTokenDefs, { replaceExisting: true }),
      ...reusableMessagingProviders,
    ]),
  ];
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
