// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as registry from "../../state/registry";
import type { SandboxMessagingPlan, SandboxMessagingRuntimeSetupPlan } from "../manifest";
import { hydrateDerivedSandboxMessagingPlanFields } from "../persistence";
import { parseSandboxMessagingPlan } from "../plan-validation";
import { MessagingSetupApplier } from "./setup-applier";
import type { MessagingSetupEnvOptions } from "./types";

export interface MessagingHostStateApplyOptions {
  readonly mode?: "replace" | "merge";
}

export class MessagingHostStateApplier {
  static buildStateFromPlan(plan: SandboxMessagingPlan): registry.SandboxMessagingState {
    return {
      schemaVersion: 1,
      plan: clonePlan(plan),
    };
  }

  static readPlanStateFromEnv(
    options: MessagingSetupEnvOptions = {},
  ): registry.SandboxMessagingState | undefined {
    const plan = MessagingSetupApplier.readPlanFromEnv(options);
    return plan ? this.buildStateFromPlan(plan) : undefined;
  }

  static applyPlanFromEnv(
    sandboxName: string,
    options: MessagingSetupEnvOptions & MessagingHostStateApplyOptions = {},
  ): boolean {
    const plan = MessagingSetupApplier.readPlanFromEnv(options);
    if (!plan) return false;
    return this.applyPlanToRegistry(sandboxName, plan, options);
  }

  static applyPlanToRegistry(
    sandboxName: string,
    plan: SandboxMessagingPlan,
    options: MessagingHostStateApplyOptions = {},
  ): boolean {
    if (plan.sandboxName !== sandboxName) return false;
    const entry = registry.getSandbox(sandboxName);
    if (!entry) return false;
    const existingPlan = parseSandboxMessagingPlan(entry.messaging?.plan);
    const hydratedExistingPlan = existingPlan
      ? hydrateDerivedSandboxMessagingPlanFields(existingPlan)
      : null;
    const nextPlan =
      options.mode === "merge" && hydratedExistingPlan
        ? mergeSandboxMessagingPlans(hydratedExistingPlan, plan)
        : clonePlan(plan);
    return registry.updateSandbox(sandboxName, {
      messaging: {
        schemaVersion: 1,
        plan: nextPlan,
      },
    });
  }
}

function clonePlan(plan: SandboxMessagingPlan): SandboxMessagingPlan {
  return MessagingSetupApplier.decodePlan(MessagingSetupApplier.encodePlan(plan));
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
  const disabledChannels = uniqueStrings([
    ...existing.disabledChannels.filter((channelId) => !activeIncomingChannels.has(channelId)),
    ...incoming.disabledChannels,
  ]);
  const networkEntries = mergeByChannelId(
    existing.networkPolicy.entries,
    incoming.networkPolicy.entries,
  );

  return clonePlan({
    ...incoming,
    channels: mergedChannels,
    disabledChannels,
    credentialBindings: mergeByChannelId(existing.credentialBindings, incoming.credentialBindings),
    networkPolicy: {
      presets: uniqueStrings(networkEntries.map((entry) => entry.presetName)),
      entries: networkEntries,
    },
    agentRender: mergeByChannelId(existing.agentRender, incoming.agentRender),
    buildSteps: mergeByChannelId(existing.buildSteps, incoming.buildSteps),
    runtimeSetup: mergeRuntimeSetup(existing.runtimeSetup, incoming.runtimeSetup),
    stateUpdates: mergeByChannelId(existing.stateUpdates, incoming.stateUpdates),
    healthChecks: mergeByChannelId(existing.healthChecks, incoming.healthChecks),
  });
}

function mergeRuntimeSetup(
  existing: SandboxMessagingRuntimeSetupPlan | undefined,
  incoming: SandboxMessagingRuntimeSetupPlan | undefined,
): SandboxMessagingRuntimeSetupPlan {
  return {
    nodePreloads: mergeByChannelId(existing?.nodePreloads ?? [], incoming?.nodePreloads ?? []),
    envAliases: mergeByChannelId(existing?.envAliases ?? [], incoming?.envAliases ?? []),
    secretScans: mergeByChannelId(existing?.secretScans ?? [], incoming?.secretScans ?? []),
  };
}

function mergeByChannelId<T extends { readonly channelId: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const incomingChannelIds = new Set(incoming.map((entry) => entry.channelId));
  return [...existing.filter((entry) => !incomingChannelIds.has(entry.channelId)), ...incoming];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].filter(Boolean).sort();
}
