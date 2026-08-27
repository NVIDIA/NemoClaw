// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentKind } from "./phase6-messaging-helpers.ts";

export type ChannelPlanExpectedState = "active" | "disabled" | "removed";

type JsonRecord = Record<string, unknown>;

export type ChannelPlanStateExpectation = {
  readonly agent: AgentKind;
  readonly channelId: string;
  readonly credentialBindingRequired: boolean;
  readonly expected: ChannelPlanExpectedState;
  readonly sandboxName: string;
};

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (record(entry) ? [entry as JsonRecord] : []))
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function channelPlanStateErrors(
  value: unknown,
  expectation: ChannelPlanStateExpectation,
): string[] {
  const plan = record(value);
  if (!plan) return ["messaging.plan must be an object"];

  const errors: string[] = [];
  if (plan.schemaVersion !== 1) errors.push("messaging.plan.schemaVersion must be 1");
  if (plan.sandboxName !== expectation.sandboxName) {
    errors.push(`messaging.plan.sandboxName must be ${expectation.sandboxName}`);
  }
  if (plan.agent !== expectation.agent) {
    errors.push(`messaging.plan.agent must be ${expectation.agent}`);
  }
  if (Object.hasOwn(plan, "agentRender")) {
    errors.push("messaging.plan.agentRender must not persist");
  }

  const channels = records(plan.channels);
  if (channels.some((channel) => Object.hasOwn(channel, "hooks"))) {
    errors.push("messaging.plan channel hooks must not persist");
  }
  const channel = channels.find((entry) => entry.channelId === expectation.channelId);
  const disabledChannels = strings(plan.disabledChannels);
  const networkPolicy = record(plan.networkPolicy) ?? {};
  const policyPresets = strings(networkPolicy.presets);
  const policyEntries = records(networkPolicy.entries);
  const credentialBindings = records(plan.credentialBindings);
  const hasPolicyEntry = policyEntries.some((entry) => entry.channelId === expectation.channelId);
  const hasCredentialBinding = credentialBindings.some(
    (entry) => entry.channelId === expectation.channelId,
  );

  if (expectation.expected === "removed") {
    if (channel)
      errors.push(`${expectation.channelId} must be absent from messaging.plan.channels`);
    if (disabledChannels.includes(expectation.channelId)) {
      errors.push(`${expectation.channelId} must be absent from disabledChannels`);
    }
    if (policyPresets.includes(expectation.channelId)) {
      errors.push(`${expectation.channelId} policy preset must be removed`);
    }
    if (hasPolicyEntry) errors.push(`${expectation.channelId} policy entry must be removed`);
    if (hasCredentialBinding) {
      errors.push(`${expectation.channelId} credential binding must be removed`);
    }
    return errors;
  }

  if (!channel) {
    errors.push(`${expectation.channelId} must be present in messaging.plan.channels`);
  } else {
    if (channel.configured !== true) errors.push(`${expectation.channelId} must be configured`);
    if (expectation.expected === "active") {
      if (channel.active !== true) errors.push(`${expectation.channelId} must be active`);
      if (channel.disabled === true) errors.push(`${expectation.channelId} must not be disabled`);
    } else {
      if (channel.disabled !== true) errors.push(`${expectation.channelId} must be disabled`);
      if (channel.active === true) errors.push(`${expectation.channelId} must not be active`);
    }
  }

  if (expectation.expected === "active" && disabledChannels.includes(expectation.channelId)) {
    errors.push(`${expectation.channelId} must be absent from disabledChannels while active`);
  }
  if (expectation.expected === "disabled" && !disabledChannels.includes(expectation.channelId)) {
    errors.push(`${expectation.channelId} must be present in disabledChannels while disabled`);
  }
  if (!policyPresets.includes(expectation.channelId)) {
    errors.push(`${expectation.channelId} policy preset must be present`);
  }
  if (!hasPolicyEntry) errors.push(`${expectation.channelId} policy entry must be present`);
  if (expectation.credentialBindingRequired && !hasCredentialBinding) {
    errors.push(`${expectation.channelId} credential binding must be present`);
  }
  return errors;
}
