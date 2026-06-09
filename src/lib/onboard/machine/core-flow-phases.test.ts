// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../state/onboard-session";
import type { OnboardFlowContext } from "./flow-context";
import { createCoreOnboardFlowPhases } from "./core-flow-phases";

type Agent = { name: string };
type Gpu = { platform: string };
type SandboxGpuConfig = { mode: string };

function context(
  patch: Partial<OnboardFlowContext<Agent, Gpu, SandboxGpuConfig>> = {},
): OnboardFlowContext<Agent, Gpu, SandboxGpuConfig> {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: { name: "openclaw" },
    recordedSandboxName: null,
    requestedSandboxName: null,
    sandboxName: "my-sandbox",
    fromDockerfile: null,
    model: null,
    provider: null,
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: ["slack"],
    gpu: { platform: "linux" },
    sandboxGpuConfig: { mode: "cdi" },
    gpuPassthrough: true,
    ...patch,
  };
}

function sessionWithUpdates(updates: SessionUpdates = {}): Session {
  const session = createSession();
  Object.assign(session, updates);
  if (updates.metadata) session.metadata = { ...session.metadata, ...updates.metadata };
  return session;
}

function createPhases() {
  return createCoreOnboardFlowPhases<OnboardFlowContext<Agent, Gpu, SandboxGpuConfig>>({
    forceProviderSelection: false,
    env: {},
    constants: {
      hermesProviderName: "hermes",
      hermesApiKeyAuthMethod: "api-key",
      hermesApiKeyCredentialEnv: "HERMES_API_KEY",
    },
    providerDeps: {
      normalizeHermesAuthMethod: (value) => value ?? null,
      setupNim: vi.fn(async () => ({
        model: "nvidia/test",
        provider: "nim",
        endpointUrl: "https://example.test/v1",
        credentialEnv: "NVIDIA_API_KEY",
        hermesAuthMethod: null,
        hermesToolGateways: ["local"],
        preferredInferenceApi: "chat",
        nimContainer: "nim-test",
      })),
      setupInference: vi.fn(async () => ({ ok: true as const })),
      startRecordedStep: vi.fn(async () => undefined),
      recordStepComplete: vi.fn(async (_stepName: string, updates: SessionUpdates = {}) =>
        sessionWithUpdates(updates),
      ),
      toSessionUpdates: (updates) => updates as SessionUpdates,
      skippedStepMessage: vi.fn(),
      ensureResumeProviderReady: vi.fn(async () => ({
        forceInferenceSetup: false,
        credentialEnv: null,
      })),
      recordStateSkipped: vi.fn(async () => createSession()),
      recordRepairEvent: vi.fn(async () => createSession()),
      hydrateCredentialEnv: vi.fn(),
      repairLocalInferenceSystemdOverrideOrExit: vi.fn(),
      isNonInteractive: () => true,
      getOpenshellBinary: () => "openshell",
      needsBedrockRuntimeAdapter: () => false,
      isInferenceRouteReady: () => false,
      isRoutedInferenceProvider: () => false,
      reconcileModelRouter: vi.fn(async () => undefined),
      reupsertRoutedProvider: () => ({ ok: true, endpointUrl: "https://example.test/v1" }),
      registryUpdateSandbox: vi.fn(),
      promptValidatedSandboxName: vi.fn(async () => "my-sandbox"),
      assessHost: () => ({ memoryGb: 64 }),
      formatSandboxBuildEstimateNote: () => null,
      formatOnboardConfigSummary: () => "summary",
      promptYesNoOrDefault: vi.fn(async () => true),
      cliName: () => "nemoclaw",
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
      deleteEnv: vi.fn(),
    },
    sandbox: {
      resumeAgentChanged: false,
      controlUiPort: null,
      rootDir: "/repo",
    },
    sandboxDeps: {
      resolvePath: (value) => value,
      agentSupportsWebSearch: () => true,
      note: vi.fn(),
      updateSession: vi.fn((mutator) => mutator(createSession()) ?? createSession()),
      getStoredMessagingChannelConfig: () => null,
      hydrateMessagingChannelConfig: (config) => config,
      messagingChannelConfigsEqual: () => true,
      persistMessagingChannelConfigToSession: vi.fn(),
      getSandboxReuseState: () => "missing",
      computeTelegramRequireMention: () => null,
      hasSandboxGpuDrift: () => false,
      hasWechatConfigDrift: () => false,
      getSandboxHermesToolGateways: () => [],
      normalizeHermesToolGatewaySelections: (value) => (Array.isArray(value) ? value : []),
      stringSetsEqual: (left, right) =>
        left.length === right.length && left.every((item) => right.includes(item)),
      removeSandboxFromRegistry: vi.fn(),
      repairRecordedSandbox: vi.fn(),
      ensureValidatedBraveSearchCredential: vi.fn(async () => null),
      isBackToSelection: () => false,
      configureWebSearch: vi.fn(async () => null),
      startRecordedStep: vi.fn(async () => undefined),
      getRecordedMessagingChannelsForResume: () => null,
      getSandboxMessagingChannels: () => null,
      setupMessagingChannels: vi.fn(async () => ["slack", "discord"]),
      readMessagingChannelConfigFromEnv: () => null,
      readMessagingPlanFromEnv: () => null,
      writePlanToEnv: vi.fn(),
      getRegistrySandboxMessagingPlan: () => null,
      promptValidatedSandboxName: vi.fn(async () => "my-sandbox"),
      selectResourceProfileForSandbox: vi.fn(async () => null),
      stopStaleDashboardListenersForSandbox: vi.fn(),
      listRegistrySandboxes: () => ({ sandboxes: [] }),
      createSandbox: vi.fn(async () => "created-sandbox"),
      updateSandboxRegistry: vi.fn(),
      getSandboxAgentRegistryFields: () => ({ agent: "openclaw" }),
      recordStepComplete: vi.fn(async (_stepName: string, updates: SessionUpdates = {}) =>
        sessionWithUpdates(updates),
      ),
      toSessionUpdates: (updates) => updates as SessionUpdates,
      skippedStepMessage: vi.fn(),
      recordStateSkipped: vi.fn(async () => createSession()),
      recordRepairEvent: vi.fn(async () => createSession()),
      error: vi.fn(),
      exitProcess: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
    },
  });
}

describe("core onboard flow phases", () => {
  it("runs provider selection and carries inference output into the flow context", async () => {
    const [providerPhase] = createPhases();

    const result = await providerPhase.run(context());

    expect(result.context).toMatchObject({
      sandboxName: "my-sandbox",
      model: "nvidia/test",
      provider: "nim",
      endpointUrl: "https://example.test/v1",
      credentialEnv: "NVIDIA_API_KEY",
      hermesToolGateways: ["local"],
      preferredInferenceApi: "chat",
      nimContainer: "nim-test",
    });
    expect(Array.isArray(result.result)).toBe(true);
  });

  it("runs sandbox setup only after provider state is complete", async () => {
    const [, sandboxPhase] = createPhases();

    await expect(sandboxPhase.run(context())).rejects.toThrow(
      "Onboarding state is incomplete before sandbox setup.",
    );

    const result = await sandboxPhase.run(
      context({
        model: "nvidia/test",
        provider: "nim",
        hermesToolGateways: ["local"],
        preferredInferenceApi: "chat",
        nimContainer: "nim-test",
      }),
    );

    expect(result.context).toMatchObject({
      sandboxName: "created-sandbox",
      selectedMessagingChannels: ["slack", "discord"],
      webSearchSupported: true,
    });
  });
});
