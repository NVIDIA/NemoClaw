// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InitialSandboxPolicy } from "./initial-policy";
import type { MessagingTokenDef } from "./messaging-prep";
import type {
  MaterializeSandboxCreatePlanInput,
  SandboxCreateIntent,
  SandboxCreateMessagingProviderRequest,
} from "./sandbox-create-intent-types";
import { prepareSandboxGpuRoutePolicies } from "./sandbox-gpu-route-policy";

type PrepareInitialSandboxCreatePolicy =
  typeof import("./initial-policy").prepareInitialSandboxCreatePolicy;

const DCODE_MCP_SNAPSHOT_TMPFS_MOUNT = {
  type: "tmpfs",
  target: "/run/nemoclaw-dcode-mcp",
  // Docker applies nosuid and nodev to tmpfs mounts by default and rejects
  // both when they are repeated in structured MountTmpfsOptions.
  options: ["noexec"],
  size_bytes: 1_048_576,
  mode: 0o1777,
} as const;
function buildSandboxDriverConfig(intent: SandboxCreateIntent): string | null {
  const dockerMounts: Array<Record<string, unknown>> = (intent.hostMounts ?? []).map(
    ({ source, target }) => ({ type: "bind", source, target, read_only: true }),
  );
  const podmanMounts: Array<Record<string, unknown>> = [];
  if (intent.policy.options.agentName === "langchain-deepagents-code") {
    dockerMounts.unshift(DCODE_MCP_SNAPSHOT_TMPFS_MOUNT);
    podmanMounts.push(DCODE_MCP_SNAPSHOT_TMPFS_MOUNT);
  }
  if (dockerMounts.length === 0) return null;
  return JSON.stringify({
    docker: { mounts: dockerMounts },
    ...(podmanMounts.length > 0 ? { podman: { mounts: podmanMounts } } : {}),
  });
}

export type SandboxCreatePlan = {
  activeMessagingChannels: string[];
  initialSandboxPolicy: InitialSandboxPolicy;
  /** Tier resolved before create, persisted with the registry entry for safe resume. */
  policyTier: string | null;
  createArgs: string[];
  messagingProviders: string[];
  gpuRoutePlan: SandboxCreateIntent["gpuRoutePlan"];
  compatibilityPolicyPath: string | null;
  sandboxGpuLogMessage: string | null;
};

function getInitialSandboxCreatePolicy(
  ...args: Parameters<PrepareInitialSandboxCreatePolicy>
): ReturnType<PrepareInitialSandboxCreatePolicy> {
  const { prepareInitialSandboxCreatePolicy } =
    require("./initial-policy") as typeof import("./initial-policy");
  return prepareInitialSandboxCreatePolicy(...args);
}

function messagingProviderRequestKey(
  request: Pick<SandboxCreateMessagingProviderRequest, "name" | "envKey">,
): string {
  // Tuple encoding stays collision-free even if either value contains a separator.
  return JSON.stringify([request.name, request.envKey]);
}

export function validateSandboxCreateIntentBindings(
  intent: SandboxCreateIntent,
  messagingTokenDefs: readonly MessagingTokenDef[],
): MessagingTokenDef[] {
  const disabledChannelNames = new Set(intent.disabledChannelNames);
  const enabledRequests = intent.messagingProviderRequests.filter(
    ({ channel }) => !channel || !disabledChannelNames.has(channel),
  );
  const intentRequestKeys = new Set(
    intent.messagingProviderRequests.map(messagingProviderRequestKey),
  );
  const tokenDefsByRequest = new Map(
    messagingTokenDefs.map((tokenDef) => [messagingProviderRequestKey(tokenDef), tokenDef]),
  );

  if (tokenDefsByRequest.size !== messagingTokenDefs.length) {
    throw new Error(
      "Cannot materialize sandbox create intent; duplicate credential bindings found.",
    );
  }
  if (
    messagingTokenDefs.some(
      (tokenDef) => !intentRequestKeys.has(messagingProviderRequestKey(tokenDef)),
    )
  ) {
    throw new Error("Cannot materialize sandbox create intent; credential binding set changed.");
  }

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
    // Default providers omit this field; normalize an empty or missing binding
    // to the intent's `undefined` representation before comparing.
    const boundProviderType = tokenDef.providerType || undefined;
    if (boundProviderType !== request.providerType) {
      throw new Error(
        `Cannot materialize sandbox create intent; provider type changed for '${request.name}'.`,
      );
    }
    return tokenDef;
  });
}

function resolveProviderChannelMap(
  requests: readonly SandboxCreateMessagingProviderRequest[],
): Map<string, string> {
  const providerChannels = new Map<string, string>();
  for (const { channel, name } of requests) {
    if (channel) providerChannels.set(name, channel);
  }
  return providerChannels;
}

function filterDisabledMessagingProviders(
  providerNames: string[],
  providerChannels: ReadonlyMap<string, string>,
  disabledChannelNames: ReadonlySet<string>,
): string[] {
  return providerNames.filter((providerName) => {
    const channel = providerChannels.get(providerName);
    return !channel || !disabledChannelNames.has(channel);
  });
}

/** Materialize policy, route metadata, resources, and providers from a secretless intent. */
export function materializeSandboxCreatePlan({
  intent,
  fromRef,
  messagingTokenDefs,
  runProviderPreDeleteCleanup,
  upsertMessagingProviders,
  getHermesToolGatewayProviderName,
  discloseInitialSandboxPolicy,
  prepareInitialSandboxCreatePolicy = getInitialSandboxCreatePolicy,
}: MaterializeSandboxCreatePlanInput): SandboxCreatePlan {
  const enabledMessagingTokenDefs = validateSandboxCreateIntentBindings(intent, messagingTokenDefs);
  const { initialSandboxPolicy, compatibilityPolicyPath } = prepareSandboxGpuRoutePolicies(
    intent.policy.basePolicyPath,
    [...intent.policy.activeMessagingChannels],
    {
      directGpu: intent.policy.options.directGpu,
      hostGpuAvailable: intent.policy.options.hostGpuAvailable,
      additionalPresets: [...intent.policy.options.additionalPresets],
      agentName: intent.policy.options.agentName,
      policyTier: intent.policy.options.policyTier,
      baselineExclusions: intent.policy.options.baselineExclusions.map((exclusion) => ({
        ...exclusion,
      })),
    },
    intent.gpuRoutePlan,
    prepareInitialSandboxCreatePolicy,
  );
  try {
    discloseInitialSandboxPolicy?.(initialSandboxPolicy);
  } catch (error) {
    initialSandboxPolicy.cleanup?.();
    throw error;
  }
  const driverConfig = buildSandboxDriverConfig(intent);
  const createArgs = [
    "--from",
    fromRef,
    "--name",
    intent.sandboxName,
    "--policy",
    initialSandboxPolicy.policyPath,
    ...(driverConfig ? ["--driver-config-json", driverConfig] : []),
    ...intent.gpuCreateArgs,
    ...intent.resourceCreateArgs,
  ];

  runProviderPreDeleteCleanup();
  const providerChannels = resolveProviderChannelMap(intent.messagingProviderRequests);
  const messagingProviders = filterDisabledMessagingProviders(
    [
      ...new Set([
        ...upsertMessagingProviders(enabledMessagingTokenDefs, { replaceExisting: true }),
        ...intent.reusableMessagingProviders,
      ]),
    ],
    providerChannels,
    new Set(intent.disabledChannelNames),
  );
  const createProviders = new Set<string>();
  if (intent.inferenceProvider) createProviders.add(intent.inferenceProvider);
  for (const provider of messagingProviders) createProviders.add(provider);
  if (intent.hermesToolGateways.length > 0) {
    createProviders.add(getHermesToolGatewayProviderName(intent.sandboxName));
  }
  for (const provider of intent.extraProviders) createProviders.add(provider);
  for (const provider of createProviders) {
    createArgs.push("--provider", provider);
  }

  return {
    activeMessagingChannels: [...intent.activeMessagingChannels],
    initialSandboxPolicy,
    policyTier: intent.policy.options.policyTier,
    createArgs,
    messagingProviders,
    gpuRoutePlan: intent.gpuRoutePlan,
    compatibilityPolicyPath,
    sandboxGpuLogMessage: intent.sandboxGpuLogMessage,
  };
}
