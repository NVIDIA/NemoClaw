// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import { makeMessagingPlan } from "./messaging-plan-fixtures";
import {
  createSession,
  type Session,
  type SessionUpdates,
} from "../../src/lib/state/onboard-session";
import type { SandboxStateOptions } from "../../src/lib/onboard/machine/handlers/sandbox";

export type Gpu = { type: string } | null;
export type Agent = { displayName?: string } | null;
export type WebSearchConfig = { fetchEnabled: true };
export type MessagingChannelConfig = Record<string, string>;
export type SandboxGpuConfig = { sandboxGpuEnabled: boolean; mode: string };
export type ResourceProfile = { cpu: string; memory: string };

export function makeMinimalPlan(
  sandboxName: string,
  agent: "openclaw" | "hermes" = "openclaw",
  channelIds: readonly string[] = [],
) {
  return makeMessagingPlan(sandboxName, channelIds, [], agent);
}

export function createDeps(
  overrides: Partial<
    SandboxStateOptions<
      Gpu,
      Agent,
      WebSearchConfig,
      MessagingChannelConfig,
      SandboxGpuConfig,
      ResourceProfile
    >["deps"]
  > = {},
) {
  let session = createSession();
  const calls = {
    note: vi.fn(),
    updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
      session = mutator(session) ?? session;
      return session;
    }),
    removeSandbox: vi.fn(),
    repairSandbox: vi.fn(),
    validateBrave: vi.fn(async () => "brave-key"),
    isBackToSelection: vi.fn(() => false),
    configureWebSearch: vi.fn(async () => null as WebSearchConfig | null),
    startStep: vi.fn(async () => undefined),
    getRecordedChannels: vi.fn(() => null),
    setupMessaging: vi.fn(async () => [] as string[]),
    promptName: vi.fn(async () => "my-assistant"),
    selectResourceProfile: vi.fn(async () => null as ResourceProfile | null),
    stopStale: vi.fn(),
    createSandbox: vi.fn(async () => "my-assistant"),
    updateSandbox: vi.fn(),
    complete: vi.fn(async () => createSession()),
    skipped: vi.fn(),
    recordSkip: vi.fn(async () => createSession()),
    repairEvent: vi.fn(async () => createSession()),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
  return {
    calls,
    deps: {
      resolvePath: (value: string) => `/abs/${value}`,
      agentSupportsWebSearch: () => true,
      note: calls.note,
      updateSession: calls.updateSession,
      getStoredMessagingChannelConfig: () => null,
      hydrateMessagingChannelConfig: (config: MessagingChannelConfig | null) => config,
      messagingChannelConfigsEqual: () => true,
      getSandboxReuseState: () => "missing",
      computeTelegramRequireMention: () => null,
      hasSandboxGpuDrift: () => false,
      hasWechatConfigDrift: () => false,
      getSandboxHermesToolGateways: () => [],
      normalizeHermesToolGatewaySelections: (value: unknown) =>
        Array.isArray(value) ? (value as string[]) : [],
      stringSetsEqual: (left: string[], right: string[]) =>
        left.length === right.length && left.every((value) => right.includes(value)),
      removeSandboxFromRegistry: calls.removeSandbox,
      repairRecordedSandbox: calls.repairSandbox,
      ensureValidatedBraveSearchCredential: calls.validateBrave,
      isBackToSelection: calls.isBackToSelection,
      configureWebSearch: calls.configureWebSearch,
      startRecordedStep: calls.startStep,
      getRecordedMessagingChannelsForResume: calls.getRecordedChannels,
      getSandboxMessagingChannels: () => ["telegram"],
      setupMessagingChannels: calls.setupMessaging,
      readMessagingPlanFromEnv: () => null,
      writePlanToEnv: () => undefined,
      getRegistrySandboxMessagingPlan: () => null,
      promptValidatedSandboxName: calls.promptName,
      selectResourceProfileForSandbox: calls.selectResourceProfile,
      stopStaleDashboardListenersForSandbox: calls.stopStale,
      listRegistrySandboxes: () => ({ sandboxes: [{ name: "old" }] }),
      createSandbox: calls.createSandbox,
      updateSandboxRegistry: calls.updateSandbox,
      getSandboxAgentRegistryFields: () => ({ agent: null }),
      recordStepComplete: calls.complete,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      skippedStepMessage: calls.skipped,
      recordStateSkipped: calls.recordSkip,
      recordRepairEvent: calls.repairEvent,
      error: calls.error,
      exitProcess: calls.exit,
      ...overrides,
    },
    getSession: () => session,
  };
}

export function baseOptions(
  deps: SandboxStateOptions<
    Gpu,
    Agent,
    WebSearchConfig,
    MessagingChannelConfig,
    SandboxGpuConfig,
    ResourceProfile
  >["deps"],
  session: Session | null = createSession(),
): SandboxStateOptions<
  Gpu,
  Agent,
  WebSearchConfig,
  MessagingChannelConfig,
  SandboxGpuConfig,
  ResourceProfile
> {
  return {
    resume: false,
    fresh: false,
    resumeAgentChanged: false,
    session,
    sandboxName: null,
    model: "model",
    provider: "provider",
    nimContainer: null,
    webSearchConfig: null,
    selectedMessagingChannels: [],
    fromDockerfile: null,
    agent: null,
    gpu: { type: "nvidia" },
    preferredInferenceApi: "openai-completions",
    sandboxGpuConfig: { sandboxGpuEnabled: false, mode: "0" },
    hermesToolGateways: [],
    controlUiPort: null,
    rootDir: "/repo",
    deps,
  };
}
