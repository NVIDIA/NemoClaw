// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import type { AgentDefinition } from "../../../agent/defs";
import {
  type CompileTelegramPlanOptions,
  compileTelegramPlanForTests,
} from "../../../messaging/__test-utils__/telegram-plan";
import type { MessagingSerializableValue, SandboxMessagingPlan } from "../../../messaging/manifest";
import type { SandboxEntry } from "../../../state/registry";
import {
  getMessagingPlanFromEntry,
  serializeSandboxMessagingStateForDisk,
} from "../../../state/registry-messaging";

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
  const {
    tamperedInputs,
    sandboxName = "alpha",
    agentName = "openclaw",
    ...compileOptions
  } = options;
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

export function fakeChannelStatusAgent(name: "openclaw" | "hermes" = "openclaw"): AgentDefinition {
  const configDir = name === "openclaw" ? "/sandbox/.openclaw" : "/sandbox/.hermes";
  const stateDirs = name === "openclaw" ? ["whatsapp"] : ["platforms"];
  return {
    name,
    agentDir: `/fake/${name}`,
    manifestPath: `/fake/${name}/manifest.yaml`,
    get displayName() {
      return name;
    },
    get healthProbe() {
      return { url: "http://localhost:0/", port: 0, timeout_seconds: 5 };
    },
    get forwardPort() {
      return 0;
    },
    get dashboard() {
      return { kind: "ui" as const, label: "UI", path: "/" };
    },
    get configPaths() {
      return { dir: configDir, configFile: "config.json", envFile: null, format: "json" };
    },
    get inferenceProviderOptions() {
      return [];
    },
    get stateDirs() {
      return stateDirs;
    },
    get stateFiles() {
      return [];
    },
    get versionCommand() {
      return `${name} --version`;
    },
    get expectedVersion() {
      return null;
    },
    get hasDevicePairing() {
      return false;
    },
    get phoneHomeHosts() {
      return [];
    },
    get dockerfileBasePath() {
      return null;
    },
    get dockerfilePath() {
      return null;
    },
    get startScriptPath() {
      return null;
    },
    get policyAdditionsPath() {
      return null;
    },
    get policyPermissivePath() {
      return null;
    },
    get pluginDir() {
      return null;
    },
    get legacyPaths() {
      return null;
    },
  } as unknown as AgentDefinition;
}

export function channelStatusEntry(
  messagingChannels: string[] = ["whatsapp"],
  disabledChannels: string[] = [],
): SandboxEntry {
  const disabled = new Set(disabledChannels);
  return {
    name: "alpha",
    agent: "openclaw",
    messaging: {
      schemaVersion: 1,
      plan: {
        schemaVersion: 1,
        sandboxName: "alpha",
        agent: "openclaw",
        workflow: "onboard",
        channels: messagingChannels.map((channelId) => ({
          channelId,
          displayName: channelId,
          authMode: channelId === "whatsapp" ? "in-sandbox-qr" : "token-paste",
          active: !disabled.has(channelId),
          selected: true,
          configured: true,
          disabled: disabled.has(channelId),
          inputs: [],
          hooks: [],
        })),
        disabledChannels,
        credentialBindings: [],
        networkPolicy: { presets: [], entries: [] },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
      },
    },
  } as SandboxEntry;
}

export interface ChannelStatusExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ChannelStatusMakeDepsOptions {
  exec: (
    sandboxName: string,
    command: string,
    timeoutMs?: number,
  ) => ChannelStatusExecResult | null;
  appliedPresets?: string[];
  gatewayPresets?: string[] | null;
  agentName?: "openclaw" | "hermes";
  sandbox?: SandboxEntry | undefined;
  channelInputs?: ChannelInputOverridesByChannel;
  messagingPlan?: SandboxMessagingPlan | null;
  out?: (line: string) => void;
}

export function makeChannelStatusDeps(opts: ChannelStatusMakeDepsOptions, probedAt: Date) {
  const calls: string[] = [];
  const out = opts.out ?? ((line: string) => calls.push(line));
  const sandbox = opts.sandbox ?? channelStatusEntry();
  return {
    out,
    deps: {
      loadAgent: () => fakeChannelStatusAgent(opts.agentName),
      getSandbox: () => sandbox,
      getAppliedPresets: () => opts.appliedPresets ?? ["whatsapp"],
      getGatewayPresets: () =>
        opts.gatewayPresets === undefined ? ["whatsapp"] : opts.gatewayPresets,
      getMessagingPlan: () =>
        opts.messagingPlan !== undefined
          ? opts.messagingPlan
          : fakePlanFromInputs(sandbox, opts.channelInputs),
      execSandbox: vi.fn(opts.exec),
      now: () => probedAt,
      out,
    },
    out_lines: calls,
  };
}
