// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createBuiltInChannelManifestRegistry,
  listSupportedMessagingChannelIdsForAgent,
  tryGetMessagingAgentId,
} from "../../../messaging";
import type { MessagingAgentId, SandboxMessagingPlan } from "../../../messaging/manifest";
import { hashCredential } from "../../../security/credential-hash";
import type { Session } from "../../../state/onboard-session";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import { getActiveChannelsFromPlan, getChannelsFromPlan } from "../../messaging-plan-session";

type MessagingAgentLike = {
  readonly name?: string;
};

export interface SandboxMessagingDeps<Agent> {
  note(message: string): void;
  getRecordedMessagingChannelsForResume(
    resume: boolean,
    session: Session | null,
    sandboxName: string | null,
  ): string[] | null;
  setupMessagingChannels(
    agent: Agent,
    existingChannels: string[] | null,
    sandboxName: string,
  ): Promise<string[]>;
  readMessagingPlanFromEnv(): SandboxMessagingPlan | null;
  writePlanToEnv(plan: SandboxMessagingPlan): void;
  clearPlanEnv(): void;
  getRegistrySandboxMessagingPlan(sandboxName: string): SandboxMessagingPlan | null;
}

export interface SandboxMessagingSelection {
  readonly plan: SandboxMessagingPlan | null;
  readonly selectedChannels: string[];
}

export interface ReconcileSandboxMessagingOptions<Agent> {
  readonly resume: boolean;
  readonly session: Session | null;
  readonly sandboxName: string;
  readonly agent: Agent;
  readonly deps: SandboxMessagingDeps<Agent>;
}

const messagingManifestRegistry = createBuiltInChannelManifestRegistry();

function refreshCredentialHashesFromEnv(plan: SandboxMessagingPlan): {
  plan: SandboxMessagingPlan;
  changed: boolean;
} {
  let changed = false;
  const credentialBindings = plan.credentialBindings.map((binding) => {
    if (binding.credentialAvailable !== true) return binding;
    const credentialHash = hashCredential(process.env[binding.providerEnvKey]);
    if (!credentialHash || credentialHash === binding.credentialHash) return binding;
    changed = true;
    return { ...binding, credentialHash };
  });
  return changed ? { plan: { ...plan, credentialBindings }, changed } : { plan, changed };
}

function resolveCurrentMessagingAgent(agent: unknown): {
  readonly agentId: MessagingAgentId | null;
  readonly supportedChannelIds: readonly string[] | null;
} {
  const descriptor = (agent ?? {}) as MessagingAgentLike;
  const name = typeof descriptor.name === "string" ? descriptor.name.trim() : "";
  if (!name) return { agentId: null, supportedChannelIds: null };
  const manifests = messagingManifestRegistry.list();
  const agentId = tryGetMessagingAgentId(descriptor, manifests);
  if (agentId === null) return { agentId: null, supportedChannelIds: [] };
  return {
    agentId,
    supportedChannelIds: listSupportedMessagingChannelIdsForAgent(manifests, agentId),
  };
}

function filterChannelNamesForCurrentAgent(
  channelIds: readonly string[],
  agent: unknown,
): string[] {
  const availability = resolveCurrentMessagingAgent(agent);
  if (availability.supportedChannelIds === null) return [...channelIds];
  if (availability.agentId === null || availability.supportedChannelIds.length === 0) return [];
  const supported = new Set(availability.supportedChannelIds);
  return channelIds.filter((channelId) => supported.has(channelId));
}

export function filterMessagingPlanForCurrentAgent(
  plan: SandboxMessagingPlan,
  agent: unknown,
): SandboxMessagingPlan | null {
  const availability = resolveCurrentMessagingAgent(agent);
  if (availability.supportedChannelIds === null) return plan;
  if (availability.agentId === null || plan.agent !== availability.agentId) return null;
  const supported = new Set(availability.supportedChannelIds);
  const channels = plan.channels.filter((channel) => supported.has(channel.channelId));
  if (channels.length === 0) return null;
  if (channels.length === plan.channels.length) return plan;

  const remainingChannelIds = new Set(channels.map((channel) => channel.channelId));
  const keepEntry = <T extends { readonly channelId: string }>(entry: T): boolean =>
    remainingChannelIds.has(entry.channelId);
  const networkEntries = plan.networkPolicy.entries.filter(keepEntry);
  const filterRuntimeSetup = <T extends { readonly channelId: string }>(entries?: readonly T[]) =>
    (entries ?? []).filter(keepEntry);

  return {
    ...plan,
    channels,
    disabledChannels: plan.disabledChannels.filter((channelId) =>
      remainingChannelIds.has(channelId),
    ),
    credentialBindings: plan.credentialBindings.filter(keepEntry),
    networkPolicy: {
      presets: [...new Set(networkEntries.map((entry) => entry.presetName))].sort(),
      entries: networkEntries,
    },
    agentRender: plan.agentRender.filter(keepEntry),
    buildSteps: plan.buildSteps.filter(keepEntry),
    runtimeSetup: plan.runtimeSetup
      ? {
          nodePreloads: filterRuntimeSetup(plan.runtimeSetup.nodePreloads),
          secretScans: filterRuntimeSetup(plan.runtimeSetup.secretScans),
        }
      : undefined,
    stateUpdates: plan.stateUpdates.filter(keepEntry),
    healthChecks: plan.healthChecks.filter(keepEntry),
  };
}

function selectionFromReusablePlan<Agent>(
  plan: SandboxMessagingPlan,
  agent: Agent,
  writeToEnv: boolean,
  deps: SandboxMessagingDeps<Agent>,
): SandboxMessagingSelection {
  const refreshed = refreshCredentialHashesFromEnv(plan);
  const filtered = filterMessagingPlanForCurrentAgent(refreshed.plan, agent);
  if (!filtered) {
    deps.clearPlanEnv();
    return { plan: null, selectedChannels: [] };
  }
  if (writeToEnv || refreshed.changed || filtered !== refreshed.plan) deps.writePlanToEnv(filtered);
  return {
    plan: filtered,
    selectedChannels: getActiveChannelsFromPlan(filtered),
  };
}

async function selectionFromMessagingSetup<Agent>(
  existingChannels: string[] | null,
  options: ReconcileSandboxMessagingOptions<Agent>,
): Promise<SandboxMessagingSelection> {
  const existing = existingChannels
    ? filterChannelNamesForCurrentAgent(existingChannels, options.agent)
    : existingChannels;
  const selected = filterChannelNamesForCurrentAgent(
    await options.deps.setupMessagingChannels(options.agent, existing, options.sandboxName),
    options.agent,
  );
  const plan = options.deps.readMessagingPlanFromEnv();
  if (!plan) return { plan: null, selectedChannels: selected };
  const filtered = filterMessagingPlanForCurrentAgent(plan, options.agent);
  if (!filtered) {
    options.deps.clearPlanEnv();
    return { plan: null, selectedChannels: [] };
  }
  if (filtered === plan) return { plan, selectedChannels: selected };
  options.deps.writePlanToEnv(filtered);
  return {
    plan: filtered,
    selectedChannels: getActiveChannelsFromPlan(filtered),
  };
}

function selectionFromRecordedChannels<Agent>(
  recordedChannels: string[],
  envPlan: SandboxMessagingPlan | null,
  registryPlan: SandboxMessagingPlan | null,
  options: ReconcileSandboxMessagingOptions<Agent>,
): SandboxMessagingSelection {
  let selection: SandboxMessagingSelection = {
    plan: null,
    selectedChannels: filterChannelNamesForCurrentAgent(recordedChannels, options.agent),
  };
  if (envPlan) selection = selectionFromReusablePlan(envPlan, options.agent, false, options.deps);
  else if (registryPlan)
    selection = selectionFromReusablePlan(registryPlan, options.agent, true, options.deps);
  if (selection.selectedChannels.length > 0) {
    options.deps.note(
      `  [non-interactive] Reusing messaging channel configuration: ${selection.selectedChannels.join(", ")}`,
    );
  }
  return selection;
}

function channelsForRegistryPlanRefresh(
  registryPlan: SandboxMessagingPlan,
  agent: unknown,
): string[] | null {
  const activeChannels = filterChannelNamesForCurrentAgent(
    getActiveChannelsFromPlan(registryPlan),
    agent,
  );
  if (activeChannels.length > 0) return null;
  const detectedChannels = filterChannelNamesForCurrentAgent(
    detectMessagingChannelsFromEnv(agent as Parameters<typeof detectMessagingChannelsFromEnv>[0]),
    agent,
  );
  return detectedChannels.length > 0 ? detectedChannels : null;
}

async function selectionFromRegistryPlan<Agent>(
  registryPlan: SandboxMessagingPlan,
  options: ReconcileSandboxMessagingOptions<Agent>,
): Promise<SandboxMessagingSelection> {
  const detectedChannels = channelsForRegistryPlanRefresh(registryPlan, options.agent);
  if (!detectedChannels) {
    return selectionFromReusablePlan(registryPlan, options.agent, true, options.deps);
  }
  options.deps.note(
    `  [non-interactive] Detected messaging channel inputs for ${detectedChannels.join(", ")}; refreshing reused sandbox messaging plan.`,
  );
  // The registry is authoritative for channels that cannot be rediscovered
  // from host env (for example, an in-sandbox QR-authenticated channel).
  return selectionFromMessagingSetup(
    getChannelsFromPlan(registryPlan) ?? getChannelsFromPlan(options.session?.messagingPlan),
    options,
  );
}

export function reconcileReusedSandboxMessaging<Agent>(
  plan: SandboxMessagingPlan | null,
  agent: Agent,
  deps: Pick<SandboxMessagingDeps<Agent>, "clearPlanEnv">,
): SandboxMessagingSelection & { readonly changed: boolean } {
  const filtered = plan ? filterMessagingPlanForCurrentAgent(plan, agent) : null;
  if (filtered !== plan) deps.clearPlanEnv();
  return {
    plan: filtered,
    selectedChannels: getActiveChannelsFromPlan(filtered),
    changed: filtered !== plan,
  };
}

export async function reconcileSandboxMessaging<Agent>(
  options: ReconcileSandboxMessagingOptions<Agent>,
): Promise<SandboxMessagingSelection> {
  const recordedChannels = options.deps.getRecordedMessagingChannelsForResume(
    options.resume,
    options.session,
    options.sandboxName,
  );
  const envPlan = options.deps.readMessagingPlanFromEnv();
  const registryPlan = options.deps.getRegistrySandboxMessagingPlan(options.sandboxName);
  if (recordedChannels) {
    return selectionFromRecordedChannels(recordedChannels, envPlan, registryPlan, options);
  }
  if (envPlan) return selectionFromReusablePlan(envPlan, options.agent, false, options.deps);
  if (registryPlan) return selectionFromRegistryPlan(registryPlan, options);
  return selectionFromMessagingSetup(getChannelsFromPlan(options.session?.messagingPlan), options);
}
