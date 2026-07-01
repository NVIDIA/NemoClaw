// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { loadAgent } from "../../agent/defs";
import { RD as _RD, D, G, R } from "../../cli/terminal-style";
import type {
  MessagingHookApplyRequest,
  MessagingHookOutputMap,
  MessagingOpenShellRunner,
  SandboxMessagingPlan,
} from "../../messaging";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
  isMessagingSupportedAgent,
  listSupportedMessagingChannelIdsForAgent,
  MessagingSetupApplier,
  MessagingWorkflowPlanner,
  tryGetMessagingAgentId,
} from "../../messaging";
import type { SandboxEntry } from "../../state/registry";
import type { RebuildBail } from "./rebuild-credential-preflight";

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

/** Stage the manifest plan while preserving rebuild's fail-before-delete boundary. */
export async function stageRebuildMessagingPlanOrBail(
  sandboxName: string,
  sandboxEntry: SandboxEntry,
  rebuildAgent: string | null,
  log: (message: string) => void,
  bail: RebuildBail,
): Promise<SandboxMessagingPlan | null> {
  try {
    return await stageMessagingManifestPlanForRebuild(sandboxName, sandboxEntry, rebuildAgent, log);
  } catch (err) {
    // Source boundary: persisted registry messaging plans and current channel
    // manifests are host-side inputs. If they drift or become invalid, rebuild
    // must fail here before backup/delete; remove this boundary only if manifest
    // staging becomes total over all persisted registry states.
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} messaging manifest plan could not be staged.`,
    );
    console.error(`  ${message}`);
    console.error("");
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }
}

const runMessagingOpenshell: MessagingOpenShellRunner = (args, options = {}) =>
  runOpenshell([...args], {
    env: options.env as NodeJS.ProcessEnv | undefined,
    ignoreError: options.ignoreError,
    input: options.input,
    stdio: options.stdio as never,
  });

function hookOutputsFromBuildSteps(
  plan: SandboxMessagingPlan,
  request: MessagingHookApplyRequest,
): { readonly outputs: MessagingHookOutputMap } {
  const outputs: Record<string, MessagingHookOutputMap[string]> = {};
  for (const step of plan.buildSteps) {
    if (
      step.channelId !== request.channelId ||
      step.hookId !== request.hookId ||
      step.value === undefined
    ) {
      continue;
    }
    outputs[step.outputId] = { kind: step.kind, value: step.value };
  }
  return { outputs };
}

/** Reapply OpenClaw messaging files that doctor may have rewritten. */
export async function reapplyMessagingManifestAfterOpenClawDoctor(
  sandboxName: string,
  plan: SandboxMessagingPlan | null,
  log: (message: string) => void,
): Promise<void> {
  if (!plan || plan.agent !== "openclaw") {
    log("Messaging manifest reapply skipped: no OpenClaw messaging plan");
    return;
  }

  try {
    log("Reapplying messaging manifest render and post-agent-install hooks after doctor");
    const result = await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
      runOpenshell: runMessagingOpenshell,
      runHook: (request) => hookOutputsFromBuildSteps(plan, request),
    });
    log(
      `messaging manifest reapply: targets=${result.appliedTargets.join(",")}, hooks=${result.appliedHooks.join(",")}`,
    );
    if (result.appliedTargets.length > 0 || result.appliedHooks.length > 0) {
      console.log(`  ${G}\u2713${R} Messaging manifest config reapplied`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Messaging manifest reapply failed: ${message}`);
    console.log(`  ${D}Messaging manifest config reapply skipped (${message})${R}`);
  }
}
