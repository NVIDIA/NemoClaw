// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseSandboxMessagingPlan } from "../../../src/lib/messaging/plan-validation.ts";
import type { AgentKind } from "./phase6-messaging-helpers.ts";

export type ChannelPlanExpectedState = "active" | "disabled" | "removed";

export type ChannelPlanStateExpectation = {
  readonly agent: AgentKind;
  readonly channelId: string;
  readonly credentialBindingRequired: boolean;
  readonly expected: ChannelPlanExpectedState;
  readonly sandboxName: string;
};

export function channelPlanStateErrors(
  value: unknown,
  expectation: ChannelPlanStateExpectation,
): string[] {
  const plan = parseSandboxMessagingPlan(value, {
    agent: expectation.agent,
    sandboxName: expectation.sandboxName,
  });
  if (!plan) {
    return [
      `messaging.plan must be a valid persisted plan for ${expectation.sandboxName} using ${expectation.agent}`,
    ];
  }

  const errors: string[] = [];
  const persistedPlan = value as Record<string, unknown>;
  if (Object.hasOwn(persistedPlan, "agentRender")) {
    errors.push("messaging.plan.agentRender must not persist");
  }

  const persistedChannels = persistedPlan.channels as Record<string, unknown>[];
  if (persistedChannels.some((channel) => Object.hasOwn(channel, "hooks"))) {
    errors.push("messaging.plan channel hooks must not persist");
  }
  const channel = plan.channels.find((entry) => entry.channelId === expectation.channelId);
  const disabledChannels = plan.disabledChannels;
  const policyPresets = plan.networkPolicy.presets;
  const policyEntries = plan.networkPolicy.entries;
  const credentialBindings = (persistedPlan.credentialBindings ?? []) as {
    channelId: string;
  }[];
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
