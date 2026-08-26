// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type InferenceEndpointSource,
  normalizeInferenceSelection,
} from "../../inference/selection";
import { createSession, type Session, type SessionUpdates } from "../../state/onboard-session";
import {
  getSandbox,
  isPendingReservationForSession,
  removeSandbox,
  reserveSandboxInferenceRoute,
} from "../../state/registry";
import { classifySandboxInferenceRouteReservation } from "../../state/registry/route-reservation";
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
import type { OnboardPrerequisiteRepairEventRecorder } from "./prerequisite-repair";
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

    compatibleEndpointReasoningEffort: null,
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

function repairRecorder(events: string[] = []): OnboardPrerequisiteRepairEventRecorder {
  return async (type, options) => {
    events.push(`${type}:${options.state ?? "unknown"}`);
  };
}

function createPhases(
  overrides: {
    endpointProvenance?: Partial<EndpointProvenanceOptions>;
    providerDeps?: Partial<ProviderOptions["deps"]>;
    sandboxOptions?: Partial<Omit<SandboxOptions, "deps">>;
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
      withModelRouterPortLifecycleLock: async <T>(
        _port: number,
        operation: () => Promise<T> | T,
      ) => await operation(),
      getModelRouterPort: () => 4000,
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

        compatibleEndpointReasoningEffort: null,
        nimContainer: "nim-test",
      })),
      setupInference: vi.fn(async () => ({ ok: true as const })),
      resolveHostLocalInferenceStartupSelection: vi.fn(() => null),
      startRecordedStep: vi.fn(async () => undefined),
      recordStepComplete: vi.fn(async (_stepName: string, updates: SessionUpdates = {}) =>
        sessionWithUpdates(updates),
      ),
      recordStepRejected: vi.fn(async () => createSession()),
      toSessionUpdates: (updates) => updates as SessionUpdates,
      skippedStepMessage: vi.fn(),
      ensureManagedLlamaCppResumeReady: vi.fn(async () => false),
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

      configureCompatibleEndpointReasoningEffort: vi.fn(async () => null),
      clearCompatibleEndpointReasoning: vi.fn(() => null),

      clearCompatibleEndpointReasoningEffort: vi.fn(() => null),
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
      checkpointSandboxIdentity: vi.fn(async () => undefined),
      prepareLocalProviderForInference: vi.fn(async () => null),
      promptValidatedSandboxName: vi.fn(async () => "my-sandbox"),
      assessHost: () => ({ memoryGb: 64 }),
      formatSandboxBuildEstimateNote: () => null,
      formatOnboardConfigSummary: () => "summary",
      prompt: vi.fn(async () => "1"),
      cliName: () => "nemoclaw",
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
      deleteEnv: vi.fn(),
      ...overrides.providerDeps,
      preflightPolicyRequirements:
        overrides.providerDeps?.preflightPolicyRequirements ?? (() => undefined),
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
    ...overrides.sandboxOptions,
    deps: {
      resolvePath: (value) => value,
      agentSupportsWebSearch: () => true,
      note: vi.fn(),

      cliName: () => "nemoclaw",
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
      ensureValidatedWebSearchCredential: vi.fn(async () => null),
      isBackToSelection: () => false,
      configureWebSearch: vi.fn(async () => null),
      startRecordedStep: vi.fn(async () => undefined),
      getRecordedMessagingChannelsForResume: () => null,
      setupMessagingChannels: vi.fn(async () => ["slack", "discord"]),
      readMessagingPlanFromEnv: () => null,
      writePlanToEnv: vi.fn(),
      clearPlanEnv: vi.fn(),
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: false, plan: null }),
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
      finalizeSandboxRouteReservation: vi.fn(() => true),
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
      preflightPolicyRequirements:
        overrides.sandboxDeps?.preflightPolicyRequirements ?? (() => undefined),
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
  it("preserves the fresh install-ollama reservation endpoint source for Hermes portable creation (#9203)", async () => {
    const durableSession = createSession();
    const sandboxName = `hermes-route-${durableSession.sessionId}`;
    const recordStepComplete = vi.fn(async (_stepName: string, updates: SessionUpdates = {}) => {
      Object.assign(durableSession, updates);
      return durableSession;
    });
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      const authority = args.at(-3) as { sessionId?: unknown } | null;
      const createIntent = args.at(-2) as {
        endpointSource?: InferenceEndpointSource | null;
      };
      const reservation = getSandbox(sandboxName);
      expect(authority).toEqual({ sessionId: durableSession.sessionId });
      expect(createIntent.endpointSource).toBeNull();
      expect(isPendingReservationForSession(reservation, authority?.sessionId as string)).toBe(
        true,
      );
      expect(
        classifySandboxInferenceRouteReservation(
          {
            sandboxName,
            gatewayName: "nemoclaw",
            sessionId: authority?.sessionId as string,
            selection: normalizeInferenceSelection({
              ...reservation,
              endpointSource: "onboard",
            }),
          },
          reservation,
        ).kind,
      ).toBe("conflict");
      expect(
        classifySandboxInferenceRouteReservation(
          {
            sandboxName,
            gatewayName: "nemoclaw",
            sessionId: authority?.sessionId as string,
            selection: normalizeInferenceSelection({
              ...reservation,
              endpointSource: createIntent.endpointSource,
            }),
          },
          reservation,
        ).kind,
      ).toBe("owned");
      return "created-sandbox";
    });
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      providerDeps: {
        setupNim: vi.fn(async () => ({
          model: "qwen3-vl:4b",
          provider: "ollama-local",
          endpointUrl: "http://inference.local/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        })),
        recordStepComplete,
        promptValidatedSandboxName: vi.fn(async () => sandboxName),
        setupInference: vi.fn(
          async (name, model, provider, endpointUrl, credentialEnv, _auth, _gateways, options) => {
            expect(options?.reservationSessionId).toBe(durableSession.sessionId);
            expect(
              reserveSandboxInferenceRoute(name, {
                provider,
                model,
                endpointUrl,
                endpointSource: options?.endpointSource ?? null,
                credentialEnv,
                preferredInferenceApi: options?.preferredInferenceApi ?? null,
                gatewayName: options?.gatewayName ?? "nemoclaw",
                reservationSessionId: options?.reservationSessionId,
              }),
            ).toBe(true);
            return { ok: true as const };
          },
        ),
      },
      sandboxDeps: {
        createSandbox,
        getSandboxRegistryEntry: getSandbox,
        promptValidatedSandboxName: vi.fn(async () => sandboxName),
      },
      sandboxOptions: { hermesPortableLifecycle: true },
    });

    try {
      const providerResult = await providerPhase.run(
        context({
          fresh: true,
          session: durableSession,
          agent: { name: "hermes" },
          sandboxName,
        }),
      );
      expect(providerResult.context).toMatchObject({
        provider: "ollama-local",
        model: "qwen3-vl:4b",
        endpointSource: null,
        hostLocalInferenceRouteOnly: false,
      });
      await sandboxPhase.run(providerResult.context);

      expect(createSandbox).toHaveBeenCalledOnce();
    } finally {
      removeSandbox(sandboxName);
    }
  });

  it("carries provider selection output into sandbox setup", async () => {
    const updateSandboxRegistry = vi.fn();
    const createSandbox = vi.fn(async () => "created-sandbox");
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      providerDeps: {
        setupNim: vi.fn(async () => ({
          model: "nvidia/test",
          provider: "compatible-endpoint",
          endpointUrl: "https://example.test/v1",
          credentialEnv: "NVIDIA_INFERENCE_API_KEY",
          hermesAuthMethod: null,
          hermesToolGateways: ["local"],
          preferredInferenceApi: "chat",
          compatibleEndpointReasoning: "true",
          compatibleEndpointReasoningEffort: null,
          nimContainer: "nim-test",
        })),
      },
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
      provider: "compatible-endpoint",
      endpointUrl: "https://example.test/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      hermesToolGateways: ["local"],
      preferredInferenceApi: "chat",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: null,
      nimContainer: "nim-test",
    });
    expect(Array.isArray(providerResult.result)).toBe(true);

    const sandboxResult = await sandboxPhase.run(providerResult.context);

    expect(sandboxResult.context).toMatchObject({
      sandboxName: "created-sandbox",
      model: "nvidia/test",
      provider: "compatible-endpoint",
      endpointUrl: "https://example.test/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      fromDockerfile: null,
      gpu: { platform: "linux" },
      sandboxGpuConfig: { mode: "cdi" },
      gpuPassthrough: true,
      hermesToolGateways: ["local"],
      preferredInferenceApi: "chat",
      compatibleEndpointReasoningEffort: null,
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
    expect(createSandbox.mock.calls[0]?.at(-2)).toMatchObject({
      compatibleEndpointReasoning: "true",
      deferSandboxEffectsUntilPolicyVerification: true,
      resolved: {
        inferenceProvider: "compatible-endpoint",
        extraProviders: ["current-provider"],
        staleExtraProviders: ["stale-provider"],
      },
    });
  });

  it("carries authoritative rebuild state into sandbox creation (#7803)", async () => {
    const createSandbox = vi.fn(async () => "created-sandbox");
    const rebuildPreservedEnv = [
      {
        path: ".env",
        assignments: ["SLACK_HOME_CHANNEL=C0123"],
      },
    ];
    const rebuildPolicyPresets = ["github"];
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      sandboxOptions: { rebuildPreservedEnv, rebuildPolicyPresets },
      sandboxDeps: { createSandbox },
    });

    const providerResult = await providerPhase.run(context({ agent: { name: "hermes" } }));
    await sandboxPhase.run(providerResult.context);

    expect(createSandbox.mock.calls[0]?.at(-2)).toMatchObject({
      rebuildPreservedEnv,
      rebuildPolicyPresets,
    });
  });

  it("defers normal-entry credential provider effects until policy verification and checkpoint publication", async () => {
    const events: string[] = [];
    const stageSandboxCredentialProviders = vi.fn(async () => {
      events.push("credential-provider-effect");
      return [];
    });
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      const createIntent = args.at(-2) as {
        deferSandboxEffectsUntilPolicyVerification?: boolean;
        resolved?: { policy?: { basePolicyPath?: string } };
      };
      const runVerifiedEffects = args.at(-1) as
        | ((context: {
            revalidatePolicyRequirements: (operation: string) => void;
          }) => Promise<void>)
        | undefined;
      expect(createIntent).toMatchObject({
        deferSandboxEffectsUntilPolicyVerification: true,
        resolved: { policy: { basePolicyPath: "/repo/policy.yaml" } },
      });
      expect(runVerifiedEffects).toEqual(expect.any(Function));
      expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
      events.push("policy-verified", "checkpoint-published");
      await runVerifiedEffects?.({
        revalidatePolicyRequirements: () => events.push("policy-checkpoint-revalidated"),
      });
      return "created-sandbox";
    });
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      sandboxDeps: { createSandbox, stageSandboxCredentialProviders },
    });

    const providerResult = await providerPhase.run(context());
    await sandboxPhase.run(providerResult.context);

    expect(events).toEqual([
      "policy-verified",
      "checkpoint-published",
      "policy-checkpoint-revalidated",
      "credential-provider-effect",
    ]);
  });

  it.each([
    ["post-create policy verification", "policy verification refused"],
    ["durable checkpoint publication", "checkpoint publication refused"],
  ])("withholds normal-entry provider effects when %s fails", async (_boundary, failure) => {
    const stageSandboxCredentialProviders = vi.fn(async () => []);
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      const createIntent = args.at(-2) as {
        deferSandboxEffectsUntilPolicyVerification?: boolean;
      };
      const runVerifiedEffects = args.at(-1);
      expect(createIntent.deferSandboxEffectsUntilPolicyVerification).toBe(true);
      expect(runVerifiedEffects).toEqual(expect.any(Function));
      expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
      throw new Error(failure);
    });
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      sandboxDeps: { createSandbox, stageSandboxCredentialProviders },
    });

    const providerResult = await providerPhase.run(context());
    await expect(sandboxPhase.run(providerResult.context)).rejects.toThrow(failure);

    expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
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

      compatibleEndpointReasoningEffort: null,
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
      expect.any(Function),
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
        revalidatePolicyRequirements: expect.any(Function),
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
      recordRepairEvent: async () => {
        throw new Error("repair recorder should not run on the exact-entry path");
      },
    });

    expect(phaseCalls).toEqual(["provider_selection", "sandbox"]);
    expect(runProviderInference).toHaveBeenCalledOnce();
    expect(runSandbox).toHaveBeenCalledOnce();
    expect(sandboxEffect).toHaveBeenCalledOnce();
    expect(sandboxEffect).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "https://example.test/v1" }),
    );
    expect(appliedTransitions).toEqual(["advance:inference", "advance:sandbox", "branch:openclaw"]);
    expect(result.context.endpointUrl).toBe("https://example.test/v1");
    expect(result.context.sandboxName).toBe("created-sandbox");
    expect(result.session.machine.state).toBe("openclaw");
  });

  it("runs the sandbox effect once at exact sandbox entry", async () => {
    const createSandbox = vi.fn(async () => "created-sandbox");
    const phases = createPhases({ sandboxDeps: { createSandbox } });
    const appliedTransitions: string[] = [];
    const repairEvents: string[] = [];
    let runtimeSession = createSession({
      machine: {
        version: 1,
        state: "sandbox",
        stateEnteredAt: "2026-06-09T00:02:00.000Z",
        revision: 7,
      },
    });

    const result = await runCoreOnboardFlowSlice({
      context: context({
        resume: true,
        model: "nvidia/test",
        provider: "nim",
        endpointUrl: "https://example.test/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
      runtime: {
        session: async () => runtimeSession,
        applyResult: async (stateResult) => {
          const transition = stateResult as ReturnType<typeof branchTo>;
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
      resume: true,
      recordRepairEvent: repairRecorder(repairEvents),
    });

    expect(createSandbox).toHaveBeenCalledOnce();
    expect(appliedTransitions).toEqual(["branch:agent_setup"]);
    expect(repairEvents).toEqual([
      "state.repair.started:provider_selection",
      "state.repair.completed:provider_selection",
    ]);
    expect(result.context.sandboxName).toBe("created-sandbox");
    expect(result.session.machine.state).toBe("agent_setup");
  });

  it.each([
    ["inference", true, ["advance:sandbox", "branch:openclaw"]],
    ["sandbox", true, ["branch:openclaw"]],
    ["sandbox", false, ["branch:openclaw"]],
  ] as const)("repairs provider context before strict %s entry", async (state, resume, expected) => {
    const calls: string[] = [];
    const applied: string[] = [];
    const repairEvents: string[] = [];
    let runtimeSession = createSession({
      machine: {
        version: 1,
        state,
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
            context: { ...ctx, endpointUrl: "https://example.test/v1" },
            result: [
              advanceTo("inference", { metadata: { state: "provider_selection" } }),
              advanceTo("sandbox", { metadata: { state: "inference" } }),
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
            result: branchTo("openclaw", { metadata: { state: "sandbox" } }),
          };
        },
      },
    };

    const result = await runCoreOnboardFlowSlice({
      context: context({ resume }),
      runtime: {
        session: async () => runtimeSession,
        applyResult: async (stateResult) => {
          if (stateResult.type === "transition") {
            applied.push(`${stateResult.transitionKind}:${stateResult.next}`);
            runtimeSession.machine = {
              ...runtimeSession.machine,
              state: stateResult.next,
              revision: runtimeSession.machine.revision + 1,
            };
          }
          return runtimeSession;
        },
      },
      phases,
      resume,
      recordRepairEvent: repairRecorder(repairEvents),
    });

    expect(calls).toEqual(["provider_selection", "sandbox"]);
    expect(applied).toEqual(expected);
    expect(repairEvents).toEqual([
      "state.repair.started:provider_selection",
      "state.repair.completed:provider_selection",
    ]);
    expect(result.context.endpointUrl).toBe("https://example.test/v1");
    expect(result.context.sandboxName).toBe("created-sandbox");
    expect(result.session.machine.state).toBe("openclaw");
  });

  it.each([
    "openclaw",
    "agent_setup",
    "policies",
    "finalizing",
    "post_verify",
  ] as const)("repairs core prerequisites without changing resumed %s entry", async (state) => {
    const repairEvents: string[] = [];
    const branchState = state === "agent_setup" ? "agent_setup" : "openclaw";
    const session = createSession({
      machine: {
        version: 1,
        state,
        stateEnteredAt: "2026-06-09T00:02:00.000Z",
        revision: 7,
      },
    });
    const phases: CoreOnboardFlowPhases<CoreContext> = {
      providerInference: {
        state: "provider_selection",
        run: (ctx) => ({
          context: { ...ctx, endpointUrl: "https://example.test/v1" },
          result: [
            advanceTo("inference", { metadata: { state: "provider_selection" } }),
            advanceTo("sandbox", { metadata: { state: "inference" } }),
          ],
        }),
      },
      sandbox: {
        state: "sandbox",
        run: (ctx) => ({
          context: { ...ctx, sandboxName: "created-sandbox" },
          result: branchTo(branchState, { metadata: { state: "sandbox" } }),
        }),
      },
    };

    const result = await runCoreOnboardFlowSlice({
      context: context({ resume: true }),
      runtime: {
        session: async () => session,
        applyResult: async () => {
          throw new Error("prerequisite repair must not apply a machine result");
        },
      },
      phases,
      resume: true,
      recordRepairEvent: repairRecorder(repairEvents),
    });

    expect(repairEvents).toEqual([
      "state.repair.started:provider_selection",
      "state.repair.completed:provider_selection",
      "state.repair.started:sandbox",
      "state.repair.completed:sandbox",
    ]);
    expect(result.session.machine.state).toBe(state);
    expect(result.context.sandboxName).toBe("created-sandbox");
  });

  it.each([
    "complete",
    "failed",
  ] as const)("rejects terminal %s sessions before core repair effects", async (state) => {
    const providerInference: OnboardSequencePhase<CoreContext> = {
      state: "provider_selection",
      run: vi.fn((ctx) => ({
        context: ctx,
        result: advanceTo("sandbox", { metadata: { state: "inference" } }),
      })),
    };
    const sandbox: OnboardSequencePhase<CoreContext> = {
      state: "sandbox",
      run: vi.fn((ctx) => ({
        context: ctx,
        result: branchTo("openclaw", { metadata: { state: "sandbox" } }),
      })),
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
        phases: { providerInference, sandbox },
        resume: true,
        recordRepairEvent: repairRecorder(),
      }),
    ).rejects.toThrow("Unexpected onboarding flow state before slice entry");
    expect(providerInference.run).not.toHaveBeenCalled();
    expect(sandbox.run).not.toHaveBeenCalled();
  });
});
