// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "./channels";
import {
  collectTemplateReferencesInLines,
  collectTemplateReferencesInValue,
  isTruthyRenderTemplate,
  resolveCredentialTemplatesInLines,
  resolveCredentialTemplatesInValue,
  resolveRenderTemplatesInLines,
  resolveRenderTemplatesInValue,
} from "./compiler/engines/template";
import type {
  ChannelHookSpec,
  ChannelManifest,
  MessagingAgentId,
  MessagingChannelId,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingChannelPlan,
  SandboxMessagingEnvLinesRenderPlan,
  SandboxMessagingHookReferencePlan,
  SandboxMessagingJsonRenderPlan,
  SandboxMessagingPlan,
} from "./manifest";

export type PersistedSandboxMessagingChannelPlan = Omit<SandboxMessagingChannelPlan, "hooks"> & {
  readonly hooks?: readonly SandboxMessagingHookReferencePlan[];
};

export type PersistedSandboxMessagingPlan = Omit<
  SandboxMessagingPlan,
  "channels" | "agentRender"
> & {
  readonly channels: readonly PersistedSandboxMessagingChannelPlan[];
  readonly agentRender?: readonly SandboxMessagingAgentRenderPlan[];
};

export function compactSandboxMessagingPlanForPersistence(
  plan: SandboxMessagingPlan,
): PersistedSandboxMessagingPlan {
  const { agentRender: _agentRender, channels, ...rest } = clonePlan(plan);
  return {
    ...rest,
    channels: channels.map(({ hooks: _hooks, ...channel }) => channel),
  };
}

export function hydrateDerivedSandboxMessagingPlanFields(
  plan: SandboxMessagingPlan,
): SandboxMessagingPlan {
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const channels = plan.channels.map((channel) => {
    if (channel.hooks.length > 0) return channel;
    return {
      ...channel,
      hooks: channelHooksFromManifest(
        plan.agent,
        channel.channelId,
        manifestRegistry.get(channel.channelId),
      ),
    };
  });
  const hydratedPlan = { ...plan, channels };
  return {
    ...hydratedPlan,
    agentRender:
      hydratedPlan.agentRender.length > 0
        ? hydratedPlan.agentRender
        : agentRenderFromManifests(hydratedPlan, manifestRegistry),
  };
}

function channelHooksFromManifest(
  agent: MessagingAgentId,
  channelId: MessagingChannelId,
  manifest: ChannelManifest | undefined,
): SandboxMessagingHookReferencePlan[] {
  if (!manifest) return [];
  return manifest.hooks
    .filter((hook) => isHookForAgent(hook, agent))
    .map((hook) => cloneHookReference(channelId, hook));
}

function agentRenderFromManifests(
  plan: SandboxMessagingPlan,
  manifestRegistry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
): SandboxMessagingAgentRenderPlan[] {
  const render: SandboxMessagingAgentRenderPlan[] = [];
  const referenceResolver = createBuiltInRenderTemplateResolver();
  for (const channel of plan.channels) {
    const manifest = manifestRegistry.get(channel.channelId);
    if (!manifest) continue;
    const context = {
      inputs: channel.inputs,
      env: process.env,
      referenceResolver,
    };

    for (const [index, entry] of manifest.render.entries()) {
      if (entry.agent !== plan.agent) continue;
      if (!isTruthyRenderTemplate(entry.when, context)) continue;
      const renderId = entry.id ?? `${manifest.id}-render-${index}`;
      const hookId = renderId;
      const handler = "common.staticOutputs";

      if (entry.kind === "json-fragment") {
        const credentialResolved = resolveCredentialTemplatesInValue(
          entry.fragment.value,
          manifest.credentials,
        );
        const value = resolveRenderTemplatesInValue(credentialResolved, context);
        if (value === undefined) continue;
        render.push({
          channelId: manifest.id,
          renderId,
          hookId,
          handler,
          kind: "json-fragment",
          agent: entry.agent,
          target: entry.target,
          path: entry.fragment.path,
          value,
          templateRefs: collectTemplateReferencesInValue(value),
        } satisfies SandboxMessagingJsonRenderPlan);
        continue;
      }

      const credentialResolved = resolveCredentialTemplatesInLines(
        entry.lines,
        manifest.credentials,
      );
      const lines = resolveRenderTemplatesInLines(credentialResolved, context);
      if (lines.length === 0) continue;
      assertSingleLineEnvRenderLines(manifest.id, renderId, lines);
      render.push({
        channelId: manifest.id,
        renderId,
        hookId,
        handler,
        kind: "env-lines",
        agent: entry.agent,
        target: entry.target,
        lines,
        templateRefs: collectTemplateReferencesInLines(lines),
      } satisfies SandboxMessagingEnvLinesRenderPlan);
    }
  }
  return render;
}

function cloneHookReference(
  channelId: MessagingChannelId,
  hook: ChannelHookSpec,
): SandboxMessagingHookReferencePlan {
  return {
    channelId,
    id: hook.id,
    phase: hook.phase,
    handler: hook.handler,
    agents: hook.agents ? [...hook.agents] : undefined,
    inputs: hook.inputs ? [...hook.inputs] : undefined,
    outputs: hook.outputs?.map((output) => ({ ...output })),
    onFailure: hook.onFailure,
  };
}

function isHookForAgent(hook: ChannelHookSpec, agent: MessagingAgentId): boolean {
  return !hook.agents || hook.agents.includes(agent);
}

function assertSingleLineEnvRenderLines(
  channelId: string,
  renderId: string,
  lines: readonly string[],
): void {
  for (const line of lines) {
    if (/[\r\n]/.test(line)) {
      throw new Error(
        "Messaging env render '" +
          renderId +
          "' for " +
          channelId +
          " must not contain line breaks.",
      );
    }
  }
}

function clonePlan(plan: SandboxMessagingPlan): SandboxMessagingPlan {
  return JSON.parse(JSON.stringify(plan)) as SandboxMessagingPlan;
}
