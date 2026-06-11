// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInMessagingHookRegistry, runMessagingHook } from "../../hooks";
import { COMMON_STATIC_OUTPUTS_HOOK_HANDLER_ID } from "../../hooks/common/static-outputs";
import type {
  ChannelHookSpec,
  ChannelManifest,
  ChannelRenderSpec,
  MessagingSerializableValue,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingEnvLinesRenderPlan,
  SandboxMessagingInputReference,
  SandboxMessagingJsonRenderPlan,
} from "../../manifest";
import type { ManifestCompilerContext } from "../types";
import {
  collectTemplateReferencesInLines,
  collectTemplateReferencesInValue,
  isTruthyRenderTemplate,
  type RenderTemplateReferenceResolver,
  resolveCredentialTemplatesInLines,
  resolveCredentialTemplatesInValue,
  resolveRenderTemplatesInLines,
  resolveRenderTemplatesInValue,
} from "./template";

export async function planAgentRender(
  manifest: ChannelManifest,
  context: ManifestCompilerContext,
  inputs: readonly SandboxMessagingInputReference[] = [],
  hooks = createBuiltInMessagingHookRegistry(),
  referenceResolver?: RenderTemplateReferenceResolver,
): Promise<SandboxMessagingAgentRenderPlan[]> {
  const plans: SandboxMessagingAgentRenderPlan[] = [];
  const templateContext = { inputs, env: process.env, referenceResolver };

  for (const [index, render] of manifest.render.entries()) {
    if (render.agent !== context.agent) continue;
    if (!isTruthyRenderTemplate(render.when, templateContext)) continue;

    const hook = renderHookForManifestEntry(manifest.id, render, index);
    const result = await runMessagingHook(hook, hooks, { channelId: manifest.id });
    const hookOutput = result.outputs.render?.value;
    if (!isChannelRenderSpec(hookOutput)) {
      throw new Error(`Messaging render hook '${hook.id}' did not return a render spec.`);
    }

    if (hookOutput.kind === "json-fragment") {
      const credentialResolved = resolveCredentialTemplatesInValue(
        hookOutput.fragment.value,
        manifest.credentials,
      );
      const value = resolveRenderTemplatesInValue(credentialResolved, templateContext);
      if (value === undefined) continue;
      plans.push({
        channelId: manifest.id,
        renderId: hookOutput.id,
        hookId: result.hookId,
        handler: result.handlerId,
        kind: "json-fragment",
        agent: hookOutput.agent,
        target: hookOutput.target,
        path: hookOutput.fragment.path,
        value,
        templateRefs: collectTemplateReferencesInValue(value),
      } satisfies SandboxMessagingJsonRenderPlan);
      continue;
    }

    const credentialResolved = resolveCredentialTemplatesInLines(
      hookOutput.lines,
      manifest.credentials,
    );
    const lines = resolveRenderTemplatesInLines(credentialResolved, templateContext);
    if (lines.length === 0) continue;
    assertSingleLineEnvRenderLines(manifest.id, hookOutput.id ?? result.hookId, lines);
    plans.push({
      channelId: manifest.id,
      renderId: hookOutput.id,
      hookId: result.hookId,
      handler: result.handlerId,
      kind: "env-lines",
      agent: hookOutput.agent,
      target: hookOutput.target,
      lines,
      templateRefs: collectTemplateReferencesInLines(lines),
    } satisfies SandboxMessagingEnvLinesRenderPlan);
  }

  return plans;
}

function renderHookForManifestEntry(
  channelId: string,
  render: ChannelRenderSpec,
  index: number,
): ChannelHookSpec {
  return {
    id: render.id ?? `${channelId}-render-${index}`,
    phase: "render",
    handler: COMMON_STATIC_OUTPUTS_HOOK_HANDLER_ID,
    agents: [render.agent],
    outputs: [
      {
        id: "render",
        kind: "agent-render",
        required: true,
        value: render as unknown as MessagingSerializableValue,
      },
    ],
  };
}

function isChannelRenderSpec(value: unknown): value is ChannelRenderSpec {
  if (!isObject(value)) return false;
  if (value.kind !== "json-fragment" && value.kind !== "env-lines") return false;
  if (typeof value.agent !== "string" || typeof value.target !== "string") return false;
  if (value.kind === "json-fragment") {
    return isObject(value.fragment) && typeof value.fragment.path === "string";
  }
  return Array.isArray(value.lines) && value.lines.every((line) => typeof line === "string");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
