// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared test scaffolding for handleProviderInferenceState specs. Extracted so
// the context-window regression cases can live in their own file without
// duplicating the deps/session factories (PR #6293 PRA-6). Not a *.test.ts
// file, so Vitest does not collect it as a suite.

import { vi } from "vitest";

import type {
  CurrentGatewayRouteCompatibilityCheck,
  CurrentGatewayRouteDiscoveryPreflight,
} from "../../../inference/gateway-route-compatibility";
import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import type { ProviderInferenceStateOptions, ProviderSelectionResult } from "./provider-inference";

export type Gpu = { type: string } | null;
export type Agent = { name: string; inference?: { provider_type?: string } } | null;
export type Host = { cpus?: number };

export const baseSelection: ProviderSelectionResult = {
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

export function createDeps(
  overrides: Partial<ProviderInferenceStateOptions<Gpu, Agent, Host>["deps"]> = {},
) {
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
    setupNim: vi.fn(async () => ({ ...baseSelection })),
    setupInference: vi.fn(async () => ({ ok: true as const })),
    startStep: vi.fn(async () => undefined),
    complete: vi.fn(async () => createSession()),
    skipped: vi.fn(),
    recoverProvider: vi.fn(
      async (
        _gatewayName: string,
        _provider: string | null | undefined,
        credentialEnv: string | null | undefined,
      ) => ({
        forceInferenceSetup: false,
        credentialEnv: credentialEnv ?? null,
      }),
    ),
    surfaceReady: vi.fn(() => true),
    recordSkip: vi.fn(async () => createSession()),
    repairEvent: vi.fn(async () => createSession()),
    hydrate: vi.fn(),
    repair: vi.fn(),
    routeReady: vi.fn((_gatewayName: string, _provider: string, _model: string) => false),
    reconcileRouter: vi.fn(async () => undefined),
    reupsertRoutedProvider: vi.fn(
      (
        _gatewayName: string,
        _provider: string,
        endpointUrl: string | null,
        _credentialEnv: string | null,
      ) => ({
        ok: true as const,
        endpointUrl: "http://host.openshell.internal:4000/v1",
      }),
    ),
    reserveRoute: vi.fn(() => true),
    updateSandbox: vi.fn(),
    promptName: vi.fn(async () => "my-assistant"),
    promptYesNo: vi.fn(async () => true),
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
    deleteEnv: vi.fn(),
  };
  return {
    calls,
    deps: {
      checkGatewayRouteCompatibility: calls.checkGatewayRouteCompatibility,
      preflightGatewayRouteDiscovery: calls.preflightGatewayRouteDiscovery,
      withGatewayRouteMutationLock: async <T>(
        _gatewayName: string,
        operation: () => Promise<T> | T,
      ) => await operation(),
      normalizeHermesAuthMethod: (value: string | null | undefined) =>
        value === "oauth" || value === "api_key" ? value : null,
      setupNim: calls.setupNim,
      setupInference: calls.setupInference,
      startRecordedStep: calls.startStep,
      recordStepComplete: calls.complete,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      skippedStepMessage: calls.skipped,
      ensureResumeProviderReady: calls.recoverProvider,
      isResumeProviderSurfaceReady: calls.surfaceReady,
      recordStateSkipped: calls.recordSkip,
      recordRepairEvent: calls.repairEvent,
      hydrateCredentialEnv: calls.hydrate,
      configureCompatibleEndpointReasoning: async (value?: string | null) =>
        value === "true" ? "true" : "false",
      clearCompatibleEndpointReasoning: () => null,
      repairLocalInferenceSystemdOverrideOrExit: calls.repair,
      isNonInteractive: () => true,
      getOpenshellBinary: () => "/usr/bin/openshell",
      needsBedrockRuntimeAdapter: () => false,
      isInferenceRouteReady: calls.routeReady,
      isRoutedInferenceProvider: (provider: string) => provider === "nvidia-router",
      reconcileModelRouter: calls.reconcileRouter,
      reupsertRoutedProvider: calls.reupsertRoutedProvider,
      reserveSandboxInferenceRoute: calls.reserveRoute,
      registryUpdateSandbox: calls.updateSandbox,
      promptValidatedSandboxName: calls.promptName,
      assessHost: () => ({ cpus: 8 }),
      formatSandboxBuildEstimateNote: () => "estimate",
      formatOnboardConfigSummary: (options: {
        provider: string;
        model: string;
        sandboxName: string;
      }) => `summary:${options.provider}/${options.model}/${options.sandboxName}`,
      promptYesNoOrDefault: calls.promptYesNo,
      cliName: () => "nemoclaw",
      log: calls.log,
      error: calls.error,
      exitProcess: calls.exit,
      deleteEnv: calls.deleteEnv,
      ...overrides,
    },
  };
}

export function baseOptions(
  deps: ProviderInferenceStateOptions<Gpu, Agent, Host>["deps"],
  session: Session | null = createSession(),
): ProviderInferenceStateOptions<Gpu, Agent, Host> {
  return {
    gatewayName: "nemoclaw",
    resume: false,
    fresh: false,
    session,
    gpu: { type: "nvidia" },
    sandboxName: null,
    agent: null,
    initial: {
      model: session?.model ?? null,
      provider: session?.provider ?? null,
      endpointUrl: session?.endpointUrl ?? null,
      credentialEnv: session?.credentialEnv ?? null,
      hermesAuthMethod: session?.hermesAuthMethod ?? null,
      hermesToolGateways: session?.hermesToolGateways ?? [],
      preferredInferenceApi: session?.preferredInferenceApi ?? null,
      compatibleEndpointReasoning: session?.compatibleEndpointReasoning ?? null,
      nimContainer: session?.nimContainer ?? null,
      webSearchConfig: session?.webSearchConfig ?? null,
    },
    selectedMessagingChannels: [],
    env: {},
    constants: {
      hermesProviderName: "hermes-provider",
      hermesApiKeyAuthMethod: "api_key",
      hermesApiKeyCredentialEnv: "NOUS_API_KEY",
    },
    deps,
  };
}
