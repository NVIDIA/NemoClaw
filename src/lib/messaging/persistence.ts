// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInChannelManifestRegistry } from "./channels/built-ins";
import { createBuiltInRenderTemplateResolver } from "./channels/template-resolver";
import { planCredentialBindings } from "./compiler/engines/credential-binding-engine";
import { planHostForward } from "./compiler/engines/host-forward-engine";
import type { ManifestCompilerContext } from "./compiler/types";
import type {
  ChannelHookSpec,
  ChannelInputSpec,
  ChannelManifest,
  MessagingAgentId,
  MessagingChannelId,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingBuildStepPlan,
  SandboxMessagingChannelPlan,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingHookReferencePlan,
  SandboxMessagingInputReference,
  SandboxMessagingPlan,
  SandboxMessagingRuntimeSetupPlan,
} from "./manifest";
import {
  hasFullPersistedCredentialBindingShape,
  normalizeFullPersistedCredentialBindings,
  normalizePersistedAgentCredentialPlaceholders,
} from "./persisted-placeholders";

export type PersistedSandboxMessagingInputReference = Pick<
  SandboxMessagingInputReference,
  "inputId" | "value" | "credentialAvailable"
>;

export type PersistedSandboxMessagingChannelPlan = Pick<
  SandboxMessagingChannelPlan,
  "channelId" | "configured" | "disabled" | "pendingRemoval"
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
    networkPolicy: _networkPolicy,
    agentRender: _agentRender,
    buildSteps: _buildSteps,
    runtimeSetup: _runtimeSetup,
    stateUpdates: _stateUpdates,
    healthChecks: _healthChecks,
    ...rest
  } = clonePlan(plan);
  return {
    ...rest,
    channels: channels.map((channel) => ({
      channelId: channel.channelId,
      active: channel.active,
      configured: channel.configured,
      disabled: channel.disabled,
      ...(channel.pendingRemoval === true ? { pendingRemoval: true } : {}),
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

export function normalizePersistedSandboxMessagingPlanShape(
  plan: MaybeCompactMessagingPlan,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SandboxMessagingPlan {
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const disabledChannels = plan.disabledChannels.filter(
    (channelId) => typeof channelId === "string",
  );
  const disabledSet = new Set(disabledChannels);
  const channels = plan.channels.map((channel) =>
    normalizePersistedChannel(
      channel,
      disabledSet,
      manifestRegistry.get(channel.channelId),
      environment,
    ),
  );
  const credentialBindings = normalizePersistedCredentialBindings(
    plan,
    channels,
    manifestRegistry,
    environment,
  );
  const normalizedPlan: SandboxMessagingPlan = {
    ...plan,
    channels,
    disabledChannels,
    credentialBindings,
    networkPolicy:
      plan.networkPolicy && Array.isArray(plan.networkPolicy.entries)
        ? plan.networkPolicy
        : { presets: [], entries: [] },
    agentRender: normalizePersistedAgentCredentialPlaceholders(
      Array.isArray(plan.agentRender) ? [...plan.agentRender] : [],
      credentialBindings,
    ),
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
  environment: Readonly<Record<string, string | undefined>>,
): SandboxMessagingChannelPlan {
  const disabled = channel.disabled ?? disabledSet.has(channel.channelId);
  const configured = channel.configured ?? true;
  const hasFullShape = hasFullChannelShape(channel);
  const inputs = hasFullShape
    ? normalizeFullInputs(channel.channelId, channel.inputs ?? [])
    : normalizePersistedInputs(channel, manifest);
  const active =
    channel.active ?? (configured && !disabled && requiredInputsAvailable(manifest, inputs));
  const hostForward = manifest
    ? planHostForward(
        manifest,
        inputs,
        active && !disabled,
        createBuiltInRenderTemplateResolver(),
        environment,
      )
    : undefined;

  return {
    channelId: channel.channelId,
    displayName: channel.displayName ?? manifest?.displayName ?? channel.channelId,
    authMode: channel.authMode ?? manifest?.auth.mode ?? "none",
    active,
    selected: channel.selected ?? configured,
    configured,
    disabled,
    ...(channel.pendingRemoval === true ? { pendingRemoval: true } : {}),
    inputs,
    ...(hostForward ? { hostForward } : {}),
    hooks: Array.isArray(channel.hooks) ? [...channel.hooks] : [],
  };
}

export function normalizePersistedInputs(
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

export function normalizeFullInputs(
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
  environment: Readonly<Record<string, string | undefined>>,
): SandboxMessagingCredentialBindingPlan[] {
  const persisted = plan.credentialBindings ?? [];
  if (
    Array.isArray(plan.credentialBindings) &&
    plan.channels.every(hasFullChannelShape) &&
    persisted.every(hasFullPersistedCredentialBindingShape)
  ) {
    return normalizeFullPersistedCredentialBindings(persisted);
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
    environment,
  );
  return generated.map((binding) => overlayPersistedCredentialBinding(binding, persisted));
}

function credentialBindingsFromManifests(
  plan: SandboxMessagingPlan,
  manifests: readonly ChannelManifest[],
  inputRegistry: ReadonlyMap<string, readonly SandboxMessagingInputReference[]>,
  environment: Readonly<Record<string, string | undefined>>,
): SandboxMessagingCredentialBindingPlan[] {
  const context = compilerContext(plan);
  return manifests.flatMap((manifest) =>
    planCredentialBindings(
      manifest,
      context,
      inputRegistry.get(manifest.id) ?? [],
      environment,
    ).map((binding) => overlayPersistedCredentialBinding(binding, plan.credentialBindings)),
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

export function hasFullChannelShape(
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

function normalizeRuntimeSetup(
  setup: SandboxMessagingRuntimeSetupPlan | undefined,
): SandboxMessagingRuntimeSetupPlan {
  return {
    nodePreloads: Array.isArray(setup?.nodePreloads) ? [...setup.nodePreloads] : [],
    envAliases: Array.isArray(setup?.envAliases) ? [...setup.envAliases] : [],
    secretScans: Array.isArray(setup?.secretScans) ? [...setup.secretScans] : [],
  };
}

export function compilerContext(plan: SandboxMessagingPlan): ManifestCompilerContext {
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
      availability[`${channel.channelId}.${input.inputId}`] = true;
      if (input.sourceEnv) availability[input.sourceEnv] = true;
    }
  }
  for (const credential of plan.credentialBindings) {
    if (!credential.credentialAvailable) continue;
    availability[credential.credentialId] = true;
    availability[`${credential.channelId}.${credential.credentialId}`] = true;
    availability[`${credential.channelId}.${credential.sourceInput}`] = true;
    availability[credential.providerEnvKey] = true;
  }
  return availability;
}

export function channelHooksFromManifest(
  agent: MessagingAgentId,
  channelId: MessagingChannelId,
  manifest: ChannelManifest | undefined,
): SandboxMessagingHookReferencePlan[] {
  if (!manifest) return [];
  return manifest.hooks
    .filter((hook) => isHookForAgent(hook, agent))
    .map((hook) => cloneHookReference(channelId, hook));
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

export function isHookForAgent(hook: ChannelHookSpec, agent: MessagingAgentId): boolean {
  return !hook.agents || hook.agents.includes(agent);
}

function clonePlan(plan: SandboxMessagingPlan): SandboxMessagingPlan {
  return JSON.parse(JSON.stringify(plan)) as SandboxMessagingPlan;
}
