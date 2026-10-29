// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  NativeLocalProvider,
  NativeLocalProviderAttachment,
} from "../inference/native-local/contract";
import {
  requireNativeProviderPolicy,
  normalizeNativeLocalProviderAttachment,
  isPersistedPiSharedLocalInferenceRoute,
  usesNativeLocalInference,
  usesNativeLocalInferenceForAgent,
  prepareNativeLocalSelection,
  retireUnreservedNativeLocalProvider,
  gatewayReachableCompatibleEndpointUrl,
} from "./inference-providers";
import {
  hostedNativeProvider,
  usesNativeHermesEndpoint,
  customNativeCredentialEnv,
  resolveCustomNativeApi,
} from "../inference/native-provider/hosted";
import { requireHostedProviderAttachment } from "../inference/native-provider/hosted-attachment";
import {
  isHostedCustomEndpoint,
  prepareHostedNativeProvider,
  prepareCustomNativeProvider,
  usesCustomNativeOnboarding,
} from "../inference/native-provider/setup";
import type { NativeProviderAttachment } from "../inference/native-provider/contract";
import type { OpenShellGatewayLifecycle } from "../adapters/openshell/gateway-lifecycle";
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
import type {
  withGatewayRouteMutationLock,
  withModelRouterPortLifecycleLock,
} from "../inference/gateway-route-mutation-lock";
import { getManagedVllmProviderBinding, shouldFrontOllamaWithProxy } from "../inference/local";
import {
  ensureNativeNvidiaProvider,
  isNativeNvidiaProvider,
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
  normalizeNativeNvidiaProviderAttachment,
  persistNativeNvidiaProviderAuthority,
  resolveGatewayNativeNvidiaProviderAuthority,
  type NativeNvidiaProviderAttachment,
} from "../inference/native-nvidia";
import {
  clearPendingOllamaModelCleanup,
  discoverOllamaModelOwnership,
  isLocalOllamaRouteOwner,
  listOllamaModelOwnershipPeersAcrossGatewayRoots,
  loadPendingOllamaModelCleanup,
  matchingOllamaModelPeers,
  type OllamaActiveOwnershipDiscoveryFn,
  type OllamaModelHolder,
  type OllamaOwnershipPhaseCapture,
  persistPendingOllamaModelCleanup,
  supersededOllamaModelWithActivePeers,
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
  captureSandboxPhasesForGateway,
  scopeGatewayOpenshellArgs,
  type OpenShellGatewayEndpointEnvironment,
} from "../adapters/openshell/runtime";
import type { withSandboxMutationLock } from "../state/mcp-lifecycle-lock";
import type { Session } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry/types";
import { createSandboxHostLocalInferenceProvenance } from "../state/registry/host-local-inference";
import {
  withRoutedInferencePortLock,
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
import type {
  OpenShellInferenceRouteMutator,
  OpenShellInferenceRouteObserver,
} from "../adapters/openshell/inference-route";
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
import { releaseAbandonedRouteReservation } from "./sandbox-lifecycle";

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
  recordMigratedProviderCredential?: (
    name: string,
    credentialEnv: string,
    persistedValue: string,
    revalidateSandboxIdentity?: (operation: string) => void,
  ) => void;
  requireNativeProviderPolicy?: typeof requireNativeProviderPolicy;
  /** Injectable resolver for resumed custom-endpoint SSRF preflight tests. */
  resolveEndpointHost?: EndpointDnsLookupFn;
  /** Resolve the current onboarding policy tier before provider mutation. */
  resolvePolicyTier?: () => Promise<string>;
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
  inferenceRouteMutator: OpenShellInferenceRouteMutator;
  inferenceRouteObserver: OpenShellInferenceRouteObserver;
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
  providerExistsInGateway: (name: string, gatewayName: string) => Promise<boolean>;
  run: typeof import("../runner").run;
  updateSandbox: typeof import("../state/registry").reserveSandboxInferenceRoute;
  // #9110 optional GPU-release seams; omitted by test literals that build deps
  // by hand, so every read below must stay optional-chained.
  getSandbox?: typeof import("../state/registry").getSandbox;
  listOllamaModelOwnershipPeers?: () => readonly OllamaModelHolder[];
  discoverActiveOllamaSandboxNames?: OllamaActiveOwnershipDiscoveryFn;
  captureOllamaOwnershipPhases?: OllamaOwnershipPhaseCapture;
  resolveOllamaOwnershipGateway?: (peer: OllamaModelHolder) => string;
  environment?: NodeJS.ProcessEnv;
  listSandboxes?: typeof import("../state/registry").listSandboxes;
  getNativeLocalProviderAuthority?: typeof import("../state/registry/native-local-provider-authority").getNativeLocalProviderAuthority;
  setNativeLocalProviderAuthority?: typeof import("../state/registry/native-local-provider-authority").setNativeLocalProviderAuthority;
  clearNativeLocalProviderAuthority?: typeof import("../state/registry/native-local-provider-authority").clearNativeLocalProviderAuthority;
  getNativeHostedProviderAuthority?: typeof import("../state/registry").getNativeHostedProviderAuthority;
  setNativeHostedProviderAuthority?: typeof import("../state/registry").setNativeHostedProviderAuthority;
  getNativeNvidiaProviderAuthority?: typeof import("../state/registry").getNativeNvidiaProviderAuthority;
  setNativeNvidiaProviderAuthority?: typeof import("../state/registry").setNativeNvidiaProviderAuthority;
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
  providerAdapter?: RemoteProviderDeps["providerAdapter"];
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

export function createRoutedResumeProviderUpsert(deps: {
  upsertProvider: SetupInferenceDeps["upsertProvider"];
  hydrateCredentialEnv: RoutedProviderDeps["hydrateCredentialEnv"];
}) {
  return async (
    gatewayName: string,
    provider: string,
    endpointUrl: string | null,
    credentialEnv: string | null,
  ) => {
    const result = await upsertRoutedInferenceProvider(provider, endpointUrl, credentialEnv, {
      upsertProvider: bindGatewayUpsertProvider(deps.upsertProvider, gatewayName),
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

export async function selectGatewayForFollowupOrExit(
  gatewayName: string,
  lifecycle: Pick<OpenShellGatewayLifecycle, "selectGateway">,
  error: (message: string) => void = console.error,
  exitProcess: (code: number) => never = (code) => process.exit(code),
): Promise<void> {
  const selected = await lifecycle.selectGateway({
    target: { kind: "named", gatewayName },
  });
  if (selected.ok) return;
  error(
    `  Error: OpenShell could not select managed gateway '${gatewayName}' after onboarding. ` +
      "No follow-up operations were run against an ambient gateway.",
  );
  exitProcess(1);
}

function resolveLocalInferenceRouteApplier(
  deps: SetupInferenceDeps,
  inferenceRouteMutator: OpenShellInferenceRouteMutator,
  gatewayName: string,
  revalidateSandboxIdentity?: (operation: string) => void,
  exitAmbiguousRouteResult?: (code: number) => never,
) {
  return (
    deps.applyLocalInferenceRoute ??
    createLocalInferenceRouteApplier({
      inferenceRouteMutator,
      gatewayName,
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
      localInferenceTimeoutSecs: deps.localInferenceTimeoutSecs,
      error: deps.error,
      exitProcess: deps.exitProcess,
      exitAmbiguousRouteResult,
    })
  );
}

const HOST_LOCAL_INFERENCE_DIAGNOSTIC_LIMIT = 240;
const RUNTIME_PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/u;

class HostLocalInferenceBranchExit extends Error {
  constructor(
    readonly code: number,
    readonly routeMutationAmbiguous = false,
  ) {
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
export function releaseSupersededOllamaModel(
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
  if (!previous || result.retry || result.stagedNativeLocalRecreation) return;
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
      persistPending(previous, attemptedModels);
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
      const selectedHost = deps.localInference.loadPersistedOllamaHost?.() ?? null;
      const nextRoute = { provider: nextProvider, model: nextModel, endpointUrl: nextEndpointUrl };
      const previousOwnsOllama = isLocalOllamaRouteOwner(previous, selectedHost);
      // This is only a retry candidate. A successful live probe below is still
      // required before the model can be unloaded.
      const retryCandidate = previousOwnsOllama
        ? supersededOllamaModelWithActivePeers(previous, nextRoute, [], new Set(), selectedHost)
        : null;
      attemptedModels = retryCandidate ? [retryCandidate] : [];
      const pending = loadPending(previous);
      attemptedModels = [...new Set([...attemptedModels, ...pending])];
      if (!retryCandidate && pending.length === 0) return;

      const peers = (
        deps.listOllamaModelOwnershipPeers ?? listOllamaModelOwnershipPeersAcrossGatewayRoots
      )();
      const ollamaRouteCandidates = peers.filter((peer) =>
        isLocalOllamaRouteOwner(peer, selectedHost),
      );
      const environment = deps.environment ?? process.env;
      const captureOwnershipPhases: OllamaOwnershipPhaseCapture =
        deps.captureOllamaOwnershipPhases ?? captureSandboxPhasesForGateway;
      const discoverPeers = (owners: readonly OllamaModelHolder[]) =>
        deps.discoverActiveOllamaSandboxNames
          ? deps.discoverActiveOllamaSandboxNames(owners, environment)
          : discoverOllamaModelOwnership(owners, environment, captureOwnershipPhases, {
              resolvePersistedSandboxOwnershipGateway: deps.resolveOllamaOwnershipGateway,
            });
      // A different model cannot keep one of the models being released resident.
      // Discover only matching owners before unloading so unrelated gateways do
      // not delay cleanup; all-route discovery is reserved for receipt retirement.
      const modelOwners = [
        ...new Set(
          attemptedModels.flatMap((model) =>
            matchingOllamaModelPeers(
              { ...previous, provider: "ollama-local", model, endpointUrl: null },
              ollamaRouteCandidates,
              selectedHost,
            ),
          ),
        ),
      ];
      const discovery = discoverPeers(modelOwners);
      if (!discovery.ok) {
        pendingRecordFailure = persistRetry();
        const retryMessage = pendingRecordFailure
          ? `Cleanup retry state could not be recorded: ${pendingRecordFailure}. Manually verify that no active matching sandbox owns the model before releasing only ${attemptedModels.join(", ")} from the local Ollama host.`
          : attemptedModels.length > 0
            ? `Re-run onboarding to retry only: ${attemptedModels.join(", ")}.`
            : "The Ollama host receipt was left unchanged.";
        cleanupWarning =
          `  Warning: NemoClaw could not verify Ollama model ownership for '${previous.name}': ` +
          `${discovery.message}. No model was unloaded; the new inference route remains active. ${retryMessage}`;
        return;
      }
      const superseded = previousOwnsOllama
        ? supersededOllamaModelWithActivePeers(
            previous,
            nextRoute,
            peers,
            discovery.activeSandboxNames,
            selectedHost,
            discovery.activePeers,
          )
        : null;
      const retryablePending = pending.filter((model) => {
        return !!supersededOllamaModelWithActivePeers(
          { ...previous, provider: "ollama-local", model, endpointUrl: null },
          nextRoute,
          peers,
          discovery.activeSandboxNames,
          selectedHost,
          discovery.activePeers,
        );
      });
      attemptedModels = [...new Set([...(superseded ? [superseded] : []), ...retryablePending])];
      const retireRouteCandidate =
        previousOwnsOllama && !isLocalOllamaRouteOwner(nextRoute, selectedHost);
      if (attemptedModels.length === 0 && !retireRouteCandidate) return;
      try {
        revalidateSandboxIdentity?.("release the superseded Ollama model");
      } catch (error) {
        authorityRefusal = error;
        pendingRecordFailure = persistRetry();
        if (pendingRecordFailure) {
          cleanupWarning =
            `  Warning: Cleanup retry state could not be recorded for '${previous.name}' after the new inference route became active: ${pendingRecordFailure}. ` +
            `No model was unloaded. Manually verify ownership before releasing only ${attemptedModels.join(", ") || "the superseded model"} from the saved local Ollama endpoint.`;
        }
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
            clearPending(previous, attemptedModels);
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
      const pendingAfterCleanup = loadPending(previous);
      if (retireRouteCandidate && !cleanupWarning && pendingAfterCleanup.length === 0) {
        const routeOwnerDiscovery =
          modelOwners.length === ollamaRouteCandidates.length
            ? discovery
            : discoverPeers(ollamaRouteCandidates);
        if (!routeOwnerDiscovery.ok) {
          cleanupWarning =
            `  Warning: Ollama cleanup for '${previous.name}' was scoped to verified model owners, ` +
            "but the host route receipt was retained because other Ollama gateway owners could not be verified.";
        } else {
          const activeOllamaPeerRoutes = peers.filter(
            (peer) =>
              (routeOwnerDiscovery.activePeers
                ? routeOwnerDiscovery.activePeers.has(peer)
                : routeOwnerDiscovery.activeSandboxNames.has(peer.name)) &&
              isLocalOllamaRouteOwner(peer, selectedHost),
          );
          if (activeOllamaPeerRoutes.length === 0) {
            // Stopped registry owners still need the shared host target if they restart.
            deps.localInference.clearPersistedOllamaHostIfUnused?.(ollamaRouteCandidates);
          }
        }
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

async function rejectNativeLocalSetupFailure(input: {
  error: unknown;
  attachment?: NativeLocalProviderAttachment;
  reservationEntered: boolean;
  sandboxName: string | null;
  gatewayName: string;
  deps: SetupInferenceDeps;
}): Promise<never> {
  if (
    input.attachment &&
    !input.reservationEntered &&
    input.deps.providerAdapter &&
    input.sandboxName
  ) {
    try {
      await retireUnreservedNativeLocalProvider({
        adapter: input.deps.providerAdapter,
        expected: input.attachment,
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
        getSandbox: input.deps.getSandbox,
        clearAuthority: input.deps.clearNativeLocalProviderAuthority,
      });
    } catch (cleanupError) {
      throw new Error(
        `${hostLocalInferenceFailureDetail(input.error, input.deps)}\n  Native local provider cleanup was not confirmed: ${hostLocalInferenceFailureDetail(cleanupError, input.deps)}`,
        { cause: input.error },
      );
    }
  }
  if (input.error instanceof HostLocalInferenceBranchExit)
    return input.deps.exitProcess(input.error.code);
  throw input.error;
}

async function cleanupUnreservedNativeLocalAfterHostFailure(input: {
  selectingNativeLocal: boolean;
  attachment?: NativeLocalProviderAttachment;
  reservationEntered: boolean;
  sandboxName: string | null;
  gatewayName: string;
  deps: SetupInferenceDeps;
}): Promise<void> {
  if (
    !input.selectingNativeLocal ||
    !input.attachment ||
    input.reservationEntered ||
    !input.sandboxName ||
    !input.deps.providerAdapter
  )
    return;
  try {
    await retireUnreservedNativeLocalProvider({
      adapter: input.deps.providerAdapter,
      expected: input.attachment,
      sandboxName: input.sandboxName,
      gatewayName: input.gatewayName,
      getSandbox: input.deps.getSandbox,
      clearAuthority: input.deps.clearNativeLocalProviderAuthority,
    });
  } catch (cleanupError) {
    input.deps.error(
      `  Native local provider cleanup was not confirmed: ${hostLocalInferenceFailureDetail(cleanupError, input.deps)}`,
    );
  }
}

async function resolveHostedSelection(input: {
  provider: string;
  endpointUrl: string | null;
  sandboxName: string | null;
  gatewayName: string;
  deps: SetupInferenceDeps;
  options: ProviderInferenceSetupOptions;
}) {
  const { provider, endpointUrl, sandboxName, gatewayName, deps, options } = input;
  const recordedSandbox = sandboxName ? deps.getSandbox?.(sandboxName) : null;
  const freshCustomSelection = Boolean(
    sandboxName &&
    isHostedCustomEndpoint(provider, endpointUrl) &&
    !recordedSandbox?.nativeHostedProviderAttachment?.custom &&
    (!recordedSandbox || recordedSandbox.pendingRouteReservation),
  );
  const resolvePolicyTier = options.resolvePolicyTier ?? deps.resolvePolicyTier;
  const policyTier = freshCustomSelection ? await resolvePolicyTier?.() : undefined;
  const custom = usesCustomNativeOnboarding(
    provider,
    endpointUrl,
    sandboxName,
    recordedSandbox,
    policyTier,
  );
  const authority =
    provider === "hermes-provider"
      ? ((recordedSandbox?.provider === provider
          ? requireHostedProviderAttachment(
              recordedSandbox.nativeHostedProviderAttachment,
              provider,
            )
          : undefined) ??
        deps.getNativeHostedProviderAuthority?.(gatewayName, provider, endpointUrl || undefined))
      : undefined;
  return {
    authority,
    recordedSandbox,
    custom,
    selected:
      custom ||
      (Boolean(hostedNativeProvider(provider)) &&
        (provider !== "hermes-provider" || usesNativeHermesEndpoint(endpointUrl, authority))),
  };
}

async function prepareSelectedHostedProvider(input: {
  provider: string;
  gatewayName: string;
  sandboxName: string | null;
  credentialEnv: string | null;
  reuseExistingCredential: boolean;
  deps: SetupInferenceDeps;
}): Promise<{
  attachment: NativeProviderAttachment;
  retainedCredential: boolean;
}> {
  const { provider, gatewayName, sandboxName, credentialEnv, reuseExistingCredential, deps } =
    input;
  if (
    !deps.providerAdapter ||
    !deps.getNativeHostedProviderAuthority ||
    !deps.setNativeHostedProviderAuthority
  ) {
    throw new Error("Native hosted setup is missing its provider adapter or ownership store.");
  }
  const hosted = hostedNativeProvider(provider);
  if (!hosted) throw new Error("Native hosted provider is unsupported.");
  const credentialValue = deps.hydrateCredentialEnv(credentialEnv || hosted.credentialEnv) || null;
  const attachment = await prepareHostedNativeProvider({
    provider,
    adapter: deps.providerAdapter,
    gatewayName,
    credentialValue,
    reuseExistingCredential,
    recordedSandbox: sandboxName ? deps.getSandbox?.(sandboxName) : null,
    readAuthority: deps.getNativeHostedProviderAuthority,
    writeAuthority: deps.setNativeHostedProviderAuthority,
  });
  return { attachment, retainedCredential: !credentialValue };
}

async function gatewayRouteCompatible(input: {
  provider: string;
  model: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  gatewayName: string;
  sandboxName: string | null;
  preferredInferenceApi: ProviderInferenceSetupOptions["preferredInferenceApi"];
  nativeHostedSelection: boolean;
  selectingNativeLocal: boolean;
  deps: SetupInferenceDeps;
}): Promise<boolean> {
  const {
    provider,
    model,
    endpointUrl,
    credentialEnv,
    gatewayName,
    sandboxName,
    preferredInferenceApi,
    nativeHostedSelection,
    selectingNativeLocal,
    deps,
  } = input;
  if (isNativeNvidiaProvider(provider) || nativeHostedSelection || selectingNativeLocal)
    return true;
  const observedRoute = await deps.inferenceRouteObserver.observeInferenceRoute({
    target: { kind: "named", gatewayName },
  });
  if (!observedRoute.ok) {
    deps.error(
      `  Cannot reconcile the current OpenShell inference selection on gateway '${gatewayName}' before onboarding mutation: ${observedRoute.error.message}`,
    );
    return false;
  }
  const compatibility = deps.checkGatewayRouteCompatibility({
    gatewayName,
    sandboxName,
    route: {
      provider,
      model,
      endpointUrl,
      credentialEnv,
      preferredInferenceApi: preferredInferenceApi ?? null,
    },
  });
  if (compatibility.ok) return true;
  if (!isAdvisoryGatewayRouteConflict(compatibility)) {
    deps.error(`  Error: ${formatGatewayRouteConflict(compatibility)}`);
    return false;
  }
  deps.error(`  ${formatGatewayRouteImpactWarning(compatibility)}`);
  return true;
}

function shouldStageGatewayRouteAfterBackup(
  provider: string,
  source: SandboxEntry | null | undefined,
  hostLocalSelection: ProviderInferenceSetupOptions["hostLocalInference"],
  credentialEnv: string | null,
  ollamaProxyCredentialEnv: string,
): boolean {
  return Boolean(
    inferenceProviders.isRemoteProviderName(provider) &&
    !hostLocalSelection &&
    credentialEnv !== ollamaProxyCredentialEnv &&
    source &&
    !isLocalOllamaRouteOwner(source) &&
    source.pendingRouteReservation !== true,
  );
}

function createGatewayRouteStager(input: {
  deps: SetupInferenceDeps;
  provider: string;
  sandboxName: string | null;
  gatewayName: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hostLocalSelection: ProviderInferenceSetupOptions["hostLocalInference"];
  options: ProviderInferenceSetupOptions;
  revalidateSandboxIdentity?: (operation: string) => void;
}) {
  let stagedRoute: Parameters<OpenShellInferenceRouteMutator["setInferenceRoute"]>[0] | null = null;
  const stagedProviderUpserts: Array<
    () => Promise<Awaited<ReturnType<CommonDeps["upsertProvider"]>>>
  > = [];
  const publishedSourceForStaging = (): SandboxEntry | null => {
    const source =
      input.sandboxName && input.options.deferPublishedRouteReservation
        ? input.deps.getSandbox?.(input.sandboxName)
        : null;
    return shouldStageGatewayRouteAfterBackup(
      input.provider,
      source,
      input.hostLocalSelection,
      input.credentialEnv,
      input.deps.ollamaProxyCredentialEnv,
    )
      ? (source ?? null)
      : null;
  };
  const mutator: OpenShellInferenceRouteMutator = {
    setInferenceRoute: (request) => {
      input.revalidateSandboxIdentity?.("change the OpenShell inference provider route");
      if (publishedSourceForStaging()) {
        stagedRoute = request;
        return Promise.resolve({ ok: true });
      }
      return input.deps.inferenceRouteMutator.setInferenceRoute(request);
    },
  };
  return {
    mutator,
    reusePublishedProvider: (providerName: string) => {
      const source = publishedSourceForStaging();
      if (!source || source.provider !== providerName) return null;
      if (
        (source.endpointUrl ?? null) !== input.endpointUrl ||
        (source.credentialEnv ?? null) !== input.credentialEnv ||
        (source.preferredInferenceApi ?? null) !== (input.options.preferredInferenceApi ?? null)
      ) {
        return {
          ok: false,
          status: 1,
          message:
            `Cannot change provider '${providerName}' endpoint, credential binding, or ` +
            `inference API while recreating the published sandbox. Re-run this model ` +
            `change with the source sandbox's provider configuration.`,
        };
      }
      return { ok: true };
    },
    stageProviderUpsert: (
      upsert: () => Promise<Awaited<ReturnType<CommonDeps["upsertProvider"]>>>,
    ) => {
      if (!publishedSourceForStaging()) return false;
      stagedProviderUpserts.push(upsert);
      return true;
    },
    hasStagedRoute: () => stagedRoute !== null,
    successResult: (): SetupInferenceResult => {
      if (!stagedRoute) {
        if (stagedProviderUpserts.length > 0)
          throw new Error("The staged inference provider has no deferred route to publish.");
        return { ok: true };
      }
      const request = stagedRoute;
      const providerUpserts = [...stagedProviderUpserts];
      return {
        ok: true,
        // The sandbox create phase holds the gateway-route lock through backup,
        // route publication, and reservation. Acquiring it here would deadlock.
        deferredInferenceRoute: async (reserve) => {
          input.revalidateSandboxIdentity?.("apply the backed-up sandbox inference route");
          const target = {
            kind: "named" as const,
            gatewayName: input.gatewayName,
          };
          const before = await input.deps.inferenceRouteObserver.observeInferenceRoute({
            target,
          });
          if (!before.ok || before.value.state !== "configured") {
            throw new Error(
              `Cannot capture the published inference route on gateway '${input.gatewayName}' before replacement.`,
            );
          }
          const sourceRoute = before.value.route;
          try {
            for (const upsert of providerUpserts) {
              const providerResult = await upsert();
              if (!providerResult.ok)
                throw new Error(
                  providerResult.message ??
                    `Cannot update the inference provider on gateway '${input.gatewayName}'.`,
                );
            }
            const result = await input.deps.inferenceRouteMutator.setInferenceRoute(request);
            if (!result.ok) throw new Error(result.error.message);
            const after = await input.deps.inferenceRouteObserver.observeInferenceRoute({
              target,
            });
            if (
              !after.ok ||
              after.value.state !== "configured" ||
              after.value.route.provider !== request.route.provider ||
              after.value.route.model !== request.route.model
            ) {
              throw new Error("The replacement inference route was not verified.");
            }
            reserve();
          } catch (error) {
            const live = await input.deps.inferenceRouteObserver.observeInferenceRoute({
              target,
            });
            if (
              !live.ok ||
              live.value.state !== "configured" ||
              ((live.value.route.provider !== sourceRoute.provider ||
                live.value.route.model !== sourceRoute.model) &&
                (live.value.route.provider !== request.route.provider ||
                  live.value.route.model !== request.route.model))
            ) {
              throw new Error(
                "Cannot safely restore the published inference route after replacement failed; inspect the live gateway before retrying.",
                { cause: error },
              );
            }
            if (
              live.value.route.provider !== sourceRoute.provider ||
              live.value.route.model !== sourceRoute.model
            ) {
              input.revalidateSandboxIdentity?.("restore the published sandbox inference route");
              const restored = await input.deps.inferenceRouteMutator.setInferenceRoute({
                ...request,
                route: sourceRoute,
              });
              if (!restored.ok) {
                throw new Error(
                  `Cannot restore the published inference route: ${restored.error.message}`,
                  { cause: error },
                );
              }
              const confirmed = await input.deps.inferenceRouteObserver.observeInferenceRoute({
                target,
              });
              if (
                !confirmed.ok ||
                confirmed.value.state !== "configured" ||
                confirmed.value.route.provider !== sourceRoute.provider ||
                confirmed.value.route.model !== sourceRoute.model
              ) {
                throw new Error(
                  "Cannot verify restoration of the published inference route; inspect the live gateway before retrying.",
                  { cause: error },
                );
              }
            }
            throw error;
          }
        },
      };
    },
  };
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
    const policyTierResolver = options.resolvePolicyTier ?? deps.resolvePolicyTier;
    let policyTierResolution: Promise<string> | undefined;
    const resolvePolicyTier = policyTierResolver
      ? () => (policyTierResolution ??= policyTierResolver())
      : undefined;
    const hostedSelectionOptions = resolvePolicyTier ? { ...options, resolvePolicyTier } : options;
    if (sandboxName && isHostedCustomEndpoint(provider, endpointUrl)) {
      await resolvePolicyTier?.();
    }
    let selectingNativeLocal = false;
    let nativeLocalAgent: string | null | undefined;
    const routedProvider = deps.isRoutedInferenceProvider?.(provider) === true;
    const usesBedrockRuntimeAdapter =
      provider === "compatible-anthropic-endpoint" && isBedrockRuntimeEndpoint(endpointUrl);
    let shouldLogSuccessfulRoute = false;
    const withInferenceMutationLocks = <T>(operation: () => Promise<T> | T): Promise<T> =>
      deps.withGatewayRouteMutationLock(gatewayName, () =>
        withRoutedInferencePortLock(routedProvider, operation, deps),
      );
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
        const {
          authority: hermesAuthority,
          selected: nativeHostedSelection,
          custom: nativeCustomSelection,
          recordedSandbox,
        } = await resolveHostedSelection({
          provider,
          endpointUrl,
          sandboxName,
          gatewayName,
          deps,
          options: hostedSelectionOptions,
        });
        const selectedInferenceApi = resolveCustomNativeApi(
          provider,
          options.preferredInferenceApi,
          nativeCustomSelection,
        );
        if (
          !(await gatewayRouteCompatible({
            provider,
            model,
            endpointUrl,
            credentialEnv,
            gatewayName,
            sandboxName,
            preferredInferenceApi: selectedInferenceApi,
            nativeHostedSelection,
            selectingNativeLocal,
            deps,
          }))
        )
          return deps.exitProcess(1);
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
        const hostLocalSelection = options.hostLocalInference;
        const routeStager = createGatewayRouteStager({
          deps,
          provider,
          sandboxName,
          gatewayName,
          endpointUrl,
          credentialEnv,
          hostLocalSelection,
          options,
          revalidateSandboxIdentity,
        });
        const revalidatingInferenceRouteMutator = routeStager.mutator;
        let hostLocalRoute: HostLocalInferenceStartupRoute | null = null;
        let hostLocalGatewayMutation: HostLocalInferenceGatewayMutation | null = null;
        let hostLocalRollbackAttempted = false;
        let hostLocalRegistryPublicationEntered = false;
        const hostLocalProviderErrors: string[] = [];
        let routeReserved = false;
        let nativeLocalReservationEntered = false;
        let hostLocalInferenceReceipt: string | null = null;
        let hostLocalInferenceProvenance:
          | import("../state/registry/types").SandboxEntry["hostLocalInferenceProvenance"]
          | undefined;
        let hostLocalInferenceGatewayPortAuthority: number | undefined;
        let hostLocalInferenceRuntimeProviderId: string | undefined;
        let nativeLocalRecreationSource: SandboxEntry | undefined;
        let nativeLocalProviderAttachment: NativeLocalProviderAttachment | undefined;
        let nativeProviderEndpoint: string | undefined;
        let nativeHostedCredentialEnv: string | undefined;
        let nativeHostedProviderAttachment: NativeProviderAttachment | undefined;
        let retainedNativeHostedCredential = false;
        let nativeNvidiaProviderAttachment: NativeNvidiaProviderAttachment | undefined;
        const reserveRoute = (name: string, selectedProvider: string, selectedModel: string) => {
          if (routeReserved || nativeLocalRecreationSource) return true;
          // Local Ollama cleanup runs after this reservation; it must not unload
          // a model while its source route remains published.
          const publishedSource = options.deferPublishedRouteReservation
            ? deps.getSandbox?.(name)
            : null;
          if (
            !selectingNativeLocal &&
            options.deferPublishedRouteReservation &&
            shouldStageGatewayRouteAfterBackup(
              provider,
              publishedSource,
              hostLocalSelection,
              credentialEnv,
              deps.ollamaProxyCredentialEnv,
            )
          ) {
            // The sandbox phase owns the replacement reservation after its
            // pre-delete backup succeeds. Keep the current source connectable
            // if that backup rejects the workspace.
            return true;
          }
          revalidateSandboxIdentity?.("reserve the sandbox inference route");
          // A route-only reservation abandoned by an earlier run otherwise
          // refuses this one and blames a session that no longer exists
          // (#11051). Release it here, before the first write, so the refusal
          // is reserved for a reservation that is genuinely contended.
          const route: Parameters<SetupInferenceDeps["updateSandbox"]>[1] = {
            provider: selectedProvider,
            model: selectedModel,
            endpointUrl:
              nativeProviderEndpoint ?? hostLocalRoute?.applicationBaseUrl ?? endpointUrl,
            endpointSource: hostLocalRoute ? "inference-set" : endpointSource,
            credentialEnv: nativeHostedCredentialEnv ?? credentialEnv,
            preferredInferenceApi: selectedInferenceApi,
            gatewayName,
            reservationSessionId: options.reservationSessionId,
            hostLocalInferenceReceipt,
            ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
            ...(nativeLocalProviderAttachment ? { nativeLocalProviderAttachment } : {}),
            ...(nativeNvidiaProviderAttachment ? { nativeNvidiaProviderAttachment } : {}),
            ...(nativeHostedProviderAttachment ? { nativeHostedProviderAttachment } : {}),
            ...(hostLocalInferenceProvenance && hostLocalInferenceGatewayPortAuthority !== undefined
              ? { gatewayPort: hostLocalInferenceGatewayPortAuthority }
              : {}),
            ...(hostLocalInferenceProvenance && hostLocalInferenceRuntimeProviderId
              ? { openshellDriver: hostLocalInferenceRuntimeProviderId }
              : {}),
          };
          if (releaseAbandonedRouteReservation(name, route)) {
            deps.log(`  Released an abandoned inference route reservation for sandbox '${name}'.`);
          }
          // A failed response can follow a durable registry write. Retain authority once publication starts.
          nativeLocalReservationEntered = true;
          const reserved = deps.updateSandbox(name, route);
          routeReserved = reserved;
          return reserved;
        };

        const defaultUpsertProvider = bindGatewayUpsertProvider(
          deps.upsertProvider,
          gatewayName,
          revalidateSandboxIdentity,
        );
        const providerExitProcess: CommonDeps["exitProcess"] =
          hostLocalSelection || selectingNativeLocal
            ? (code: number): never => {
                throw new HostLocalInferenceBranchExit(code);
              }
            : deps.exitProcess;
        const ambiguousRouteExitProcess: CommonDeps["exitProcess"] = hostLocalSelection
          ? (code: number): never => {
              throw new HostLocalInferenceBranchExit(code, true);
            }
          : deps.exitProcess;
        const providerError: CommonDeps["error"] = hostLocalSelection
          ? (message: string) => {
              hostLocalProviderErrors.push(message);
            }
          : deps.error;
        const selectedUpsertProvider: CommonDeps["upsertProvider"] = async (...args) => {
          revalidateSandboxIdentity?.("register the inference provider");
          if (selectingNativeLocal) {
            if (!sandboxName) throw new Error("Native local inference requires a sandbox.");
            if (hostLocalGatewayMutation?.registerNativeProvider) {
              nativeLocalProviderAttachment =
                await hostLocalGatewayMutation.registerNativeProvider();
              return { ok: true };
            }
            if (!deps.providerAdapter)
              throw new Error("Native local inference requires a provider adapter.");
            const [name, , sourceCredentialEnv, selectedEndpoint, env] = args;
            const recorded = deps.getSandbox?.(sandboxName);
            if (
              recorded &&
              recorded.pendingRouteReservation !== true &&
              (usesNativeLocalInference(recorded.provider, recorded.endpointUrl) ||
                usesNativeLocalInferenceForAgent(
                  recorded.agent,
                  recorded.provider,
                  recorded.endpointUrl,
                )) &&
              !normalizeNativeLocalProviderAttachment(recorded.nativeLocalProviderAttachment)
            ) {
              if (
                !options.recreatePublishedSandbox ||
                !options.deferPublishedRouteReservation ||
                !options.reservationSessionId ||
                (recorded.agent !== "langchain-deepagents-code" &&
                  recorded.agent !== "openclaw" &&
                  recorded.agent !== "hermes" &&
                  recorded.agent !== "pi")
              ) {
                throw new Error("Recreate this beta sandbox before using native local inference.");
              }
              nativeLocalRecreationSource = structuredClone(recorded);
            }
            const value = env?.[sourceCredentialEnv] ?? null;
            const hostReachableEndpoint =
              hostLocalRoute?.gatewayProviderBaseUrl ??
              gatewayReachableCompatibleEndpointUrl(name, selectedEndpoint);
            if (typeof hostReachableEndpoint !== "string")
              throw new Error("Native local inference endpoint is missing.");
            nativeLocalProviderAttachment = await prepareNativeLocalSelection({
              adapter: deps.providerAdapter,
              binding: {
                provider: name as NativeLocalProvider,
                ...(nativeLocalAgent === "openclaw" ||
                nativeLocalAgent === "pi" ||
                nativeLocalAgent === "hermes"
                  ? { agent: nativeLocalAgent }
                  : {}),
                endpointUrl: hostReachableEndpoint,
                authMode:
                  (name === "ollama-local" && value === "ollama") ||
                  (name === "vllm-local" && value === "dummy")
                    ? "sentinel"
                    : "authenticated",
                gatewayName,
                sandboxName,
              },
              credentialValue: value,
              ownedProxy:
                (name === "ollama-local" && !hostLocalRoute && deps.shouldFrontOllamaWithProxy()) ||
                (name === "compatible-endpoint" &&
                  sourceCredentialEnv === deps.ollamaProxyCredentialEnv),
              readAuthority: deps.getNativeLocalProviderAuthority,
              writeAuthority: deps.setNativeLocalProviderAuthority,
            });
            return { ok: true };
          }
          const reused = routeStager.reusePublishedProvider(args[0]);
          if (reused) return reused;
          const upsertProvider = hostLocalGatewayMutation?.upsertProvider ?? defaultUpsertProvider;
          if (routeStager.stageProviderUpsert(async () => await upsertProvider(...args)))
            return { ok: true };
          return await upsertProvider(...args);
        };
        const commonDeps = {
          runOpenshell: runGatewayOpenshell,
          inferenceRouteMutator: revalidatingInferenceRouteMutator,
          nativeLocalInference: selectingNativeLocal,
          gatewayName,
          upsertProvider: selectedUpsertProvider,
          verifyInferenceRoute: (selectedProvider: string, selectedModel: string) => {
            if (routeStager.hasStagedRoute()) return;
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
          reserveSandboxInferenceRoute: (name: string) => reserveRoute(name, provider, model),
          exitProcess: providerExitProcess,
          error: providerError,
          log: deps.log,
        } satisfies CommonDeps &
          Pick<
            RemoteProviderDeps,
            "inferenceRouteMutator" | "gatewayName" | "reserveSandboxInferenceRoute"
          >;

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
          if (nativeCustomSelection) {
            if (
              !deps.providerAdapter ||
              !deps.getNativeHostedProviderAuthority ||
              !deps.setNativeHostedProviderAuthority
            )
              throw new Error(
                "Native custom setup is missing its provider adapter or ownership store.",
              );
            const selectedCredentialEnv = credentialEnv || customNativeCredentialEnv(provider);
            const credentialValue = deps.hydrateCredentialEnv(selectedCredentialEnv) || null;
            nativeHostedProviderAttachment = await prepareCustomNativeProvider({
              gatewayName,
              provider,
              endpointUrl: endpointUrl!,
              api: selectedInferenceApi!,
              credentialEnv: selectedCredentialEnv,
              credentialValue,
              adapter: deps.providerAdapter,
              recordedAttachment:
                recordedSandbox?.provider === provider
                  ? recordedSandbox.nativeHostedProviderAttachment
                  : undefined,
              recordedSandboxName:
                recordedSandbox?.provider === provider ? recordedSandbox.name : null,
              lookup: endpointPinnedAddresses
                ? async () => endpointPinnedAddresses!.map((address) => ({ address }))
                : deps.resolveEndpointHost,
              trustedPrivateHosts: deps.trustedPrivateEndpointHosts,
              readAuthority: deps.getNativeHostedProviderAuthority,
              writeAuthority: deps.setNativeHostedProviderAuthority,
              onCredentialPersisted: (env, value) => {
                deps.recordMigratedProviderCredential?.(
                  provider,
                  env,
                  value,
                  revalidateSandboxIdentity,
                );
              },
            });
            retainedNativeHostedCredential = !credentialValue;
            return null;
          }
          const hosted = hostedNativeProvider(provider);
          if (hosted && provider !== deps.hermesProviderAuth.HERMES_PROVIDER_NAME) {
            const prepared = await prepareSelectedHostedProvider({
              provider,
              gatewayName,
              sandboxName,
              credentialEnv,
              reuseExistingCredential: options.reuseGatewayCredentialWithoutLocalKey === true,
              deps,
            });
            nativeHostedProviderAttachment = prepared.attachment;
            retainedNativeHostedCredential = prepared.retainedCredential;
            return null;
          }

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
                getNativeProviderAuthority: () => hermesAuthority,
                prepareNativeProvider: async (apiKey, returnedEndpoint) => {
                  if (
                    !deps.providerAdapter ||
                    !deps.getNativeHostedProviderAuthority ||
                    !deps.setNativeHostedProviderAuthority
                  )
                    throw new Error(
                      "Native Hermes setup is missing its provider adapter or ownership store",
                    );
                  revalidateSandboxIdentity?.("register the native Hermes provider");
                  nativeHostedProviderAttachment = await prepareHostedNativeProvider({
                    provider,
                    gatewayName,
                    adapter: deps.providerAdapter,
                    credentialValue: apiKey,
                    endpointUrl: returnedEndpoint,
                    lookup: deps.resolveEndpointHost,
                    recordedSandbox: sandboxName ? deps.getSandbox?.(sandboxName) : null,
                    reuseExistingCredential: apiKey === null,
                    readAuthority: deps.getNativeHostedProviderAuthority,
                    writeAuthority: deps.setNativeHostedProviderAuthority,
                  });
                  nativeProviderEndpoint =
                    nativeHostedProviderAttachment.endpointUrl ??
                    hostedNativeProvider(provider)!.endpoint;
                  nativeHostedCredentialEnv = "OPENAI_API_KEY";
                  return nativeHostedProviderAttachment;
                },
                hermesProviderAuth: deps.hermesProviderAuth,
                getHermesToolGatewayBroker: deps.getHermesToolGatewayBroker,
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

          if (isNativeNvidiaProvider(provider)) {
            const resolvedCredentialEnv = credentialEnv || NVIDIA_HOSTED_CREDENTIAL_ENV;
            const credentialValue = deps.hydrateCredentialEnv(resolvedCredentialEnv) || null;
            const providerAdapter = deps.providerAdapter;
            if (!providerAdapter) {
              throw new Error("Native NVIDIA setup is missing its OpenShell provider adapter.");
            }
            const recordedSandbox = sandboxName ? deps.getSandbox?.(sandboxName) : null;
            const recordedAttachment = normalizeNativeNvidiaProviderAttachment(
              recordedSandbox?.nativeNvidiaProviderAttachment,
            );
            if (
              recordedSandbox &&
              isNativeNvidiaProvider(recordedSandbox.provider) &&
              !recordedAttachment
            ) {
              throw new Error(
                `Sandbox '${sandboxName}' predates native NVIDIA provider attachments. Recreate this beta sandbox before using native NVIDIA inference; NemoClaw does not migrate existing beta sandboxes automatically.`,
              );
            }
            const gatewayAuthority = deps.getNativeNvidiaProviderAuthority?.(gatewayName);
            const providerAuthority = resolveGatewayNativeNvidiaProviderAuthority({
              gatewayName,
              gatewayAuthority,
              recordedAttachment,
            });
            nativeNvidiaProviderAttachment = await ensureNativeNvidiaProvider({
              adapter: providerAdapter,
              target: { kind: "named", gatewayName },
              credentialValue,
              reuseExistingCredential: options.reuseGatewayCredentialWithoutLocalKey === true,
              ...(providerAuthority ? { expected: providerAuthority } : {}),
              ...(providerAuthority && !gatewayAuthority && recordedSandbox
                ? { recordedSandboxName: recordedSandbox.name }
                : {}),
            });
            nativeProviderEndpoint = NVIDIA_HOSTED_NATIVE_ENDPOINT;
            // The retained gateway credential is unavailable to a host-side smoke.
            retainedNativeHostedCredential = !credentialValue;
            if (deps.getNativeNvidiaProviderAuthority && deps.setNativeNvidiaProviderAuthority) {
              await persistNativeNvidiaProviderAuthority({
                adapter: providerAdapter,
                target: { kind: "named", gatewayName },
                gatewayName,
                receipt: nativeNvidiaProviderAttachment,
                ...(providerAuthority ? { existing: providerAuthority } : {}),
                readAuthority: deps.getNativeNvidiaProviderAuthority,
                writeAuthority: deps.setNativeNvidiaProviderAuthority,
              });
            } else {
              deps.setNativeNvidiaProviderAuthority?.(gatewayName, nativeNvidiaProviderAttachment);
            }
            return null;
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
                allowLegacyRecordedNoAuthEndpoint:
                  options.allowLegacyRecordedNoAuthEndpoint === true,
                skipHostInferenceSmoke: options.skipHostInferenceSmoke === true,
                preferredInferenceApi: selectedInferenceApi,
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
                providerAdapter: deps.providerAdapter,
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
                applyLocalInferenceRoute: selectingNativeLocal
                  ? async () => {
                      if (!nativeLocalProviderAttachment)
                        throw new Error("Native local provider registration was not confirmed.");
                      return false;
                    }
                  : resolveLocalInferenceRouteApplier(
                      hostLocalRoute
                        ? {
                            ...deps,
                            exitProcess: commonDeps.exitProcess,
                            error: commonDeps.error,
                          }
                        : deps,
                      revalidatingInferenceRouteMutator,
                      gatewayName,
                      revalidateSandboxIdentity,
                      ambiguousRouteExitProcess,
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
                    : {
                        preparedProxyToken: options.preparedOllamaProxyToken,
                      }),
                },
                {
                  ...commonDeps,
                  validateLocalProvider: hostLocalRoute
                    ? () => ({ ok: true as const })
                    : deps.validateLocalProvider,
                  getLocalProviderBaseUrl: hostLocalRoute
                    ? () => hostLocalRoute.gatewayProviderBaseUrl
                    : deps.getLocalProviderBaseUrl,
                  applyLocalInferenceRoute: selectingNativeLocal
                    ? async () => {
                        if (!nativeLocalProviderAttachment)
                          throw new Error("Native local provider registration was not confirmed.");
                        return false;
                      }
                    : resolveLocalInferenceRouteApplier(
                        hostLocalRoute
                          ? {
                              ...deps,
                              exitProcess: commonDeps.exitProcess,
                              error: commonDeps.error,
                            }
                          : deps,
                        revalidatingInferenceRouteMutator,
                        gatewayName,
                        revalidateSandboxIdentity,
                        ambiguousRouteExitProcess,
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
          if (selectingNativeLocal && !nativeLocalProviderAttachment)
            throw new Error("Native local provider registration was not confirmed.");
          if (
            !nativeNvidiaProviderAttachment &&
            !nativeHostedProviderAttachment &&
            !nativeLocalProviderAttachment
          )
            commonDeps.verifyInferenceRoute(provider, model);
          if (hostLocalRoute) {
            deps.log(
              "  Deferring inference.local smoke to the sandbox runtime after sandbox readiness.",
            );
          } else if (nativeHostedProviderAttachment?.custom) {
            deps.log(
              "  Custom native inference will be verified from the sandbox using its selected API.",
            );
          } else if (options.skipHostInferenceSmoke === true || retainedNativeHostedCredential) {
            deps.log("  Reusing existing gateway credential; skipping host inference smoke.");
          } else {
            await deps.verifyOnboardInferenceSmoke({
              provider,
              model,
              endpointUrl:
                nativeProviderEndpoint ??
                nativeHostedProviderAttachment?.endpointUrl ??
                hostedNativeProvider(provider)?.endpoint ??
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
            const finalizePublishedResume = hostLocalRoute.prepared.finalizePublishedResume;
            const committed = normalizeHostLocalInferenceReceipt(
              finalizePublishedResume
                ? finalizePublishedResume(() => {
                    revalidateSandboxIdentity?.(
                      "finalize the published host-local inference provider receipt",
                    );
                    if (sandboxName && !routeReserved) {
                      throw new Error(
                        "Host-local inference published resume lost sandbox route reservation authority.",
                      );
                    }
                  })
                : hostLocalRoute.prepared.commit(),
            );
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
          if (nativeLocalRecreationSource && nativeLocalProviderAttachment) {
            return {
              ok: true,
              stagedNativeLocalRecreation: {
                source: nativeLocalRecreationSource,
                attachment: nativeLocalProviderAttachment,
              },
            };
          }
          return routeStager.successResult();
        } catch (error) {
          if (!hostLocalRoute || !hostLocalSelection) {
            return rejectNativeLocalSetupFailure({
              error,
              attachment: nativeLocalProviderAttachment,
              reservationEntered: nativeLocalReservationEntered,
              sandboxName,
              gatewayName,
              deps,
            });
          }
          await cleanupUnreservedNativeLocalAfterHostFailure({
            selectingNativeLocal,
            attachment: nativeLocalProviderAttachment,
            reservationEntered: nativeLocalReservationEntered,
            sandboxName,
            gatewayName,
            deps,
          });
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
            !hostLocalRollbackAttempted &&
            !(error instanceof HostLocalInferenceBranchExit && error.routeMutationAmbiguous)
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
      const selectedAgent = options.agentName ?? options.hostLocalInference?.request.application;
      let recordedAgent: string | null | undefined;
      let recordedNimContainer: string | null | undefined;
      try {
        const recorded = sandboxName ? (deps.getSandbox?.(sandboxName) ?? null) : null;
        previousSandbox = recorded;
        recordedAgent = recorded?.agent;
        recordedNimContainer = recorded?.nimContainer;
      } catch (error) {
        if (!selectedAgent && usesNativeLocalInference(provider, endpointUrl)) throw error;
        /* An unreadable registry skips GPU release; it must not fail onboarding. */
      }
      nativeLocalAgent = selectedAgent ?? recordedAgent;
      selectingNativeLocal =
        !options.hostLocalInference?.sharedInferenceRoute &&
        usesNativeLocalInferenceForAgent(
          nativeLocalAgent,
          provider,
          endpointUrl,
          options.localNimSelected ?? (provider === "vllm-local" && Boolean(recordedNimContainer)),
        );
      const preservingLegacyPiRoute =
        options.preserveLegacyPiSharedLocalRoute === true &&
        isPersistedPiSharedLocalInferenceRoute(
          sandboxName ? deps.getSandbox?.(sandboxName) : null,
          { provider, model, endpointUrl },
        );
      if (options.preserveLegacyPiSharedLocalRoute && !preservingLegacyPiRoute)
        throw new Error("Recorded Pi shared local inference route changed before setup.");
      selectingNativeLocal = selectingNativeLocal && !preservingLegacyPiRoute;
      if (selectingNativeLocal)
        await (deps.requireNativeProviderPolicy ?? requireNativeProviderPolicy)(gatewayName);

      // Compatible endpoints can own the same host Ollama daemon as direct Ollama routes.
      // Serialize publication with release decisions across gateways to prevent a newly
      // published peer route from being missed by concurrent cleanup (#12677).
      const participatesInOllamaOwnership =
        (previousSandbox !== null && isLocalOllamaRouteOwner(previousSandbox)) ||
        isLocalOllamaRouteOwner({ provider, endpointUrl });
      const runRouteAndRelease = async (): Promise<SetupInferenceResult> => {
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
          deps.log(
            isNativeNvidiaProvider(provider)
              ? `  ✓ Native NVIDIA provider ready: ${provider} / ${model}`
              : `  ✓ Inference route set: ${provider} / ${model}`,
          );
        }
        return result;
      };
      if (!participatesInOllamaOwnership) return runRouteAndRelease();
      const withOwnershipTransaction =
        deps.withOllamaModelOwnershipTransaction ?? withOllamaModelOwnershipTransaction;
      return withOwnershipTransaction(runRouteAndRelease);
    };
    return sandboxName
      ? deps.withSandboxMutationLock(sandboxName, mutateGatewayRouteAndReleaseSupersededModel)
      : mutateGatewayRouteAndReleaseSupersededModel();
  };
}
