// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../state/onboard-session";
import { recordInvalidatedTargets } from "../__test-helpers__/machine-recorders";
import {
  type CoreOnboardFlowPhases,
  createProviderInferenceOnboardFlowPhase,
  createSandboxOnboardFlowPhase,
  type EndpointProvenanceOptions,
  type ProviderInferenceOnboardFlowPhaseOptions,
  runCoreOnboardFlowSlice,
  type SandboxOnboardFlowPhaseOptions,
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
type ProviderOptions = ProviderInferenceOnboardFlowPhaseOptions<CoreContext, TestHost>;
type SandboxOptions = SandboxOnboardFlowPhaseOptions<CoreContext>;

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
    endpointProvenance?: Partial<EndpointProvenanceOptions>;
    providerDeps?: Partial<ProviderOptions["deps"]>;
    sandboxDeps?: Partial<SandboxOptions["deps"]>;
  } = {},
): CoreOnboardFlowPhases<CoreContext> {
  const getSandboxRegistryEntry = () => ({
    name: "my-sandbox",
    provider: "nim",
    model: "nvidia/test",
    endpointUrl: "https://example.test/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "chat",
    gatewayName: "nemoclaw",
    gpuEnabled: false,
    policies: [],
  });
  const endpointProvenance = {
    getSandboxRegistryEntry,
    ...overrides.endpointProvenance,
  };
  const providerInference = createProviderInferenceOnboardFlowPhase<CoreContext, TestHost>({
    gatewayName: "nemoclaw",
    forceProviderSelection: false,
    endpointProvenance,
    env: {},
    constants: {
      hermesProviderName: "hermes",
      hermesApiKeyAuthMethod: "api_key",
      hermesApiKeyCredentialEnv: "HERMES_API_KEY",
    },
    deps: {
      checkGatewayRouteCompatibility: () => ({ ok: true }),
      preflightGatewayRouteDiscovery: () => ({
        ok: true,
        requiredModel: null,
        requiredEndpointUrl: null,
        requiredInferenceApi: null,
      }),
      getSandboxRecoveryAuthority: (): "missing" => "missing",
      withGatewayRouteMutationLock: async <T>(
        _gatewayName: string,
        operation: () => Promise<T> | T,
      ) => await operation(),
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
      ensureResumeProviderReady: vi.fn(
        async (
          _gatewayName: string,
          _provider: string | null | undefined,
          _credentialEnv: string | null | undefined,
        ) => ({
          forceInferenceSetup: false,
          credentialEnv: null,
        }),
      ),
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
      isInferenceRouteReady: (_gatewayName, _provider, _model) => false,
      isRoutedInferenceProvider: () => false,
      reconcileModelRouter: vi.fn(async () => undefined),
      reupsertRoutedProvider: (_gatewayName, _provider, _endpointUrl, _credentialEnv) => ({
        ok: true,
        endpointUrl: "https://example.test/v1",
      }),
      reserveSandboxInferenceRoute: vi.fn(() => true),
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
  });
  const sandbox = createSandboxOnboardFlowPhase<CoreContext>({
    gatewayName: "nemoclaw",
    resumeAgentChanged: false,
    endpointProvenance,
    recreateSandbox: () => false,
    controlUiPort: null,
    rootDir: "/repo",
    env: {},
    deps: {
      resolvePath: (value) => value,
      agentSupportsWebSearch: () => true,
      note: vi.fn(),
      updateSession: vi.fn((mutator) => mutator(createSession()) ?? createSession()),
      getStoredMessagingChannelConfig: () => null,
      hydrateMessagingChannelConfig: (config) => config,
      messagingChannelConfigsEqual: () => true,
      getSandboxReuseState: () => "missing",
      getSandboxRecreateObservation: () => ({ state: "missing", liveIdentityFingerprint: null }),
      getDcodeSelectionDrift: () => ({ changed: false, unknown: false }),
      hasSandboxGpuDrift: () => false,
      getSandboxHermesToolGateways: () => [],
      getSandboxRegistryEntry,
      normalizeHermesToolGatewaySelections: (value) => (Array.isArray(value) ? value : []),
      stringSetsEqual: (left, right) =>
        left.length === right.length && left.every((item) => right.includes(item)),
      removeSandboxFromRegistry: vi.fn(() => null),
      restoreSandboxRegistryEntryIfMissing: vi.fn(() => false),
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
      providerMatchesGatewayCredential: () => false,
      stageSandboxCredentialProviders: vi.fn(async () => []),
      promptValidatedSandboxName: vi.fn(async () => "my-sandbox"),
      selectResourceProfileForSandbox: vi.fn(async () => null),
      stopStaleDashboardListenersForSandbox: vi.fn(),
      listRegistrySandboxes: () => ({ sandboxes: [] }),
      planRegisteredExtraProviders: vi.fn(() => ({
        extraProviders: [],
        staleExtraProviders: [],
      })),
      resolveSandboxCreateIntent: vi.fn(
        async ({ sandboxName, inferenceProvider, extraProviders, staleExtraProviders }) => ({
          sandboxName,
          inferenceProvider: inferenceProvider ?? null,
          activeMessagingChannels: [],
          messagingProviderRequests: [],
          reusableMessagingProviders: [],
          extraProviders: [...extraProviders],
          staleExtraProviders: [...staleExtraProviders],
          hermesToolGateways: [],
          policy: {
            basePolicyPath: "/repo/policy.yaml",
            activeMessagingChannels: [],
            options: {
              directGpu: false,
              additionalPresets: [],
              policyTier: null,
              baselineExclusions: [],
            },
          },
          gpuCreateArgs: [],
          resourceCreateArgs: [],
          gpuRoutePlan: "none" as const,
          sandboxGpuLogMessage: null,
          disabledChannelNames: [],
          extraPlaceholderKeys: [],
        }),
      ),
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
      checkGatewayRouteCompatibility:
        overrides.sandboxDeps?.checkGatewayRouteCompatibility ?? (() => ({ ok: true })),
      withGatewayRouteMutationLock:
        overrides.sandboxDeps?.withGatewayRouteMutationLock ??
        (async <T>(_gatewayName: string, operation: () => Promise<T> | T) => await operation()),
    },
  });
  return { providerInference, sandbox };
}

describe("core onboard flow phases", () => {
  it("carries provider selection output into sandbox setup", async () => {
    const updateSandboxRegistry = vi.fn();
    const createSandbox = vi.fn(async () => "created-sandbox");
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      sandboxDeps: {
        createSandbox,
        planRegisteredExtraProviders: vi.fn(() => ({
          extraProviders: ["current-provider"],
          staleExtraProviders: ["stale-provider"],
        })),
        updateSandboxRegistry,
      },
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
    expect(createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      resolved: {
        inferenceProvider: "nim",
        extraProviders: ["current-provider"],
        staleExtraProviders: ["stale-provider"],
      },
    });
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
    const { providerInference: providerPhase } = createPhases({ providerDeps: { setupNim } });

    await providerPhase.run(context({ fresh: true }));

    expect(setupNim).toHaveBeenCalledWith(
      { platform: "linux" },
      "my-sandbox",
      { name: "openclaw" },
      false,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      expect.any(String),
    );
  });

  it("uses normalized context Hermes tool gateways for provider inference resume", async () => {
    const setupInference = vi.fn(async () => ({ ok: true as const }));
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      providerDeps: {
        ensureResumeProviderReady: vi.fn(async (_gatewayName, _provider, _credentialEnv) => ({
          forceInferenceSetup: false,
          credentialEnv: "HERMES_API_KEY",
        })),
        isInferenceRouteReady: (_gatewayName, _provider, _model) => true,
        setupInference,
      },
      sandboxDeps: {
        getSandboxRegistryEntry: () => ({
          name: "my-sandbox",
          provider: "hermes",
          model: "nvidia/test",
          endpointUrl: null,
          credentialEnv: "HERMES_API_KEY",
          preferredInferenceApi: null,
          gatewayName: "nemoclaw",
          gpuEnabled: false,
          policies: [],
        }),
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
      {
        gatewayName: "nemoclaw",
        allowToolsIncompatible: false,
        endpointSource: null,
        reservationSessionId: session.sessionId,
      },
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

  it.each([
    [
      "matching",
      "compatible-endpoint",
      "https://persisted.example.test/v1",
      "onboard",
      "https://persisted.example.test/v1",
      true,
    ],
    [
      "endpoint-mismatched",
      "compatible-endpoint",
      "https://other.example.test/v1",
      null,
      null,
      false,
    ],
    ["provider-mismatched", "nvidia-prod", "https://persisted.example.test/v1", null, null, false],
  ] as const)("binds %s persisted onboard provenance to its exact provider endpoint", async (_label, registeredProvider, registeredEndpointUrl, expectedSource, expectedOnboardEndpointUrl, expectTrustedUrl) => {
    const setupInference = vi.fn(async () => ({ ok: true as const }));
    const updateSandboxRegistry = vi.fn();
    const getSandboxRegistryEntry = vi.fn((_sandboxName: string) => ({
      name: "my-sandbox",
      provider: registeredProvider,
      model: "custom/model",
      endpointUrl: registeredEndpointUrl,
      endpointSource: "onboard" as const,
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      gpuEnabled: false,
      policies: [],
    }));
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      providerDeps: {
        setupInference,
        hydrateCredentialEnv: vi.fn(() => "host-key"),
      },
      endpointProvenance: {
        getSandboxRegistryEntry,
      },
      sandboxDeps: { updateSandboxRegistry },
    });
    const session = createSession({
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: "https://persisted.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      steps: { provider_selection: completeStep() },
    });

    const result = await providerPhase.run(
      context({
        resume: true,
        session,
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl: "https://persisted.example.test/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
    );

    const inferenceOptions = setupInference.mock.calls[0]?.at(-1) as
      | { endpointSource?: string | null; onboardEndpointUrl?: string }
      | undefined;
    expect(inferenceOptions).toMatchObject({ endpointSource: expectedSource });
    expect(inferenceOptions?.onboardEndpointUrl ?? null).toBe(expectedOnboardEndpointUrl);
    expect(Object.hasOwn(inferenceOptions ?? {}, "onboardEndpointUrl")).toBe(expectTrustedUrl);
    expect(result.context.endpointSource).toBe(expectedSource);
    expect(result.context.onboardEndpointUrl ?? null).toBe(expectedOnboardEndpointUrl);
    expect(getSandboxRegistryEntry).toHaveBeenCalledWith("my-sandbox");

    await sandboxPhase.run(result.context);

    expect(updateSandboxRegistry).toHaveBeenCalledWith(
      "created-sandbox",
      expect.objectContaining({ endpointSource: expectedSource }),
    );
  });

  it.each([
    ["fresh", false],
    ["resumed", true],
  ] as const)("uses the strict runner for %s provider selection sessions", async (_label, resume) => {
    const phaseCalls: string[] = [];
    const appliedTransitions: string[] = [];
    const sandboxEffect = vi.fn();
    let runtimeSession = createSession({
      machine: {
        version: 1,
        state: "provider_selection",
        stateEnteredAt: "2026-06-09T00:00:00.000Z",
        revision: 1,
      },
    });
    const runProviderInference = vi.fn((ctx: CoreContext) => {
      phaseCalls.push("provider_selection");
      return {
        context: { ...ctx, endpointUrl: "https://example.test/v1" },
        result: [
          advanceTo("inference", { metadata: { state: "provider_selection" } }),
          advanceTo("sandbox", { metadata: { state: "inference" } }),
        ],
      };
    });
    const runSandbox = vi.fn((ctx: CoreContext) => {
      phaseCalls.push("sandbox");
      sandboxEffect(ctx);
      return {
        context: { ...ctx, sandboxName: "created-sandbox" },
        result: branchTo("openclaw", { metadata: { state: "sandbox" } }),
      };
    });
    const phases: CoreOnboardFlowPhases<CoreContext> = {
      providerInference: {
        state: "provider_selection",
        run: runProviderInference,
      },
      sandbox: {
        state: "sandbox",
        run: runSandbox,
      },
    };
    const recordStateResult = vi.fn(async () => {
      throw new Error("compatibility recorder should not run");
    });
    const recordInvalidatedStateResult = vi.fn(async () => {
      throw new Error("invalidation recorder should not run on the strict runner path");
    });

    const result = await runCoreOnboardFlowSlice({
      context: context({
        resume,
        fresh: !resume,
        model: "nvidia/test",
        provider: "nim",
      }),
      runtime: {
        session: async () => runtimeSession,
        applyResult: async (stateResult) => {
          const transition = stateResult as ReturnType<typeof advanceTo>;
          appliedTransitions.push(`${transition.transitionKind}:${transition.next}`);
          runtimeSession = createSession({
            machine: {
              version: 1,
              state: transition.next,
              stateEnteredAt: "2026-06-09T00:03:00.000Z",
              revision: runtimeSession.machine.revision + 1,
            },
          });
          return runtimeSession;
        },
      },
      phases,
      resume,
      recordStateResult,
      recordInvalidatedStateResult,
    });

    expect(phaseCalls).toEqual(["provider_selection", "sandbox"]);
    expect(runProviderInference).toHaveBeenCalledOnce();
    expect(runSandbox).toHaveBeenCalledOnce();
    expect(sandboxEffect).toHaveBeenCalledOnce();
    expect(sandboxEffect).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "https://example.test/v1" }),
    );
    expect(appliedTransitions).toEqual(["advance:inference", "advance:sandbox", "branch:openclaw"]);
    expect(recordStateResult).not.toHaveBeenCalled();
    expect(recordInvalidatedStateResult).not.toHaveBeenCalled();
    expect(result.context.endpointUrl).toBe("https://example.test/v1");
    expect(result.context.sandboxName).toBe("created-sandbox");
    expect(result.session.machine.state).toBe("openclaw");
  });

  it.each([
    "inference",
    "sandbox",
    "openclaw",
    "agent_setup",
    "policies",
    "finalizing",
    "post_verify",
  ] as const)("lets resume sessions at %s pass through core compatibility", async (state) => {
    const recorded: string[] = [];
    const applyResult = vi.fn(async () => {
      throw new Error("downstream resume compatibility should not use the strict runner");
    });
    const phases: CoreOnboardFlowPhases<CoreContext> = {
      providerInference: {
        state: "provider_selection",
        run: (ctx) => ({ context: ctx, result: advanceTo("sandbox") }),
      },
      sandbox: {
        state: "sandbox",
        run: (ctx) => ({ context: ctx, result: advanceTo("openclaw") }),
      },
    };

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
        applyResult,
      },
      phases,
      resume: true,
      recordStateResult: async (result) => {
        recorded.push((result as ReturnType<typeof advanceTo>).next);
      },
      recordInvalidatedStateResult: recordInvalidatedTargets(recorded),
    });

    expect(recorded).toEqual(["sandbox", "openclaw"]);
    expect(applyResult).not.toHaveBeenCalled();
  });

  it.each([
    "complete",
    "failed",
  ] as const)("rejects terminal %s sessions before core compatibility side effects", async (state) => {
    const phase: OnboardSequencePhase<CoreContext> = {
      state: "provider_selection",
      run: vi.fn((ctx) => ({ context: ctx, result: advanceTo("sandbox") })),
    };
    const sandboxPhase: OnboardSequencePhase<CoreContext> = {
      state: "sandbox",
      run: vi.fn((ctx) => ({ context: ctx, result: advanceTo("openclaw") })),
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
        phases: { providerInference: phase, sandbox: sandboxPhase },
        resume: true,
        recordStateResult: async () => undefined,
        recordInvalidatedStateResult: recordInvalidatedTargets([]),
      }),
    ).rejects.toThrow("Unexpected onboarding live flow state before slice entry");
    expect(phase.run).not.toHaveBeenCalled();
    expect(sandboxPhase.run).not.toHaveBeenCalled();
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
    const phases: CoreOnboardFlowPhases<CoreContext> = {
      providerInference: {
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
      sandbox: {
        state: "sandbox",
        run: (ctx) => {
          calls.push("sandbox");
          return {
            context: { ...ctx, sandboxName: "created-sandbox" },
            result: advanceTo("openclaw", { metadata: { state: "sandbox" } }),
          };
        },
      },
    };

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
        const source = stateResult.metadata?.state;
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
      recordInvalidatedStateResult: async (stateResult, invalidation) => {
        if (stateResult.type !== "transition") return runtimeSession;
        skipped.push(`${invalidation.sourceState ?? "unknown"}->${stateResult.next}`);
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
