// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

interface SelectionHook {
  readonly id: string;
  readonly phase: string;
}

interface SelectionChannel {
  readonly channelId: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly hooks?: readonly SelectionHook[];
}

interface SelectionPlanBase {
  readonly channels: readonly SelectionChannel[];
}

/**
 * Canonical active-channel selection for the image applier. Each selection
 * consumer must resolve the same active channels and mutable outputs.
 */
export function selectActiveMessagingChannelIds(plan: SelectionPlanBase): string[] {
  const seen = new Set<string>();
  const channels: string[] = [];
  for (const item of plan.channels) {
    const channel = String(item.channelId || "")
      .trim()
      .toLowerCase();
    if (!channel || seen.has(channel)) continue;
    if (item.active === true && item.disabled !== true) {
      seen.add(channel);
      channels.push(channel);
    }
  }
  return channels;
}

export function selectEnabledMessagingAgentRender<
  Render extends {
    readonly agent: string;
    readonly channelId: string;
  },
>(
  plan: SelectionPlanBase & {
    readonly agent: string;
    readonly agentRender: readonly Render[];
  },
): Render[] {
  const active = new Set(selectActiveMessagingChannelIds(plan));
  return plan.agentRender.filter(
    (render) => render.agent === plan.agent && active.has(render.channelId),
  );
}

export function selectEnabledPostAgentInstallBuildFiles<
  Step extends {
    readonly channelId: string;
    readonly kind: string;
    readonly hookId?: string;
  },
>(
  plan: SelectionPlanBase & {
    readonly buildSteps: readonly Step[];
  },
): Step[] {
  const active = new Set(selectActiveMessagingChannelIds(plan));
  return plan.buildSteps.filter((step) => {
    if (!active.has(step.channelId) || step.kind !== "build-file") return false;
    if (!step.hookId) return true;
    const hookPhase = plan.channels
      .find((channel) => channel.channelId === step.channelId)
      ?.hooks?.find((hook) => hook.id === step.hookId)?.phase;
    return hookPhase === undefined || hookPhase === "post-agent-install";
  });
}
