// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import type { MessagingSerializableValue, SandboxMessagingPlan } from "../../messaging/manifest";
import type { SandboxEntry } from "../../state/registry";

export type ChannelInputOverride = {
  inputId: string;
  value?: MessagingSerializableValue;
};

export type ChannelInputOverridesByChannel = Record<string, ReadonlyArray<ChannelInputOverride>>;

export function mergePlanInputs(
  base: SandboxMessagingPlan,
  channelInputs: ChannelInputOverridesByChannel,
): SandboxMessagingPlan {
  return {
    ...base,
    channels: base.channels.map((channel) => {
      const overrides = channelInputs[channel.channelId];
      return overrides
        ? {
            ...channel,
            inputs: overrides.map((override) => ({
              channelId: channel.channelId,
              inputId: override.inputId,
              kind: "config" as const,
              required: false,
              ...(override.value !== undefined ? { value: override.value } : {}),
            })),
          }
        : channel;
    }),
  };
}

export function fakePlanFromInputs(
  sandbox: SandboxEntry | undefined,
  channelInputs: ChannelInputOverridesByChannel | undefined,
): SandboxMessagingPlan | null {
  const base = sandbox?.messaging?.plan ?? null;
  return base && channelInputs ? mergePlanInputs(base, channelInputs) : base;
}

export interface TelegramDoctorPlanOptions {
  readonly agent: "openclaw" | "hermes";
  readonly inputs?: ReadonlyArray<ChannelInputOverride>;
}

export function telegramDoctorPlan(options: TelegramDoctorPlanOptions): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: options.agent,
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        displayName: "telegram",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: (options.inputs ?? []).map((override) => ({
          channelId: "telegram",
          inputId: override.inputId,
          kind: "config" as const,
          required: false,
          ...(override.value === undefined ? {} : { value: override.value }),
        })),
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  } as SandboxMessagingPlan;
}

export interface MessagingRegistryModule {
  getConfiguredMessagingChannelsFromEntry: (...args: unknown[]) => unknown;
  getDisabledMessagingChannelsFromEntry: (...args: unknown[]) => unknown;
  getMessagingPlanFromEntry: (...args: unknown[]) => unknown;
}

export function mockTelegramDoctorRegistry(
  registry: MessagingRegistryModule,
  options: TelegramDoctorPlanOptions,
): void {
  vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
  vi.spyOn(registry, "getDisabledMessagingChannelsFromEntry").mockReturnValue([]);
  vi.spyOn(registry, "getMessagingPlanFromEntry").mockReturnValue(telegramDoctorPlan(options));
}

type CompactPlanInput = {
  readonly inputId?: string;
  readonly value?: unknown;
};

type CompactPlanChannel = {
  readonly channelId?: string;
  readonly inputs?: ReadonlyArray<CompactPlanInput>;
};

type CompactMessagingState = {
  readonly schemaVersion?: number;
  readonly plan?: {
    readonly channels?: ReadonlyArray<CompactPlanChannel>;
  };
};

export function tamperCompactRegistryTelegramInputs(
  onDisk: unknown,
  overrides: Readonly<Record<string, unknown>>,
): unknown {
  const state = onDisk as CompactMessagingState;
  const planChannels = state.plan?.channels ?? [];
  const tamperedChannels = planChannels.map((channel) => {
    const isTelegram = channel.channelId === "telegram";
    const tamperedInputs = (channel.inputs ?? []).map((input) => {
      const inputId = input.inputId ?? "";
      const replacement = overrides[inputId];
      return replacement === undefined ? input : { ...input, value: replacement };
    });
    return isTelegram ? { ...channel, inputs: tamperedInputs } : channel;
  });
  return { ...state, plan: { ...state.plan, channels: tamperedChannels } };
}
