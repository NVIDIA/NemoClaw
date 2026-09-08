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
import {
  normalizeReasoningEffort,
  REASONING_EFFORT_ENV,
  resolveReasoningEffortRequest,
} from "../../reasoning-mode";
import {
  createProviderRecoveryReceiptLedger,
  mintProviderRecoveryReceipt,
  type ProviderRecoveryReceipt,
} from "../../rebuild-route-handoff";
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
  compatibleEndpointReasoningEffort: null,
  nimContainer: null,
};

/** Mint and activate a provider-recovery receipt bound to one session, as the rebuild assembly would. */
export function activatedRecoveryReceipt(input: {
  sandboxName: string;
  sessionId: string;
  gatewayName?: string;
  provider?: string;
  model?: string;
  endpointUrl?: string | null;
  preferredInferenceApi?: string | null;
  nowMs?: number;
  ledger?: ReturnType<typeof createProviderRecoveryReceiptLedger>;
}): {
  receipt: ProviderRecoveryReceipt;
  ledger: ReturnType<typeof createProviderRecoveryReceiptLedger>;
} {
  const gatewayName = input.gatewayName ?? "nemoclaw";
  const provider = input.provider ?? "compatible-endpoint";
  const model = input.model ?? "mock/channels-rebuild";
  const nowMs = input.nowMs ?? 0;
  const target = {
    sandboxName: input.sandboxName,
    gatewayName,
    provider,
    model,
    route: {
      provider,
      model,
      endpointUrl: input.endpointUrl ?? "https://compatible.example.test/v1",
      preferredInferenceApi: input.preferredInferenceApi ?? "openai-completions",
      source: "registry" as const,
    },
  };
  const ledger = input.ledger ?? createProviderRecoveryReceiptLedger();
  const minted = mintProviderRecoveryReceipt(target, {
    nonce: `nonce-${input.sandboxName}-${input.sessionId}`,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  });
  const receipt = ledger.activate(minted, { target, sessionId: input.sessionId, nowMs });
  if (!receipt) throw new Error("test recovery receipt failed to activate");
  return { receipt, ledger };
}

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
    setupInference: vi.fn<
      ProviderInferenceStateOptions<Gpu, Agent, Host>["deps"]["setupInference"]
    >(async () => ({ ok: true as const })),
    resolveHostLocalInferenceStartupSelection: vi.fn(() => null),
    startStep: vi.fn(async () => undefined),
    complete: vi.fn<ProviderInferenceStateOptions<Gpu, Agent, Host>["deps"]["recordStepComplete"]>(
      async () => createSession(),
    ),
    rejected: vi.fn(async () => createSession()),
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
    recoverManagedLlamaCpp: vi.fn(async () => false),
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
    checkpointSandboxIdentity: vi.fn(async () => undefined),
    prepareLocalProviderForInference: vi.fn(async () => null),
    promptName: vi.fn(async () => "my-assistant"),
    prompt: vi.fn(async () => "1"),
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
      getSandboxRecoveryAuthority: (): "missing" => "missing",
      withGatewayRouteMutationLock: async <T>(
        _gatewayName: string,
        operation: () => Promise<T> | T,
      ) => await operation(),
      withModelRouterPortLifecycleLock: async <T>(_port: number, operation: () => Promise<T> | T) =>
        await operation(),
      getModelRouterPort: () => 4000,
      normalizeHermesAuthMethod: (value: string | null | undefined) =>
        value === "oauth" || value === "api_key" ? value : null,
      setupNim: calls.setupNim,
      setupInference: calls.setupInference,
      resolveHostLocalInferenceStartupSelection: calls.resolveHostLocalInferenceStartupSelection,
      startRecordedStep: calls.startStep,
      recordStepComplete: calls.complete,
      recordStepRejected: calls.rejected,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      skippedStepMessage: calls.skipped,
      ensureManagedLlamaCppResumeReady: calls.recoverManagedLlamaCpp,
      ensureResumeProviderReady: calls.recoverProvider,
      isResumeProviderSurfaceReady: calls.surfaceReady,
      recordStateSkipped: calls.recordSkip,
      recordRepairEvent: calls.repairEvent,
      hydrateCredentialEnv: calls.hydrate,
      configureCompatibleEndpointReasoning: async (value?: string | null) =>
        value === "true" ? "true" : "false",
      clearCompatibleEndpointReasoning: () => null,
      configureCompatibleEndpointReasoningEffort: async (
        value?: unknown,
        env: NodeJS.ProcessEnv = process.env,
        allowRequestFallback = true,
      ) => {
        const configured =
          normalizeReasoningEffort(value) ??
          (allowRequestFallback ? resolveReasoningEffortRequest(null, env).effort : null);
        if (configured) {
          env[REASONING_EFFORT_ENV] = configured;
        } else {
          delete env[REASONING_EFFORT_ENV];
        }
        return configured;
      },
      clearCompatibleEndpointReasoningEffort: () => null,
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
      checkpointSandboxIdentity: calls.checkpointSandboxIdentity,
      prepareLocalProviderForInference: calls.prepareLocalProviderForInference,
      promptValidatedSandboxName: calls.promptName,
      assessHost: () => ({ cpus: 8 }),
      formatSandboxBuildEstimateNote: () => "estimate",
      formatOnboardConfigSummary: (options: {
        provider: string;
        model: string;
        sandboxName: string;
      }) => `summary:${options.provider}/${options.model}/${options.sandboxName}`,
      prompt: calls.prompt,
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
    gpuPassthrough: true,
    sandboxName: null,
    agent: null,
    initial: {
      model: session?.model ?? null,
      provider: session?.provider ?? null,
      endpointUrl: session?.endpointUrl ?? null,
      endpointSource: null,
      credentialEnv: session?.credentialEnv ?? null,
      hermesAuthMethod: session?.hermesAuthMethod ?? null,
      hermesToolGateways: session?.hermesToolGateways ?? [],
      preferredInferenceApi: session?.preferredInferenceApi ?? null,
      compatibleEndpointReasoning: session?.compatibleEndpointReasoning ?? null,
      compatibleEndpointReasoningEffort: session?.compatibleEndpointReasoningEffort ?? null,
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
