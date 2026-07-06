// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../state/onboard-session";
import {
  type CoreOnboardFlowPhaseOptions,
  createCoreOnboardFlowPhases,
  runCoreOnboardFlowSlice,
} from "./core-flow-phases";
import type { OnboardFlowContext } from "./flow-context";
import type { OnboardStateResult } from "./result";
import { advanceTo, branchTo } from "./result";
import type { OnboardSequencePhase } from "./sequence-runner";

type Agent = { name: string };
type Gpu = { platform: string };
type SandboxGpuConfig = { mode: string };
type CoreContext = OnboardFlowContext<Agent, Gpu, SandboxGpuConfig>;
type TestHost = { memoryGb: number };
type CoreOptions = CoreOnboardFlowPhaseOptions<CoreContext, TestHost>;

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
    compatibleEndpointReasoning: null,
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

function completeStep(): Session["steps"][string] {
  return {
    status: "complete",
    startedAt: "2026-06-09T00:00:00.000Z",
    completedAt: "2026-06-09T00:01:00.000Z",
    error: null,
  };
}

function createPhases(
  overrides: {
    providerDeps?: Partial<CoreOptions["providerDeps"]>;
    sandboxDeps?: Partial<CoreOptions["sandboxDeps"]>;
  } = {},
) {
  return createCoreOnboardFlowPhases<CoreContext, TestHost>({
    forceProviderSelection: false,
    env: {},
    constants: {
      hermesProviderName: "hermes",
      hermesApiKeyAuthMethod: "api_key",
      hermesApiKeyCredentialEnv: "HERMES_API_KEY",
    },
    providerDeps: {
      normalizeHermesAuthMethod: (value) =>
        value === "oauth" || value === "api_key" ? value : null,
      setupNim: vi.fn(async () => ({
        model: "nvidia/test",
        provider: "nim",
        endpointUrl: "https://example.test/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        hermesAuthMethod: null,
        hermesToolGateways: ["local"],
        preferredInferenceApi: "chat",
        compatibleEndpointReasoning: null,
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
      isResumeProviderSurfaceReady: vi.fn(() => true),
      recordStateSkipped: vi.fn(async () => createSession()),
      recordRepairEvent: vi.fn(async () => createSession()),
      hydrateCredentialEnv: vi.fn(),
      configureCompatibleEndpointReasoning: vi.fn(async () => "false" as const),
      clearCompatibleEndpointReasoning: vi.fn(() => null),
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
      ...overrides.providerDeps,
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
      getSandboxReuseState: () => "missing",
      hasSandboxGpuDrift: () => false,
      getSandboxHermesToolGateways: () => [],
      getSandboxRegistryEntry: () => null,
      normalizeHermesToolGatewaySelections: (value) => (Array.isArray(value) ? value : []),
      stringSetsEqual: (left, right) =>
        left.length === right.length && left.every((item) => right.includes(item)),
      removeSandboxFromRegistry: vi.fn(),
      repairRecordedSandbox: vi.fn(),
      ensureValidatedWebSearchCredential: vi.fn(async () => null),
      isBackToSelection: () => false,
      configureWebSearch: vi.fn(async () => null),
      startRecordedStep: vi.fn(async () => undefined),
      getRecordedMessagingChannelsForResume: () => null,
      setupMessagingChannels: vi.fn(async () => ["slack", "discord"]),
      readMessagingPlanFromEnv: () => null,
      writePlanToEnv: vi.fn(),
      clearPlanEnv: vi.fn(),
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
      ...overrides.sandboxDeps,
    },
  });
}

describe("core onboard flow phases", () => {
  it("carries provider selection output into sandbox setup", async () => {
    const updateSandboxRegistry = vi.fn();
    const [providerPhase, sandboxPhase] = createPhases({
      sandboxDeps: { updateSandboxRegistry },
    });

    const providerResult = await providerPhase.run(context());

    expect(providerResult.context).toMatchObject({
      sandboxName: "my-sandbox",
      model: "nvidia/test",
      provider: "nim",
      endpointUrl: "https://example.test/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      hermesToolGateways: ["local"],
      preferredInferenceApi: "chat",
      nimContainer: "nim-test",
    });
    expect(Array.isArray(providerResult.result)).toBe(true);

    const sandboxResult = await sandboxPhase.run(providerResult.context);

    expect(sandboxResult.context).toMatchObject({
      sandboxName: "created-sandbox",
      model: "nvidia/test",
      provider: "nim",
      endpointUrl: "https://example.test/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      fromDockerfile: null,
      gpu: { platform: "linux" },
      sandboxGpuConfig: { mode: "cdi" },
      gpuPassthrough: true,
      hermesToolGateways: ["local"],
      preferredInferenceApi: "chat",
      nimContainer: "nim-test",
      selectedMessagingChannels: ["slack", "discord"],
      webSearchSupported: true,
    });
    expect(updateSandboxRegistry).toHaveBeenCalledWith(
      "created-sandbox",
      expect.objectContaining({
        endpointUrl: "https://example.test/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
    );
  });

  it("passes fresh context through to provider setup recovery policy", async () => {
    const setupNim = vi.fn(async () => ({
      model: "nvidia/test",
      provider: "nim",
      endpointUrl: "https://example.test/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: "chat",
      compatibleEndpointReasoning: null,
      nimContainer: null,
    }));
    const [providerPhase] = createPhases({ providerDeps: { setupNim } });

    await providerPhase.run(context({ fresh: true }));

    expect(setupNim).toHaveBeenCalledWith(
      { platform: "linux" },
      "my-sandbox",
      { name: "openclaw" },
      false,
    );
  });

  it("uses normalized context Hermes tool gateways for provider inference resume", async () => {
    const setupInference = vi.fn(async () => ({ ok: true as const }));
    const [providerPhase, sandboxPhase] = createPhases({
      providerDeps: {
        ensureResumeProviderReady: vi.fn(async () => ({
          forceInferenceSetup: false,
          credentialEnv: "HERMES_API_KEY",
        })),
        isInferenceRouteReady: () => true,
        setupInference,
      },
    });
    const session = createSession({
      model: "nvidia/test",
      provider: "hermes",
      credentialEnv: "HERMES_API_KEY",
      hermesAuthMethod: "api_key",
      hermesToolGateways: ["unknown-preset"],
      steps: {
        provider_selection: completeStep(),
      },
    });

    const result = await providerPhase.run(
      context({
        resume: true,
        session,
        model: "nvidia/test",
        provider: "hermes",
        credentialEnv: "HERMES_API_KEY",
        hermesAuthMethod: "api_key",
        hermesToolGateways: ["nous-web"],
      }),
    );

    expect(setupInference).toHaveBeenCalledWith(
      "my-sandbox",
      "nvidia/test",
      "hermes",
      null,
      "HERMES_API_KEY",
      "api_key",
      ["nous-web"],
      { allowToolsIncompatible: false },
    );
    expect(result.context.hermesToolGateways).toEqual(["nous-web"]);

    const sandboxResult = await sandboxPhase.run(result.context);

    expect(sandboxResult.context).toMatchObject({
      sandboxName: "created-sandbox",
      model: "nvidia/test",
      provider: "hermes",
      credentialEnv: "HERMES_API_KEY",
      hermesToolGateways: ["nous-web"],
      sandboxGpuConfig: { mode: "cdi" },
    });
  });

  it("uses the strict runner for fresh provider selection sessions", async () => {
    const calls: string[] = [];
    const applied: string[] = [];
    let runtimeSession = createSession({
      machine: {
        version: 1,
        state: "provider_selection",
        stateEnteredAt: "2026-06-09T00:00:00.000Z",
        revision: 1,
      },
    });
    const phases: readonly OnboardSequencePhase<CoreContext>[] = [
      {
        state: "provider_selection",
        run: (ctx) => {
          calls.push("provider_selection");
          return {
            context: ctx,
            result: [
              advanceTo("inference", { metadata: { state: "provider_selection" } }),
              advanceTo("sandbox", { metadata: { state: "inference" } }),
            ],
          };
        },
      },
      {
        state: "sandbox",
        run: (ctx) => {
          calls.push("sandbox");
          return {
            context: { ...ctx, sandboxName: "created-sandbox" },
            result: branchTo("openclaw", { metadata: { state: "sandbox" } }),
          };
        },
      },
    ];

    const result = await runCoreOnboardFlowSlice({
      context: context({ model: "nvidia/test", provider: "nim" }),
      runtime: {
        session: async () => runtimeSession,
        applyResult: async (stateResult) => {
          const next = (stateResult as ReturnType<typeof advanceTo>).next;
          applied.push(next);
          runtimeSession = createSession({
            machine: {
              version: 1,
              state: next,
              stateEnteredAt: "2026-06-09T00:03:00.000Z",
              revision: runtimeSession.machine.revision + 1,
            },
          });
          return runtimeSession;
        },
      },
      phases,
      resume: false,
      recordStateResult: async () => {
        throw new Error("compatibility recorder should not run");
      },
    });

    expect(calls).toEqual(["provider_selection", "sandbox"]);
    expect(applied).toEqual(["inference", "sandbox", "openclaw"]);
    expect(result.context.sandboxName).toBe("created-sandbox");
    expect(result.session.machine.state).toBe("openclaw");
  });

  it("records each phase result on the resume compatibility path", async () => {
    const recorded: string[] = [];
    const phases: readonly OnboardSequencePhase<
      OnboardFlowContext<Agent, Gpu, SandboxGpuConfig>
    >[] = [
      {
        state: "provider_selection",
        run: (ctx) => ({ context: ctx, result: advanceTo("sandbox") }),
      },
      {
        state: "sandbox",
        run: (ctx) => ({ context: ctx, result: advanceTo("openclaw") }),
      },
    ];

    await runCoreOnboardFlowSlice({
      context: context({ resume: true }),
      runtime: {
        session: async () =>
          createSession({
            machine: {
              version: 1,
              state: "provider_selection",
              stateEnteredAt: "2026-06-09T00:00:00.000Z",
              revision: 1,
            },
          }),
        applyResult: async () => createSession(),
      },
      phases,
      resume: true,
      recordStateResult: async (result) => {
        if (result.type === "transition") recorded.push(result.next);
      },
    });

    expect(recorded).toEqual(["sandbox", "openclaw"]);
  });

  it.each([
    "policies",
    "finalizing",
    "post_verify",
  ] as const)("lets resume sessions at %s pass through core compatibility", async (state) => {
    const recorded: string[] = [];
    const phases: readonly OnboardSequencePhase<CoreContext>[] = [
      {
        state: "provider_selection",
        run: (ctx) => ({ context: ctx, result: advanceTo("sandbox") }),
      },
      {
        state: "sandbox",
        run: (ctx) => ({ context: ctx, result: advanceTo("openclaw") }),
      },
    ];

    await runCoreOnboardFlowSlice({
      context: context({ resume: true }),
      runtime: {
        session: async () =>
          createSession({
            machine: {
              version: 1,
              state,
              stateEnteredAt: "2026-06-09T00:00:00.000Z",
              revision: 7,
            },
          }),
        applyResult: async () => createSession(),
      },
      phases,
      resume: true,
      recordStateResult: async (result) => {
        recorded.push((result as ReturnType<typeof advanceTo>).next);
      },
    });

    expect(recorded).toEqual(["sandbox", "openclaw"]);
  });

  it.each([
    "complete",
    "failed",
  ] as const)("rejects terminal %s sessions before core compatibility side effects", async (state) => {
    const phase: OnboardSequencePhase<CoreContext> = {
      state: "provider_selection",
      run: vi.fn((ctx) => ({ context: ctx, result: advanceTo("sandbox") })),
    };

    await expect(
      runCoreOnboardFlowSlice({
        context: context({ resume: true }),
        runtime: {
          session: async () =>
            createSession({
              machine: {
                version: 1,
                state,
                stateEnteredAt: "2026-06-09T00:00:00.000Z",
                revision: 7,
              },
            }),
          applyResult: async () => createSession(),
        },
        phases: [phase],
        resume: true,
        recordStateResult: async () => undefined,
      }),
    ).rejects.toThrow("Unexpected onboarding live flow state before slice entry");
    expect(phase.run).not.toHaveBeenCalled();
  });

  it("keeps non-resume ahead-state sessions on the compatibility path", async () => {
    const calls: string[] = [];
    const skipped: string[] = [];
    const applied: string[] = [];
    let runtimeSession = createSession({
      machine: {
        version: 1,
        state: "sandbox",
        stateEnteredAt: "2026-06-09T00:02:00.000Z",
        revision: 7,
      },
    });
    const phases: readonly OnboardSequencePhase<CoreContext>[] = [
      {
        state: "provider_selection",
        run: (ctx) => {
          calls.push("provider_selection");
          return {
            context: ctx,
            result: [
              advanceTo("inference", {
                metadata: { state: "provider_selection", provider: "nim", model: "nvidia/test" },
              }),
              advanceTo("sandbox", {
                metadata: { state: "inference", provider: "nim", model: "nvidia/test" },
              }),
            ],
          };
        },
      },
      {
        state: "sandbox",
        run: (ctx) => {
          calls.push("sandbox");
          return {
            context: { ...ctx, sandboxName: "created-sandbox" },
            result: advanceTo("openclaw", { metadata: { state: "sandbox" } }),
          };
        },
      },
    ];

    const result = await runCoreOnboardFlowSlice({
      context: context(),
      runtime: {
        session: async () => runtimeSession,
        applyResult: async () => {
          throw new Error("ahead-state compatibility path should not use strict applyResult");
        },
      },
      phases,
      resume: false,
      recordStateResult: async (stateResult: OnboardStateResult) => {
        if (stateResult.type !== "transition") return runtimeSession;
        const source =
          stateResult.metadata && typeof stateResult.metadata.state === "string"
            ? stateResult.metadata.state
            : null;
        if (
          runtimeSession.machine.state === stateResult.next ||
          source !== runtimeSession.machine.state
        ) {
          skipped.push(`${source ?? "unknown"}->${stateResult.next}`);
          return runtimeSession;
        }
        applied.push(`${source}->${stateResult.next}`);
        runtimeSession = createSession({
          machine: {
            version: 1,
            state: stateResult.next,
            stateEnteredAt: "2026-06-09T00:03:00.000Z",
            revision: runtimeSession.machine.revision + 1,
          },
        });
        return runtimeSession;
      },
    });

    expect(calls).toEqual(["provider_selection", "sandbox"]);
    expect(skipped).toEqual(["provider_selection->inference", "inference->sandbox"]);
    expect(applied).toEqual(["sandbox->openclaw"]);
    expect(result.context.sandboxName).toBe("created-sandbox");
    expect(result.session.machine.state).toBe("openclaw");
  });
});
