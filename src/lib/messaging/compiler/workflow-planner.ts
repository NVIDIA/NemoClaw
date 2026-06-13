// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MessagingHookRegistry } from "../hooks";
import type {
  ChannelManifestRegistry,
  MessagingAgentId,
  MessagingChannelId,
  MessagingCompilerWorkflow,
  SandboxMessagingChannelPlan,
  SandboxMessagingPlan,
} from "../manifest";
import type { RenderTemplateReferenceResolver } from "./engines/template";
import { ManifestCompiler } from "./manifest-compiler";
import type { ManifestCompilerContext, MessagingCompilerCredentialAvailability } from "./types";

export interface MessagingWorkflowPlannerBuildContext {
  readonly sandboxName: string;
  readonly agent: MessagingAgentId;
  readonly workflow: MessagingCompilerWorkflow;
  readonly isInteractive: boolean;
  readonly configuredChannels?: readonly MessagingChannelId[];
  readonly disabledChannels?: readonly MessagingChannelId[];
  readonly supportedChannelIds?: readonly MessagingChannelId[];
  readonly credentialAvailability?: MessagingCompilerCredentialAvailability;
}

export class MessagingWorkflowPlanner {
  private readonly compiler: ManifestCompiler;

  constructor(
    private readonly registry: ChannelManifestRegistry,
    hooks = new MessagingHookRegistry(),
    renderTemplateResolver?: RenderTemplateReferenceResolver,
  ) {
    this.compiler = new ManifestCompiler(registry, hooks, renderTemplateResolver);
  }

  async buildPlan(context: MessagingWorkflowPlannerBuildContext): Promise<SandboxMessagingPlan> {
    const configuredChannels = uniqueChannels(context.configuredChannels);
    const disabledChannels = onlyConfiguredChannels(context.disabledChannels, configuredChannels);
    this.assertSupportedChannels(configuredChannels, context);

    const compilerContext: ManifestCompilerContext = {
      sandboxName: context.sandboxName,
      agent: context.agent,
      isInteractive: context.isInteractive,
      workflow: context.workflow,
      configuredChannels,
      disabledChannels,
      supportedChannelIds: context.supportedChannelIds,
      credentialAvailability: context.credentialAvailability,
    };
    return this.compiler.compile(compilerContext);
  }

  async buildChannelAddPlanFromSandboxEntry(
    context: MessagingWorkflowPlannerChannelAddContext,
  ): Promise<SandboxMessagingPlan> {
    const existingPlan = readSandboxEntryPlan(context);
    const compiledPlan = await this.buildPlan({
      sandboxName: context.sandboxName,
      agent: context.agent,
      workflow: "add-channel",
      isInteractive: context.isInteractive,
      configuredChannels: [context.channelId],
      disabledChannels: [],
      supportedChannelIds: context.supportedChannelIds,
      credentialAvailability: mergeAvailability(
        credentialAvailabilityFromPlan(existingPlan),
        this.credentialAvailabilityFromSandboxEntry(context.sandboxEntry, [context.channelId]),
        context.credentialAvailability,
      ),
    });
    return existingPlan ? mergeSandboxMessagingPlans(existingPlan, compiledPlan) : compiledPlan;
  }

  async buildChannelStopPlanFromSandboxEntry(
    context: MessagingWorkflowPlannerChannelMutationContext,
  ): Promise<SandboxMessagingPlan | null> {
    const plan = await this.planForSandboxEntryMutation(context, "stop-channel");
    return plan ? setPlanChannelDisabled(plan, context.channelId, true, "stop-channel") : null;
  }

  async buildChannelStartPlanFromSandboxEntry(
    context: MessagingWorkflowPlannerChannelMutationContext,
  ): Promise<SandboxMessagingPlan | null> {
    const plan = await this.planForSandboxEntryMutation(context, "start-channel");
    return plan ? setPlanChannelDisabled(plan, context.channelId, false, "start-channel") : null;
  }

  async buildChannelRemovePlanFromSandboxEntry(
    context: MessagingWorkflowPlannerChannelMutationContext,
  ): Promise<SandboxMessagingPlan | null> {
    const plan = await this.planForSandboxEntryMutation(context, "remove-channel");
    return plan ? removePlanChannel(plan, context.channelId, "remove-channel") : null;
  }

  async buildRebuildPlanFromSandboxEntry(
    context: MessagingWorkflowPlannerSandboxRebuildContext,
  ): Promise<SandboxMessagingPlan | null> {
    const existingPlan = readSandboxEntryPlan(context);
    if (existingPlan) {
      const normalizedPlan = setPlanDisabledChannels(
        existingPlan,
        disabledChannelsFromSandboxEntry(context.sandboxEntry, existingPlan),
        "rebuild",
      );
      if (!planMissingActiveChannelRender(normalizedPlan)) return normalizedPlan;

      const configuredChannels = uniqueChannels(
        normalizedPlan.channels.map((channel) => channel.channelId),
      );
      const refreshedPlan = await this.buildPlan({
        sandboxName: context.sandboxName,
        agent: context.agent,
        workflow: "rebuild",
        isInteractive: false,
        configuredChannels,
        disabledChannels: normalizedPlan.disabledChannels,
        supportedChannelIds: context.supportedChannelIds,
        credentialAvailability: mergeAvailability(
          credentialAvailabilityFromPlan(normalizedPlan),
          this.credentialAvailabilityFromSandboxEntry(context.sandboxEntry, configuredChannels),
          context.credentialAvailability,
        ),
      });
      return mergeSandboxMessagingPlans(
        normalizedPlan,
        preserveCredentialBindingHashes(normalizedPlan, refreshedPlan),
      );
    }
    return null;
  }

  private assertSupportedChannels(
    channelIds: readonly MessagingChannelId[],
    context: Pick<MessagingWorkflowPlannerBuildContext, "agent" | "supportedChannelIds">,
  ): void {
    const supportedIds = new Set(this.supportedChannelIds(context));
    const unsupportedIds = uniqueChannels(channelIds)
      .filter((channelId) => !supportedIds.has(channelId))
      .sort();

    if (unsupportedIds.length > 0) {
      throw new Error(
        `Unsupported messaging channel(s) for ${context.agent}: ${unsupportedIds.join(", ")}`,
      );
    }
  }

  private supportedChannelIds(
    context: Pick<MessagingWorkflowPlannerBuildContext, "agent" | "supportedChannelIds">,
  ): MessagingChannelId[] {
    const supportedFilter =
      context.supportedChannelIds && context.supportedChannelIds.length > 0
        ? new Set(context.supportedChannelIds)
        : null;

    return this.registry
      .list()
      .filter((manifest) => manifest.supportedAgents.includes(context.agent))
      .filter((manifest) => !supportedFilter || supportedFilter.has(manifest.id))
      .map((manifest) => manifest.id);
  }

  private async planForSandboxEntryMutation(
    context: MessagingWorkflowPlannerChannelMutationContext,
    workflow: MessagingCompilerWorkflow,
  ): Promise<SandboxMessagingPlan | null> {
    const existingPlan = readSandboxEntryPlan(context);
    if (existingPlan) return { ...clonePlan(existingPlan), workflow };
    return null;
  }

  private credentialAvailabilityFromSandboxEntry(
    sandboxEntry: MessagingWorkflowPlannerSandboxEntry | null | undefined,
    channelIds: readonly MessagingChannelId[],
  ): MessagingCompilerCredentialAvailability | undefined {
    const plan = sandboxEntry?.messaging?.plan;
    if (!plan) return undefined;

    const availability: Record<string, boolean> = {};
    for (const channelId of channelIds) {
      const manifest = this.registry.get(channelId);
      if (!manifest) continue;
      for (const credential of manifest.credentials) {
        const binding = plan.credentialBindings.find(
          (b) => b.channelId === channelId && b.providerEnvKey === credential.providerEnvKey,
        );
        if (!binding?.credentialAvailable) continue;
        availability[credential.sourceInput] = true;
        availability[manifest.id + "." + credential.sourceInput] = true;
        availability[credential.id] = true;
        availability[manifest.id + "." + credential.id] = true;
        availability[credential.providerEnvKey] = true;
      }
    }
    return Object.keys(availability).length > 0 ? availability : undefined;
  }
}

export interface MessagingWorkflowPlannerSandboxEntry {
  readonly name: string;
  readonly agent?: string | null;
  readonly messaging?: {
    readonly schemaVersion: 1;
    readonly plan: SandboxMessagingPlan;
  } | null;
}

export interface MessagingWorkflowPlannerSandboxContext {
  readonly sandboxName: string;
  readonly agent: MessagingAgentId;
  readonly sandboxEntry?: MessagingWorkflowPlannerSandboxEntry | null;
  readonly supportedChannelIds?: readonly MessagingChannelId[];
  readonly credentialAvailability?: MessagingCompilerCredentialAvailability;
}

export interface MessagingWorkflowPlannerChannelAddContext
  extends MessagingWorkflowPlannerSandboxContext {
  readonly channelId: MessagingChannelId;
  readonly isInteractive: boolean;
}

export interface MessagingWorkflowPlannerChannelMutationContext
  extends MessagingWorkflowPlannerSandboxContext {
  readonly channelId: MessagingChannelId;
}

export type MessagingWorkflowPlannerSandboxRebuildContext = MessagingWorkflowPlannerSandboxContext;

function uniqueChannels(
  channelIds: readonly MessagingChannelId[] | null | undefined,
): MessagingChannelId[] {
  return [...new Set(channelIds ?? [])];
}

function onlyConfiguredChannels(
  channelIds: readonly MessagingChannelId[] | undefined,
  configuredChannels: readonly MessagingChannelId[],
): MessagingChannelId[] {
  const configured = new Set(configuredChannels);
  return uniqueChannels(channelIds).filter((channelId) => configured.has(channelId));
}

function readSandboxEntryPlan(
  context: Pick<MessagingWorkflowPlannerSandboxContext, "agent" | "sandboxEntry" | "sandboxName">,
): SandboxMessagingPlan | null {
  const plan = context.sandboxEntry?.messaging?.plan;
  if (
    !plan ||
    plan.schemaVersion !== 1 ||
    plan.sandboxName !== context.sandboxName ||
    plan.agent !== context.agent
  ) {
    return null;
  }
  return clonePlan(plan);
}

function disabledChannelsFromSandboxEntry(
  _sandboxEntry: MessagingWorkflowPlannerSandboxEntry | null | undefined,
  fallbackPlan: SandboxMessagingPlan | null,
): MessagingChannelId[] {
  return uniqueChannels(fallbackPlan?.disabledChannels ?? []);
}

function clonePlan(plan: SandboxMessagingPlan): SandboxMessagingPlan {
  return JSON.parse(JSON.stringify(plan)) as SandboxMessagingPlan;
}

function mergeSandboxMessagingPlans(
  existing: SandboxMessagingPlan,
  incoming: SandboxMessagingPlan,
): SandboxMessagingPlan {
  if (
    existing.schemaVersion !== incoming.schemaVersion ||
    existing.sandboxName !== incoming.sandboxName ||
    existing.agent !== incoming.agent
  ) {
    return clonePlan(incoming);
  }

  const incomingChannelIds = new Set(incoming.channels.map((channel) => channel.channelId));
  const mergedChannels = [
    ...existing.channels.filter((channel) => !incomingChannelIds.has(channel.channelId)),
    ...incoming.channels,
  ];
  const activeIncomingChannels = new Set(
    incoming.channels
      .filter((channel) => channel.active && !channel.disabled)
      .map((channel) => channel.channelId),
  );
  const disabledChannels = uniqueSortedStrings([
    ...existing.disabledChannels.filter((channelId) => !activeIncomingChannels.has(channelId)),
    ...incoming.disabledChannels,
  ]);
  const networkEntries = mergePlanEntriesByChannel(
    existing.networkPolicy.entries,
    incoming.networkPolicy.entries,
  );

  return clonePlan({
    ...incoming,
    channels: mergedChannels,
    disabledChannels,
    credentialBindings: mergePlanEntriesByChannel(
      existing.credentialBindings,
      incoming.credentialBindings,
    ),
    networkPolicy: {
      presets: uniqueSortedStrings(networkEntries.map((entry) => entry.presetName)),
      entries: networkEntries,
    },
    agentRender: mergePlanEntriesByChannel(existing.agentRender, incoming.agentRender),
    buildSteps: mergePlanEntriesByChannel(existing.buildSteps, incoming.buildSteps),
    stateUpdates: mergePlanEntriesByChannel(existing.stateUpdates, incoming.stateUpdates),
    healthChecks: mergePlanEntriesByChannel(existing.healthChecks, incoming.healthChecks),
  });
}

function setPlanChannelDisabled(
  plan: SandboxMessagingPlan,
  channelId: MessagingChannelId,
  disabled: boolean,
  workflow: MessagingCompilerWorkflow,
): SandboxMessagingPlan {
  const nextChannels = plan.channels.map((channel) => {
    if (channel.channelId !== channelId) return channel;
    const nextChannel = { ...channel, disabled };
    return {
      ...nextChannel,
      active: !disabled && isChannelPlanStartable(nextChannel),
    };
  });
  const configuredIds = new Set(nextChannels.map((channel) => channel.channelId));
  const disabledChannels = disabled
    ? uniqueSortedStrings([...plan.disabledChannels, channelId]).filter((id) =>
        configuredIds.has(id),
      )
    : plan.disabledChannels.filter((id) => id !== channelId);

  return clonePlan({
    ...plan,
    workflow,
    channels: nextChannels,
    disabledChannels,
  });
}

function setPlanDisabledChannels(
  plan: SandboxMessagingPlan,
  disabledChannelIds: readonly MessagingChannelId[],
  workflow: MessagingCompilerWorkflow,
): SandboxMessagingPlan {
  const configuredIds = new Set(plan.channels.map((channel) => channel.channelId));
  const disabledChannels = uniqueSortedStrings(disabledChannelIds).filter((id) =>
    configuredIds.has(id),
  );
  const disabledSet = new Set(disabledChannels);
  const channels = plan.channels.map((channel) => {
    const disabled = disabledSet.has(channel.channelId);
    const nextChannel = { ...channel, disabled };
    return {
      ...nextChannel,
      active: !disabled && isChannelPlanStartable(nextChannel),
    };
  });

  return clonePlan({
    ...plan,
    workflow,
    channels,
    disabledChannels,
  });
}

function preserveCredentialBindingHashes(
  existing: SandboxMessagingPlan,
  incoming: SandboxMessagingPlan,
): SandboxMessagingPlan {
  const existingHashes = new Map(
    existing.credentialBindings
      .filter((binding) => binding.credentialHash)
      .map((binding) => [credentialBindingKey(binding), binding.credentialHash] as const),
  );
  if (existingHashes.size === 0) return incoming;

  return clonePlan({
    ...incoming,
    credentialBindings: incoming.credentialBindings.map((binding) => ({
      ...binding,
      credentialHash: binding.credentialHash ?? existingHashes.get(credentialBindingKey(binding)),
    })),
  });
}

function credentialBindingKey(
  binding: Pick<SandboxMessagingPlan["credentialBindings"][number], "channelId" | "providerEnvKey">,
): string {
  return binding.channelId + "\0" + binding.providerEnvKey;
}

function planMissingActiveChannelRender(plan: SandboxMessagingPlan): boolean {
  const renderedChannels = new Set(plan.agentRender.map((entry) => entry.channelId));
  return plan.channels.some(
    (channel) => channel.active && !channel.disabled && !renderedChannels.has(channel.channelId),
  );
}

function removePlanChannel(
  plan: SandboxMessagingPlan,
  channelId: MessagingChannelId,
  workflow: MessagingCompilerWorkflow,
): SandboxMessagingPlan {
  const channels = plan.channels.filter((channel) => channel.channelId !== channelId);
  const remainingChannelIds = new Set(channels.map((channel) => channel.channelId));
  const networkEntries = plan.networkPolicy.entries.filter(
    (entry) => entry.channelId !== channelId,
  );
  const keepEntry = <T extends { readonly channelId: MessagingChannelId }>(entry: T) =>
    entry.channelId !== channelId && remainingChannelIds.has(entry.channelId);

  return clonePlan({
    ...plan,
    workflow,
    channels,
    disabledChannels: plan.disabledChannels.filter(
      (id) => id !== channelId && remainingChannelIds.has(id),
    ),
    credentialBindings: plan.credentialBindings.filter(keepEntry),
    networkPolicy: {
      presets: uniqueSortedStrings(networkEntries.map((entry) => entry.presetName)),
      entries: networkEntries,
    },
    agentRender: plan.agentRender.filter(keepEntry),
    buildSteps: plan.buildSteps.filter(keepEntry),
    stateUpdates: plan.stateUpdates.filter(keepEntry),
    healthChecks: plan.healthChecks.filter(keepEntry),
  });
}

function isChannelPlanStartable(channel: SandboxMessagingChannelPlan): boolean {
  if (!channel.configured) return false;
  return channel.inputs.every((input) => {
    if (!input.required) return true;
    if (input.kind === "secret") return input.credentialAvailable === true;
    if (input.value === undefined) return false;
    return typeof input.value === "string" ? input.value.trim().length > 0 : true;
  });
}

function mergePlanEntriesByChannel<T extends { readonly channelId: MessagingChannelId }>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const incomingChannelIds = new Set(incoming.map((entry) => entry.channelId));
  return [...existing.filter((entry) => !incomingChannelIds.has(entry.channelId)), ...incoming];
}

function credentialAvailabilityFromPlan(
  plan: SandboxMessagingPlan | null,
): MessagingCompilerCredentialAvailability | undefined {
  if (!plan) return undefined;
  const availability: Record<string, boolean> = {};
  for (const channel of plan.channels) {
    for (const input of channel.inputs) {
      if (input.kind !== "secret" || input.credentialAvailable !== true) continue;
      availability[input.inputId] = true;
      availability[`${channel.channelId}.${input.inputId}`] = true;
      if (input.sourceEnv) availability[input.sourceEnv] = true;
    }
  }
  for (const credential of plan.credentialBindings) {
    if (!credential.credentialAvailable) continue;
    availability[credential.credentialId] = true;
    availability[`${credential.channelId}.${credential.credentialId}`] = true;
    availability[credential.sourceInput] = true;
    availability[`${credential.channelId}.${credential.sourceInput}`] = true;
    availability[credential.providerEnvKey] = true;
  }
  return Object.keys(availability).length > 0 ? availability : undefined;
}

function mergeAvailability(
  ...sources: Array<MessagingCompilerCredentialAvailability | undefined>
): MessagingCompilerCredentialAvailability | undefined {
  const merged: Record<string, boolean> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === true) merged[key] = true;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].filter(Boolean).sort();
}
