// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInChannelManifestRegistry } from "./channels/built-ins";
import { createBuiltInRenderTemplateResolver } from "./channels/template-resolver";
import { planHealthChecks } from "./compiler/engines/health-check-engine";
import { planHostForward } from "./compiler/engines/host-forward-engine";
import { planNetworkPolicy } from "./compiler/engines/policy-resolver";
import { planRuntimeSetup } from "./compiler/engines/runtime-setup-engine";
import { planStateUpdates } from "./compiler/engines/state-update-engine";
import {
  collectTemplateReferencesInLines,
  collectTemplateReferencesInValue,
  isTruthyRenderTemplate,
  resolveCredentialTemplatesInLines,
  resolveCredentialTemplatesInValue,
  resolveRenderTemplatesInLines,
  resolveRenderTemplatesInValue,
} from "./compiler/engines/template";
import type { MessagingHookInputMap, MessagingHookOutputMap } from "./hooks";
import { BUILT_IN_MESSAGING_HOOK_REGISTRY, runMessagingHookSync } from "./hooks";
import type {
  ChannelHookSpec,
  ChannelManifest,
  MessagingAgentId,
  MessagingSerializableValue,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingBuildStepPlan,
  SandboxMessagingChannelPlan,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingEnvLinesRenderPlan,
  SandboxMessagingJsonRenderPlan,
  SandboxMessagingPlan,
  SandboxMessagingRuntimeSetupPlan,
} from "./manifest";
import {
  channelHooksFromManifest,
  compilerContext,
  hasFullChannelShape,
  isHookForAgent,
  normalizeFullInputs,
  normalizePersistedInputs,
} from "./persistence";

export interface SandboxMessagingHydrationOptions {
  /** Explicit environment seam for deterministic rehydration without ambient credentials. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export function hydrateDerivedSandboxMessagingPlanFields(
  plan: SandboxMessagingPlan,
  options: SandboxMessagingHydrationOptions = {},
): SandboxMessagingPlan {
  const environment = options.environment ?? process.env;
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const channels = plan.channels.map((channel) =>
    hydrateChannelFromManifest(plan, channel, manifestRegistry.get(channel.channelId), environment),
  );
  const hydratedPlan = { ...plan, channels };
  const manifests = channels.flatMap((channel) => {
    const manifest = manifestRegistry.get(channel.channelId);
    return manifest ? [manifest] : [];
  });
  return {
    ...hydratedPlan,
    networkPolicy: planNetworkPolicy(manifests, compilerContext(hydratedPlan)),
    agentRender:
      plan.agentRender.length > 0
        ? plan.agentRender
        : agentRenderFromManifests(hydratedPlan, manifestRegistry, environment),
    buildSteps:
      plan.buildSteps.length > 0
        ? plan.buildSteps
        : buildStepsFromManifests(hydratedPlan, manifests),
    runtimeSetup: runtimeSetupHasEntries(plan.runtimeSetup)
      ? plan.runtimeSetup
      : planRuntimeSetup(manifests, plan.agent, channels),
    stateUpdates:
      plan.stateUpdates.length > 0 ? plan.stateUpdates : manifests.flatMap(planStateUpdates),
    healthChecks:
      plan.healthChecks.length > 0 ? plan.healthChecks : manifests.flatMap(planHealthChecks),
  };
}

function hydrateChannelFromManifest(
  plan: SandboxMessagingPlan,
  channel: SandboxMessagingChannelPlan,
  manifest: ChannelManifest | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): SandboxMessagingChannelPlan {
  const { hostForward: _oldHostForward, ...channelWithoutHostForward } = channel;
  const disabled = channel.disabled || plan.disabledChannels.includes(channel.channelId);
  const inputs = hasFullChannelShape(channel)
    ? normalizeFullInputs(channel.channelId, channel.inputs)
    : normalizePersistedInputs(channel, manifest);
  const configured = channel.configured;
  const active = channel.active && !disabled;
  const hostForward = manifest
    ? planHostForward(manifest, inputs, active, createBuiltInRenderTemplateResolver(), environment)
    : undefined;
  return {
    ...channelWithoutHostForward,
    displayName: channel.displayName ?? manifest?.displayName ?? channel.channelId,
    authMode: channel.authMode ?? manifest?.auth.mode ?? "none",
    configured,
    disabled,
    active: channel.active,
    inputs,
    ...(hostForward ? { hostForward } : {}),
    hooks:
      channel.hooks.length > 0
        ? channel.hooks
        : channelHooksFromManifest(plan.agent, channel.channelId, manifest),
  };
}

function buildStepsFromManifests(
  plan: SandboxMessagingPlan,
  manifests: readonly ChannelManifest[],
): SandboxMessagingBuildStepPlan[] {
  const channelById = new Map(plan.channels.map((channel) => [channel.channelId, channel]));
  return manifests.flatMap((manifest) => {
    const channel = channelById.get(manifest.id);
    const active = channel?.active === true && channel.disabled !== true;
    return [
      ...packageInstallBuildSteps(plan.agent, manifest, active),
      ...hookBuildSteps(plan, manifest, channel, active),
    ];
  });
}

function packageInstallBuildSteps(
  agent: MessagingAgentId,
  manifest: ChannelManifest,
  active: boolean,
): SandboxMessagingBuildStepPlan[] {
  return (manifest.agentPackages ?? [])
    .filter((agentPackage) => agentPackage.agent === agent)
    .map((agentPackage) => ({
      channelId: manifest.id,
      kind: "package-install" as const,
      outputId: agentPackage.id,
      required: agentPackage.required !== false,
      ...(active
        ? {
            value: {
              manager: agentPackage.manager,
              spec: agentPackage.spec,
              ...(typeof agentPackage.pin === "boolean" ? { pin: agentPackage.pin } : {}),
            },
          }
        : {}),
    }));
}

function hookBuildSteps(
  plan: SandboxMessagingPlan,
  manifest: ChannelManifest,
  channel: SandboxMessagingChannelPlan | undefined,
  active: boolean,
): SandboxMessagingBuildStepPlan[] {
  return manifest.hooks
    .filter((hook) => isHookForAgent(hook, plan.agent))
    .flatMap((hook) => {
      const outputs = (hook.outputs ?? []).filter((output) =>
        ["build-arg", "build-file", "package-install"].includes(output.kind),
      );
      if (outputs.length === 0) return [];
      const hookOutputs = active && channel ? buildHookOutputs(plan, manifest, hook, channel) : {};
      return outputs.map((output) => ({
        channelId: manifest.id,
        kind: output.kind as "build-arg" | "build-file" | "package-install",
        hookId: hook.id,
        handler: hook.handler,
        outputId: output.id,
        required: output.required === true,
        ...(hookOutputs[output.id]?.value !== undefined
          ? { value: hookOutputs[output.id]?.value }
          : output.value !== undefined && active
            ? { value: output.value }
            : {}),
      }));
    });
}

function buildHookOutputs(
  plan: SandboxMessagingPlan,
  manifest: ChannelManifest,
  hook: ChannelHookSpec,
  channel: SandboxMessagingChannelPlan,
): MessagingHookOutputMap {
  return runMessagingHookSync(hook, BUILT_IN_MESSAGING_HOOK_REGISTRY, {
    channelId: manifest.id,
    inputs: selectHookInputs(buildHookInputMap(channel, plan.credentialBindings), hook.inputs),
  }).outputs;
}

function buildHookInputMap(
  channel: SandboxMessagingChannelPlan,
  credentialBindings: readonly SandboxMessagingCredentialBindingPlan[],
): MessagingHookInputMap {
  const inputs: Record<string, MessagingSerializableValue> = {};
  for (const input of channel.inputs) {
    if (input.value === undefined) continue;
    inputs[input.inputId] = input.value;
    if (input.statePath) inputs[input.statePath] = input.value;
  }
  for (const credential of credentialBindings) {
    if (credential.channelId !== channel.channelId) continue;
    inputs[`credential.${credential.credentialId}.placeholder`] = credential.placeholder;
  }
  return inputs;
}

function selectHookInputs(
  inputs: MessagingHookInputMap,
  inputKeys: readonly string[] | undefined,
): MessagingHookInputMap {
  if (!inputKeys || inputKeys.length === 0) return inputs;
  return Object.fromEntries(
    inputKeys
      .filter((inputKey) => Object.hasOwn(inputs, inputKey))
      .map((inputKey) => [inputKey, inputs[inputKey]]),
  );
}

function runtimeSetupHasEntries(setup: SandboxMessagingRuntimeSetupPlan | undefined): boolean {
  return Boolean(
    setup &&
    (setup.nodePreloads.length > 0 || setup.envAliases.length > 0 || setup.secretScans.length > 0),
  );
}

function agentRenderFromManifests(
  plan: SandboxMessagingPlan,
  manifestRegistry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
  environment: Readonly<Record<string, string | undefined>>,
): SandboxMessagingAgentRenderPlan[] {
  const render: SandboxMessagingAgentRenderPlan[] = [];
  const referenceResolver = createBuiltInRenderTemplateResolver();
  for (const channel of plan.channels) {
    const manifest = manifestRegistry.get(channel.channelId);
    if (!manifest) continue;
    const context = {
      inputs: channel.inputs,
      env: environment,
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
