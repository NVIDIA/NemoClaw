// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingChannelId,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingBuildStepPlan,
  SandboxMessagingChannelPlan,
  SandboxMessagingHookReferencePlan,
} from "./manifest";

export type EnabledPlanChannel = Pick<SandboxMessagingChannelPlan, "channelId"> &
  Partial<Pick<SandboxMessagingChannelPlan, "active" | "disabled">>;

export interface EnabledPlanSelection<Channel extends EnabledPlanChannel = EnabledPlanChannel> {
  readonly channels: readonly Channel[];
  readonly disabledChannels?: readonly MessagingChannelId[];
}

export function normalizeMessagingChannelId(channelId: MessagingChannelId): MessagingChannelId {
  return channelId.trim().toLowerCase();
}

export function enabledPlanChannels<Channel extends EnabledPlanChannel>(
  plan: EnabledPlanSelection<Channel>,
): Channel[] {
  const disabled = new Set(
    (plan.disabledChannels ?? []).map(normalizeMessagingChannelId).filter(Boolean),
  );
  return plan.channels.filter((channel) => {
    const channelId = normalizeMessagingChannelId(channel.channelId);
    return channelId.length > 0 && channel.active && !channel.disabled && !disabled.has(channelId);
  });
}

export function enabledPlanChannelIds(plan: EnabledPlanSelection): Set<MessagingChannelId> {
  return new Set(
    enabledPlanChannels(plan).map((channel) => normalizeMessagingChannelId(channel.channelId)),
  );
}

export function filterEnabledPlanEntries<T extends { readonly channelId: MessagingChannelId }>(
  plan: EnabledPlanSelection,
  entries: readonly T[],
): T[] {
  const enabled = enabledPlanChannelIds(plan);
  return entries.filter((entry) => enabled.has(normalizeMessagingChannelId(entry.channelId)));
}

type SelectionChannel = EnabledPlanChannel & {
  readonly hooks?: readonly (Pick<SandboxMessagingHookReferencePlan, "id"> & {
    readonly phase: string;
  })[];
};

type SelectionRender = Pick<SandboxMessagingAgentRenderPlan, "agent" | "channelId">;

type SelectionBuildStep = Pick<SandboxMessagingBuildStepPlan, "channelId" | "kind" | "hookId">;

/**
 * Canonical active-channel selection for the image applier. Each selection
 * consumer must resolve the same active channels and mutable outputs.
 */
export function selectActiveMessagingChannelIds<Channel extends EnabledPlanChannel>(
  plan: EnabledPlanSelection<Channel>,
): MessagingChannelId[] {
  const seen = new Set<string>();
  const channels: string[] = [];
  for (const item of enabledPlanChannels(plan)) {
    const channel = normalizeMessagingChannelId(item.channelId);
    if (!channel || seen.has(channel)) continue;
    seen.add(channel);
    channels.push(channel);
  }
  return channels;
}

export function selectEnabledMessagingAgentRender<Render extends SelectionRender>(
  plan: EnabledPlanSelection & {
    readonly agent: string;
    readonly agentRender: readonly Render[];
  },
): Render[] {
  const active = new Set(selectActiveMessagingChannelIds(plan));
  return plan.agentRender.filter(
    (render) =>
      render.agent === plan.agent && active.has(normalizeMessagingChannelId(render.channelId)),
  );
}

export function selectEnabledPostAgentInstallBuildFiles<
  Channel extends SelectionChannel,
  Step extends SelectionBuildStep,
>(
  plan: EnabledPlanSelection<Channel> & {
    readonly buildSteps: readonly Step[];
  },
): Array<Step & { readonly kind: "build-file" }> {
  const active = new Set(selectActiveMessagingChannelIds(plan));
  const channels = enabledPlanChannels(plan);
  return plan.buildSteps.filter((step): step is Step & { readonly kind: "build-file" } => {
    const channelId = normalizeMessagingChannelId(step.channelId);
    if (!active.has(channelId) || step.kind !== "build-file") return false;
    if (!step.hookId) return true;
    const matchingChannels = channels.filter(
      (channel) => normalizeMessagingChannelId(channel.channelId) === channelId,
    );
    if (matchingChannels.length !== 1) return false;
    const matchedHook = matchingChannels[0]?.hooks?.find((hook) => hook.id === step.hookId);
    return matchedHook !== undefined && matchedHook.phase === "post-agent-install";
  });
}
