// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  CurrentGatewayRouteCompatibilityCheck,
  CurrentGatewayRouteDiscoveryPreflight,
} from "../../../inference/gateway-route-compatibility";
import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import {
  handleProviderInferenceState,
  type ProviderInferenceStateOptions,
  type ProviderSelectionResult,
} from "./provider-inference";

type Options = ProviderInferenceStateOptions<null, null, { cpus?: number }>;

const fallbackSelection: ProviderSelectionResult = {
  model: "nvidia/test",
  provider: "nvidia-prod",
  endpointUrl: "https://integrate.api.nvidia.com/v1",
  credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  hermesAuthMethod: null,
  hermesToolGateways: [],
  preferredInferenceApi: "openai-responses",
  compatibleEndpointReasoning: null,
  nimContainer: null,
};

function createDeps() {
  const calls = {
    checkGatewayRouteCompatibility: vi.fn<CurrentGatewayRouteCompatibilityCheck>(() => ({
      ok: true,
    })),
    preflightGatewayRouteDiscovery: vi.fn<CurrentGatewayRouteDiscoveryPreflight>(() => ({
      ok: true,
      requiredModel: null,
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    })),
    selectionProbe: vi.fn(),
    canProbeResult: vi.fn(),
    routeConstraints: vi.fn(),
    setupNim: vi.fn<Options["deps"]["setupNim"]>(
      async (_gpu, _sandbox, _agent, _recover, _gateway, guard, canProbeRoute) => {
        calls.canProbeResult(canProbeRoute?.(fallbackSelection.provider));
        calls.routeConstraints(
          guard?.({
            provider: fallbackSelection.provider,
            model: fallbackSelection.model,
            endpointUrl: fallbackSelection.endpointUrl,
            credentialEnv: fallbackSelection.credentialEnv,
            preferredInferenceApi: fallbackSelection.preferredInferenceApi,
          }),
        );
        calls.selectionProbe();
        return { ...fallbackSelection };
      },
    ),
    setupInference: vi.fn(async () => ({ ok: true as const })),
    recordStepComplete: vi.fn(async () => createSession()),
    surfaceReady: vi.fn(() => true),
    reconcileRouter: vi.fn(async () => undefined),
    reupsertRoutedProvider: vi.fn(
      (_provider: string, endpointUrl: string | null, _credentialEnv: string | null) => ({
        ok: true as const,
        endpointUrl: endpointUrl ?? "http://host.openshell.internal:4000/v1",
      }),
    ),
    updateSandbox: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
  const deps: Options["deps"] = {
    checkGatewayRouteCompatibility: calls.checkGatewayRouteCompatibility,
    preflightGatewayRouteDiscovery: calls.preflightGatewayRouteDiscovery,
    getSandboxRecoveryAuthority: (): "missing" => "missing",
    withGatewayRouteMutationLock: async (_gatewayName, operation) => await operation(),
    normalizeHermesAuthMethod: () => null,
    setupNim: calls.setupNim,
    setupInference: calls.setupInference,
    startRecordedStep: vi.fn(async () => undefined),
    recordStepComplete: calls.recordStepComplete,
    toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
    skippedStepMessage: vi.fn(),
    ensureResumeProviderReady: vi.fn(async (_gatewayName, _provider, credentialEnv) => ({
      forceInferenceSetup: false,
      credentialEnv: credentialEnv ?? null,
    })),
    isResumeProviderSurfaceReady: calls.surfaceReady,
    recordStateSkipped: vi.fn(async () => createSession()),
    recordRepairEvent: vi.fn(async () => createSession()),
    hydrateCredentialEnv: vi.fn(() => "test-key"),
    configureCompatibleEndpointReasoning: vi.fn(async () => "false" as const),
    clearCompatibleEndpointReasoning: () => null,
    repairLocalInferenceSystemdOverrideOrExit: vi.fn(),
    isNonInteractive: () => true,
    getOpenshellBinary: () => "/usr/bin/openshell",
    needsBedrockRuntimeAdapter: () => false,
    isInferenceRouteReady: () => true,
    isRoutedInferenceProvider: (provider) => provider === "nvidia-router",
    reconcileModelRouter: calls.reconcileRouter,
    reupsertRoutedProvider: calls.reupsertRoutedProvider,
    reserveSandboxInferenceRoute: vi.fn(() => true),
    registryUpdateSandbox: calls.updateSandbox,
    promptValidatedSandboxName: vi.fn(async () => "target-sandbox"),
    assessHost: () => ({ cpus: 8 }),
    formatSandboxBuildEstimateNote: () => "estimate",
    formatOnboardConfigSummary: ({ provider, model, sandboxName }) =>
      `summary:${provider}/${model}/${sandboxName}`,
    promptYesNoOrDefault: vi.fn(async () => true),
    cliName: () => "nemoclaw",
    log: calls.log,
    error: calls.error,
    exitProcess: calls.exit,
    deleteEnv: vi.fn(),
  };
  return { calls, deps };
}

function resumeOptions(
  deps: Options["deps"],
  session: Session,
  selectedMessagingChannels: string[] = [],
): Options {
  return {
    gatewayName: "nemoclaw-9090",
    resume: true,
    fresh: false,
    session,
    gpu: null,
    sandboxName: "target-sandbox",
    agent: null,
    initial: {
      model: session.model,
      provider: session.provider,
      endpointUrl: session.endpointUrl,
      credentialEnv: session.credentialEnv,
      hermesAuthMethod: session.hermesAuthMethod,
      hermesToolGateways: session.hermesToolGateways ?? [],
      preferredInferenceApi: session.preferredInferenceApi,
      compatibleEndpointReasoning: session.compatibleEndpointReasoning,
      nimContainer: session.nimContainer,
      webSearchConfig: session.webSearchConfig,
    },
    selectedMessagingChannels,
    env: {},
    constants: {
      hermesProviderName: "hermes-provider",
      hermesApiKeyAuthMethod: "api_key",
      hermesApiKeyCredentialEnv: "NOUS_API_KEY",
    },
    deps,
  };
}

function reportDifferentRoute(
  calls: ReturnType<typeof createDeps>["calls"],
  provider: string,
  model: string,
) {
  calls.checkGatewayRouteCompatibility.mockReturnValue({
    ok: false,
    gatewayName: "nemoclaw-9090",
    sandboxName: "target-sandbox",
    route: { provider, model },
    conflicts: [{ sandboxName: "existing-sandbox", reason: "provider-model" }],
  });
  calls.preflightGatewayRouteDiscovery.mockReturnValue({
    ok: false,
    result: {
      ok: false,
      gatewayName: "nemoclaw-9090",
      sandboxName: "target-sandbox",
      route: { provider, model },
      conflicts: [{ sandboxName: "existing-sandbox", reason: "provider-model" }],
    },
  });
}

describe("provider route containment", () => {
  it("allows fresh selection to continue so setup can issue the mutation warning (#6315)", async () => {
    const { calls, deps } = createDeps();
    reportDifferentRoute(calls, "nvidia-prod", "nvidia/test");
    const options = resumeOptions(deps, createSession());

    await expect(
      handleProviderInferenceState({ ...options, resume: false, sandboxName: null }),
    ).resolves.toMatchObject({
      sandboxName: "target-sandbox",
      provider: "nvidia-prod",
      model: "nvidia/test",
    });

    expect(calls.setupNim).toHaveBeenCalledOnce();
    expect(calls.preflightGatewayRouteDiscovery).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-9090",
      sandboxName: null,
      route: {
        provider: "nvidia-prod",
        model: "nvidia/test",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        preferredInferenceApi: "openai-responses",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      },
    });
    expect(calls.checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({ provider: "nvidia-prod", model: "nvidia/test" }),
      }),
    );
    expect(calls.selectionProbe).toHaveBeenCalledOnce();
    expect(calls.canProbeResult).toHaveBeenCalledWith(true);
    expect(calls.routeConstraints).toHaveBeenCalledWith({
      requiredModel: null,
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    });
    expect(calls.recordStepComplete).toHaveBeenCalled();
    expect(calls.surfaceReady).not.toHaveBeenCalled();
    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.error).not.toHaveBeenCalled();
  });

  it("does not constrain fresh selection to a valid peer route (#6315)", async () => {
    const { calls, deps } = createDeps();
    calls.preflightGatewayRouteDiscovery.mockReturnValue({
      ok: true,
      requiredModel: "peer/model",
      requiredEndpointUrl: "https://peer.example.test/v1",
      requiredInferenceApi: "openai-completions",
    });
    const options = resumeOptions(deps, createSession());

    await expect(
      handleProviderInferenceState({ ...options, resume: false, sandboxName: null }),
    ).resolves.toMatchObject({
      provider: "nvidia-prod",
      model: "nvidia/test",
    });

    expect(calls.routeConstraints).toHaveBeenCalledWith({
      requiredModel: null,
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    });
    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.error).not.toHaveBeenCalled();
  });

  it("allows routed-provider repair across a valid peer-route difference (#6315)", async () => {
    const session = createSession({ provider: "nvidia-router", model: "router/model" });
    session.steps.provider_selection.status = "complete";
    const { calls, deps } = createDeps();
    reportDifferentRoute(calls, "nvidia-router", "router/model");

    await expect(handleProviderInferenceState(resumeOptions(deps, session))).resolves.toMatchObject(
      {
        provider: "nvidia-router",
        model: "router/model",
      },
    );

    expect(calls.checkGatewayRouteCompatibility).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-9090",
      sandboxName: "target-sandbox",
      route: {
        provider: "nvidia-router",
        model: "router/model",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
      },
    });
    expect(calls.reconcileRouter).toHaveBeenCalledOnce();
    expect(calls.surfaceReady).toHaveBeenCalledOnce();
    expect(calls.reupsertRoutedProvider).toHaveBeenCalledOnce();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("rechecks routed repair after waiting for the gateway lock (#6315)", async () => {
    const session = createSession({ provider: "nvidia-router", model: "router/model" });
    session.steps.provider_selection.status = "complete";
    const { calls, deps } = createDeps();
    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let reportLockEntered!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      reportLockEntered = resolve;
    });
    deps.withGatewayRouteMutationLock = async (_gatewayName, operation) => {
      reportLockEntered();
      await lockReleased;
      return await operation();
    };

    const repair = handleProviderInferenceState(resumeOptions(deps, session));
    await lockEntered;
    reportDifferentRoute(calls, "nvidia-router", "router/model");
    releaseLock();

    await expect(repair).resolves.toMatchObject({ provider: "nvidia-router" });
    expect(calls.reconcileRouter).toHaveBeenCalledOnce();
    expect(calls.reupsertRoutedProvider).toHaveBeenCalledOnce();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("allows compatible-endpoint refresh to reach the final setup boundary (#6315)", async () => {
    const session = createSession({
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: "https://example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const { calls, deps } = createDeps();
    reportDifferentRoute(calls, "compatible-endpoint", "custom/model");

    await expect(
      handleProviderInferenceState(resumeOptions(deps, session, ["telegram"])),
    ).resolves.toMatchObject({ provider: "compatible-endpoint", model: "custom/model" });

    expect(calls.checkGatewayRouteCompatibility).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-9090",
      sandboxName: "target-sandbox",
      route: {
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl: "https://example.test/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
    });
    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.surfaceReady).toHaveBeenCalledOnce();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.error).not.toHaveBeenCalled();
  });

  it("still blocks incomplete registered route metadata (#6315)", async () => {
    const session = createSession();
    session.steps.provider_selection.status = "complete";
    const { calls, deps } = createDeps();
    calls.checkGatewayRouteCompatibility.mockReturnValue({
      ok: false,
      gatewayName: "nemoclaw-9090",
      sandboxName: "target-sandbox",
      route: { provider: "nvidia-prod", model: "nvidia/test" },
      conflicts: [{ sandboxName: "broken-sandbox", reason: "incomplete-route" }],
    });

    await expect(handleProviderInferenceState(resumeOptions(deps, session))).rejects.toThrow(
      "exit 1",
    );

    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("broken-sandbox"));
    expect(calls.setupInference).not.toHaveBeenCalled();
  });
});
