// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import { createBuiltInChannelManifestRegistry } from "../../messaging/channels/built-ins";
import { createBuiltInRenderTemplateResolver } from "../../messaging/channels/template-resolver";
import { MessagingWorkflowPlanner } from "../../messaging/compiler/workflow-planner";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import {
  isMessagingSupportedAgent,
  listSupportedMessagingChannelIdsForAgent,
  tryGetMessagingAgentId,
} from "../../messaging/utils";
import type { SandboxEntry } from "../../state/registry";

/** Build and stage the manifest-derived messaging recreate contract. */
export async function stageMessagingManifestPlanForRebuild(
  sandboxName: string,
  sandboxEntry: SandboxEntry,
  rebuildAgent: string | null,
  log: (message: string) => void,
): Promise<SandboxMessagingPlan | null> {
  const agent = loadAgent(rebuildAgent || "openclaw");
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const manifests = manifestRegistry.list();
  const agentId = tryGetMessagingAgentId(agent, manifests);
  if (agentId === null) {
    MessagingSetupApplier.clearPlanEnv();
    log(
      `Messaging manifest rebuild plan skipped: agent '${agent.name}' is not supported by any channel manifest`,
    );
    return null;
  }
  if (!isMessagingSupportedAgent(agent, manifests)) {
    MessagingSetupApplier.clearPlanEnv();
    log(
      `Messaging manifest rebuild plan skipped: agent '${agent.name}' has no supported messaging channels`,
    );
    return null;
  }
  const supportedChannelIds = listSupportedMessagingChannelIdsForAgent(manifests, agentId);
  const planner = new MessagingWorkflowPlanner(
    manifestRegistry,
    undefined,
    createBuiltInRenderTemplateResolver(),
  );
  const plan = await planner.buildRebuildPlanFromSandboxEntry({
    sandboxName,
    agent: agentId,
    sandboxEntry,
    supportedChannelIds,
  });
  if (!plan) {
    MessagingSetupApplier.clearPlanEnv();
    log("Messaging manifest rebuild plan: no configured channels");
    return null;
  }
  MessagingSetupApplier.writePlanToEnv(plan);
  if (plan.channels.length === 0) {
    log("Messaging manifest rebuild plan staged: no configured channels");
    return plan;
  }
  log(
    `Messaging manifest rebuild plan staged: ${plan.channels
      .map((channel) => channel.channelId)
      .join(",")}`,
  );
  return plan;
}
