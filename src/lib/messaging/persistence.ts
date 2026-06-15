// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "./channels";
import { buildWechatSeedOpenClawAccountOutputs } from "./channels/wechat/hooks/seed-openclaw-account";
import { planCredentialBindings } from "./compiler/engines/credential-binding-engine";
import { planHealthChecks } from "./compiler/engines/health-check-engine";
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
import type { ManifestCompilerContext } from "./compiler/types";
import type {
  ChannelHookSpec,
  ChannelInputSpec,
  ChannelManifest,
  MessagingAgentId,
  MessagingChannelId,
  MessagingSerializableValue,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingBuildStepPlan,
  SandboxMessagingChannelPlan,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingEnvLinesRenderPlan,
  SandboxMessagingHookReferencePlan,
  SandboxMessagingInputReference,
  SandboxMessagingJsonRenderPlan,
  SandboxMessagingPlan,
  SandboxMessagingRuntimeSetupPlan,
} from "./manifest";
import type { MessagingHookInputMap, MessagingHookOutputMap } from "./hooks";

export type PersistedSandboxMessagingInputReference = Pick<
  SandboxMessagingInputReference,
  "inputId" | "value" | "credentialAvailable"
>;

export type PersistedSandboxMessagingChannelPlan = Pick<
  SandboxMessagingChannelPlan,
  "channelId" | "configured" | "disabled"
> & {
  readonly inputs?: readonly PersistedSandboxMessagingInputReference[];
} & Partial<
    Pick<SandboxMessagingChannelPlan, "displayName" | "authMode" | "active" | "selected">
  > & {
    readonly hooks?: readonly SandboxMessagingHookReferencePlan[];
  };

export type PersistedSandboxMessagingCredentialBindingPlan = Pick<
  SandboxMessagingCredentialBindingPlan,
  "channelId" | "providerEnvKey" | "credentialAvailable" | "credentialHash"
> &
  Partial<
    Pick<
      SandboxMessagingCredentialBindingPlan,
      "credentialId" | "sourceInput" | "providerName" | "placeholder"
    >
  >;

export type PersistedSandboxMessagingPlan = Omit<
  SandboxMessagingPlan,
  | "channels"
  | "credentialBindings"
  | "networkPolicy"
  | "agentRender"
  | "buildSteps"
  | "runtimeSetup"
  | "stateUpdates"
  | "healthChecks"
> & {
  readonly channels: readonly PersistedSandboxMessagingChannelPlan[];
  readonly credentialBindings?: readonly PersistedSandboxMessagingCredentialBindingPlan[];
  readonly networkPolicy?: SandboxMessagingPlan["networkPolicy"];
  readonly agentRender?: readonly SandboxMessagingAgentRenderPlan[];
  readonly buildSteps?: readonly SandboxMessagingBuildStepPlan[];
  readonly runtimeSetup?: SandboxMessagingRuntimeSetupPlan;
  readonly stateUpdates?: SandboxMessagingPlan["stateUpdates"];
  readonly healthChecks?: SandboxMessagingPlan["healthChecks"];
};

export function compactSandboxMessagingPlanForPersistence(
  plan: SandboxMessagingPlan,
): PersistedSandboxMessagingPlan {
  const {
    channels,
    credentialBindings,
    networkPolicy,
    agentRender: _agentRender,
    buildSteps: _buildSteps,
    runtimeSetup: _runtimeSetup,
    stateUpdates: _stateUpdates,
    healthChecks: _healthChecks,
    ...rest
  } = clonePlan(plan);
  return {
    ...rest,
    networkPolicy,
    channels: channels.map((channel) => ({
      channelId: channel.channelId,
      active: channel.active,
      configured: channel.configured,
      disabled: channel.disabled,
      inputs: channel.inputs
        .flatMap((input) => {
          const compact: PersistedSandboxMessagingInputReference = {
            inputId: input.inputId,
            ...(input.value !== undefined ? { value: input.value } : {}),
            ...(input.credentialAvailable !== undefined
              ? { credentialAvailable: input.credentialAvailable }
              : {}),
          };
          return compact.value !== undefined || compact.credentialAvailable !== undefined
            ? [compact]
            : [];
        })
        .sort((left, right) => left.inputId.localeCompare(right.inputId)),
    })),
    credentialBindings: credentialBindings
      .map((binding) => ({
        channelId: binding.channelId,
        providerEnvKey: binding.providerEnvKey,
        credentialAvailable: binding.credentialAvailable,
        ...(binding.credentialHash ? { credentialHash: binding.credentialHash } : {}),
      }))
      .sort((left, right) =>
        `${left.channelId}:${left.providerEnvKey}`.localeCompare(
          `${right.channelId}:${right.providerEnvKey}`,
        ),
      ),
  };
}

export function hydrateDerivedSandboxMessagingPlanFields(
  plan: SandboxMessagingPlan,
): SandboxMessagingPlan {
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const channels = plan.channels.map((channel) =>
    hydrateChannelFromManifest(plan, channel, manifestRegistry.get(channel.channelId)),
  );
  const hydratedPlan = { ...plan, channels };
  const manifests = channels.flatMap((channel) => {
    const manifest = manifestRegistry.get(channel.channelId);
    return manifest ? [manifest] : [];
  });
  const planWithCredentials = hydratedPlan;
  return {
    ...planWithCredentials,
    networkPolicy:
      plan.networkPolicy.entries.length > 0
        ? plan.networkPolicy
        : planNetworkPolicy(manifests, compilerContext(planWithCredentials)),
    agentRender:
      plan.agentRender.length > 0
        ? plan.agentRender
        : agentRenderFromManifests(planWithCredentials, manifestRegistry),
    buildSteps:
      plan.buildSteps.length > 0
        ? plan.buildSteps
        : buildStepsFromManifests(planWithCredentials, manifests),
    runtimeSetup: runtimeSetupHasEntries(plan.runtimeSetup)
      ? plan.runtimeSetup
      : planRuntimeSetup(manifests, plan.agent, channels),
    stateUpdates:
      plan.stateUpdates.length > 0 ? plan.stateUpdates : manifests.flatMap(planStateUpdates),
    healthChecks:
      plan.healthChecks.length > 0 ? plan.healthChecks : manifests.flatMap(planHealthChecks),
  };
}

export function normalizePersistedSandboxMessagingPlanShape(
  plan: MaybeCompactMessagingPlan,
): SandboxMessagingPlan {
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const disabledChannels = plan.disabledChannels.filter(
    (channelId) => typeof channelId === "string",
  );
  const disabledSet = new Set(disabledChannels);
  const channels = plan.channels.map((channel) =>
    normalizePersistedChannel(channel, disabledSet, manifestRegistry.get(channel.channelId)),
  );
  const normalizedPlan: SandboxMessagingPlan = {
    ...plan,
    channels,
    disabledChannels,
    credentialBindings: normalizePersistedCredentialBindings(plan, channels, manifestRegistry),
    networkPolicy:
      plan.networkPolicy && Array.isArray(plan.networkPolicy.entries)
        ? plan.networkPolicy
        : { presets: [], entries: [] },
    agentRender: Array.isArray(plan.agentRender) ? [...plan.agentRender] : [],
    buildSteps: Array.isArray(plan.buildSteps) ? [...plan.buildSteps] : [],
    ...(plan.runtimeSetup !== undefined
      ? { runtimeSetup: normalizeRuntimeSetup(plan.runtimeSetup) }
      : {}),
    stateUpdates: Array.isArray(plan.stateUpdates) ? [...plan.stateUpdates] : [],
    healthChecks: Array.isArray(plan.healthChecks) ? [...plan.healthChecks] : [],
  };

  return normalizedPlan;
}

export type MaybeCompactMessagingChannelPlan = Partial<SandboxMessagingChannelPlan> & {
  readonly channelId: string;
  readonly inputs?: readonly Partial<SandboxMessagingInputReference>[];
};

export type MaybeCompactMessagingPlan = Omit<
  Partial<SandboxMessagingPlan>,
  "channels" | "credentialBindings"
> &
  Pick<SandboxMessagingPlan, "schemaVersion" | "sandboxName" | "agent" | "workflow"> & {
    readonly channels: readonly MaybeCompactMessagingChannelPlan[];
    readonly disabledChannels: readonly string[];
    readonly credentialBindings?: readonly Partial<SandboxMessagingCredentialBindingPlan>[];
  };

function normalizePersistedChannel(
  channel: MaybeCompactMessagingChannelPlan,
  disabledSet: ReadonlySet<string>,
  manifest: ChannelManifest | undefined,
): SandboxMessagingChannelPlan {
  const disabled = channel.disabled ?? disabledSet.has(channel.channelId);
  const configured = channel.configured ?? true;
  const hasFullShape = hasFullChannelShape(channel);
  const inputs = hasFullShape
    ? normalizeFullInputs(channel.channelId, channel.inputs ?? [])
    : normalizePersistedInputs(channel, manifest);
  const active =
    channel.active ?? (configured && !disabled && requiredInputsAvailable(manifest, inputs));

  return {
    channelId: channel.channelId,
    displayName: channel.displayName ?? manifest?.displayName ?? channel.channelId,
    authMode: channel.authMode ?? manifest?.auth.mode ?? "none",
    active,
    selected: channel.selected ?? configured,
    configured,
    disabled,
    inputs,
    hooks: Array.isArray(channel.hooks) ? [...channel.hooks] : [],
  };
}

function normalizePersistedInputs(
  channel: MaybeCompactMessagingChannelPlan,
  manifest: ChannelManifest | undefined,
): SandboxMessagingInputReference[] {
  const persistedById = new Map(
    (channel.inputs ?? [])
      .filter((input) => typeof input.inputId === "string")
      .map((input) => [input.inputId as string, input] as const),
  );
  const fromManifest = (manifest?.inputs ?? []).map((input) =>
    inputReferenceFromManifest(channel.channelId, input, persistedById.get(input.id)),
  );
  const manifestInputIds = new Set((manifest?.inputs ?? []).map((input) => input.id));
  const unknownInputs = [...persistedById.values()].flatMap((input) => {
    if (!input.inputId || manifestInputIds.has(input.inputId)) return [];
    return [normalizeUnknownInput(channel.channelId, input)];
  });
  return [...fromManifest, ...unknownInputs];
}

function normalizeFullInputs(
  channelId: string,
  inputs: readonly Partial<SandboxMessagingInputReference>[],
): SandboxMessagingInputReference[] {
  return inputs
    .filter((input) => typeof input.inputId === "string")
    .map((input) => ({
      channelId: typeof input.channelId === "string" ? input.channelId : channelId,
      inputId: input.inputId as string,
      kind: input.kind === "secret" || input.kind === "config" ? input.kind : "config",
      required: typeof input.required === "boolean" ? input.required : false,
      ...(typeof input.sourceEnv === "string" ? { sourceEnv: input.sourceEnv } : {}),
      ...(typeof input.statePath === "string" ? { statePath: input.statePath } : {}),
      ...(input.credentialAvailable !== undefined
        ? { credentialAvailable: input.credentialAvailable }
        : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
    }));
}

function inputReferenceFromManifest(
  channelId: string,
  input: ChannelInputSpec,
  persisted: Partial<SandboxMessagingInputReference> | undefined,
): SandboxMessagingInputReference {
  return {
    channelId,
    inputId: input.id,
    kind: input.kind,
    required: input.required,
    ...(input.envKey ? { sourceEnv: input.envKey } : {}),
    ...(input.kind === "config" && input.statePath ? { statePath: input.statePath } : {}),
    ...(persisted?.credentialAvailable !== undefined
      ? { credentialAvailable: persisted.credentialAvailable }
      : {}),
    ...(persisted?.value !== undefined ? { value: persisted.value } : {}),
  };
}

function normalizeUnknownInput(
  channelId: string,
  input: Partial<SandboxMessagingInputReference>,
): SandboxMessagingInputReference {
  const kind = input.kind === "secret" || input.kind === "config" ? input.kind : "config";
  return {
    channelId,
    inputId: input.inputId as string,
    kind,
    required: input.required === true,
    ...(typeof input.sourceEnv === "string" ? { sourceEnv: input.sourceEnv } : {}),
    ...(typeof input.statePath === "string" ? { statePath: input.statePath } : {}),
    ...(input.credentialAvailable !== undefined
      ? { credentialAvailable: input.credentialAvailable }
      : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
  };
}

function requiredInputsAvailable(
  manifest: ChannelManifest | undefined,
  inputs: readonly SandboxMessagingInputReference[],
): boolean {
  if (!manifest) return true;
  return manifest.inputs.every((manifestInput) => {
    if (!manifestInput.required) return true;
    const input = inputs.find((entry) => entry.inputId === manifestInput.id);
    if (!input) return false;
    if (input.kind === "secret") return input.credentialAvailable === true;
    if (input.value === undefined) return false;
    return typeof input.value === "string" ? input.value.trim().length > 0 : true;
  });
}

function normalizePersistedCredentialBindings(
  plan: MaybeCompactMessagingPlan,
  channels: readonly SandboxMessagingChannelPlan[],
  manifestRegistry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
): SandboxMessagingCredentialBindingPlan[] {
  const persisted = plan.credentialBindings ?? [];
  if (
    Array.isArray(plan.credentialBindings) &&
    plan.channels.every(hasFullChannelShape) &&
    persisted.every(hasFullCredentialBindingShape)
  ) {
    return persisted.map((binding) => ({
      channelId: binding.channelId as string,
      credentialId: binding.credentialId as string,
      sourceInput: binding.sourceInput as string,
      providerName: binding.providerName as string,
      providerEnvKey: binding.providerEnvKey as string,
      placeholder: binding.placeholder as string,
      credentialAvailable: binding.credentialAvailable === true,
      ...(typeof binding.credentialHash === "string"
        ? { credentialHash: binding.credentialHash }
        : {}),
    }));
  }

  const manifests = channels.flatMap((channel) => {
    const manifest = manifestRegistry.get(channel.channelId);
    return manifest ? [manifest] : [];
  });
  const planForBindings: SandboxMessagingPlan = {
    ...plan,
    channels,
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
    stateUpdates: [],
    healthChecks: [],
  };
  const generated = credentialBindingsFromManifests(
    planForBindings,
    manifests,
    new Map(channels.map((channel) => [channel.channelId, channel.inputs] as const)),
  );
  return generated.map((binding) => overlayPersistedCredentialBinding(binding, persisted));
}

function hydrateChannelFromManifest(
  plan: SandboxMessagingPlan,
  channel: SandboxMessagingChannelPlan,
  manifest: ChannelManifest | undefined,
): SandboxMessagingChannelPlan {
  const disabled = channel.disabled || plan.disabledChannels.includes(channel.channelId);
  const inputs = hasFullChannelShape(channel)
    ? normalizeFullInputs(channel.channelId, channel.inputs)
    : normalizePersistedInputs(channel, manifest);
  const configured = channel.configured;
  return {
    ...channel,
    displayName: channel.displayName ?? manifest?.displayName ?? channel.channelId,
    authMode: channel.authMode ?? manifest?.auth.mode ?? "none",
    configured,
    disabled,
    active: channel.active,
    inputs,
    hooks:
      channel.hooks.length > 0
        ? channel.hooks
        : channelHooksFromManifest(plan.agent, channel.channelId, manifest),
  };
}

function credentialBindingsFromManifests(
  plan: SandboxMessagingPlan,
  manifests: readonly ChannelManifest[],
  inputRegistry: ReadonlyMap<string, readonly SandboxMessagingInputReference[]>,
): SandboxMessagingCredentialBindingPlan[] {
  const context = compilerContext(plan);
  return manifests.flatMap((manifest) =>
    planCredentialBindings(manifest, context, inputRegistry.get(manifest.id) ?? []).map((binding) =>
      overlayPersistedCredentialBinding(binding, plan.credentialBindings),
    ),
  );
}

function overlayPersistedCredentialBinding(
  binding: SandboxMessagingCredentialBindingPlan,
  persisted: readonly Partial<SandboxMessagingCredentialBindingPlan>[],
): SandboxMessagingCredentialBindingPlan {
  const match = persisted.find((candidate) => credentialBindingMatches(binding, candidate));
  if (!match) return binding;
  return {
    ...binding,
    credentialAvailable:
      typeof match.credentialAvailable === "boolean"
        ? match.credentialAvailable
        : binding.credentialAvailable,
    ...(typeof match.credentialHash === "string" && match.credentialHash.length > 0
      ? { credentialHash: match.credentialHash }
      : binding.credentialHash
        ? { credentialHash: binding.credentialHash }
        : {}),
  };
}

function credentialBindingMatches(
  binding: SandboxMessagingCredentialBindingPlan,
  candidate: Partial<SandboxMessagingCredentialBindingPlan>,
): boolean {
  if (candidate.channelId && candidate.channelId !== binding.channelId) return false;
  if (candidate.providerEnvKey && candidate.providerEnvKey === binding.providerEnvKey) return true;
  if (candidate.credentialId && candidate.credentialId === binding.credentialId) return true;
  if (candidate.sourceInput && candidate.sourceInput === binding.sourceInput) return true;
  return false;
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
      const hookOutputs =
        active && channel ? buildKnownHookOutputs(plan, manifest, hook, channel) : {};
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

function buildKnownHookOutputs(
  plan: SandboxMessagingPlan,
  _manifest: ChannelManifest,
  hook: ChannelHookSpec,
  channel: SandboxMessagingChannelPlan,
): MessagingHookOutputMap {
  if (hook.handler === "wechat.seedOpenClawAccount") {
    try {
      return buildWechatSeedOpenClawAccountOutputs(
        selectHookInputs(buildHookInputMap(channel, plan.credentialBindings), hook.inputs),
      );
    } catch {
      return {};
    }
  }
  return {};
}

function hasFullChannelShape(
  channel: MaybeCompactMessagingChannelPlan,
): channel is MaybeCompactMessagingChannelPlan & SandboxMessagingChannelPlan {
  return (
    typeof channel.displayName === "string" &&
    typeof channel.authMode === "string" &&
    typeof channel.active === "boolean" &&
    typeof channel.selected === "boolean" &&
    typeof channel.configured === "boolean" &&
    typeof channel.disabled === "boolean" &&
    Array.isArray(channel.inputs)
  );
}

function hasFullCredentialBindingShape(
  binding: Partial<SandboxMessagingCredentialBindingPlan>,
): binding is SandboxMessagingCredentialBindingPlan {
  return (
    typeof binding.channelId === "string" &&
    typeof binding.credentialId === "string" &&
    typeof binding.sourceInput === "string" &&
    typeof binding.providerName === "string" &&
    typeof binding.providerEnvKey === "string" &&
    typeof binding.placeholder === "string" &&
    typeof binding.credentialAvailable === "boolean"
  );
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
      (setup.nodePreloads.length > 0 ||
        setup.envAliases.length > 0 ||
        setup.secretScans.length > 0),
  );
}

function normalizeRuntimeSetup(
  setup: SandboxMessagingRuntimeSetupPlan | undefined,
): SandboxMessagingRuntimeSetupPlan {
  return {
    nodePreloads: Array.isArray(setup?.nodePreloads) ? [...setup.nodePreloads] : [],
    envAliases: Array.isArray(setup?.envAliases) ? [...setup.envAliases] : [],
    secretScans: Array.isArray(setup?.secretScans) ? [...setup.secretScans] : [],
  };
}

function compilerContext(plan: SandboxMessagingPlan): ManifestCompilerContext {
  return {
    sandboxName: plan.sandboxName,
    agent: plan.agent,
    workflow: plan.workflow,
    isInteractive: false,
    configuredChannels: plan.channels.map((channel) => channel.channelId),
    disabledChannels: plan.disabledChannels,
    credentialAvailability: credentialAvailabilityFromPlan(plan),
  };
}

function credentialAvailabilityFromPlan(plan: SandboxMessagingPlan): Record<string, boolean> {
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
  return availability;
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
