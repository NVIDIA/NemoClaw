// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelManifestRegistry,
  MessagingChannelId,
  SandboxMessagingChannelPlan,
  SandboxMessagingInputReference,
  SandboxMessagingPlan,
} from "../manifest";
import {
  assertArray,
  assertBoolean,
  assertRecord,
  assertSerializableValue,
  assertString,
  fail,
  isAgent,
  isWorkflow,
} from "./assertions";
import type { PlanManifestMap } from "./types";

const AUTH_MODES = new Set(["none", "token-paste", "host-qr", "in-sandbox-qr"]);

export function assertPlanEnvelope(value: unknown): SandboxMessagingPlan {
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

export function validateChannels(
  plan: SandboxMessagingPlan,
  registry: ChannelManifestRegistry,
  supportedChannelIds: readonly MessagingChannelId[] | undefined,
): PlanManifestMap {
  const supported =
    supportedChannelIds && supportedChannelIds.length > 0 ? new Set(supportedChannelIds) : null;
  const manifests = new Map<MessagingChannelId, ReturnType<ChannelManifestRegistry["get"]>>();
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
  return manifests as PlanManifestMap;
}

export function validateDisabledChannels(
  plan: SandboxMessagingPlan,
  manifests: PlanManifestMap,
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

export function validateChannelInputs(
  plan: SandboxMessagingPlan,
  manifests: PlanManifestMap,
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
