// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { getCredential } from "../../../credentials/store";
import {
  createBuiltInChannelManifestRegistry,
  listSupportedMessagingChannelIdsForAgent,
  tryGetMessagingAgentId,
} from "../../../messaging";
import { mergeSandboxMessagingPlans } from "../../../messaging/applier/host-state-applier";
import type { MessagingAgentId, SandboxMessagingPlan } from "../../../messaging/manifest";
import {
  type RegistryMessagingAuthority,
  resolveMessagingPlanAuthority,
  sameRegistryMessagingAuthority,
} from "../../../messaging/plan-authority";
import { hashCredential } from "../../../security/credential-hash";
import { isDecisionSelected, isDecisionUnset } from "../../../state/onboard-checkpoint-decision";
import type { Session } from "../../../state/onboard-session";
import {
  detectMessagingChannelsFromEnv,
  detectUnconfiguredMessagingChannels,
} from "../../messaging-channel-setup";
import { staticMessagingProviderTypeForChannel } from "../../messaging-bridge-provider";
import { getActiveChannelsFromPlan, getChannelsFromPlan } from "../../messaging-plan-session";

export {
  type RegistryMessagingAuthority,
  resolveMessagingPlanAuthority,
  sameRegistryMessagingAuthority,
};

function sameChannelSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((channel) => seen.has(channel));
}

type MessagingAgentLike = {
  readonly name?: string;
};

export interface SandboxMessagingDeps<Agent> {
  note(message: string): void;
  showMessagingStage?(): void;
  getRecordedMessagingChannelsForResume(
    resume: boolean,
    session: Session | null,
    sandboxName: string | null,
  ): string[] | null;
  setupMessagingChannels(
    agent: Agent,
    existingChannels: string[] | null,
    sandboxName: string,
    options?: { readonly selectionCompleted?: boolean },
  ): Promise<string[]>;
  readMessagingPlanFromEnv(): SandboxMessagingPlan | null;
  writePlanToEnv(plan: SandboxMessagingPlan): void;
  clearPlanEnv(): void;
  getRegistrySandboxMessagingAuthority(sandboxName: string): RegistryMessagingAuthority;
  providerMatchesGatewayCredential(name: string, type: string, credentialEnv: string): boolean;
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
  readonly env?: NodeJS.ProcessEnv;
  readonly registryAuthoritySnapshot?: RegistryMessagingAuthority;
  readonly credentialValidationPlan?: SandboxMessagingPlan | null;
  readonly forceCredentialValidation?: boolean;
  readonly deps: SandboxMessagingDeps<Agent>;
}

const messagingManifestRegistry = createBuiltInChannelManifestRegistry();
const registryLifecycleWorkflows = new Set<SandboxMessagingPlan["workflow"]>([
  "add-channel",
  "remove-channel",
  "start-channel",
  "stop-channel",
]);

function registryPlanRecordsLifecycleSelection(plan: SandboxMessagingPlan): boolean {
  return registryLifecycleWorkflows.has(plan.workflow);
}

export function hasMessagingCredentialDrift(
  plan: SandboxMessagingPlan | null,
  env: NodeJS.ProcessEnv,
  activeChannelIds: readonly string[] = getActiveChannelsFromPlan(plan),
): boolean {
  return messagingChannelsWithCredentialDrift(plan, env, activeChannelIds).length > 0;
}

function messagingChannelsWithCredentialDrift(
  plan: SandboxMessagingPlan | null,
  env: NodeJS.ProcessEnv,
  activeChannelIds: readonly string[] = getActiveChannelsFromPlan(plan),
): string[] {
  if (!plan) return [];
  const activeChannels = new Set(activeChannelIds);
  const driftedChannels = new Set<string>();
  for (const binding of plan.credentialBindings) {
    if (!activeChannels.has(binding.channelId)) continue;
    const credentialHash = hashCredential(env[binding.providerEnvKey]);
    if (credentialHash !== null && credentialHash !== binding.credentialHash) {
      driftedChannels.add(binding.channelId);
    }
  }
  return [...driftedChannels];
}

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
          envAliases: filterRuntimeSetup(plan.runtimeSetup.envAliases),
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

function filterUnconfiguredHostChannelsFromSelection<Agent>(
  selection: SandboxMessagingSelection,
  agent: Agent,
  deps: Pick<SandboxMessagingDeps<Agent>, "clearPlanEnv" | "note" | "writePlanToEnv">,
): SandboxMessagingSelection {
  // A registry plan records the previous selection, not the current host
  // input. Rebuild the host-backed selection so policy reconciliation can
  // disable a removed channel. The detector keeps in-sandbox QR-paired
  // channels.
  const unconfiguredChannels = new Set(
    detectUnconfiguredMessagingChannels(
      selection.selectedChannels,
      [],
      agent as Parameters<typeof detectUnconfiguredMessagingChannels>[2],
    ),
  );
  if (unconfiguredChannels.size === 0) return selection;
  deps.note(
    `  No host inputs configure ${[...unconfiguredChannels].join(", ")}; disabling the channel and its network egress.`,
  );
  const plan = disableChannelsInPlan(selection.plan, unconfiguredChannels);
  if (plan) deps.writePlanToEnv(plan);
  else deps.clearPlanEnv();
  return {
    plan,
    selectedChannels: selection.selectedChannels.filter(
      (channelId) => !unconfiguredChannels.has(channelId),
    ),
  };
}

/**
 * Record the removal in the plan itself, not only in the selection derived from
 * it. The plan is what reaches the registry and the next run, so a selection
 * that alone drops the channel leaves every later reader to rediscover the
 * removal from host inputs — and a reader that cannot, keeps the channel's
 * network egress applied.
 */
function disableChannelsInPlan(
  plan: SandboxMessagingPlan | null,
  channelIds: ReadonlySet<string>,
): SandboxMessagingPlan | null {
  if (!plan) return null;
  return {
    ...plan,
    channels: plan.channels.map((channel) =>
      channelIds.has(channel.channelId)
        ? { ...channel, active: false, selected: false, disabled: true }
        : channel,
    ),
    disabledChannels: [...new Set([...plan.disabledChannels, ...channelIds])],
  };
}

function requireValidatedActiveChannels<Agent>(
  selection: SandboxMessagingSelection,
  requiredChannels: readonly string[],
  validationBaseline: SandboxMessagingPlan | null,
  options: ReconcileSandboxMessagingOptions<Agent>,
): SandboxMessagingSelection {
  if (!options.forceCredentialValidation) return selection;
  const reportedChannels = new Set(selection.selectedChannels);
  const validatedChannels = new Set(
    getActiveChannelsFromPlan(selection.plan).filter((channelId) =>
      reportedChannels.has(channelId),
    ),
  );
  const missingChannels = requiredChannels.filter((channelId) => !validatedChannels.has(channelId));
  const recoveryPlan =
    validationBaseline ??
    (options.session?.messagingPlan
      ? filterMessagingPlanForCurrentAgent(options.session.messagingPlan, options.agent)
      : null);
  if (missingChannels.length > 0) {
    if (recoveryPlan) options.deps.writePlanToEnv(recoveryPlan);
    else options.deps.clearPlanEnv();
    throw new Error(
      `Credential validation did not complete for active messaging channels: ${missingChannels.join(", ")}. The existing sandbox was not changed.`,
    );
  }
  if (!validationBaseline || !selection.plan) return selection;

  const mergedPlan = mergeSandboxMessagingPlans(validationBaseline, selection.plan);
  options.deps.writePlanToEnv(mergedPlan);
  return {
    plan: mergedPlan,
    selectedChannels: getActiveChannelsFromPlan(mergedPlan),
  };
}

async function selectionFromMessagingSetup<Agent>(
  existingChannels: string[] | null,
  options: ReconcileSandboxMessagingOptions<Agent>,
  selectionCompleted = false,
  validationBaseline: SandboxMessagingPlan | null = null,
): Promise<SandboxMessagingSelection> {
  const existing = existingChannels
    ? filterChannelNamesForCurrentAgent(existingChannels, options.agent)
    : existingChannels;
  const requiredChannels = existing ?? [];
  const setupOptions = selectionCompleted ? { selectionCompleted: true } : undefined;
  const selected = filterChannelNamesForCurrentAgent(
    setupOptions
      ? await options.deps.setupMessagingChannels(
          options.agent,
          existing,
          options.sandboxName,
          setupOptions,
        )
      : await options.deps.setupMessagingChannels(options.agent, existing, options.sandboxName),
    options.agent,
  );
  const plan = options.deps.readMessagingPlanFromEnv();
  if (!plan) {
    return requireValidatedActiveChannels(
      { plan: null, selectedChannels: selected },
      requiredChannels,
      validationBaseline,
      options,
    );
  }
  const filtered = filterMessagingPlanForCurrentAgent(plan, options.agent);
  if (!filtered) {
    options.deps.clearPlanEnv();
    return requireValidatedActiveChannels(
      { plan: null, selectedChannels: [] },
      requiredChannels,
      validationBaseline,
      options,
    );
  }
  if (filtered === plan) {
    return requireValidatedActiveChannels(
      { plan, selectedChannels: selected },
      requiredChannels,
      validationBaseline,
      options,
    );
  }
  options.deps.writePlanToEnv(filtered);
  return requireValidatedActiveChannels(
    {
      plan: filtered,
      selectedChannels: selected,
    },
    requiredChannels,
    validationBaseline,
    options,
  );
}

/** Reconcile checkpoint channels against current host inputs before reuse. */
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
  selection = filterUnconfiguredHostChannelsFromSelection(selection, options.agent, options.deps);
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
  if (registryPlanRecordsLifecycleSelection(registryPlan)) {
    // A lifecycle command owns which channels the operator asked for, but not
    // whether the host still configures them. Onboarding re-reads the host
    // either way, so the same removal check applies here.
    return filterUnconfiguredHostChannelsFromSelection(
      selectionFromReusablePlan(registryPlan, options.agent, true, options.deps),
      options.agent,
      options.deps,
    );
  }
  const activeChannels = filterChannelNamesForCurrentAgent(
    getActiveChannelsFromPlan(registryPlan),
    options.agent,
  );
  const credentialDriftChannels = messagingChannelsWithCredentialDrift(
    registryPlan,
    options.env ?? process.env,
    activeChannels,
  );
  if (credentialDriftChannels.length > 0) {
    options.deps.note(
      `  [non-interactive] Detected messaging channel inputs for ${credentialDriftChannels.join(", ")}; reconciling reused sandbox messaging plan.`,
    );
    return selectionFromMessagingSetup(
      credentialDriftChannels,
      { ...options, forceCredentialValidation: true },
      true,
      registryPlan,
    );
  }
  const detectedChannels = channelsForRegistryPlanRefresh(registryPlan, options.agent);
  if (!detectedChannels) {
    return filterUnconfiguredHostChannelsFromSelection(
      selectionFromReusablePlan(registryPlan, options.agent, true, options.deps),
      options.agent,
      options.deps,
    );
  }
  options.deps.note(
    `  [non-interactive] Detected messaging channel inputs for ${detectedChannels.join(", ")}; refreshing reused sandbox messaging plan.`,
  );
  return selectionFromMessagingSetup(
    // The registry is authoritative for channels that cannot be rediscovered
    // from host env (for example, an in-sandbox QR-authenticated channel).
    getChannelsFromPlan(registryPlan) ?? getChannelsFromPlan(options.session?.messagingPlan),
    options,
  );
}

export function reconcileReusedSandboxMessaging<Agent>(
  plan: SandboxMessagingPlan | null,
  agent: Agent,
  deps: Pick<SandboxMessagingDeps<Agent>, "clearPlanEnv" | "note" | "writePlanToEnv">,
  recordedPlan: SandboxMessagingPlan | null = plan,
): SandboxMessagingSelection & { readonly changed: boolean } {
  const filtered = plan ? filterMessagingPlanForCurrentAgent(plan, agent) : null;
  const selection = filterUnconfiguredHostChannelsFromSelection(
    { plan: filtered, selectedChannels: getActiveChannelsFromPlan(filtered) },
    agent,
    deps,
  );
  const changed = !isDeepStrictEqual(selection.plan, recordedPlan);
  if (changed && isDeepStrictEqual(selection.plan, filtered)) deps.clearPlanEnv();
  return {
    ...selection,
    changed,
  };
}

function divergedCheckpointChannels(
  session: Session | null | undefined,
  durablePlan: SandboxMessagingPlan | null,
): readonly string[] | null {
  const checkpoint = session?.checkpoint;
  if (!checkpoint) return null;
  const messagingDecision = checkpoint.messaging;
  const checkpointedChannels = isDecisionSelected(messagingDecision)
    ? messagingDecision.value.selectedChannels.filter(
        (channelId) => !messagingDecision.value.disabledChannels.includes(channelId),
      )
    : [];
  const durableChannels = durablePlan ? getActiveChannelsFromPlan(durablePlan) : [];
  return sameChannelSet(checkpointedChannels, durableChannels) ? null : checkpointedChannels;
}

async function selectionFromDivergedMessagingCheckpoint<Agent>(
  checkpointedChannels: readonly string[],
  options: ReconcileSandboxMessagingOptions<Agent>,
): Promise<SandboxMessagingSelection> {
  if (checkpointedChannels.length === 0) {
    options.deps.clearPlanEnv();
    options.deps.showMessagingStage?.();
    options.deps.note("  [resume] Reusing messaging selection: no channels.");
    return { plan: null, selectedChannels: [] };
  }
  options.deps.note("  [resume] Reconciling messaging selection with the recorded checkpoint.");
  return selectionFromMessagingSetup([...checkpointedChannels], options, true);
}

function missingCredentialNeedsValidation(
  binding: SandboxMessagingPlan["credentialBindings"][number],
  agent: SandboxMessagingPlan["agent"],
  validateMissingCredentials: boolean,
  stagedProviderNames: ReadonlySet<string>,
  deps: Pick<SandboxMessagingDeps<unknown>, "providerMatchesGatewayCredential">,
): boolean {
  if (validateMissingCredentials && !stagedProviderNames.has(binding.providerName)) return true;
  const providerMatches = deps.providerMatchesGatewayCredential(
    binding.providerName,
    staticMessagingProviderTypeForChannel(binding.channelId, agent) ?? "generic",
    binding.providerEnvKey,
  );
  return validateMissingCredentials && !providerMatches;
}

function channelsNeedingCredentialValidation(
  plan: SandboxMessagingPlan,
  selectedChannels: readonly string[],
  validateMissingCredentials: boolean,
  stagedProviderNames: ReadonlySet<string>,
  deps: Pick<SandboxMessagingDeps<unknown>, "providerMatchesGatewayCredential">,
): string[] {
  const activeChannels = new Set(selectedChannels);
  const channels = new Set<string>();
  for (const binding of plan.credentialBindings) {
    if (!activeChannels.has(binding.channelId)) continue;
    const credentialHash = hashCredential(getCredential(binding.providerEnvKey));
    if (credentialHash && credentialHash !== binding.credentialHash) {
      channels.add(binding.channelId);
      continue;
    }
    if (
      !credentialHash &&
      missingCredentialNeedsValidation(
        binding,
        plan.agent,
        validateMissingCredentials,
        stagedProviderNames,
        deps,
      )
    ) {
      channels.add(binding.channelId);
    }
  }
  return [...channels];
}

async function selectionFromCompletedMessagingCheckpoint<Agent>(
  envPlan: SandboxMessagingPlan | null,
  options: ReconcileSandboxMessagingOptions<Agent>,
  durablePlan: SandboxMessagingPlan | null = options.session?.messagingPlan ?? null,
  reconcileCheckpoint = true,
  validateMissingCredentials = reconcileCheckpoint,
): Promise<SandboxMessagingSelection> {
  // After the checkpoint completes, the selected messaging plan is authoritative.
  // The process plan may already have refreshed hashes, so it cannot prove
  // that a newly exported credential passed the channel's validation hooks.
  // Forced credential validation returns before this checkpoint path when a baseline exists.
  const validationPlan = durablePlan;
  const diverged = reconcileCheckpoint
    ? divergedCheckpointChannels(options.session, validationPlan)
    : null;
  if (diverged) {
    return selectionFromDivergedMessagingCheckpoint(diverged, options);
  }
  if (!validationPlan) {
    options.deps.clearPlanEnv();
    options.deps.showMessagingStage?.();
    options.deps.note("  [resume] Reusing messaging selection: no channels.");
    return { plan: null, selectedChannels: [] };
  }

  const filteredPlan = filterMessagingPlanForCurrentAgent(validationPlan, options.agent);
  if (!filteredPlan) {
    options.deps.clearPlanEnv();
    options.deps.showMessagingStage?.();
    options.deps.note("  [resume] Reusing messaging selection: no active channels.");
    return { plan: null, selectedChannels: [] };
  }
  const selectedChannels = getActiveChannelsFromPlan(filteredPlan);
  if (selectedChannels.length === 0) {
    const selection = selectionFromReusablePlan(
      validationPlan,
      options.agent,
      envPlan !== validationPlan,
      options.deps,
    );
    options.deps.showMessagingStage?.();
    options.deps.note("  [resume] Reusing messaging selection: no active channels.");
    return selection;
  }

  const credentialValidationChannels = channelsNeedingCredentialValidation(
    filteredPlan,
    selectedChannels,
    validateMissingCredentials,
    new Set(options.session?.stagedCredentialProviders ?? []),
    options.deps,
  );
  if (credentialValidationChannels.length > 0) {
    options.deps.writePlanToEnv(validationPlan);
    return selectionFromMessagingSetup(
      credentialValidationChannels,
      { ...options, forceCredentialValidation: true },
      true,
      validationPlan,
    );
  }

  const selection = selectionFromReusablePlan(
    validationPlan,
    options.agent,
    envPlan !== validationPlan,
    options.deps,
  );
  options.deps.showMessagingStage?.();
  options.deps.note(
    `  [resume] Reusing messaging channels: ${selection.selectedChannels.join(", ")}.`,
  );
  return selection;
}

async function selectionFromRegistryAuthority<Agent>(
  authority: ReturnType<typeof resolveMessagingPlanAuthority>,
  envPlan: SandboxMessagingPlan | null,
  messagingDecisionCompleted: boolean,
  options: ReconcileSandboxMessagingOptions<Agent>,
): Promise<SandboxMessagingSelection | null> {
  if (authority.source !== "registry") return null;
  const agentName = (options.agent as MessagingAgentLike | null)?.name;
  if ((!agentName || agentName === "openclaw") && options.resume && messagingDecisionCompleted) {
    const selection = await selectionFromCompletedMessagingCheckpoint(
      envPlan,
      options,
      authority.plan,
      false,
    );
    return filterUnconfiguredHostChannelsFromSelection(
      selection,
      options.agent,
      options.deps,
    );
  }
  if (authority.plan) return selectionFromRegistryPlan(authority.plan, options);
  options.deps.clearPlanEnv();
  return { plan: null, selectedChannels: [] };
}

async function selectionFromForcedCredentialValidation<Agent>(
  options: ReconcileSandboxMessagingOptions<Agent>,
): Promise<SandboxMessagingSelection | null> {
  if (!options.forceCredentialValidation || !options.credentialValidationPlan) return null;
  const validationBaseline = filterMessagingPlanForCurrentAgent(
    options.credentialValidationPlan,
    options.agent,
  );
  if (!validationBaseline) {
    options.deps.clearPlanEnv();
    return { plan: null, selectedChannels: [] };
  }
  const requiredChannels = messagingChannelsWithCredentialDrift(
    validationBaseline,
    options.env ?? process.env,
  );
  if (requiredChannels.length === 0) {
    requiredChannels.push(...getActiveChannelsFromPlan(validationBaseline));
  }
  if (requiredChannels.length === 0) {
    return selectionFromReusablePlan(validationBaseline, options.agent, true, options.deps);
  }
  options.deps.writePlanToEnv(validationBaseline);
  return selectionFromMessagingSetup(requiredChannels, options, true, validationBaseline);
}

function stagedPlanFromAuthority(
  authority: ReturnType<typeof resolveMessagingPlanAuthority>,
): SandboxMessagingPlan | null {
  return authority.source === "staged" ? authority.plan : null;
}

async function selectionFromCompletedMessagingAuthority<Agent>(
  authority: ReturnType<typeof resolveMessagingPlanAuthority>,
  envPlan: SandboxMessagingPlan | null,
  messagingDecisionCompleted: boolean,
  options: ReconcileSandboxMessagingOptions<Agent>,
): Promise<SandboxMessagingSelection | null> {
  const agentName = (options.agent as MessagingAgentLike | null)?.name;
  if ((agentName && agentName !== "openclaw") || !options.resume || !messagingDecisionCompleted) {
    return null;
  }
  const stagedPlan = stagedPlanFromAuthority(authority);
  if (stagedPlan) {
    return selectionFromCompletedMessagingCheckpoint(envPlan, options, stagedPlan, false);
  }
  return selectionFromCompletedMessagingCheckpoint(envPlan, options, authority.plan);
}

export async function reconcileSandboxMessaging<Agent>(
  options: ReconcileSandboxMessagingOptions<Agent>,
): Promise<SandboxMessagingSelection> {
  const registry =
    options.registryAuthoritySnapshot ??
    options.deps.getRegistrySandboxMessagingAuthority(options.sandboxName);
  const envPlan = registry.authoritative ? null : options.deps.readMessagingPlanFromEnv();
  const authority = resolveMessagingPlanAuthority({
    sandboxName: options.sandboxName,
    registry,
    stagedPlan: envPlan,
    sessionPlan: options.session?.messagingPlan ?? null,
  });
  const forcedValidationSelection = await selectionFromForcedCredentialValidation(options);
  if (forcedValidationSelection) return forcedValidationSelection;
  const messagingDecisionCompleted = options.session?.checkpoint
    ? !isDecisionUnset(options.session.checkpoint.messaging)
    : options.session?.sandboxPromptProgress?.messaging === true;
  const registrySelection = await selectionFromRegistryAuthority(
    authority,
    envPlan,
    messagingDecisionCompleted,
    options,
  );
  if (registrySelection) return registrySelection;
  const completedSelection = await selectionFromCompletedMessagingAuthority(
    authority,
    envPlan,
    messagingDecisionCompleted,
    options,
  );
  if (completedSelection) return completedSelection;
  const recordedChannels = options.deps.getRecordedMessagingChannelsForResume(
    options.resume,
    options.session,
    options.sandboxName,
  );
  if (recordedChannels) {
    return selectionFromRecordedChannels(
      recordedChannels,
      stagedPlanFromAuthority(authority),
      null,
      options,
    );
  }
  if (authority.source === "staged" && authority.plan) {
    return selectionFromReusablePlan(authority.plan, options.agent, false, options.deps);
  }
  return selectionFromMessagingSetup(getChannelsFromPlan(authority.plan), options);
}
