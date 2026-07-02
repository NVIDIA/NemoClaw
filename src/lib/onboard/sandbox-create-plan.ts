// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  listMessagingCredentialMetadata,
  type MessagingCredentialMetadata,
} from "../messaging/channels";
import type { InitialSandboxPolicy } from "./initial-policy";
import type { MessagingTokenDef } from "./messaging-prep";
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
  extraProviders?: readonly string[];
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
    readonly dockerGpuPatch: boolean;
    readonly additionalPresets: readonly string[];
    readonly agentName?: string | null;
    readonly policyTier: string | null;
  };
};

/**
 * Serializable intent for the create-time sandbox contributions. When built
 * through {@link prepareSandboxCreatePlan}, messaging credential values are
 * represented only by their logical environment-key bindings and presence.
 *
 * This is deliberately separate from {@link SandboxCreatePlan}, which is an
 * execution artifact containing temporary paths and cleanup callbacks. Its
 * serializable shape is for internal inspection and testing only; it is not a
 * persistence, machine-event, or public API contract.
 */
export type SandboxCreateIntent = {
  readonly sandboxName: string;
  readonly activeMessagingChannels: readonly string[];
  readonly messagingProviderRequests: readonly SandboxCreateMessagingProviderRequest[];
  readonly reusableMessagingProviders: readonly string[];
  readonly extraProviders: readonly string[];
  readonly hermesToolGateways: readonly string[];
  readonly policy: SandboxCreatePolicyRequest;
  readonly gpuCreateArgs: readonly string[];
  readonly useDockerGpuPatch: boolean;
  readonly sandboxGpuLogMessage: string | null;
  readonly disabledChannelNames: readonly string[];
};

export type ResolveSandboxCreateIntentInput = {
  basePolicyPath: string;
  sandboxName: string;
  channels: MessagingChannel[];
  enabledChannels: string[] | null;
  disabledChannelNames: ReadonlySet<string>;
  messagingProviderRequests: readonly SandboxCreateMessagingProviderRequest[];
  primaryMessagingCredentialEnvKeys: readonly string[];
  reusableMessagingChannels: readonly string[];
  reusableMessagingProviders: readonly string[];
  extraProviders?: readonly string[];
  hermesToolGateways: readonly string[];
  sandboxGpuConfig: SandboxGpuCreateConfig;
  gpuCreateArgs: readonly string[];
  useDockerGpuPatch: boolean;
  sandboxGpuLogMessage: string | null;
  agentName?: string | null;
  policyTier: string | null;
};

export type MaterializeSandboxCreatePlanInput = {
  intent: SandboxCreateIntent;
  buildCtx: string;
  messagingTokenDefs: MessagingTokenDef[];
  appendResourceFlags(createArgs: string[]): void;
  runProviderPreDeleteCleanup(): void;
  upsertMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    options: { replaceExisting: true },
  ): string[];
  getHermesToolGatewayProviderName(sandboxName: string): string;
  prepareInitialSandboxCreatePolicy?: PrepareInitialSandboxCreatePolicy;
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

function filterMessagingProviderRequestsByEnabledChannel(
  requests: readonly SandboxCreateMessagingProviderRequest[],
  disabledChannelNames: ReadonlySet<string>,
): SandboxCreateMessagingProviderRequest[] {
  return requests.filter(({ channel }) => !channel || !disabledChannelNames.has(channel));
}

function resolveTokenProviderChannelMap(
  requests: readonly SandboxCreateMessagingProviderRequest[],
): Map<string, string> {
  const providerChannels = new Map<string, string>();
  for (const { channel, name } of requests) {
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
  messagingProviderRequests,
  primaryMessagingCredentialEnvKeys,
  reusableMessagingChannels,
}: Pick<
  ResolveSandboxCreateIntentInput,
  | "channels"
  | "disabledChannelNames"
  | "enabledChannels"
  | "messagingProviderRequests"
  | "primaryMessagingCredentialEnvKeys"
  | "reusableMessagingChannels"
>): string[] {
  const primaryCredentialEnvKeys = new Set(primaryMessagingCredentialEnvKeys);
  const qrSelectedChannels = resolveQrSelectedChannels(
    channels,
    enabledChannels,
    disabledChannelNames,
  );
  return filterEnabledChannelNames(
    [
      ...new Set([
        ...messagingProviderRequests
          .filter(({ credentialConfigured }) => credentialConfigured)
          .flatMap(({ channel, envKey }) => {
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

export function resolveSandboxCreateMessagingProviderRequests(
  messagingTokenDefs: readonly MessagingTokenDef[],
  getMessagingChannelForEnvKey: (envKey: string) => string | null,
): SandboxCreateMessagingProviderRequest[] {
  return messagingTokenDefs.map(({ name, envKey, providerType, token }) => ({
    name,
    envKey,
    ...(providerType ? { providerType } : {}),
    credentialConfigured: Boolean(token),
    channel: getMessagingChannelForEnvKey(envKey),
  }));
}

export function resolveSandboxCreateIntent({
  basePolicyPath,
  sandboxName,
  channels,
  enabledChannels,
  disabledChannelNames,
  messagingProviderRequests,
  primaryMessagingCredentialEnvKeys,
  reusableMessagingChannels,
  reusableMessagingProviders,
  extraProviders,
  hermesToolGateways,
  sandboxGpuConfig,
  gpuCreateArgs,
  useDockerGpuPatch,
  sandboxGpuLogMessage,
  agentName,
  policyTier,
}: ResolveSandboxCreateIntentInput): SandboxCreateIntent {
  const enabledMessagingProviderRequests = filterMessagingProviderRequestsByEnabledChannel(
    messagingProviderRequests,
    disabledChannelNames,
  );
  const providerChannels = resolveTokenProviderChannelMap(messagingProviderRequests);
  const activeMessagingChannels = resolveActiveMessagingChannels({
    channels,
    disabledChannelNames,
    enabledChannels,
    messagingProviderRequests: enabledMessagingProviderRequests,
    primaryMessagingCredentialEnvKeys,
    reusableMessagingChannels,
  });
  const enabledReusableMessagingProviders = filterMessagingProvidersByEnabledChannel(
    [...new Set(reusableMessagingProviders)],
    providerChannels,
    disabledChannelNames,
  );

  return {
    sandboxName,
    activeMessagingChannels,
    messagingProviderRequests: messagingProviderRequests.map((request) => ({ ...request })),
    reusableMessagingProviders: enabledReusableMessagingProviders,
    extraProviders: [...new Set(extraProviders ?? [])].filter(Boolean),
    hermesToolGateways: [...hermesToolGateways],
    policy: {
      basePolicyPath,
      activeMessagingChannels: [...activeMessagingChannels],
      options: {
        directGpu: sandboxGpuConfig.sandboxGpuEnabled,
        dockerGpuPatch: useDockerGpuPatch,
        additionalPresets: [...hermesToolGateways],
        ...(agentName !== undefined ? { agentName } : {}),
        policyTier,
      },
    },
    gpuCreateArgs: [...gpuCreateArgs],
    useDockerGpuPatch,
    sandboxGpuLogMessage,
    disabledChannelNames: [...disabledChannelNames],
  };
}

function messagingProviderRequestKey(
  request: Pick<SandboxCreateMessagingProviderRequest, "name" | "envKey">,
): string {
  return `${request.name}\u0000${request.envKey}`;
}

function bindMessagingTokenDefs(
  intent: SandboxCreateIntent,
  messagingTokenDefs: readonly MessagingTokenDef[],
): MessagingTokenDef[] {
  const enabledRequests = filterMessagingProviderRequestsByEnabledChannel(
    intent.messagingProviderRequests,
    new Set(intent.disabledChannelNames),
  );
  const tokenDefsByRequest = new Map(
    messagingTokenDefs.map((tokenDef) => [messagingProviderRequestKey(tokenDef), tokenDef]),
  );

  return enabledRequests.map((request) => {
    const tokenDef = tokenDefsByRequest.get(messagingProviderRequestKey(request));
    if (!tokenDef) {
      throw new Error(
        `Cannot materialize sandbox create intent; missing credential binding '${request.envKey}' for provider '${request.name}'.`,
      );
    }
    if (Boolean(tokenDef.token) !== request.credentialConfigured) {
      throw new Error(
        `Cannot materialize sandbox create intent; credential availability changed for provider '${request.name}'.`,
      );
    }
    if ((tokenDef.providerType || undefined) !== request.providerType) {
      throw new Error(
        `Cannot materialize sandbox create intent; provider type changed for '${request.name}'.`,
      );
    }
    return tokenDef;
  });
}

export function materializeSandboxCreatePlan({
  intent,
  buildCtx,
  messagingTokenDefs,
  appendResourceFlags,
  runProviderPreDeleteCleanup,
  upsertMessagingProviders,
  getHermesToolGatewayProviderName,
  prepareInitialSandboxCreatePolicy = getInitialSandboxCreatePolicy,
}: MaterializeSandboxCreatePlanInput): SandboxCreatePlan {
  const enabledMessagingTokenDefs = bindMessagingTokenDefs(intent, messagingTokenDefs);
  const initialSandboxPolicy = prepareInitialSandboxCreatePolicy(
    intent.policy.basePolicyPath,
    [...intent.policy.activeMessagingChannels],
    {
      directGpu: intent.policy.options.directGpu,
      dockerGpuPatch: intent.policy.options.dockerGpuPatch,
      additionalPresets: [...intent.policy.options.additionalPresets],
      agentName: intent.policy.options.agentName,
      policyTier: intent.policy.options.policyTier,
    },
  );
  const createArgs = [
    "--from",
    `${buildCtx}/Dockerfile`,
    "--name",
    intent.sandboxName,
    "--policy",
    initialSandboxPolicy.policyPath,
    ...intent.gpuCreateArgs,
  ];

  appendResourceFlags(createArgs);
  runProviderPreDeleteCleanup();
  const providerChannels = resolveTokenProviderChannelMap(intent.messagingProviderRequests);
  const messagingProviders = filterMessagingProvidersByEnabledChannel(
    [
      ...new Set([
        ...upsertMessagingProviders(enabledMessagingTokenDefs, { replaceExisting: true }),
        ...intent.reusableMessagingProviders,
      ]),
    ],
    providerChannels,
    new Set(intent.disabledChannelNames),
  );
  for (const provider of messagingProviders) {
    createArgs.push("--provider", provider);
  }
  if (intent.hermesToolGateways.length > 0) {
    createArgs.push("--provider", getHermesToolGatewayProviderName(intent.sandboxName));
  }
  for (const provider of intent.extraProviders) {
    if (messagingProviders.includes(provider)) continue;
    createArgs.push("--provider", provider);
  }

  return {
    activeMessagingChannels: [...intent.activeMessagingChannels],
    initialSandboxPolicy,
    createArgs,
    messagingProviders,
    useDockerGpuPatch: intent.useDockerGpuPatch,
    sandboxGpuLogMessage: intent.sandboxGpuLogMessage,
  };
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
  extraProviders,
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
  const { useDockerGpuPatch, logMessage: sandboxGpuLogMessage } = (
    deps.resolveDockerGpuSandboxCreatePlan ?? getDockerGpuSandboxCreatePlan
  )(sandboxGpuConfig, { dockerDriverGateway });
  const gpuCreateArgs = (deps.buildSandboxGpuCreateArgs ?? buildSandboxGpuCreateArgs)(
    sandboxGpuConfig,
    {
      suppressGpuFlag: useDockerGpuPatch,
    },
  );
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
    primaryMessagingCredentialEnvKeys: [...getPrimaryCredentialEnvKeys()],
    reusableMessagingChannels,
    reusableMessagingProviders,
    extraProviders,
    hermesToolGateways,
    sandboxGpuConfig,
    gpuCreateArgs,
    useDockerGpuPatch,
    sandboxGpuLogMessage,
    agentName,
    policyTier,
  });

  return materializeSandboxCreatePlan({
    intent,
    buildCtx,
    messagingTokenDefs,
    appendResourceFlags,
    runProviderPreDeleteCleanup,
    upsertMessagingProviders,
    getHermesToolGatewayProviderName,
    prepareInitialSandboxCreatePolicy:
      deps.prepareInitialSandboxCreatePolicy ?? getInitialSandboxCreatePolicy,
  });
}
