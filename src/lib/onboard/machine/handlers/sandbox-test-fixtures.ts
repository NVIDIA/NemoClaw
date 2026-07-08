// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import type { SandboxStateOptions } from "./sandbox";

export function makeMinimalPlan(
  sandboxName: string,
  agent = "openclaw",
  channelIds: readonly SandboxMessagingPlan["channels"][number]["channelId"][] = [],
  disabledChannels: readonly SandboxMessagingPlan["channels"][number]["channelId"][] = [],
): SandboxMessagingPlan {
  const disabled = new Set(disabledChannels);
  return {
    schemaVersion: 1,
    sandboxName,
    agent: agent as SandboxMessagingPlan["agent"],
    workflow: "onboard",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [...disabled],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

export function withTelegramCredentialHash(
  plan: SandboxMessagingPlan,
  credentialHash: string | null,
): SandboxMessagingPlan {
  return {
    ...plan,
    credentialBindings: [
      {
        channelId: "telegram",
        credentialId: "bot-token",
        sourceInput: "botToken",
        providerName: `${plan.sandboxName}-telegram-bridge`,
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
        ...(credentialHash ? { credentialHash } : {}),
      },
    ],
  };
}

export async function withEnv<T>(key: string, value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

type Gpu = { type: string } | null;
type Agent = { displayName?: string; name?: string } | null;
type WebSearchConfig = { fetchEnabled: true; provider?: "brave" | "tavily" };
type MessagingChannelConfig = Record<string, string>;
type SandboxGpuConfig = { sandboxGpuEnabled: boolean; mode: string };
type ResourceProfile = { cpu: string; memory: string };

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
    checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
    note: vi.fn(),
    updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
      session = mutator(session) ?? session;
      return session;
    }),
    persistMessaging: vi.fn(),
    clearPlanEnv: vi.fn(),
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
    complete: vi.fn(async (_stepName: string, updates: SessionUpdates) => {
      Object.assign(session, updates);
      return session;
    }),
    skipped: vi.fn(),
    recordSkip: vi.fn(async () => session),
    repairEvent: vi.fn(async () => createSession()),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
    withGatewayRouteMutationLock: vi.fn(),
  };
  const runWithGatewayRouteMutationLock = async <T>(
    gatewayName: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    if (overrides.withGatewayRouteMutationLock) {
      return await overrides.withGatewayRouteMutationLock(gatewayName, operation);
    }
    calls.withGatewayRouteMutationLock(gatewayName, operation);
    return await operation();
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
      getDcodeSelectionDrift: () => ({ changed: false, unknown: false }),
      hasSandboxGpuDrift: () => false,
      getSandboxHermesToolGateways: () => [],
      getSandboxRegistryEntry: (name: string) => ({
        name,
        provider: "provider",
        model: "model",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        webSearchEnabled: false,
        toolDisclosure: "progressive" as const,
        fromDockerfile: null,
        hermesAuthMethod: null,
      }),
      normalizeHermesToolGatewaySelections: (value: unknown) =>
        Array.isArray(value) ? (value as string[]) : [],
      stringSetsEqual: (left: string[], right: string[]) =>
        left.length === right.length && left.every((value) => right.includes(value)),
      removeSandboxFromRegistry: calls.removeSandbox,
      repairRecordedSandbox: calls.repairSandbox,
      ensureValidatedWebSearchCredential: calls.validateBrave,
      isBackToSelection: calls.isBackToSelection,
      configureWebSearch: calls.configureWebSearch,
      startRecordedStep: calls.startStep,
      getRecordedMessagingChannelsForResume: calls.getRecordedChannels,
      setupMessagingChannels: calls.setupMessaging,
      readMessagingPlanFromEnv: () => null,
      writePlanToEnv: () => undefined,
      clearPlanEnv: calls.clearPlanEnv,
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
      checkGatewayRouteCompatibility:
        overrides.checkGatewayRouteCompatibility ?? calls.checkGatewayRouteCompatibility,
      withGatewayRouteMutationLock: runWithGatewayRouteMutationLock,
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
    gatewayName: "nemoclaw",
    session,
    sandboxName: null,
    model: "model",
    provider: "provider",
    endpointUrl: null,
    credentialEnv: null,
    nimContainer: null,
    webSearchConfig: null,
    selectedMessagingChannels: [],
    fromDockerfile: null,
    agent: null,
    gpu: { type: "nvidia" },
    preferredInferenceApi: "openai-completions",
    sandboxGpuConfig: { sandboxGpuEnabled: false, mode: "0" },
    hermesToolGateways: [],
    hermesAuthMethod: null,
    controlUiPort: null,
    rootDir: "/repo",
    env: {},
    deps,
  };
}
