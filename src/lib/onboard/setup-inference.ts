// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalEndpoint } from "../core/url-utils";
import { isBedrockRuntimeEndpoint } from "../inference/bedrock-runtime";
import {
  assertEndpointResolvesPublic,
  type EndpointDnsLookupFn,
  parseTrustedPrivateInferenceHostsFromEnv,
} from "../inference/endpoint-ssrf-preflight";
import {
  type CurrentGatewayRouteCompatibilityCheck,
  formatGatewayRouteConflict,
  formatGatewayRouteImpactWarning,
  isAdvisoryGatewayRouteConflict,
} from "../inference/gateway-route-compatibility";
import {
  withGatewayRouteMutationLock,
  withModelRouterPortLifecycleLock,
} from "../inference/gateway-route-mutation-lock";
import { getManagedVllmProviderBinding } from "../inference/local";
import {
  clearPendingOllamaModelCleanup,
  isLocalOllamaRouteOwner,
  loadPendingOllamaModelCleanup,
  type OllamaModelHolder,
  persistPendingOllamaModelCleanup,
  supersededOllamaModel,
} from "../inference/ollama/model-ownership";
import {
  getOllamaProxyToken,
  persistAndProbeOllamaProxy,
  startOllamaAuthProxy,
  type OllamaUnloadResult,
  withOllamaModelOwnershipLock,
  withOllamaModelOwnershipTransaction,
} from "../inference/ollama/proxy";
import {
  assertNoOpenShellGatewayEndpointOverride,
  scopeGatewayOpenshellArgs,
  type OpenShellGatewayEndpointEnvironment,
} from "../adapters/openshell/gateway-scope";
import { withSandboxMutationLock } from "../state/mcp-lifecycle-lock";
import type { Session } from "../state/onboard-session";
import { createSandboxHostLocalInferenceProvenance } from "../state/registry/host-local-inference";
import { shouldFrontOllamaWithProxy } from "./local-inference-topology";
import { resolveModelRouterPort } from "./model-router";
import {
  type RoutedProviderDeps,
  upsertRoutedProvider as upsertRoutedInferenceProvider,
} from "./routed-inference";

export { assertNoOpenShellGatewayEndpointOverride };

export function createProviderReviewDeps(
  updateSession: (mutator: (session: Session) => Session | void) => Session | Promise<Session>,
  checkpointSandboxName: (
    sandboxName: string,
    agent: { name?: string } | null,
    updateSession: (mutator: (session: Session) => Session | void) => Session | Promise<Session>,
  ) => Promise<void>,
  localProvider: {
    shouldFrontOllamaWithProxy: () => boolean;
    startOllamaAuthProxy: () => boolean;
    getOllamaProxyToken: () => string | null;
    persistAndProbeOllamaProxy: (token: string) => Promise<void>;
  },
  exitProcess: (code: number) => never,
  writeError: (message: string) => void,
) {
  return {
    checkpointSandboxIdentity: (sandboxName: string, agent: { name?: string } | null) =>
      checkpointSandboxName(sandboxName, agent, updateSession),
    prepareLocalProviderForInference: async (providerName: string) => {
      if (providerName !== "ollama-local" || !localProvider.shouldFrontOllamaWithProxy()) {
        return null;
      }
      if (!localProvider.startOllamaAuthProxy()) exitProcess(1);
      const proxyToken = localProvider.getOllamaProxyToken();
      if (!proxyToken) {
        writeError("  Ollama auth proxy token is not set. Re-run onboard to initialize the proxy.");
        exitProcess(1);
      }
      await localProvider.persistAndProbeOllamaProxy(proxyToken);
      return proxyToken;
    },
  };
}

export function createDefaultProviderReviewDeps(
  updateSession: Parameters<typeof createProviderReviewDeps>[0],
  checkpointSandboxName: Parameters<typeof createProviderReviewDeps>[1],
) {
  return createProviderReviewDeps(
    updateSession,
    checkpointSandboxName,
    {
      shouldFrontOllamaWithProxy,
      startOllamaAuthProxy,
      getOllamaProxyToken,
      persistAndProbeOllamaProxy,
    },
    process.exit,
    console.error,
  );
}

import type { HermesAuthMethod } from "./hermes-auth";

function matchesOnboardEndpoint(
  provider: string,
  endpointUrl: string | null,
  onboardEndpointUrl: string | undefined,
): boolean {
  if (!endpointUrl || !onboardEndpointUrl) return false;
  const flavor = provider === "compatible-anthropic-endpoint" ? "anthropic" : "openai";
  const selected = canonicalEndpoint(endpointUrl, flavor);
  return selected !== null && selected === canonicalEndpoint(onboardEndpointUrl, flavor);
}

import type {
  CommonDeps,
  HermesDeps,
  OllamaDeps,
  RemoteProviderDeps,
  RoutedDeps,
  SetupInferenceResult,
  VllmDeps,
} from "./inference-providers";
import * as inferenceProviders from "./inference-providers";
import {
  ensureOpenAiInferenceProviderProfile,
  type InferenceProviderProfileDeps,
  OPENAI_GATEWAY_PROVIDER_TYPE,
} from "./inference-providers/provider-profile";
import { createLocalInferenceRouteApplier } from "./local-inference-route";
import type { ProviderInferenceSetupOptions } from "./machine/handlers/provider-inference";
import {
  hostLocalInferenceRollbackStatus,
  normalizeHostLocalInferenceReceipt,
  normalizeHostLocalOllamaModelRef,
  serializeHostLocalInferenceReceipt,
} from "./runtime-provider/host-local-inference";
import {
  type HostLocalInferenceGatewayMutation,
  type HostLocalInferenceStartupRoute,
  hostLocalInferenceGatewayPort,
  hostLocalInferenceGatewayProvider,
  hostLocalInferenceOperationEnvironment,
  prepareHostLocalInferenceStartup,
  hostLocalInferenceRequestModel,
  hostLocalInferenceRequestToolCalling,
  hostLocalInferenceRuntimeOwnerSandboxName,
} from "./runtime-provider/host-local-inference-routing";
import { requireRuntimeProviderHostLocalInferenceOperation } from "./runtime-provider/registry";

type ProviderBranchDeps = Pick<
  CommonDeps,
  "verifyOnboardInferenceSmoke" | "isNonInteractive" | "exitProcess" | "error" | "log"
> &
  Pick<
    HermesDeps,
    | "lookup"
    | "hermesProviderAuth"
    | "getHermesToolGatewayBroker"
    | "normalizeHermesAuthMethod"
    | "resolveHermesNousApiKey"
    | "checkHermesProviderStoreReachable"
    | "hermesAuthMethodLabel"
    | "hermesConstants"
    | "requireValue"
    | "redact"
    | "compactText"
  > &
  Pick<
    RemoteProviderDeps,
    | "REMOTE_PROVIDER_CONFIG"
    | "hydrateCredentialEnv"
    | "promptValidationRecovery"
    | "classifyApplyFailure"
    | "bedrockRuntimeOnboard"
    | "openrouterRuntimeOnboard"
  > &
  Pick<
    VllmDeps,
    "validateLocalProvider" | "getLocalProviderHealthCheck" | "getLocalProviderBaseUrl"
  > &
  Pick<
    OllamaDeps,
    | "shouldFrontOllamaWithProxy"
    | "ensureOllamaAuthProxy"
    | "isProxyHealthy"
    | "getOllamaProxyToken"
    | "persistAndProbeOllamaProxy"
    | "localInference"
  > &
  Pick<RoutedDeps, "reconcileModelRouter" | "routedInference">;

export type SetupInferenceDeps = ProviderBranchDeps & {
  /** Injectable resolver for resumed custom-endpoint SSRF preflight tests. */
  resolveEndpointHost?: EndpointDnsLookupFn;
  /** Exact private endpoint hosts trusted by the operator (tests may inject this). */
  trustedPrivateEndpointHosts?: readonly string[];
  checkGatewayRouteCompatibility: CurrentGatewayRouteCompatibilityCheck;
  withGatewayRouteMutationLock: typeof withGatewayRouteMutationLock;
  withModelRouterPortLifecycleLock?: typeof withModelRouterPortLifecycleLock;
  getModelRouterPort?: () => number;
  withSandboxMutationLock: typeof withSandboxMutationLock;
  step: (current: number, total: number, label: string) => void;
  getGatewayName: () => string;
  runOpenshell: import("./openshell-cli").OpenshellCliHelpers["runOpenshell"];
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: NodeJS.ProcessEnv | undefined,
    gatewayName: string,
    options?: { revalidateSandboxIdentity?(operation: string): void },
  ) => ReturnType<CommonDeps["upsertProvider"]>;
  verifyInferenceRoute: (gatewayName: string, provider: string, model: string) => void;
  providerExistsInGateway: (name: string, gatewayName: string) => boolean;
  run: typeof import("../runner").run;
  updateSandbox: typeof import("../state/registry").reserveSandboxInferenceRoute;
  // #9110 optional GPU-release seams; omitted by test literals that build deps
  // by hand, so every read below must stay optional-chained.
  getSandbox?: typeof import("../state/registry").getSandbox;
  listSandboxes?: typeof import("../state/registry").listSandboxes;
  unloadOllamaModels?: (onlyModels: readonly string[]) => OllamaUnloadResult | void;
  withOllamaModelOwnershipLock?: typeof withOllamaModelOwnershipLock;
  withOllamaModelOwnershipTransaction?: typeof withOllamaModelOwnershipTransaction;
  localInferenceTimeoutSecs: number;
  vllmLocalCredentialEnv: string;
  getManagedVllmProviderBinding?: () => {
    baseUrl: string;
    validationBaseUrl?: string;
    apiKey: string;
  } | null;
  ollamaProxyCredentialEnv: string;
  isRoutedInferenceProvider: (provider: string) => boolean;
  applyLocalInferenceRoute?: VllmDeps["applyLocalInferenceRoute"];
  // #6294 optional overrides for the remote-provider OpenAI-surface branch;
  // production omits these and remote.ts falls back to the real modules.
  probeOpenAiLikeEndpoint?: RemoteProviderDeps["probeOpenAiLikeEndpoint"];
  readGatewayProviderMetadata?: RemoteProviderDeps["readGatewayProviderMetadata"];
  deleteGatewayProvider?: RemoteProviderDeps["deleteGatewayProvider"];
  log: (message: string) => void;
  error: (message: string) => void;
  exitProcess: (code: number) => never;
};

export function createGatewayScopedOpenshellRunner<Rest extends unknown[], Result>(
  runOpenshell: (args: string[], ...rest: Rest) => Result,
  gatewayName: string,
  env: OpenShellGatewayEndpointEnvironment = process.env,
): (args: string[], ...rest: Rest) => Result {
  assertNoOpenShellGatewayEndpointOverride(env);
  return (args, ...rest) => runOpenshell(scopeGatewayOpenshellArgs(args, gatewayName), ...rest);
}

export function bindGatewayUpsertProvider(
  upsertProvider: SetupInferenceDeps["upsertProvider"],
  gatewayName: string,
  revalidateSandboxIdentity?: (operation: string) => void,
): CommonDeps["upsertProvider"] {
  return (name, type, credentialEnv, baseUrl, env) =>
    revalidateSandboxIdentity
      ? upsertProvider(name, type, credentialEnv, baseUrl, env, gatewayName, {
          revalidateSandboxIdentity,
        })
      : upsertProvider(name, type, credentialEnv, baseUrl, env, gatewayName);
}

export function bindOpenAiProviderProfile(
  upsertProvider: CommonDeps["upsertProvider"],
  runOpenshell: InferenceProviderProfileDeps["runOpenshell"],
  error: CommonDeps["error"],
  exitProcess: CommonDeps["exitProcess"],
): CommonDeps["upsertProvider"] {
  return (name, type, ...rest) => {
    if (type === OPENAI_GATEWAY_PROVIDER_TYPE) {
      ensureOpenAiInferenceProviderProfile({
        runOpenshell,
        log: error,
        exit: exitProcess,
      });
    }
    return upsertProvider(name, type, ...rest);
  };
}

export function createRoutedResumeProviderUpsert(deps: {
  upsertProvider: SetupInferenceDeps["upsertProvider"];
  runGatewayOpenshell: InferenceProviderProfileDeps["runOpenshell"];
  hydrateCredentialEnv: RoutedProviderDeps["hydrateCredentialEnv"];
  error?: CommonDeps["error"];
  exitProcess?: CommonDeps["exitProcess"];
}) {
  return (
    gatewayName: string,
    provider: string,
    endpointUrl: string | null,
    credentialEnv: string | null,
  ) => {
    const result = upsertRoutedInferenceProvider(provider, endpointUrl, credentialEnv, {
      upsertProvider: bindOpenAiProviderProfile(
        bindGatewayUpsertProvider(deps.upsertProvider, gatewayName),
        deps.runGatewayOpenshell,
        deps.error ?? console.error,
        deps.exitProcess ?? ((code) => process.exit(code)),
      ),
      hydrateCredentialEnv: deps.hydrateCredentialEnv,
    });
    return {
      ok: result.ok,
      endpointUrl: result.endpointUrl,
      message: result.result.message,
      status: result.result.status,
    };
  };
}

export function selectGatewayForFollowupOrExit(
  gatewayName: string,
  runOpenshell: SetupInferenceDeps["runOpenshell"],
  error: (message: string) => void = console.error,
  exitProcess: (code: number) => never = (code) => process.exit(code),
): void {
  const selected = runOpenshell(["gateway", "select", gatewayName], { ignoreError: true });
  if (selected.status === 0) return;
  error(
    `  Error: OpenShell could not select managed gateway '${gatewayName}' after onboarding. ` +
      "No follow-up operations were run against an ambient gateway.",
  );
  exitProcess(typeof selected.status === "number" && selected.status !== 0 ? selected.status : 1);
}

function resolveLocalInferenceRouteApplier(
  deps: SetupInferenceDeps,
  runOpenshell: SetupInferenceDeps["runOpenshell"],
  revalidateSandboxIdentity?: (operation: string) => void,
) {
  return (
    deps.applyLocalInferenceRoute ??
    createLocalInferenceRouteApplier({
      runOpenshell,
      isNonInteractive: deps.isNonInteractive,
      promptValidationRecovery: (label, recovery, credentialEnv, helpUrl) =>
        deps.promptValidationRecovery(
          label,
          recovery,
          credentialEnv,
          helpUrl,
          revalidateSandboxIdentity,
        ),
      classifyApplyFailure: deps.classifyApplyFailure,
      compactText: deps.compactText,
      redact: deps.redact,
      localInferenceTimeoutSecs: deps.localInferenceTimeoutSecs,
      error: deps.error,
      exitProcess: deps.exitProcess,
    })
  );
}

const HOST_LOCAL_INFERENCE_DIAGNOSTIC_LIMIT = 240;
const RUNTIME_PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/u;

class HostLocalInferenceBranchExit extends Error {
  constructor(readonly code: number) {
    super(`Host-local inference provider branch requested exit ${String(code)}.`);
  }
}

function hostLocalInferenceProviderLabel(value: string): string {
  return RUNTIME_PROVIDER_ID.test(value) ? value : "invalid-runtime-provider";
}

function stripHostLocalInferenceUrlSecrets(value: string): string {
  return value.replace(/https?:\/\/[^\s]+/giu, (candidate) => {
    try {
      const parsed = new URL(candidate);
      return `${parsed.protocol}//${parsed.host}/[redacted]`;
    } catch {
      return "[redacted-url]";
    }
  });
}

function hostLocalInferenceFailureDetail(error: unknown, deps: SetupInferenceDeps): string {
  try {
    const raw = error instanceof Error ? error.message : String(error);
    const redacted = stripHostLocalInferenceUrlSecrets(deps.redact(raw));
    const detail = deps.compactText(redacted).slice(0, HOST_LOCAL_INFERENCE_DIAGNOSTIC_LIMIT);
    return detail || "provider-native failure detail unavailable";
  } catch {
    return "provider-native failure detail unavailable";
  }
}

function emitHostLocalInferenceFailure(
  providerId: string,
  error: unknown,
  deps: SetupInferenceDeps,
): void {
  deps.error(
    `  Host-local inference failure [runtime provider '${hostLocalInferenceProviderLabel(providerId)}']: ${hostLocalInferenceFailureDetail(error, deps)}`,
  );
}

function assertHostLocalInferenceRollback(
  route: HostLocalInferenceStartupRoute,
  result: ReturnType<HostLocalInferenceStartupRoute["prepared"]["rollback"]>,
): void {
  if (
    serializeHostLocalInferenceReceipt(normalizeHostLocalInferenceReceipt(result.receipt)) !==
    serializeHostLocalInferenceReceipt(route.receipt)
  ) {
    throw new Error("Host-local inference rollback returned a different runtime authority.");
  }
  const expectedStatus = hostLocalInferenceRollbackStatus(result.priorState);
  if (result.status !== expectedStatus || result.priorState !== route.prepared.rollbackPriorState) {
    throw new Error("Host-local inference rollback returned ambiguous prior-runtime evidence.");
  }
}

async function rollbackHostLocalInferenceStartup(
  providerId: string,
  route: HostLocalInferenceStartupRoute,
  gatewayMutation: HostLocalInferenceGatewayMutation | null,
  deps: SetupInferenceDeps,
): Promise<void> {
  if (gatewayMutation) {
    try {
      await gatewayMutation.rollback();
    } catch (error) {
      emitHostLocalInferenceFailure(providerId, error, deps);
      throw new Error(
        "Host-local inference gateway rollback is indeterminate; retaining the exact runtime for recovery.",
      );
    }
  }
  try {
    assertHostLocalInferenceRollback(route, route.prepared.rollback());
  } catch (error) {
    emitHostLocalInferenceFailure(providerId, error, deps);
    throw new Error("Host-local inference rollback evidence is incomplete or indeterminate.");
  }
}

function resolveHostLocalInferenceRoute(
  sandboxName: string | null,
  model: string,
  provider: string,
  requireToolCalling: boolean,
  selection: NonNullable<ProviderInferenceSetupOptions["hostLocalInference"]>,
): HostLocalInferenceStartupRoute {
  const { request } = selection;
  const expectedProvider = hostLocalInferenceGatewayProvider(request);
  if (expectedProvider !== provider) {
    throw new Error(`Host-local ${request.service} cannot configure provider '${provider}'.`);
  }
  if (!sandboxName) {
    throw new Error("Host-local inference requires a sandbox-bound runtime provider.");
  }
  if (!RUNTIME_PROVIDER_ID.test(selection.runtimeProviderId)) {
    throw new Error("Host-local inference selected a malformed runtime-provider identity.");
  }
  const selectedModel =
    request.service === "ollama" ? normalizeHostLocalOllamaModelRef(model) : model;
  const requestedModel = hostLocalInferenceRequestModel(request);
  if (
    requestedModel !== selectedModel ||
    hostLocalInferenceRequestToolCalling(request) !== requireToolCalling
  ) {
    throw new Error("Host-local inference request drifted from the accepted model proof.");
  }
  const providerBundle = selection.resolveRuntimeProvider(sandboxName);
  if (!providerBundle) {
    throw new Error(`Sandbox '${sandboxName}' has no host-local inference runtime provider.`);
  }
  if (providerBundle.identity.id !== selection.runtimeProviderId) {
    throw new Error("Sandbox-bound host-local inference runtime-provider identity drifted.");
  }
  const operation =
    request.service === "llama-cpp"
      ? requireRuntimeProviderHostLocalInferenceOperation(
          providerBundle,
          request.service,
          { env: hostLocalInferenceOperationEnvironment(request.service) },
          request.adapter.operation,
        )
      : requireRuntimeProviderHostLocalInferenceOperation(providerBundle, request.service, {
          env: hostLocalInferenceOperationEnvironment(request.service),
          acceleration:
            request.service === "ollama" && "endpoint" in request
              ? request.endpoint.acceleration
              : "nvidia-gpu",
        });
  return prepareHostLocalInferenceStartup(operation, request);
}

export type SetupInference = (
  sandboxName: string | null,
  model: string,
  provider: string,
  endpointUrl?: string | null,
  credentialEnv?: string | null,
  hermesAuthMethod?: HermesAuthMethod | string | null,
  hermesToolGateways?: string[],
  options?: ProviderInferenceSetupOptions,
) => Promise<SetupInferenceResult>;

/**
 * Release the GPU memory an Ollama-backed sandbox held before this onboarding
 * moved it to a different model (#9110).
 *
 * Runs after the route mutation, so the new route is already proven by
 * `verifyOnboardInferenceSmoke` before the old memory is freed. Best-effort:
 * the route is committed by this point, so GPU cleanup must never change the
 * result or the exit code.
 */
function releaseSupersededOllamaModel(
  previous: OllamaModelHolder | null,
  nextProvider: string,
  nextModel: string,
  nextEndpointUrl: string | null,
  result: SetupInferenceResult,
  deps: SetupInferenceDeps,
  revalidateSandboxIdentity?: (operation: string) => void,
): void {
  // A reselection retry left the recorded route untouched, so the sandbox
  // still owns its model.
  if (!previous || result.retry) return;
  let authorityRefusal: unknown;
  let cleanupWarning: string | null = null;
  let attemptedModels: readonly string[] = [];
  let pendingRecordFailure: string | null = null;
  const loadPending =
    deps.localInference.loadPendingOllamaModelCleanup ?? loadPendingOllamaModelCleanup;
  const persistPending =
    deps.localInference.persistPendingOllamaModelCleanup ?? persistPendingOllamaModelCleanup;
  const clearPending =
    deps.localInference.clearPendingOllamaModelCleanup ?? clearPendingOllamaModelCleanup;
  const persistRetry = (): string | null => {
    if (attemptedModels.length === 0) return null;
    try {
      persistPending(previous.name, attemptedModels);
      return null;
    } catch (error) {
      return (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, " ")
        .slice(0, 240);
    }
  };
  try {
    const withOwnershipLock = deps.withOllamaModelOwnershipLock ?? withOllamaModelOwnershipLock;
    withOwnershipLock(() => {
      const peers = deps.listSandboxes?.().sandboxes ?? [];
      const selectedHost = deps.localInference.loadPersistedOllamaHost?.() ?? null;
      const nextRoute = { provider: nextProvider, model: nextModel, endpointUrl: nextEndpointUrl };
      const superseded = supersededOllamaModel(previous, nextRoute, peers, selectedHost);
      const pending = loadPending(previous.name);
      const retryablePending = pending.filter((model) =>
        supersededOllamaModel(
          { name: previous.name, provider: "ollama-local", model, endpointUrl: null },
          nextRoute,
          peers,
          selectedHost,
        ),
      );
      attemptedModels = [...new Set([...(superseded ? [superseded] : []), ...retryablePending])];
      const retireRoute =
        isLocalOllamaRouteOwner(previous, selectedHost) &&
        !isLocalOllamaRouteOwner(nextRoute, selectedHost) &&
        !peers.some((peer) => isLocalOllamaRouteOwner(peer, selectedHost));
      if (attemptedModels.length === 0 && !retireRoute) return;
      try {
        revalidateSandboxIdentity?.("release the superseded Ollama model");
      } catch (error) {
        authorityRefusal = error;
        return;
      }
      if (attemptedModels.length > 0 && deps.unloadOllamaModels) {
        // The committed route no longer names the old model. Record it before
        // release so later lifecycle commands retain a scoped retry target.
        pendingRecordFailure = persistRetry();
        try {
          const cleanup = deps.unloadOllamaModels(attemptedModels);
          if (cleanup && !cleanup.ok) {
            if (pendingRecordFailure) pendingRecordFailure = persistRetry();
            const detail = cleanup.message
              ? `: ${cleanup.message.replace(/\s+/g, " ").slice(0, 240)}`
              : "";
            const recoveryAction =
              cleanup.outcome === "discovery-failed"
                ? `Restore access to ${cleanup.endpoint}`
                : cleanup.outcome === "still-resident"
                  ? `Stop the recorded model at ${cleanup.endpoint}`
                  : `Allow the model unload request at ${cleanup.endpoint}`;
            cleanupWarning =
              `  Warning: Ollama did not release recorded model cleanup for '${previous.name}' from ` +
              `${cleanup.endpoint} (outcome: ${cleanup.outcome}${detail}). The new inference ` +
              `route remains active. ${recoveryAction}. ` +
              (pendingRecordFailure
                ? `Cleanup retry state could not be recorded: ${pendingRecordFailure}. Manually release only ${attemptedModels.join(", ")} at ${cleanup.endpoint}.`
                : `Re-run onboarding or destroy '${previous.name}' to retry only: ${attemptedModels.join(", ")}.`);
          } else {
            clearPending(previous.name, attemptedModels);
          }
        } catch (error) {
          if (pendingRecordFailure) pendingRecordFailure = persistRetry();
          const detail = (error instanceof Error ? error.message : String(error))
            .replace(/\s+/g, " ")
            .slice(0, 240);
          cleanupWarning =
            `  Warning: Ollama cleanup for '${previous.name}' failed: ${detail}. The new inference ` +
            `route remains active. ` +
            (pendingRecordFailure
              ? `Cleanup retry state could not be recorded: ${pendingRecordFailure}. Manually release only ${attemptedModels.join(", ")} from the saved local Ollama endpoint.`
              : `Re-run onboarding or destroy '${previous.name}' to retry only the recorded models: ${attemptedModels.join(", ")}.`);
        }
      }
      const pendingAfterCleanup = loadPending(previous.name);
      if (retireRoute && !cleanupWarning && pendingAfterCleanup.length === 0) {
        deps.localInference.clearPersistedOllamaHostIfUnused?.(peers);
      }
    });
  } catch (error) {
    if (!pendingRecordFailure) pendingRecordFailure = persistRetry();
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .slice(0, 240);
    cleanupWarning =
      `  Warning: NemoClaw could not finish superseded Ollama cleanup: ${detail}. The new ` +
      `inference route remains active. ` +
      (pendingRecordFailure
        ? `Cleanup retry state could not be recorded: ${pendingRecordFailure}. Manually release only ${attemptedModels.join(", ") || "the superseded model"} from the saved local Ollama endpoint.`
        : `Re-run onboarding or destroy '${previous.name}' to retry only the recorded models: ${attemptedModels.join(", ") || "none"}.`);
  }
  if (cleanupWarning) console.warn(cleanupWarning);
  if (authorityRefusal) throw authorityRefusal;
}

export function createSetupInference(
  defaults: SetupInferenceDeps,
  overrides: Partial<SetupInferenceDeps> = {},
): SetupInference {
  const deps: SetupInferenceDeps = { ...defaults, ...overrides };

  return async function setupInferenceWithDeps(
    sandboxName: string | null,
    model: string,
    provider: string,
    endpointUrl: string | null = null,
    credentialEnv: string | null = null,
    hermesAuthMethod: HermesAuthMethod | string | null = null,
    hermesToolGateways: string[] = [],
    options: ProviderInferenceSetupOptions = {},
  ): Promise<SetupInferenceResult> {
    const revalidateSandboxIdentity = sandboxName ? options.revalidateSandboxIdentity : undefined;
    const gatewayName = options.gatewayName ?? deps.getGatewayName();
    const endpointSource =
      options.endpointSource === undefined ? "onboard" : options.endpointSource;
    const routedProvider = deps.isRoutedInferenceProvider?.(provider) === true;
    const usesBedrockRuntimeAdapter =
      provider === "compatible-anthropic-endpoint" && isBedrockRuntimeEndpoint(endpointUrl);
    let shouldLogSuccessfulRoute = false;
    const withInferenceMutationLocks = <T>(operation: () => Promise<T> | T): Promise<T> =>
      deps.withGatewayRouteMutationLock(gatewayName, () => {
        if (!routedProvider) return operation();
        const withRouterPortLock =
          deps.withModelRouterPortLifecycleLock ?? withModelRouterPortLifecycleLock;
        const port = (deps.getModelRouterPort ?? resolveModelRouterPort)();
        return withRouterPortLock(port, operation);
      });
    const mutateGatewayRoute = (): Promise<SetupInferenceResult> =>
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: provider onboarding centralizes route and two-phase transaction ordering.
      withInferenceMutationLocks(async () => {
        revalidateSandboxIdentity?.("change the inference provider route");
        if (
          options.isRecordedProviderRecoveryAuthorized &&
          !options.isRecordedProviderRecoveryAuthorized()
        ) {
          deps.error(
            `  Error: recorded inference recovery for sandbox '${sandboxName}' lost reservation ownership before route setup.`,
          );
          return deps.exitProcess(1);
        }
        const compatibility = deps.checkGatewayRouteCompatibility({
          gatewayName,
          sandboxName,
          route: {
            provider,
            model,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi: options.preferredInferenceApi ?? null,
          },
        });
        if (!compatibility.ok) {
          if (!isAdvisoryGatewayRouteConflict(compatibility)) {
            deps.error(`  Error: ${formatGatewayRouteConflict(compatibility)}`);
            return deps.exitProcess(1);
          }
          deps.error(`  ${formatGatewayRouteImpactWarning(compatibility)}`);
        }
        deps.step(4, 8, "Setting up inference provider");
        let endpointPinnedAddresses = options.endpointPinnedAddresses;
        let endpointTrustedPrivateCapability = options.endpointTrustedPrivateCapability;
        // Strictly classified AWS Bedrock Runtime hostnames use the dedicated
        // SigV4/bearer adapter rather than the generic curl probe path. Their
        // hostname is constrained to AWS-owned suffixes by the classifier, so
        // do not apply the custom-origin curl pinning contract here.
        const usesOnboardEndpoint = matchesOnboardEndpoint(
          provider,
          endpointUrl,
          options.onboardEndpointUrl,
        );
        if (
          (provider === "compatible-endpoint" || provider === "compatible-anthropic-endpoint") &&
          endpointUrl &&
          !usesBedrockRuntimeAdapter &&
          !usesOnboardEndpoint &&
          !endpointPinnedAddresses
        ) {
          const preflight = await assertEndpointResolvesPublic(
            endpointUrl,
            deps.resolveEndpointHost,
            {
              trustedPrivateHosts:
                deps.trustedPrivateEndpointHosts ??
                parseTrustedPrivateInferenceHostsFromEnv(process.env),
            },
          );
          if (!preflight.ok) {
            deps.error(
              `  Endpoint SSRF preflight failed: ${preflight.reason ?? "endpoint is not safe to probe"}`,
            );
            if (deps.isNonInteractive()) return deps.exitProcess(1);
            return { retry: "selection" };
          }
          endpointPinnedAddresses = preflight.addresses;
          endpointTrustedPrivateCapability = preflight.trustedPrivateCapability;
          revalidateSandboxIdentity?.("change the inference provider route after DNS validation");
        }
        const runExactGatewayOpenshell = createGatewayScopedOpenshellRunner(
          deps.runOpenshell,
          gatewayName,
        );
        const runGatewayOpenshell: typeof runExactGatewayOpenshell = (...args) => {
          revalidateSandboxIdentity?.("change the OpenShell inference provider route");
          return runExactGatewayOpenshell(...args);
        };
        let hostLocalRoute: HostLocalInferenceStartupRoute | null = null;
        let hostLocalGatewayMutation: HostLocalInferenceGatewayMutation | null = null;
        let hostLocalRollbackAttempted = false;
        let hostLocalRegistryPublicationEntered = false;
        const hostLocalProviderErrors: string[] = [];
        const hostLocalSelection = options.hostLocalInference;
        let routeReserved = false;
        let hostLocalInferenceReceipt: string | null = null;
        let hostLocalInferenceProvenance:
          | import("../state/registry/types").SandboxEntry["hostLocalInferenceProvenance"]
          | undefined;
        let hostLocalInferenceGatewayPortAuthority: number | undefined;
        let hostLocalInferenceRuntimeProviderId: string | undefined;
        const reserveRoute = (name: string, selectedProvider: string, selectedModel: string) => {
          if (routeReserved) return true;
          revalidateSandboxIdentity?.("reserve the sandbox inference route");
          const reserved = deps.updateSandbox(name, {
            provider: selectedProvider,
            model: selectedModel,
            endpointUrl: hostLocalRoute?.applicationBaseUrl ?? endpointUrl,
            endpointSource: hostLocalRoute ? "inference-set" : endpointSource,
            credentialEnv,
            preferredInferenceApi: options.preferredInferenceApi ?? null,
            gatewayName,
            reservationSessionId: options.reservationSessionId,
            hostLocalInferenceReceipt,
            ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
            ...(hostLocalInferenceProvenance && hostLocalInferenceGatewayPortAuthority !== undefined
              ? { gatewayPort: hostLocalInferenceGatewayPortAuthority }
              : {}),
            ...(hostLocalInferenceProvenance && hostLocalInferenceRuntimeProviderId
              ? { openshellDriver: hostLocalInferenceRuntimeProviderId }
              : {}),
          });
          routeReserved = reserved;
          return reserved;
        };

        const defaultUpsertProvider = bindGatewayUpsertProvider(
          deps.upsertProvider,
          gatewayName,
          revalidateSandboxIdentity,
        );
        const providerExitProcess: CommonDeps["exitProcess"] = hostLocalSelection
          ? (code: number): never => {
              throw new HostLocalInferenceBranchExit(code);
            }
          : deps.exitProcess;
        const providerError: CommonDeps["error"] = hostLocalSelection
          ? (message: string) => {
              hostLocalProviderErrors.push(message);
            }
          : deps.error;
        const profiledUpsertProvider = bindOpenAiProviderProfile(
          (...args) => {
            revalidateSandboxIdentity?.("register the inference provider");
            const selectedUpsertProvider =
              hostLocalGatewayMutation?.upsertProvider ?? defaultUpsertProvider;
            return selectedUpsertProvider(...args);
          },
          runGatewayOpenshell,
          providerError,
          providerExitProcess,
        );
        const commonDeps = {
          runOpenshell: runGatewayOpenshell,
          upsertProvider: profiledUpsertProvider,
          verifyInferenceRoute: (selectedProvider: string, selectedModel: string) => {
            if (!hostLocalRoute && sandboxName) {
              reserveRoute(sandboxName, selectedProvider, selectedModel);
            }
            deps.verifyInferenceRoute(gatewayName, selectedProvider, selectedModel);
          },
          verifyOnboardInferenceSmoke: (
            input: Parameters<CommonDeps["verifyOnboardInferenceSmoke"]>[0],
          ) =>
            deps.verifyOnboardInferenceSmoke({
              ...input,
              pinnedAddresses: endpointPinnedAddresses,
              trustedPrivateCapability: endpointTrustedPrivateCapability,
              capabilityCache: options.inferenceCapabilityCache,
            }),
          isNonInteractive: deps.isNonInteractive,
          registry: {
            updateSandbox: (name: string) => reserveRoute(name, provider, model),
          },
          exitProcess: providerExitProcess,
          error: providerError,
          log: deps.log,
        } satisfies CommonDeps;

        if (options.hostLocalInference) {
          try {
            revalidateSandboxIdentity?.("prepare the host-local inference runtime");
            hostLocalRoute = resolveHostLocalInferenceRoute(
              sandboxName,
              model,
              provider,
              options.allowToolsIncompatible !== true,
              options.hostLocalInference,
            );
            hostLocalInferenceReceipt = serializeHostLocalInferenceReceipt(hostLocalRoute.receipt);
            if (options.hostLocalInference.request.service === "llama-cpp") {
              hostLocalInferenceProvenance = createSandboxHostLocalInferenceProvenance(
                hostLocalInferenceRuntimeOwnerSandboxName(
                  options.hostLocalInference.request,
                  sandboxName!,
                ),
                hostLocalInferenceReceipt,
              );
              hostLocalInferenceGatewayPortAuthority = hostLocalInferenceGatewayPort(
                options.hostLocalInference.request,
              );
              hostLocalInferenceRuntimeProviderId = options.hostLocalInference.runtimeProviderId;
            }
            revalidateSandboxIdentity?.("prepare the host-local inference provider route");
            hostLocalGatewayMutation = await options.hostLocalInference.prepareGatewayMutation({
              gatewayName,
              sandboxName: sandboxName!,
              provider: hostLocalRoute.gatewayProvider,
              model,
              providerBaseUrl: hostLocalRoute.gatewayProviderBaseUrl,
            });
            if (
              !hostLocalGatewayMutation ||
              typeof hostLocalGatewayMutation.commit !== "function" ||
              typeof hostLocalGatewayMutation.rollback !== "function"
            ) {
              throw new Error(
                "Host-local inference gateway mutation authority is missing or malformed.",
              );
            }
          } catch (error) {
            emitHostLocalInferenceFailure(
              options.hostLocalInference.runtimeProviderId,
              error,
              deps,
            );
            if (hostLocalRoute) {
              try {
                await rollbackHostLocalInferenceStartup(
                  options.hostLocalInference.runtimeProviderId,
                  hostLocalRoute,
                  hostLocalGatewayMutation,
                  deps,
                );
              } catch {
                // The rollback helper already emitted bounded provider-labelled evidence.
              }
            }
            return deps.exitProcess(1);
          }
        }

        const setupSelectedProvider = async (): Promise<SetupInferenceResult | null> => {
          if (provider === deps.hermesProviderAuth.HERMES_PROVIDER_NAME) {
            return inferenceProviders.setupHermesProviderInference(
              {
                sandboxName,
                model,
                provider,
                endpointUrl,
                credentialEnv,
                hermesAuthMethod,
                hermesToolGateways,
              },
              {
                ...commonDeps,
                hermesProviderAuth: deps.hermesProviderAuth,
                getHermesToolGatewayBroker: deps.getHermesToolGatewayBroker,
                providerExistsInGateway: (name: string) =>
                  deps.providerExistsInGateway(name, gatewayName),
                normalizeHermesAuthMethod: deps.normalizeHermesAuthMethod,
                resolveHermesNousApiKey: deps.resolveHermesNousApiKey,
                checkHermesProviderStoreReachable: deps.checkHermesProviderStoreReachable,
                hermesAuthMethodLabel: deps.hermesAuthMethodLabel,
                hermesConstants: deps.hermesConstants,
                requireValue: deps.requireValue,
                redact: deps.redact,
                compactText: deps.compactText,
                lookup: deps.lookup,
              },
            );
          }

          if (inferenceProviders.isRemoteProviderName(provider)) {
            const outcome = await inferenceProviders.setupRemoteProviderInference(
              {
                sandboxName,
                model,
                provider,
                endpointUrl,
                credentialEnv,
                reuseGatewayCredentialWithoutLocalKey:
                  options.reuseGatewayCredentialWithoutLocalKey === true,
                skipHostInferenceSmoke: options.skipHostInferenceSmoke === true,
                preferredInferenceApi: options.preferredInferenceApi ?? null,
                pinnedAddresses: endpointPinnedAddresses,
                trustedPrivateCapability: endpointTrustedPrivateCapability,
                capabilityCache: options.inferenceCapabilityCache,
              },
              {
                ...commonDeps,
                REMOTE_PROVIDER_CONFIG: deps.REMOTE_PROVIDER_CONFIG,
                hydrateCredentialEnv: deps.hydrateCredentialEnv,
                promptValidationRecovery: (label, recovery, selectedCredentialEnv, helpUrl) =>
                  deps.promptValidationRecovery(
                    label,
                    recovery,
                    selectedCredentialEnv,
                    helpUrl,
                    revalidateSandboxIdentity,
                  ),
                classifyApplyFailure: deps.classifyApplyFailure,
                LOCAL_INFERENCE_TIMEOUT_SECS: deps.localInferenceTimeoutSecs,
                bedrockRuntimeOnboard: deps.bedrockRuntimeOnboard,
                openrouterRuntimeOnboard: deps.openrouterRuntimeOnboard,
                redact: deps.redact,
                compactText: deps.compactText,
                probeOpenAiLikeEndpoint: deps.probeOpenAiLikeEndpoint,
                readGatewayProviderMetadata: deps.readGatewayProviderMetadata,
                deleteGatewayProvider: deps.deleteGatewayProvider,
              },
            );
            if (outcome.done) return outcome.result;
          } else if (provider === "vllm-local") {
            const outcome = await inferenceProviders.setupVllmLocalInference(
              { model, provider },
              {
                ...commonDeps,
                validateLocalProvider: hostLocalRoute
                  ? () => ({ ok: true as const })
                  : deps.validateLocalProvider,
                getLocalProviderHealthCheck: deps.getLocalProviderHealthCheck,
                getLocalProviderBaseUrl: hostLocalRoute
                  ? () => hostLocalRoute.gatewayProviderBaseUrl
                  : deps.getLocalProviderBaseUrl,
                applyLocalInferenceRoute: resolveLocalInferenceRouteApplier(
                  hostLocalRoute
                    ? {
                        ...deps,
                        exitProcess: commonDeps.exitProcess,
                        error: commonDeps.error,
                      }
                    : deps,
                  runGatewayOpenshell,
                  revalidateSandboxIdentity,
                ),
                run: deps.run,
                VLLM_LOCAL_CREDENTIAL_ENV: deps.vllmLocalCredentialEnv,
                getManagedVllmProviderBinding: hostLocalRoute
                  ? () => null
                  : (deps.getManagedVllmProviderBinding ?? getManagedVllmProviderBinding),
              },
            );
            if (outcome.done) {
              if (hostLocalRoute && hostLocalGatewayMutation && hostLocalSelection) {
                emitHostLocalInferenceFailure(
                  hostLocalSelection.runtimeProviderId,
                  hostLocalProviderErrors.at(-1) ?? "gateway route requested provider reselection",
                  deps,
                );
                hostLocalRollbackAttempted = true;
                await rollbackHostLocalInferenceStartup(
                  hostLocalSelection.runtimeProviderId,
                  hostLocalRoute,
                  hostLocalGatewayMutation,
                  deps,
                );
              }
              return outcome.result;
            }
          } else if (provider === "ollama-local") {
            const withOwnershipTransaction =
              deps.withOllamaModelOwnershipTransaction ?? withOllamaModelOwnershipTransaction;
            const outcome = await withOwnershipTransaction(() =>
              inferenceProviders.setupOllamaLocalInference(
                {
                  model,
                  provider,
                  allowToolsIncompatible: options.allowToolsIncompatible === true,
                  ...(hostLocalRoute
                    ? {}
                    : { preparedProxyToken: options.preparedOllamaProxyToken }),
                },
                {
                  ...commonDeps,
                  validateLocalProvider: hostLocalRoute
                    ? () => ({ ok: true as const })
                    : deps.validateLocalProvider,
                  getLocalProviderBaseUrl: hostLocalRoute
                    ? () => hostLocalRoute.gatewayProviderBaseUrl
                    : deps.getLocalProviderBaseUrl,
                  applyLocalInferenceRoute: resolveLocalInferenceRouteApplier(
                    hostLocalRoute
                      ? {
                          ...deps,
                          exitProcess: commonDeps.exitProcess,
                          error: commonDeps.error,
                        }
                      : deps,
                    runGatewayOpenshell,
                    revalidateSandboxIdentity,
                  ),
                  run: deps.run,
                  shouldFrontOllamaWithProxy: hostLocalRoute
                    ? () => false
                    : deps.shouldFrontOllamaWithProxy,
                  ensureOllamaAuthProxy: deps.ensureOllamaAuthProxy,
                  isProxyHealthy: deps.isProxyHealthy,
                  getOllamaProxyToken: deps.getOllamaProxyToken,
                  persistAndProbeOllamaProxy: deps.persistAndProbeOllamaProxy,
                  localInference: deps.localInference,
                  providerOwnedInferenceProof: hostLocalRoute?.receipt.inference,
                  OLLAMA_PROXY_CREDENTIAL_ENV: deps.ollamaProxyCredentialEnv,
                },
              ),
            );
            if (outcome.done) {
              if (hostLocalRoute && hostLocalGatewayMutation && hostLocalSelection) {
                emitHostLocalInferenceFailure(
                  hostLocalSelection.runtimeProviderId,
                  hostLocalProviderErrors.at(-1) ?? "gateway route requested provider reselection",
                  deps,
                );
                hostLocalRollbackAttempted = true;
                await rollbackHostLocalInferenceStartup(
                  hostLocalSelection.runtimeProviderId,
                  hostLocalRoute,
                  hostLocalGatewayMutation,
                  deps,
                );
              }
              return outcome.result;
            }
          } else if (routedProvider) {
            await inferenceProviders.setupRoutedInference(
              { model, provider, endpointUrl, credentialEnv },
              {
                ...commonDeps,
                reconcileModelRouter: deps.reconcileModelRouter,
                routedInference: deps.routedInference,
                hydrateCredentialEnv: deps.hydrateCredentialEnv,
                redact: deps.redact,
                compactText: deps.compactText,
              },
            );
          } else {
            commonDeps.error(`  Unsupported provider configuration: ${provider}`);
            commonDeps.exitProcess(1);
          }

          return null;
        };

        try {
          const providerResult = await setupSelectedProvider();
          if (providerResult) return providerResult;
          commonDeps.verifyInferenceRoute(provider, model);
          if (hostLocalRoute) {
            deps.log(
              "  Deferring inference.local smoke to the sandbox runtime after sandbox readiness.",
            );
          } else if (options.skipHostInferenceSmoke === true) {
            deps.log("  Reusing existing gateway credential; skipping host inference smoke.");
          } else {
            await deps.verifyOnboardInferenceSmoke({
              provider,
              model,
              endpointUrl,
              credentialEnv,
              pinnedAddresses: endpointPinnedAddresses,
              trustedPrivateCapability: endpointTrustedPrivateCapability,
              capabilityCache: options.inferenceCapabilityCache,
            });
          }
          if (sandboxName && !hostLocalRoute) {
            commonDeps.registry.updateSandbox(sandboxName);
          }
          if (hostLocalRoute) {
            if (!hostLocalGatewayMutation || !hostLocalSelection) {
              throw new Error("Host-local inference commit authority is incomplete.");
            }
            const validatePreparedReceipt = () => {
              const validated = normalizeHostLocalInferenceReceipt(
                hostLocalRoute.prepared.validateBeforeCommit(),
              );
              if (
                serializeHostLocalInferenceReceipt(validated) !==
                serializeHostLocalInferenceReceipt(hostLocalRoute.receipt)
              ) {
                throw new Error(
                  "Host-local inference pre-commit validation returned a different receipt authority.",
                );
              }
            };
            validatePreparedReceipt();
            revalidateSandboxIdentity?.("commit the host-local inference provider route");
            await hostLocalGatewayMutation.commit();
            // The awaited gateway commit is the only async gap between provider
            // proof and publication. Close it before registry or receipt entry.
            validatePreparedReceipt();
            if (sandboxName) {
              // The registry writer may complete its atomic replacement before
              // returning false or throwing. From entry onward there is no
              // exact prior-registry restoration authority, so gateway/runtime
              // rollback could leave a durable inference.local reservation
              // pointing at a removed runtime. Retain the proven pair and fail
              // closed instead.
              hostLocalRegistryPublicationEntered = true;
              if (!reserveRoute(sandboxName, provider, model)) {
                throw new Error("Host-local inference lost sandbox route reservation authority.");
              }
            }
            revalidateSandboxIdentity?.("publish the host-local inference provider receipt");
            const committed = normalizeHostLocalInferenceReceipt(hostLocalRoute.prepared.commit());
            if (
              serializeHostLocalInferenceReceipt(committed) !==
              serializeHostLocalInferenceReceipt(hostLocalRoute.receipt)
            ) {
              throw new Error(
                "Host-local inference commit returned a different receipt authority.",
              );
            }
          }
          revalidateSandboxIdentity?.("report successful inference provider setup");
          shouldLogSuccessfulRoute = true;
          return { ok: true as const };
        } catch (error) {
          if (!hostLocalRoute || !hostLocalSelection) throw error;
          emitHostLocalInferenceFailure(
            hostLocalSelection.runtimeProviderId,
            error instanceof HostLocalInferenceBranchExit
              ? (hostLocalProviderErrors.at(-1) ?? error)
              : error,
            deps,
          );
          let publicationState: ReturnType<
            HostLocalInferenceStartupRoute["prepared"]["publicationState"]
          > = "indeterminate";
          try {
            publicationState = hostLocalRoute.prepared.publicationState();
          } catch {
            // Missing or malformed publication evidence is not rollback authority.
          }
          if (
            publicationState === "unpublished" &&
            !hostLocalRegistryPublicationEntered &&
            !hostLocalRollbackAttempted
          ) {
            try {
              await rollbackHostLocalInferenceStartup(
                hostLocalSelection.runtimeProviderId,
                hostLocalRoute,
                hostLocalGatewayMutation,
                deps,
              );
            } catch {
              // The rollback helper already emitted bounded provider-labelled evidence.
            }
          }
          return deps.exitProcess(error instanceof HostLocalInferenceBranchExit ? error.code : 1);
        }
      });
    // Both the prior-route read and the GPU release stay inside the sandbox
    // mutation lock: the read happens before `reserveRoute` rewrites the row
    // (after which the previous selection is unrecoverable), and the release
    // happens before the lock opens, so a serialized re-onboard can neither
    // replace the row under the read nor select the captured model before
    // this cleanup runs.
    const mutateGatewayRouteAndReleaseSupersededModel = async (): Promise<SetupInferenceResult> => {
      let previousSandbox: OllamaModelHolder | null = null;
      try {
        previousSandbox = sandboxName ? (deps.getSandbox?.(sandboxName) ?? null) : null;
      } catch {
        /* An unreadable registry skips GPU release; it must not fail onboarding. */
      }
      const result = await mutateGatewayRoute();
      releaseSupersededOllamaModel(
        previousSandbox,
        provider,
        model,
        endpointUrl,
        result,
        deps,
        revalidateSandboxIdentity,
      );
      if (shouldLogSuccessfulRoute && "ok" in result) {
        deps.log(`  ✓ Inference route set: ${provider} / ${model}`);
      }
      return result;
    };
    return sandboxName
      ? deps.withSandboxMutationLock(sandboxName, mutateGatewayRouteAndReleaseSupersededModel)
      : mutateGatewayRouteAndReleaseSupersededModel();
  };
}
