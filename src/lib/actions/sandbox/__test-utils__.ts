// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import {
  type CompileTelegramPlanOptions,
  compileTelegramPlanForTests,
} from "../../messaging/__test-utils__/telegram-plan";
import type { MessagingSerializableValue, SandboxMessagingPlan } from "../../messaging/manifest";
import type { SandboxEntry } from "../../state/registry";
import {
  getMessagingPlanFromEntry,
  serializeSandboxMessagingStateForDisk,
} from "../../state/registry-messaging";

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

export interface CompactTelegramEntryOptions extends CompileTelegramPlanOptions {
  readonly sandboxName?: string;
  readonly agentName?: "openclaw" | "hermes";
  readonly tamperedInputs?: Readonly<Record<string, unknown>>;
}

export interface CompactTelegramEntryBundle {
  readonly entry: SandboxEntry;
  readonly messagingOnDisk: unknown;
}

export async function compactTelegramEntryFromEnv(
  options: CompactTelegramEntryOptions,
): Promise<CompactTelegramEntryBundle> {
  const { tamperedInputs, sandboxName = "alpha", agentName = "openclaw", ...compileOptions } = options;
  const compiled = await compileTelegramPlanForTests(compileOptions);
  const baseOnDisk = serializeSandboxMessagingStateForDisk({ schemaVersion: 1, plan: compiled });
  const messagingOnDisk = tamperedInputs
    ? tamperCompactRegistryTelegramInputs(baseOnDisk, tamperedInputs)
    : baseOnDisk;
  const entry = {
    name: sandboxName,
    agent: agentName,
    messaging: messagingOnDisk,
  } as unknown as SandboxEntry;
  return { entry, messagingOnDisk };
}

export function useRealMessagingPlanReader<
  T extends { getMessagingPlan: (entry: SandboxEntry | undefined) => SandboxMessagingPlan | null },
>(deps: T): T {
  deps.getMessagingPlan = (entry) => getMessagingPlanFromEntry(entry);
  return deps;
}
