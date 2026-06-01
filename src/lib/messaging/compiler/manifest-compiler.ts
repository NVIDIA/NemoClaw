// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelHookSpec,
  ChannelInputSpec,
  ChannelManifest,
  ChannelManifestRegistry,
  MessagingChannelId,
  MessagingStatePath,
  MessagingSerializableValue,
  SandboxMessagingChannelPlan,
  SandboxMessagingHookReferencePlan,
  SandboxMessagingInputReference,
  SandboxMessagingPlan,
} from "../manifest";
import { MessagingHookRegistry, runMessagingHook } from "../hooks";
import type {
  MessagingHookInputMap,
  MessagingHookOutputMap,
  MessagingHookRunResult,
} from "../hooks";
import { planAgentRender } from "./engines/agent-render-engine";
import { planBuildSteps } from "./engines/build-step-engine";
import { planCredentialBindings } from "./engines/credential-binding-engine";
import { planHealthChecks } from "./engines/health-check-engine";
import { planNetworkPolicy } from "./engines/policy-resolver";
import { planStateUpdates } from "./engines/state-update-engine";
import type { ManifestCompilerContext } from "./types";

export class ManifestCompiler {
  constructor(
    private readonly registry: ChannelManifestRegistry,
    private readonly hooks = new MessagingHookRegistry(),
  ) {}

  async compile(context: ManifestCompilerContext): Promise<SandboxMessagingPlan> {
    const manifests = this.resolveManifests(requestedChannelIds(context), context);
    const channels: SandboxMessagingChannelPlan[] = [];
    for (const manifest of manifests) {
      channels.push(await this.compileChannel(manifest, context));
    }
    const inputRegistry = new Map(
      channels.map((channel) => [channel.channelId, channel.inputs] as const),
    );
    const disabledChannels = channels
      .filter((channel) => channel.disabled)
      .map((channel) => channel.channelId);
    const credentialBindings = manifests.flatMap((manifest) =>
      planCredentialBindings(manifest, context, inputRegistry.get(manifest.id) ?? []),
    );
    const networkPolicy = planNetworkPolicy(manifests, context);
    const agentRender = manifests.flatMap((manifest) =>
      planAgentRender(manifest, context),
    );
    const buildSteps = manifests.flatMap((manifest) =>
      planBuildSteps(manifest, context.agent),
    );
    const stateUpdates = manifests.flatMap((manifest) => planStateUpdates(manifest));
    const healthChecks = manifests.flatMap((manifest) => planHealthChecks(manifest));

    return {
      schemaVersion: 1,
      sandboxName: context.sandboxName,
      agent: context.agent,
      workflow: context.workflow,
      channels,
      disabledChannels,
      credentialBindings,
      networkPolicy,
      agentRender,
      buildSteps,
      stateUpdates,
      healthChecks,
    };
  }

  private resolveManifests(
    channelIds: readonly MessagingChannelId[],
    context: ManifestCompilerContext,
  ): ChannelManifest[] {
    const requestedIds = new Set(channelIds);
    const supportedIds =
      context.supportedChannelIds && context.supportedChannelIds.length > 0
        ? new Set(context.supportedChannelIds)
        : null;

    const manifests = this.registry
      .list()
      .filter((manifest) => requestedIds.has(manifest.id))
      .filter((manifest) => manifest.supportedAgents.includes(context.agent))
      .filter((manifest) => !supportedIds || supportedIds.has(manifest.id));

    const foundIds = new Set(manifests.map((manifest) => manifest.id));
    const missingIds = [...requestedIds].filter((channelId) => !foundIds.has(channelId));
    if (missingIds.length > 0) {
      throw new Error(`Missing messaging channel manifest(s): ${missingIds.join(", ")}`);
    }

    return manifests;
  }

  private async compileChannel(
    manifest: ChannelManifest,
    context: ManifestCompilerContext,
  ): Promise<SandboxMessagingChannelPlan> {
    const configured = context.configuredChannels.includes(manifest.id);
    const disabled = context.disabledChannels?.includes(manifest.id) ?? false;
    const selected = configured;
    const requested = configured;
    const requestedActive = !disabled && requested;
    const resolvedInputs = await resolveChannelInputs(manifest, context, this.hooks, {
      runEnrollment:
        selected &&
        requestedActive &&
        isEnrollmentWorkflow(context.workflow) &&
        context.isInteractive,
      runEnrollmentChecks: selected && requestedActive && isEnrollmentWorkflow(context.workflow),
    });
    const active = requestedActive && !resolvedInputs.skipped;

    return {
      channelId: manifest.id,
      displayName: manifest.displayName,
      authMode: manifest.auth.mode,
      active,
      selected,
      configured: configured && !resolvedInputs.skipped,
      disabled: disabled || resolvedInputs.skipped,
      inputs: resolvedInputs.inputs,
      hooks: requested
        ? manifest.hooks
            .filter((hook) => isHookForAgent(hook, context.agent))
            .map((hook) => cloneHookReference(manifest.id, hook))
        : [],
    };
  }
}

function isHookForAgent(hook: ChannelHookSpec, agent: ManifestCompilerContext["agent"]): boolean {
  return !hook.agents || hook.agents.includes(agent);
}

function requestedChannelIds(context: ManifestCompilerContext): MessagingChannelId[] {
  return uniqueChannels(context.configuredChannels);
}

function uniqueChannels(channelIds: readonly MessagingChannelId[]): MessagingChannelId[] {
  return [...new Set(channelIds)];
}

function isEnrollmentWorkflow(workflow: ManifestCompilerContext["workflow"]): boolean {
  return workflow === "onboard" || workflow === "add-channel";
}

function cloneHookReference(
  channelId: MessagingChannelId,
  hook: ChannelManifest["hooks"][number],
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

async function resolveChannelInputs(
  manifest: ChannelManifest,
  context: ManifestCompilerContext,
  hooks: MessagingHookRegistry,
  options: { readonly runEnrollment: boolean; readonly runEnrollmentChecks: boolean },
): Promise<{
  readonly inputs: SandboxMessagingInputReference[];
  readonly skipped: boolean;
}> {
  let inputs = manifest.inputs.map((input) => resolveChannelInput(manifest, input, context));
  let hookInputs = buildCompilerHookInputs(manifest, inputs);
  inputs = applyCredentialAvailability(manifest, inputs, context);
  const enrollmentHooks = options.runEnrollment
    ? manifest.hooks
        .filter((hook) => isHookForAgent(hook, context.agent))
        .filter((hook) => hook.phase === "enroll")
    : [];

  let skipped = false;
  for (const hook of enrollmentHooks) {
    const result = await runCompilerHook(manifest, hook, hooks, hookInputs);
    if (!result) {
      skipped = true;
      break;
    }
    hookInputs = mergeHookOutputsIntoInputs(manifest, hookInputs, result.outputs);
    inputs = applyCredentialAvailability(
      manifest,
      mergeEnrollmentOutputs(inputs, result.outputs),
      context,
    );
  }

  if (!skipped && options.runEnrollmentChecks && hasRequiredInputsAvailable(manifest, inputs)) {
    for (const hook of manifest.hooks
      .filter((entry) => isHookForAgent(entry, context.agent))
      .filter((entry) => entry.phase === "reachability-check")
      .filter((entry) => hasDeclaredHookInputs(hookInputs, entry))) {
      await runCompilerHook(manifest, hook, hooks, hookInputs);
    }
  }

  return { inputs, skipped };
}

async function runCompilerHook(
  manifest: ChannelManifest,
  hook: ChannelHookSpec,
  hooks: MessagingHookRegistry,
  inputs: MessagingHookInputMap,
): Promise<MessagingHookRunResult | null> {
  try {
    return await runMessagingHook(hook, hooks, {
      channelId: manifest.id,
      inputs: selectDeclaredHookInputs(hook, inputs),
    });
  } catch (error) {
    if (hook.onFailure === "skip-channel") return null;
    throw error;
  }
}

function resolveChannelInput(
  manifest: ChannelManifest,
  input: ChannelInputSpec,
  context: ManifestCompilerContext,
): SandboxMessagingInputReference {
  const base = inputReferenceBase(manifest, input);
  const envValue = readInputEnvValue(input);
  if (envValue !== undefined) {
    return input.kind === "secret"
      ? { ...base, credentialAvailable: true }
      : { ...base, value: envValue };
  }

  return {
    ...base,
  };
}

function inputReferenceBase(
  manifest: ChannelManifest,
  input: ChannelInputSpec,
): Omit<SandboxMessagingInputReference, "credentialAvailable" | "value"> {
  const statePath = readInputStatePath(input);

  return {
    channelId: manifest.id,
    inputId: input.id,
    kind: input.kind,
    required: input.required,
    sourceEnv: input.envKey,
    ...(statePath ? { statePath } : {}),
  };
}

function readInputEnvValue(input: ChannelInputSpec): MessagingSerializableValue | undefined {
  if (!input.envKey) return undefined;
  const value = process.env[input.envKey];
  return value && value.length > 0 ? value : undefined;
}

function readInputStatePath(input: ChannelInputSpec): MessagingStatePath | undefined {
  return input.kind === "config" ? input.statePath : undefined;
}

function isCredentialAvailable(
  manifest: ChannelManifest,
  input: SandboxMessagingInputReference,
  context: ManifestCompilerContext,
): boolean {
  const availability = context.credentialAvailability ?? {};
  const keys = [input.inputId, `${manifest.id}.${input.inputId}`, input.sourceEnv].filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );

  return keys.some((key) => availability[key] === true);
}

function applyCredentialAvailability(
  manifest: ChannelManifest,
  inputs: readonly SandboxMessagingInputReference[],
  context: ManifestCompilerContext,
): SandboxMessagingInputReference[] {
  return inputs.map((input) => {
    if (input.kind !== "secret") return input;
    return {
      ...input,
      credentialAvailable:
        input.credentialAvailable === true || isCredentialAvailable(manifest, input, context),
    };
  });
}

function hasRequiredInputsAvailable(
  manifest: ChannelManifest,
  inputs: readonly SandboxMessagingInputReference[],
): boolean {
  const byId = new Map(inputs.map((input) => [input.inputId, input]));
  return manifest.inputs.every((input) => {
    if (!input.required) return true;
    const resolved = byId.get(input.id);
    if (!resolved) return false;
    return resolved.kind === "secret"
      ? resolved.credentialAvailable === true
      : resolved.value !== undefined;
  });
}

function buildCompilerHookInputs(
  manifest: ChannelManifest,
  inputs: readonly SandboxMessagingInputReference[],
): Record<string, MessagingSerializableValue> {
  const inputSpecs = new Map(manifest.inputs.map((input) => [input.id, input]));
  const entries: Array<[string, MessagingSerializableValue]> = [];
  for (const input of inputs) {
    const spec = inputSpecs.get(input.inputId);
    const value = input.value ?? (spec ? readInputEnvValue(spec) : undefined);
    if (value === undefined) continue;
    entries.push([input.inputId, value]);
    if (input.statePath) entries.push([input.statePath, value]);
  }
  return Object.fromEntries(entries);
}

function mergeHookOutputsIntoInputs(
  manifest: ChannelManifest,
  inputs: Record<string, MessagingSerializableValue>,
  outputs: MessagingHookOutputMap,
): Record<string, MessagingSerializableValue> {
  const next = { ...inputs };
  const inputSpecs = new Map(manifest.inputs.map((input) => [input.id, input]));
  for (const [outputId, output] of Object.entries(outputs)) {
    if (output.kind !== "secret" && output.kind !== "config") continue;
    next[outputId] = output.value;
    const statePath = inputSpecs.get(outputId)?.statePath;
    if (statePath) next[statePath] = output.value;
  }
  return next;
}

function hasDeclaredHookInputs(
  inputs: MessagingHookInputMap,
  hook: ChannelHookSpec,
): boolean {
  return (hook.inputs ?? []).every((inputKey) => Object.hasOwn(inputs, inputKey));
}

function selectDeclaredHookInputs(
  hook: ChannelHookSpec,
  inputs: MessagingHookInputMap,
): MessagingHookInputMap | undefined {
  if (!hook.inputs || hook.inputs.length === 0) return undefined;
  return Object.fromEntries(
    hook.inputs
      .filter((inputKey) => Object.hasOwn(inputs, inputKey))
      .map((inputKey) => [inputKey, inputs[inputKey] as MessagingSerializableValue]),
  );
}

function mergeEnrollmentOutputs(
  inputs: readonly SandboxMessagingInputReference[],
  outputs: MessagingHookOutputMap,
): SandboxMessagingInputReference[] {
  return inputs.map((input) => {
    const output = outputs[input.inputId];
    if (!output) return input;
    if (output.kind === "secret") {
      return { ...input, credentialAvailable: true };
    }
    if (output.kind === "config") {
      return input.value === undefined ? { ...input, value: output.value } : input;
    }
    return input;
  });
}
