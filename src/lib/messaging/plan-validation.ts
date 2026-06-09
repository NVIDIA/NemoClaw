// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInChannelManifestRegistry } from "./channels";
import {
  collectTemplateReferencesInLines,
  collectTemplateReferencesInValue,
  resolveCredentialTemplatesInLines,
  resolveCredentialTemplatesInValue,
  resolveSandboxNameTemplate,
} from "./compiler/engines/template";
import { BUILT_IN_MESSAGING_HOOK_REGISTRY, type MessagingHookRegistry } from "./hooks";
import type {
  ChannelCredentialSpec,
  ChannelHookOutputSpec,
  ChannelHookSpec,
  ChannelManifest,
  ChannelManifestRegistry,
  ChannelPolicyPresetReference,
  ChannelPolicyPresetSpec,
  MessagingAgentId,
  MessagingChannelId,
  MessagingCompilerWorkflow,
  MessagingSerializableValue,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingBuildStepPlan,
  SandboxMessagingChannelPlan,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingHealthCheckPlan,
  SandboxMessagingHookReferencePlan,
  SandboxMessagingInputReference,
  SandboxMessagingNetworkPolicyEntryPlan,
  SandboxMessagingPlan,
  SandboxMessagingStateUpdatePlan,
} from "./manifest";

const AGENTS = new Set<MessagingAgentId>(["openclaw", "hermes"]);
const WORKFLOWS = new Set<MessagingCompilerWorkflow>([
  "onboard",
  "add-channel",
  "remove-channel",
  "start-channel",
  "stop-channel",
  "rebuild",
]);
const AUTH_MODES = new Set(["none", "token-paste", "host-qr", "in-sandbox-qr"]);
const HOOK_PHASES = new Set([
  "enroll",
  "reachability-check",
  "apply",
  "post-agent-install",
  "health-check",
  "diagnostic",
  "status",
]);

export interface SandboxMessagingPlanValidationOptions {
  readonly registry?: ChannelManifestRegistry;
  readonly hooks?: MessagingHookRegistry;
  readonly sandboxName?: string;
  readonly agent?: MessagingAgentId;
  readonly supportedChannelIds?: readonly MessagingChannelId[];
}

export function parseValidSandboxMessagingPlan(
  value: unknown,
  options: SandboxMessagingPlanValidationOptions = {},
): SandboxMessagingPlan | null {
  try {
    assertValidSandboxMessagingPlan(value, options);
    return value;
  } catch {
    return null;
  }
}

export function validateSandboxMessagingPlan(
  value: unknown,
  options: SandboxMessagingPlanValidationOptions = {},
): value is SandboxMessagingPlan {
  return parseValidSandboxMessagingPlan(value, options) !== null;
}

export function assertValidSandboxMessagingPlan(
  value: unknown,
  options: SandboxMessagingPlanValidationOptions = {},
): asserts value is SandboxMessagingPlan {
  const plan = assertPlanEnvelope(value);
  if (options.sandboxName !== undefined && plan.sandboxName !== options.sandboxName) {
    fail("$.sandboxName", `expected '${options.sandboxName}'`);
  }
  if (options.agent !== undefined && plan.agent !== options.agent) {
    fail("$.agent", `expected '${options.agent}'`);
  }

  const registry = options.registry ?? createBuiltInChannelManifestRegistry();
  const hooks = options.hooks ?? BUILT_IN_MESSAGING_HOOK_REGISTRY;
  const manifests = validateChannels(plan, registry, options.supportedChannelIds);
  validateDisabledChannels(plan, manifests);
  validateChannelInputs(plan, manifests);
  validateChannelHooks(plan, manifests, hooks);
  validateCredentialBindings(plan, manifests);
  validateNetworkPolicy(plan, manifests);
  validateAgentRender(plan, manifests);
  validateBuildSteps(plan, manifests, hooks);
  validateStateUpdates(plan, manifests);
  validateHealthChecks(plan, manifests, hooks);
}

function assertPlanEnvelope(value: unknown): SandboxMessagingPlan {
  const plan = assertRecord(value, "$");
  if (plan.schemaVersion !== 1) fail("$.schemaVersion", "expected 1");
  assertString(plan.sandboxName, "$.sandboxName");
  if (!isAgent(plan.agent)) fail("$.agent", "expected supported messaging agent");
  if (!isWorkflow(plan.workflow)) fail("$.workflow", "expected supported messaging workflow");
  assertArray(plan.channels, "$.channels");
  assertArray(plan.disabledChannels, "$.disabledChannels");
  assertArray(plan.credentialBindings, "$.credentialBindings");
  const networkPolicy = assertRecord(plan.networkPolicy, "$.networkPolicy");
  assertArray(networkPolicy.presets, "$.networkPolicy.presets");
  assertArray(networkPolicy.entries, "$.networkPolicy.entries");
  assertArray(plan.agentRender, "$.agentRender");
  assertArray(plan.buildSteps, "$.buildSteps");
  assertArray(plan.stateUpdates, "$.stateUpdates");
  assertArray(plan.healthChecks, "$.healthChecks");
  return plan as unknown as SandboxMessagingPlan;
}

function validateChannels(
  plan: SandboxMessagingPlan,
  registry: ChannelManifestRegistry,
  supportedChannelIds: readonly MessagingChannelId[] | undefined,
): ReadonlyMap<MessagingChannelId, ChannelManifest> {
  const supported =
    supportedChannelIds && supportedChannelIds.length > 0 ? new Set(supportedChannelIds) : null;
  const manifests = new Map<MessagingChannelId, ChannelManifest>();
  const seen = new Set<MessagingChannelId>();
  plan.channels.forEach((channel, index) => {
    const path = `$.channels[${index}]`;
    assertChannelShape(channel, path);
    if (seen.has(channel.channelId)) fail(`${path}.channelId`, "duplicate channel id");
    seen.add(channel.channelId);

    const manifest = registry.get(channel.channelId);
    if (!manifest) fail(`${path}.channelId`, "unknown messaging channel");
    if (!manifest.supportedAgents.includes(plan.agent)) {
      fail(`${path}.channelId`, `channel is not supported for ${plan.agent}`);
    }
    if (supported && !supported.has(channel.channelId)) {
      fail(`${path}.channelId`, `channel is not enabled for ${plan.agent}`);
    }
    if (channel.authMode !== manifest.auth.mode) {
      fail(`${path}.authMode`, "does not match channel manifest");
    }
    manifests.set(channel.channelId, manifest);
  });
  return manifests;
}

function assertChannelShape(
  channel: unknown,
  path: string,
): asserts channel is SandboxMessagingChannelPlan {
  const record = assertRecord(channel, path);
  assertString(record.channelId, `${path}.channelId`);
  assertString(record.displayName, `${path}.displayName`);
  if (typeof record.authMode !== "string" || !AUTH_MODES.has(record.authMode)) {
    fail(`${path}.authMode`, "expected supported auth mode");
  }
  assertBoolean(record.active, `${path}.active`);
  assertBoolean(record.selected, `${path}.selected`);
  assertBoolean(record.configured, `${path}.configured`);
  assertBoolean(record.disabled, `${path}.disabled`);
  assertArray(record.inputs, `${path}.inputs`);
  assertArray(record.hooks, `${path}.hooks`);
}

function validateDisabledChannels(
  plan: SandboxMessagingPlan,
  manifests: ReadonlyMap<MessagingChannelId, ChannelManifest>,
): void {
  const seen = new Set<string>();
  plan.disabledChannels.forEach((channelId, index) => {
    const path = `$.disabledChannels[${index}]`;
    assertString(channelId, path);
    if (!manifests.has(channelId)) fail(path, "disabled channel is not in plan channels");
    if (seen.has(channelId)) fail(path, "duplicate disabled channel id");
    seen.add(channelId);
  });
}

function validateChannelInputs(
  plan: SandboxMessagingPlan,
  manifests: ReadonlyMap<MessagingChannelId, ChannelManifest>,
): void {
  plan.channels.forEach((channel, channelIndex) => {
    const manifest = manifests.get(channel.channelId);
    if (!manifest) return;
    const manifestInputs = new Map(manifest.inputs.map((input) => [input.id, input]));
    channel.inputs.forEach((input, inputIndex) => {
      const path = `$.channels[${channelIndex}].inputs[${inputIndex}]`;
      assertInputShape(input, path);
      if (input.channelId !== channel.channelId) {
        fail(`${path}.channelId`, "input channel does not match parent channel");
      }
      const manifestInput = manifestInputs.get(input.inputId);
      if (manifestInput) {
        if (input.kind !== manifestInput.kind)
          fail(`${path}.kind`, "does not match manifest input");
        if (input.required !== manifestInput.required) {
          fail(`${path}.required`, "does not match manifest input");
        }
        if (input.sourceEnv !== undefined && input.sourceEnv !== manifestInput.envKey) {
          fail(`${path}.sourceEnv`, "does not match manifest input env key");
        }
        if (input.statePath !== undefined && input.statePath !== manifestInput.statePath) {
          fail(`${path}.statePath`, "does not match manifest input state path");
        }
      }
      if (input.kind === "secret" && input.value !== undefined) {
        fail(`${path}.value`, "secret input values must not be persisted");
      }
      if (input.value !== undefined) assertSerializableValue(input.value, `${path}.value`);
    });
  });
}

function assertInputShape(
  input: unknown,
  path: string,
): asserts input is SandboxMessagingInputReference {
  const record = assertRecord(input, path);
  assertString(record.channelId, `${path}.channelId`);
  assertString(record.inputId, `${path}.inputId`);
  if (record.kind !== "secret" && record.kind !== "config") {
    fail(`${path}.kind`, "expected secret or config");
  }
  assertBoolean(record.required, `${path}.required`);
  if (record.sourceEnv !== undefined) assertString(record.sourceEnv, `${path}.sourceEnv`);
  if (record.statePath !== undefined) assertString(record.statePath, `${path}.statePath`);
  if (record.credentialAvailable !== undefined) {
    assertBoolean(record.credentialAvailable, `${path}.credentialAvailable`);
  }
}

function validateChannelHooks(
  plan: SandboxMessagingPlan,
  manifests: ReadonlyMap<MessagingChannelId, ChannelManifest>,
  hooks: MessagingHookRegistry,
): void {
  plan.channels.forEach((channel, channelIndex) => {
    const manifest = manifests.get(channel.channelId);
    if (!manifest) return;
    const expectedHooks = manifest.hooks.filter((hook) => isHookForAgent(hook, plan.agent));
    channel.hooks.forEach((hook, hookIndex) => {
      const path = `$.channels[${channelIndex}].hooks[${hookIndex}]`;
      assertHookShape(hook, path);
      if (hook.channelId !== channel.channelId) {
        fail(`${path}.channelId`, "hook channel does not match parent channel");
      }
      const expected = expectedHooks.find((candidate) => hooksEqual(hook, candidate));
      if (!expected) fail(path, "hook is not declared by the channel manifest");
      assertHookHandlerRegistered(hooks, hook.handler, `${path}.handler`);
    });
  });
}

function assertHookShape(
  hook: unknown,
  path: string,
): asserts hook is SandboxMessagingHookReferencePlan {
  const record = assertRecord(hook, path);
  assertString(record.channelId, `${path}.channelId`);
  assertString(record.id, `${path}.id`);
  if (typeof record.phase !== "string" || !HOOK_PHASES.has(record.phase)) {
    fail(`${path}.phase`, "expected supported hook phase");
  }
  assertString(record.handler, `${path}.handler`);
  if (record.agents !== undefined) assertStringArray(record.agents, `${path}.agents`);
  if (record.inputs !== undefined) assertStringArray(record.inputs, `${path}.inputs`);
  if (record.outputs !== undefined) {
    assertArray(record.outputs, `${path}.outputs`);
    record.outputs.forEach((output, index) => {
      const outputPath = `${path}.outputs[${index}]`;
      const outputRecord = assertRecord(output, outputPath);
      assertString(outputRecord.id, `${outputPath}.id`);
      if (
        outputRecord.kind !== "secret" &&
        outputRecord.kind !== "config" &&
        outputRecord.kind !== "build-arg" &&
        outputRecord.kind !== "build-file"
      ) {
        fail(`${outputPath}.kind`, "expected supported hook output kind");
      }
      if (outputRecord.required !== undefined) {
        assertBoolean(outputRecord.required, `${outputPath}.required`);
      }
    });
  }
  if (
    record.onFailure !== undefined &&
    record.onFailure !== "abort" &&
    record.onFailure !== "skip-channel"
  ) {
    fail(`${path}.onFailure`, "expected supported failure mode");
  }
}

function validateCredentialBindings(
  plan: SandboxMessagingPlan,
  manifests: ReadonlyMap<MessagingChannelId, ChannelManifest>,
): void {
  plan.credentialBindings.forEach((binding, index) => {
    const path = `$.credentialBindings[${index}]`;
    assertCredentialBindingShape(binding, path);
    const manifest = requirePlanManifest(manifests, binding.channelId, `${path}.channelId`);
    const expected = manifest.credentials.find((credential) =>
      credentialBindingMatches(plan, binding, credential),
    );
    if (!expected) fail(path, "credential binding is not declared by the channel manifest");
  });
}

function assertCredentialBindingShape(
  binding: unknown,
  path: string,
): asserts binding is SandboxMessagingCredentialBindingPlan {
  const record = assertRecord(binding, path);
  assertString(record.channelId, `${path}.channelId`);
  assertString(record.credentialId, `${path}.credentialId`);
  assertString(record.sourceInput, `${path}.sourceInput`);
  assertString(record.providerName, `${path}.providerName`);
  assertString(record.providerEnvKey, `${path}.providerEnvKey`);
  assertString(record.placeholder, `${path}.placeholder`);
  assertBoolean(record.credentialAvailable, `${path}.credentialAvailable`);
  if (record.credentialHash !== undefined)
    assertString(record.credentialHash, `${path}.credentialHash`);
}

function validateNetworkPolicy(
  plan: SandboxMessagingPlan,
  manifests: ReadonlyMap<MessagingChannelId, ChannelManifest>,
): void {
  const allowedPresets = new Set(
    Array.from(manifests.values()).flatMap((manifest) =>
      (manifest.policyPresets ?? []).map((preset) => normalizePolicyPreset(preset).name),
    ),
  );
  plan.networkPolicy.presets.forEach((preset, index) => {
    const path = `$.networkPolicy.presets[${index}]`;
    assertString(preset, path);
    if (!allowedPresets.has(preset)) fail(path, "policy preset is not declared by a plan channel");
  });

  plan.networkPolicy.entries.forEach((entry, index) => {
    const path = `$.networkPolicy.entries[${index}]`;
    assertNetworkPolicyEntryShape(entry, path);
    const manifest = requirePlanManifest(manifests, entry.channelId, `${path}.channelId`);
    const expected = policyEntriesForManifest(manifest, plan.agent).find((candidate) =>
      networkPolicyEntryMatches(entry, candidate),
    );
    if (!expected) fail(path, "policy entry is not declared by the channel manifest");
  });
}

function assertNetworkPolicyEntryShape(
  entry: unknown,
  path: string,
): asserts entry is SandboxMessagingNetworkPolicyEntryPlan {
  const record = assertRecord(entry, path);
  assertString(record.channelId, `${path}.channelId`);
  assertString(record.presetName, `${path}.presetName`);
  assertStringArray(record.policyKeys, `${path}.policyKeys`);
  if (record.source !== "agent-alias" && record.source !== "manifest") {
    fail(`${path}.source`, "expected manifest or agent-alias");
  }
}

function validateAgentRender(
  plan: SandboxMessagingPlan,
  manifests: ReadonlyMap<MessagingChannelId, ChannelManifest>,
): void {
  plan.agentRender.forEach((render, index) => {
    const path = `$.agentRender[${index}]`;
    assertAgentRenderShape(render, path);
    const manifest = requirePlanManifest(manifests, render.channelId, `${path}.channelId`);
    const expected = renderEntriesForManifest(manifest, plan.agent).find((candidate) =>
      renderEntryMatches(render, candidate),
    );
    if (!expected) fail(path, "render entry is not declared by the channel manifest");
  });
}

function assertAgentRenderShape(
  render: unknown,
  path: string,
): asserts render is SandboxMessagingAgentRenderPlan {
  const record = assertRecord(render, path);
  assertString(record.channelId, `${path}.channelId`);
  if (record.renderId !== undefined) assertString(record.renderId, `${path}.renderId`);
  if (!isAgent(record.agent)) fail(`${path}.agent`, "expected supported messaging agent");
  assertString(record.target, `${path}.target`);
  if (record.kind === "json-fragment") {
    assertString(record.path, `${path}.path`);
    assertSerializableValue(record.value, `${path}.value`);
    assertStringArray(record.templateRefs, `${path}.templateRefs`);
    return;
  }
  if (record.kind === "env-lines") {
    assertStringArray(record.lines, `${path}.lines`);
    assertStringArray(record.templateRefs, `${path}.templateRefs`);
    return;
  }
  fail(`${path}.kind`, "expected supported render kind");
}

function validateBuildSteps(
  plan: SandboxMessagingPlan,
  manifests: ReadonlyMap<MessagingChannelId, ChannelManifest>,
  hooks: MessagingHookRegistry,
): void {
  plan.buildSteps.forEach((step, index) => {
    const path = `$.buildSteps[${index}]`;
    assertBuildStepShape(step, path);
    const manifest = requirePlanManifest(manifests, step.channelId, `${path}.channelId`);
    const expected = buildStepsForManifest(manifest, plan.agent).find((candidate) =>
      buildStepMatches(step, candidate),
    );
    if (!expected) fail(path, "build step is not declared by the channel manifest");
    assertHookHandlerRegistered(hooks, step.handler, `${path}.handler`);
  });
}

function assertBuildStepShape(
  step: unknown,
  path: string,
): asserts step is SandboxMessagingBuildStepPlan {
  const record = assertRecord(step, path);
  assertString(record.channelId, `${path}.channelId`);
  if (record.kind !== "build-arg" && record.kind !== "build-file") {
    fail(`${path}.kind`, "expected build-arg or build-file");
  }
  assertString(record.hookId, `${path}.hookId`);
  assertString(record.handler, `${path}.handler`);
  assertString(record.outputId, `${path}.outputId`);
  assertBoolean(record.required, `${path}.required`);
}

function validateStateUpdates(
  plan: SandboxMessagingPlan,
  manifests: ReadonlyMap<MessagingChannelId, ChannelManifest>,
): void {
  plan.stateUpdates.forEach((update, index) => {
    const path = `$.stateUpdates[${index}]`;
    assertStateUpdateShape(update, path);
    const manifest = requirePlanManifest(manifests, update.channelId, `${path}.channelId`);
    const expected = stateUpdatesForManifest(manifest).find((candidate) =>
      stateUpdateMatches(update, candidate),
    );
    if (!expected) fail(path, "state update is not declared by the channel manifest");
  });
}

function assertStateUpdateShape(
  update: unknown,
  path: string,
): asserts update is SandboxMessagingStateUpdatePlan {
  const record = assertRecord(update, path);
  assertString(record.channelId, `${path}.channelId`);
  if (record.kind === "persist-inputs") {
    assertString(record.stateKey, `${path}.stateKey`);
    assertStringArray(record.inputIds, `${path}.inputIds`);
    return;
  }
  if (record.kind === "rebuild-hydration") {
    assertString(record.statePath, `${path}.statePath`);
    assertString(record.env, `${path}.env`);
    return;
  }
  fail(`${path}.kind`, "expected supported state update kind");
}

function validateHealthChecks(
  plan: SandboxMessagingPlan,
  manifests: ReadonlyMap<MessagingChannelId, ChannelManifest>,
  hooks: MessagingHookRegistry,
): void {
  plan.healthChecks.forEach((check, index) => {
    const path = `$.healthChecks[${index}]`;
    assertHealthCheckShape(check, path);
    const manifest = requirePlanManifest(manifests, check.channelId, `${path}.channelId`);
    const expected = healthCheckForManifest(manifest);
    if (!healthCheckMatches(check, expected)) {
      fail(path, "health check is not declared by the channel manifest");
    }
    const manifestHooks = new Map(manifest.hooks.map((hook) => [hook.id, hook]));
    check.hookIds.forEach((hookId, hookIndex) => {
      const hook = manifestHooks.get(hookId);
      if (hook) assertHookHandlerRegistered(hooks, hook.handler, `${path}.hookIds[${hookIndex}]`);
    });
  });
}

function assertHealthCheckShape(
  check: unknown,
  path: string,
): asserts check is SandboxMessagingHealthCheckPlan {
  const record = assertRecord(check, path);
  assertString(record.channelId, `${path}.channelId`);
  if (record.phase !== "health-check") fail(`${path}.phase`, "expected health-check");
  if (record.requiredBefore !== "lifecycle-success") {
    fail(`${path}.requiredBefore`, "expected lifecycle-success");
  }
  assertStringArray(record.hookIds, `${path}.hookIds`);
}

function credentialBindingMatches(
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

function policyEntriesForManifest(
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

function renderEntriesForManifest(
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

function buildStepsForManifest(
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

function isBuildStepOutput(
  output: ChannelHookOutputSpec,
): output is ChannelHookOutputSpec & { readonly kind: "build-arg" | "build-file" } {
  return output.kind === "build-arg" || output.kind === "build-file";
}

function stateUpdatesForManifest(manifest: ChannelManifest): SandboxMessagingStateUpdatePlan[] {
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

function healthCheckForManifest(manifest: ChannelManifest): SandboxMessagingHealthCheckPlan {
  return {
    channelId: manifest.id,
    phase: "health-check",
    requiredBefore: "lifecycle-success",
    hookIds: manifest.hooks.filter((hook) => hook.phase === "health-check").map((hook) => hook.id),
  };
}

function normalizePolicyPreset(preset: ChannelPolicyPresetReference): ChannelPolicyPresetSpec {
  return typeof preset === "string" ? { name: preset } : preset;
}

function requirePlanManifest(
  manifests: ReadonlyMap<MessagingChannelId, ChannelManifest>,
  channelId: MessagingChannelId,
  path: string,
): ChannelManifest {
  const manifest = manifests.get(channelId);
  if (!manifest) fail(path, "entry channel is not in plan channels");
  return manifest;
}

function isHookForAgent(hook: ChannelHookSpec, agent: MessagingAgentId): boolean {
  return !hook.agents || hook.agents.includes(agent);
}

function hooksEqual(
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

function networkPolicyEntryMatches(
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

function renderEntryMatches(
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

function buildStepMatches(
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

function stateUpdateMatches(
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

function healthCheckMatches(
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

function assertHookHandlerRegistered(
  hooks: MessagingHookRegistry,
  handler: string,
  path: string,
): void {
  if (!hooks.get(handler)) fail(path, "hook handler is not registered");
}

function isAgent(value: unknown): value is MessagingAgentId {
  return typeof value === "string" && AGENTS.has(value as MessagingAgentId);
}

function isWorkflow(value: unknown): value is MessagingCompilerWorkflow {
  return typeof value === "string" && WORKFLOWS.has(value as MessagingCompilerWorkflow);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected object");
  }
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected array");
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") fail(path, "expected string");
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") fail(path, "expected boolean");
}

function assertStringArray(value: unknown, path: string): asserts value is readonly string[] {
  assertArray(value, path);
  value.forEach((entry, index) => assertString(entry, `${path}[${index}]`));
}

function assertSerializableValue(
  value: unknown,
  path: string,
  visiting: Set<object> = new Set(),
): asserts value is MessagingSerializableValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    assertAcyclicObject(value, path, visiting, () => {
      value.forEach((entry, index) =>
        assertSerializableValue(entry, `${path}[${index}]`, visiting),
      );
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    assertAcyclicObject(value, path, visiting, () => {
      for (const [key, entry] of Object.entries(value)) {
        assertSerializableValue(entry, `${path}.${key}`, visiting);
      }
    });
    return;
  }
  fail(path, "expected JSON-serializable value");
}

function assertAcyclicObject(
  value: object,
  path: string,
  visiting: Set<object>,
  visit: () => void,
): void {
  if (visiting.has(value)) fail(path, "contains a cycle");
  visiting.add(value);
  try {
    visit();
  } finally {
    visiting.delete(value);
  }
}

function optionalStringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stringArraysEqual(left, right);
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(path: string, reason: string): never {
  throw new Error(`Invalid SandboxMessagingPlan at ${path}: ${reason}.`);
}
