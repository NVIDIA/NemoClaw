// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  collectTemplateReferencesInLines,
  collectTemplateReferencesInValue,
  resolveCredentialTemplatesInLines,
  resolveCredentialTemplatesInValue,
  resolveSandboxNameTemplate,
} from "../compiler/engines/template";
import type {
  ChannelCredentialSpec,
  ChannelHookOutputSpec,
  ChannelHookSpec,
  ChannelManifest,
  ChannelPolicyPresetReference,
  ChannelPolicyPresetSpec,
  MessagingAgentId,
  MessagingChannelId,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingBuildStepPlan,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingHealthCheckPlan,
  SandboxMessagingHookReferencePlan,
  SandboxMessagingNetworkPolicyEntryPlan,
  SandboxMessagingPlan,
  SandboxMessagingStateUpdatePlan,
} from "../manifest";
import { fail, jsonEqual, optionalStringArraysEqual, stringArraysEqual } from "./assertions";
import type { PlanManifestMap } from "./types";

export function credentialBindingMatches(
  plan: SandboxMessagingPlan,
  binding: SandboxMessagingCredentialBindingPlan,
  credential: ChannelCredentialSpec,
): boolean {
  return (
    binding.credentialId === credential.id &&
    binding.sourceInput === credential.sourceInput &&
    binding.providerName ===
      resolveSandboxNameTemplate(credential.providerName, plan.sandboxName) &&
    binding.providerEnvKey === credential.providerEnvKey &&
    binding.placeholder === credential.placeholder
  );
}

export function policyEntriesForManifest(
  manifest: ChannelManifest,
  agent: MessagingAgentId,
): SandboxMessagingNetworkPolicyEntryPlan[] {
  return (manifest.policyPresets ?? []).map((preset) => {
    const policy = normalizePolicyPreset(preset);
    const agentPolicyKeys = policy.agentPolicyKeys?.[agent];
    if (agentPolicyKeys) {
      return {
        channelId: manifest.id,
        presetName: policy.name,
        policyKeys: agentPolicyKeys,
        source: "agent-alias",
      };
    }
    return {
      channelId: manifest.id,
      presetName: policy.name,
      policyKeys: policy.policyKeys ?? [policy.name],
      source: "manifest",
    };
  });
}

export function renderEntriesForManifest(
  manifest: ChannelManifest,
  agent: MessagingAgentId,
): SandboxMessagingAgentRenderPlan[] {
  return manifest.render
    .filter((render) => render.agent === agent)
    .map((render) => {
      if (render.kind === "json-fragment") {
        const value = resolveCredentialTemplatesInValue(
          render.fragment.value,
          manifest.credentials,
        );
        return {
          channelId: manifest.id,
          renderId: render.id,
          kind: "json-fragment",
          agent: render.agent,
          target: render.target,
          path: render.fragment.path,
          value,
          templateRefs: collectTemplateReferencesInValue(value),
        };
      }
      const lines = resolveCredentialTemplatesInLines(render.lines, manifest.credentials);
      return {
        channelId: manifest.id,
        renderId: render.id,
        kind: "env-lines",
        agent: render.agent,
        target: render.target,
        lines,
        templateRefs: collectTemplateReferencesInLines(lines),
      };
    });
}

export function buildStepsForManifest(
  manifest: ChannelManifest,
  agent: MessagingAgentId,
): SandboxMessagingBuildStepPlan[] {
  return manifest.hooks.flatMap((hook) => {
    if (!isHookForAgent(hook, agent)) return [];
    return (hook.outputs ?? []).filter(isBuildStepOutput).map((output) => ({
      channelId: manifest.id,
      kind: output.kind,
      hookId: hook.id,
      handler: hook.handler,
      outputId: output.id,
      required: output.required === true,
    }));
  });
}

export function stateUpdatesForManifest(
  manifest: ChannelManifest,
): SandboxMessagingStateUpdatePlan[] {
  const persistUpdates = Object.entries(manifest.state.persist ?? {}).map(
    ([stateKey, inputIds]) => ({
      channelId: manifest.id,
      kind: "persist-inputs" as const,
      stateKey,
      inputIds,
    }),
  );
  const hydrationUpdates = (manifest.state.rebuildHydration ?? []).map((hydration) => ({
    channelId: manifest.id,
    kind: "rebuild-hydration" as const,
    statePath: hydration.statePath,
    env: hydration.env,
  }));
  return [...persistUpdates, ...hydrationUpdates];
}

export function healthCheckForManifest(manifest: ChannelManifest): SandboxMessagingHealthCheckPlan {
  return {
    channelId: manifest.id,
    phase: "health-check",
    requiredBefore: "lifecycle-success",
    hookIds: manifest.hooks.filter((hook) => hook.phase === "health-check").map((hook) => hook.id),
  };
}

export function normalizePolicyPreset(
  preset: ChannelPolicyPresetReference,
): ChannelPolicyPresetSpec {
  return typeof preset === "string" ? { name: preset } : preset;
}

export function requirePlanManifest(
  manifests: PlanManifestMap,
  channelId: MessagingChannelId,
  path: string,
): ChannelManifest {
  const manifest = manifests.get(channelId);
  if (!manifest) fail(path, "entry channel is not in plan channels");
  return manifest;
}

export function isHookForAgent(hook: ChannelHookSpec, agent: MessagingAgentId): boolean {
  return !hook.agents || hook.agents.includes(agent);
}

export function hooksEqual(
  planHook: SandboxMessagingHookReferencePlan,
  manifestHook: ChannelHookSpec,
): boolean {
  return (
    planHook.id === manifestHook.id &&
    planHook.phase === manifestHook.phase &&
    planHook.handler === manifestHook.handler &&
    optionalStringArraysEqual(planHook.agents, manifestHook.agents) &&
    optionalStringArraysEqual(planHook.inputs, manifestHook.inputs) &&
    hookOutputsEqual(planHook.outputs, manifestHook.outputs) &&
    planHook.onFailure === manifestHook.onFailure
  );
}

export function networkPolicyEntryMatches(
  entry: SandboxMessagingNetworkPolicyEntryPlan,
  expected: SandboxMessagingNetworkPolicyEntryPlan,
): boolean {
  return (
    entry.channelId === expected.channelId &&
    entry.presetName === expected.presetName &&
    entry.source === expected.source &&
    stringArraysEqual(entry.policyKeys, expected.policyKeys)
  );
}

export function renderEntryMatches(
  render: SandboxMessagingAgentRenderPlan,
  expected: SandboxMessagingAgentRenderPlan,
): boolean {
  if (
    render.channelId !== expected.channelId ||
    render.renderId !== expected.renderId ||
    render.kind !== expected.kind ||
    render.agent !== expected.agent ||
    render.target !== expected.target
  ) {
    return false;
  }
  if (render.kind === "json-fragment" && expected.kind === "json-fragment") {
    return (
      render.path === expected.path &&
      jsonEqual(render.value, expected.value) &&
      stringArraysEqual(render.templateRefs, expected.templateRefs)
    );
  }
  if (render.kind === "env-lines" && expected.kind === "env-lines") {
    return (
      stringArraysEqual(render.lines, expected.lines) &&
      stringArraysEqual(render.templateRefs, expected.templateRefs)
    );
  }
  return false;
}

export function buildStepMatches(
  step: SandboxMessagingBuildStepPlan,
  expected: SandboxMessagingBuildStepPlan,
): boolean {
  return (
    step.channelId === expected.channelId &&
    step.kind === expected.kind &&
    step.hookId === expected.hookId &&
    step.handler === expected.handler &&
    step.outputId === expected.outputId &&
    step.required === expected.required
  );
}

export function stateUpdateMatches(
  update: SandboxMessagingStateUpdatePlan,
  expected: SandboxMessagingStateUpdatePlan,
): boolean {
  if (update.channelId !== expected.channelId || update.kind !== expected.kind) return false;
  if (update.kind === "persist-inputs" && expected.kind === "persist-inputs") {
    return (
      update.stateKey === expected.stateKey && stringArraysEqual(update.inputIds, expected.inputIds)
    );
  }
  if (update.kind === "rebuild-hydration" && expected.kind === "rebuild-hydration") {
    return update.statePath === expected.statePath && update.env === expected.env;
  }
  return false;
}

export function healthCheckMatches(
  check: SandboxMessagingHealthCheckPlan,
  expected: SandboxMessagingHealthCheckPlan,
): boolean {
  return (
    check.channelId === expected.channelId &&
    check.phase === expected.phase &&
    check.requiredBefore === expected.requiredBefore &&
    stringArraysEqual(check.hookIds, expected.hookIds)
  );
}

function hookOutputsEqual(
  left: SandboxMessagingHookReferencePlan["outputs"],
  right: ChannelHookSpec["outputs"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  return left.every((output, index) => {
    const expected = right[index];
    return (
      expected !== undefined &&
      output.id === expected.id &&
      output.kind === expected.kind &&
      output.required === expected.required
    );
  });
}

function isBuildStepOutput(
  output: ChannelHookOutputSpec,
): output is ChannelHookOutputSpec & { readonly kind: "build-arg" | "build-file" } {
  return output.kind === "build-arg" || output.kind === "build-file";
}
