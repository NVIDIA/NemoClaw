// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { clearAutoDetectedCompatibleContextWindow } from "../../../inference/compatible-endpoint-context";
import { resolveAgentProviderInferenceApi } from "../../../inference/config";
import type { TrustedPrivateEndpointCapability } from "../../../inference/endpoint-ssrf-preflight";
import {
  type CurrentGatewayRouteCompatibilityCheck,
  type CurrentGatewayRouteDiscoveryPreflight,
  type GatewayRouteDiscoveryConstraints,
  isAdvisoryGatewayRouteConflict,
} from "../../../inference/gateway-route-compatibility";
import { withModelRouterPortLifecycleLock } from "../../../inference/gateway-route-mutation-lock";
import { getOllamaContextWindowFloorForAgent } from "../../../inference/ollama-runtime-context";
import type { InferenceEndpointSource } from "../../../inference/selection";
import type { ServingProfileProvenance } from "../../../inference/serving/types";
import type { WebSearchConfig } from "../../../inference/web-search";
import type { HermesAuthMethod, Session, SessionUpdates } from "../../../state/onboard-session";
import { checkpointSandboxIdentityMatches } from "../../checkpoint-replay";
import type { OnboardInferenceCapabilityCache } from "../../inference-capability-cache";
import type { RepairLocalInferenceSystemdOverrideOptions } from "../../local-inference-topology";
import { resolveModelRouterPort } from "../../model-router";
import { promptOnboardConfigurationReview } from "../../prompt-helpers";
import {
  describeIgnoredReasoningEffortEnv,
  describeIgnoredReasoningEnv,
  REASONING_EFFORT_ENV,
  type ReasoningEffort,
  type ReasoningEffortRequest,
  resolveReasoningEffortRequest,
} from "../../reasoning-mode";
import type {
  createProviderRecoveryReceiptLedger,
  ProviderRecoveryReceipt,
} from "../../rebuild-route-handoff";
import type { HostLocalOllamaAccelerationAuthority } from "../../runtime-provider/host-local-inference";
import { normalizeHostLocalOllamaModelRef } from "../../runtime-provider/host-local-inference";
import {
  HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL,
  HOST_LOCAL_INFERENCE_APPLICATIONS,
  type HostLocalInferenceApplication,
  type HostLocalInferenceSandboxProofAuthority,
  type HostLocalInferenceStartupSelection,
  type HostLocalInferenceStartupSelectionResolver,
  hostLocalInferenceGatewayProvider,
  hostLocalInferenceRequestModel,
  hostLocalInferenceRequestToolCalling,
  hostLocalInferenceSandboxProofAuthority,
} from "../../runtime-provider/host-local-inference-routing";
import { withInferenceTrace, withProviderSelectionTrace } from "../../tracing";
import { advanceTo, type OnboardStateTransitionResult, retryTo } from "../result";
import { createRecovery, type RecoveryAuthority } from "./provider-inference-recovery";
import {
  assertProviderInferenceRouteCompatible,
  guardProviderInferenceRouteSelection,
  type ProviderInferenceProbeRoute,
} from "./provider-inference-route-containment";

export type ProviderInferenceRetry = { retry: "selection" } | { ok: true; retry?: undefined };

export interface ProviderInferenceSetupOptions {
  gatewayName?: string;
  allowToolsIncompatible?: boolean;
  skipHostInferenceSmoke?: boolean;
  reuseGatewayCredentialWithoutLocalKey?: boolean;
  /** Exact onboarding-provenanced endpoint permitted to skip DNS re-resolution. */
  onboardEndpointUrl?: string;
  /**
   * Resolved (agent-coerced) inference API for the selection. Lets the
   * remote-provider registration pick the gateway surface that matches the
   * sandbox contract (#6294: openai_compatible agents on
   * compatible-anthropic-endpoint register type=openai).
   */
  preferredInferenceApi?: string | null;
  /** Public addresses approved for custom endpoint host probes. */
  endpointPinnedAddresses?: readonly string[];
  /** Durable route provenance to preserve when reserving a refreshed route. */
  endpointSource?: InferenceEndpointSource | null;
  /** Non-forgeable proof of the exact host and complete pins admitted by the custom preflight. */
  endpointTrustedPrivateCapability?: TrustedPrivateEndpointCapability;
  /** One-shot host capability cache carried only through this onboarding run. */
  inferenceCapabilityCache?: OnboardInferenceCapabilityCache;
  /** Onboard session that owns the route reservation this setup creates. */
  reservationSessionId?: string;
  /** Recheck recorded-route ownership after acquiring route mutation locks. */
  isRecordedProviderRecoveryAuthorized?: () => boolean;
  /** Recheck the receipt-bound policy requirements at each inference mutation edge. */
  revalidatePolicyRequirements?: (operation: string) => void;
  /** Operation-scoped provider request selected for this onboarding attempt. */
  hostLocalInference?: HostLocalInferenceStartupSelection;
  /** Proxy token prepared after configuration review; avoids repeating host mutations in setup. */
  preparedOllamaProxyToken?: string;
}

export interface ProviderSelectionResult {
  model: string | null;
  provider: string;
  endpointUrl: string | null;
  endpointSource?: InferenceEndpointSource | null;
  credentialEnv: string | null;
  hermesAuthMethod: HermesAuthMethod | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: string | null;
  compatibleEndpointReasoningEffort: string | null;
  nimContainer: string | null;
  allowToolsIncompatible?: boolean;
  skipHostInferenceSmoke?: boolean;
  reuseGatewayCredentialWithoutLocalKey?: boolean;
  recoveredFromSandbox?: boolean;
  endpointPinnedAddresses?: string[];
  endpointTrustedPrivateCapability?: TrustedPrivateEndpointCapability;
  inferenceCapabilityCache?: OnboardInferenceCapabilityCache;
  /** Checkpoint identity proven while validating a local vLLM served alias. */
  vllmModelIdentity?: string;
}

export interface ProviderInferenceStateOptions<Gpu, Agent, Host> {
  gatewayName: string;
  resume: boolean;
  fresh: boolean;
  session: Session | null;
  gpu: Gpu;
  /** Accepted sandbox GPU-passthrough choice for this flow, including resume. */
  gpuPassthrough: boolean;
  sandboxName: string | null;
  /** Sandbox name the operator passed this run via --name or NEMOCLAW_SANDBOX_NAME (#8953). */
  requestedSandboxName?: string | null;
  agent: Agent;
  forceProviderSelection?: boolean;
  /** Force setup for a provider that authoritative rebuild preflight observed missing. */
  forceInferenceSetup?: boolean;
  /** Trust the rebuild-preflighted session selection even if its old step marker is incomplete. */
  authoritativeResumeConfig?: boolean;
  /** One-shot authority, activated at selection, to recover a recorded provider during rebuild. */
  providerRecoveryReceipt?: ProviderRecoveryReceipt | null;
  providerRecoveryReceiptLedger?: ReturnType<typeof createProviderRecoveryReceiptLedger>;
  initial: {
    model: string | null;
    provider: string | null;
    endpointUrl: string | null;
    endpointSource?: InferenceEndpointSource | null;
    /** Canonical endpoint paired with onboard provenance; never inferred from a later URL. */
    onboardEndpointUrl?: string | null;
    credentialEnv: string | null;
    hermesAuthMethod: HermesAuthMethod | null;
    hermesToolGateways: string[];
    preferredInferenceApi: string | null;
    compatibleEndpointReasoning: string | null;
    compatibleEndpointReasoningEffort: string | null;
    nimContainer: string | null;
    webSearchConfig: WebSearchConfig | null;
  };
  selectedMessagingChannels: string[];
  env: NodeJS.ProcessEnv;
  constants: {
    hermesProviderName: string;
    hermesApiKeyAuthMethod: HermesAuthMethod;
    hermesApiKeyCredentialEnv: string;
  };
  deps: {
    checkGatewayRouteCompatibility: CurrentGatewayRouteCompatibilityCheck;
    preflightGatewayRouteDiscovery: CurrentGatewayRouteDiscoveryPreflight;
    preflightPolicyRequirements(input: {
      gatewayName: string;
      sandboxName: string | null;
      agent: Agent;
      selectedMessagingChannels: readonly string[];
      hermesToolGateways: readonly string[];
      gpuPassthrough: boolean;
      provider: string | null;
      hostLocalInferenceRouteOnly?: boolean;
      webSearchConfig: WebSearchConfig | null;
      observabilityEnabled: boolean;
      operation: string;
    }): void;
    getSandboxRecoveryAuthority(
      sandboxName: string,
      sessionId: string | null | undefined,
    ): RecoveryAuthority;
    withGatewayRouteMutationLock<T>(
      gatewayName: string,
      operation: () => Promise<T> | T,
    ): Promise<T>;
    withModelRouterPortLifecycleLock?<T>(port: number, operation: () => Promise<T> | T): Promise<T>;
    getModelRouterPort?(): number;
    normalizeHermesAuthMethod(value: string | null | undefined): HermesAuthMethod | null;
    setupNim(
      gpu: Gpu,
      sandboxName: string | null,
      agent: Agent,
      allowRecordedProviderRecovery?: boolean,
      gatewayName?: string,
      assertRouteCompatible?: (
        route: ProviderInferenceProbeRoute,
      ) => GatewayRouteDiscoveryConstraints,
      canProbeRoute?: (provider: string) => boolean,
      recoverySessionId?: string | null,
      revalidatePolicyRequirements?: (
        route: ProviderInferenceProbeRoute,
        operation: string,
      ) => void,
    ): Promise<ProviderSelectionResult>;
    setupInference(
      sandboxName: string | null,
      model: string,
      provider: string,
      endpointUrl: string | null,
      credentialEnv: string | null,
      hermesAuthMethod: HermesAuthMethod | null,
      hermesToolGateways: string[],
      options?: ProviderInferenceSetupOptions,
    ): Promise<ProviderInferenceRetry>;
    /** Resolve an operation-scoped request only after provider selection is accepted. */
    resolveHostLocalInferenceStartupSelection: HostLocalInferenceStartupSelectionResolver;
    startRecordedStep(
      stepName: string,
      updates?: { provider?: string | null; model?: string | null },
    ): Promise<void>;
    recordStepComplete(stepName: string, updates: SessionUpdates): Promise<Session>;
    recordStepRejected(stepName: string): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    ensureResumeProviderReady(
      gatewayName: string,
      provider: string | null | undefined,
      credentialEnv: string | null | undefined,
      revalidatePolicyRequirements?: (operation: string) => void,
    ): Promise<{ forceInferenceSetup: boolean; credentialEnv: string | null }>;
    ensureManagedLlamaCppResumeReady(
      provider: string | null | undefined,
      sandboxName: string | null | undefined,
      revalidatePolicyRequirements?: (operation: string) => void,
    ): Promise<boolean>;
    isResumeProviderSurfaceReady(
      gatewayName: string,
      provider: string | null | undefined,
      preferredInferenceApi: string | null | undefined,
      credentialEnv: string | null | undefined,
      endpointUrl: string | null | undefined,
    ): boolean;
    recordStateSkipped(
      state: "provider_selection" | "inference",
      metadata?: Record<string, unknown> | null,
    ): Promise<Session>;
    recordRepairEvent(
      type: "state.repair.started" | "state.repair.completed" | "state.repair.failed",
      options?: {
        state?: "provider_selection" | "inference";
        error?: string | null;
        metadata?: Record<string, unknown> | null;
      },
    ): Promise<Session>;
    hydrateCredentialEnv(credentialEnv: string | null): string | null | undefined;
    configureCompatibleEndpointReasoning(storedValue?: string | null): Promise<"true" | "false">;
    clearCompatibleEndpointReasoning(): null;
    configureCompatibleEndpointReasoningEffort(
      storedValue?: unknown,
      env?: NodeJS.ProcessEnv,
      allowRequestFallback?: boolean,
    ): Promise<ReasoningEffort | null>;
    clearCompatibleEndpointReasoningEffort(): null;
    repairLocalInferenceSystemdOverrideOrExit(
      options: RepairLocalInferenceSystemdOverrideOptions,
    ): void;
    isNonInteractive(): boolean;
    getOpenshellBinary(): string;
    needsBedrockRuntimeAdapter(provider: string, endpointUrl: string | null): boolean;
    isInferenceRouteReady(gatewayName: string, provider: string, model: string): boolean;
    isRoutedInferenceProvider(provider: string): boolean;
    reconcileModelRouter(): Promise<void>;
    reupsertRoutedProvider(
      gatewayName: string,
      provider: string,
      endpointUrl: string | null,
      credentialEnv: string | null,
    ): { ok: boolean; endpointUrl: string; message?: string; status?: number };
    reserveSandboxInferenceRoute(
      sandboxName: string,
      route: {
        provider: string | null;
        model: string | null;
        endpointUrl: string | null;
        endpointSource: InferenceEndpointSource | null;
        credentialEnv: string | null;
        preferredInferenceApi: string | null;
        gatewayName: string;
        reservationSessionId?: string;
      },
      options?: { requireAbsent?: boolean },
    ): boolean;
    registryUpdateSandbox(sandboxName: string, updates: { nimContainer?: string | null }): void;
    checkpointSandboxIdentity(sandboxName: string, agent: Agent): Promise<void>;
    prepareLocalProviderForInference(provider: string): Promise<string | null>;
    promptValidatedSandboxName(agent: Agent, previousName?: string | null): Promise<string>;
    assessHost(): Host;
    formatSandboxBuildEstimateNote(host: Host): string | null;
    formatOnboardConfigSummary(options: {
      provider: string;
      model: string;
      credentialEnv: string | null;
      hermesAuthMethod: string | null;
      webSearchConfig: WebSearchConfig | null;
      hermesToolGateways: string[];
      enabledChannels: string[] | null;
      sandboxName: string;
      servingProfileProvenance?: ServingProfileProvenance | null;
      notes: string[];
    }): string;
    prompt(question: string): Promise<string>;
    cliName(): string;
    log(message?: string): void;
    error(message?: string): void;
    exitProcess(code: number): never;
    deleteEnv(name: string): void;
  };
}

export interface ProviderInferenceStateResult {
  sandboxName: string | null;
  model: string;
  provider: string;
  endpointUrl: string | null;
  endpointSource: InferenceEndpointSource | null;
  onboardEndpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: HermesAuthMethod | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: string | null;
  compatibleEndpointReasoningEffort: string | null;
  nimContainer: string | null;
  webSearchConfig: WebSearchConfig | null;
  hostLocalInferenceRouteOnly: boolean;
  hostLocalInferenceSandboxProofAuthority: HostLocalInferenceSandboxProofAuthority | null;
  session: Session | null;
  stateResult: OnboardStateTransitionResult;
  stateResults: OnboardStateTransitionResult[];
  retryStateResults: OnboardStateTransitionResult[];
}

function requireSelection(
  provider: string | null,
  model: string | null,
  deps: Pick<
    ProviderInferenceStateOptions<unknown, unknown, unknown>["deps"],
    "error" | "exitProcess"
  >,
): { provider: string; model: string } {
  if (typeof provider !== "string" || typeof model !== "string") {
    deps.error("  Inference selection did not yield a provider/model.");
    deps.exitProcess(1);
  }
  return { provider, model };
}

function clearStagedCredentialEnv(
  deps: Pick<ProviderInferenceStateOptions<unknown, unknown, unknown>["deps"], "deleteEnv">,
  credentialEnv: string | null,
): void {
  if (credentialEnv) deps.deleteEnv(credentialEnv);
}

function agentName(agent: unknown): string {
  const name = (agent as { name?: string | null } | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : "openclaw";
}

function selectedHostLocalOllamaAcceleration(
  gpu: unknown,
  gpuPassthrough: boolean,
): HostLocalOllamaAccelerationAuthority {
  return gpuPassthrough && (gpu as { readonly type?: unknown } | null)?.type === "nvidia"
    ? "nvidia-gpu"
    : "cpu";
}

type HostLocalInferenceSetupOptions = {
  hostLocalInference?: HostLocalInferenceStartupSelection;
};

function isHostLocalInferenceProvider(provider: string): boolean {
  return provider === "ollama-local" || provider === "vllm-local" || provider === "llama-cpp-local";
}

function isCanonicalHostLocalResume(input: {
  effectiveResume: boolean;
  provider: string;
  endpointUrl: string | null;
  endpointSource: InferenceEndpointSource | null;
}): boolean {
  return (
    input.effectiveResume &&
    isHostLocalInferenceProvider(input.provider) &&
    input.endpointUrl === HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL &&
    input.endpointSource === "inference-set"
  );
}

export function createCachedHostLocalInferenceSetupResolver(input: {
  resolver: HostLocalInferenceStartupSelectionResolver;
  application: string;
  provider: string;
  model: string;
  acceleration: HostLocalOllamaAccelerationAuthority;
  requireToolCalling: boolean | null;
  freshRequireToolCalling: boolean;
  allowPublishedResume: boolean;
  recover: boolean;
  recordToolCallingRequirement(requireToolCalling: boolean): void;
  initial?: {
    readonly sandboxName: string;
    readonly setupOptions: HostLocalInferenceSetupOptions;
  };
}): (sandboxName: string) => HostLocalInferenceSetupOptions {
  let cached: HostLocalInferenceSetupOptions | null = input.initial?.setupOptions ?? null;
  let cachedSandboxName: string | null = input.initial?.sandboxName ?? null;
  return (sandboxName) => {
    if (cached === null) {
      cached = hostLocalInferenceSetupOptions(input.resolver, {
        application: input.application,
        sandboxName,
        provider: input.provider,
        model: input.model,
        acceleration: input.acceleration,
        requireToolCalling: input.requireToolCalling,
        freshRequireToolCalling: input.freshRequireToolCalling,
        allowPublishedResume: input.allowPublishedResume,
        recover: input.recover,
      });
      cachedSandboxName = sandboxName;
    } else if (sandboxName !== cachedSandboxName) {
      throw new Error("Cached host-local inference authority belongs to a different sandbox.");
    }
    const request = cached.hostLocalInference?.request;
    if (request) {
      input.recordToolCallingRequirement(hostLocalInferenceRequestToolCalling(request));
    }
    return cached;
  };
}

async function resolveHostLocalResumeSetup(input: {
  sandboxName: string | null;
  effectiveResume: boolean;
  provider: string;
  canonicalResume: boolean;
  promptSandboxName(): Promise<string>;
  resolve(sandboxName: string): HostLocalInferenceSetupOptions;
}): Promise<{ sandboxName: string | null; setupOptions: HostLocalInferenceSetupOptions }> {
  let sandboxName = input.sandboxName;
  if (!sandboxName && input.effectiveResume && isHostLocalInferenceProvider(input.provider)) {
    sandboxName = await input.promptSandboxName();
  }
  // Fresh selection authority is resolved only after configuration review.
  // Resume must resolve here so route readiness is evaluated against the
  // exact durable host-local authority rather than a coincidental live route.
  const setupOptions = sandboxName && input.effectiveResume ? input.resolve(sandboxName) : {};
  if (input.canonicalResume && !setupOptions.hostLocalInference) {
    throw new Error(
      "Canonical host-local inference resume requires exact injected runtime recovery authority.",
    );
  }
  return { sandboxName, setupOptions };
}

function canResumeInferenceRoute(input: {
  needsBedrockRuntimeAdapter: boolean;
  hasHostLocalInference: boolean;
  forceProviderSelection: boolean;
  forceInferenceSetup: boolean;
  effectiveResume: boolean;
  routeReady(): boolean;
}): boolean {
  return (
    !input.needsBedrockRuntimeAdapter &&
    !input.hasHostLocalInference &&
    !input.forceProviderSelection &&
    !input.forceInferenceSetup &&
    input.effectiveResume &&
    input.routeReady()
  );
}

function hostLocalToolCallingRequirement(
  deriveFromDurableAuthority: boolean,
  allowToolsIncompatible: boolean,
): boolean | null {
  return deriveFromDurableAuthority ? null : !allowToolsIncompatible;
}

async function prepareSelectedLocalProvider(
  selection: HostLocalInferenceStartupSelection | undefined,
  provider: string,
  prepare: (provider: string) => Promise<string | null>,
): Promise<string | null> {
  return selection ? null : prepare(provider);
}

function hostLocalInferenceSessionRoute(
  routeOnly: boolean,
  endpointUrl: string | null,
  endpointSource: InferenceEndpointSource | null,
): { endpointUrl?: string | null; endpointSource?: InferenceEndpointSource | null } {
  return routeOnly ? { endpointUrl, endpointSource } : {};
}

function resolvedHostLocalInferenceRoute(
  selection: HostLocalInferenceStartupSelection | undefined,
  current: {
    endpointUrl: string | null;
    endpointSource: InferenceEndpointSource | null;
    onboardEndpointUrl: string | null;
  },
): {
  routeOnly: boolean;
  proofAuthority: HostLocalInferenceSandboxProofAuthority | null;
  endpointUrl: string | null;
  endpointSource: InferenceEndpointSource | null;
  onboardEndpointUrl: string | null;
} {
  if (!selection) return { routeOnly: false, proofAuthority: null, ...current };
  return {
    routeOnly: true,
    proofAuthority: hostLocalInferenceSandboxProofAuthority(selection.request),
    endpointUrl: HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL,
    endpointSource: "inference-set",
    onboardEndpointUrl: null,
  };
}

function hostLocalInferenceSetupOptions(
  resolver: HostLocalInferenceStartupSelectionResolver,
  input: {
    application: string;
    sandboxName: string;
    provider: string;
    model: string;
    acceleration: HostLocalOllamaAccelerationAuthority;
    requireToolCalling: boolean | null;
    freshRequireToolCalling: boolean;
    allowPublishedResume: boolean;
    recover: boolean;
  },
): { hostLocalInference?: HostLocalInferenceStartupSelection } {
  const application = HOST_LOCAL_INFERENCE_APPLICATIONS.find(
    (candidate): candidate is HostLocalInferenceApplication => candidate === input.application,
  );
  if (!application) {
    if (!isHostLocalInferenceProvider(input.provider)) return {};
    throw new Error(`Unsupported host-local inference application '${input.application}'.`);
  }
  const selected = resolver({
    application,
    sandboxName: input.sandboxName,
    provider: input.provider,
    model: input.model,
    acceleration: input.acceleration,
    requireToolCalling: input.requireToolCalling,
    allowPublishedResume: input.allowPublishedResume,
    recover: input.recover,
  });
  if (selected) {
    if (selected.request.application !== application) {
      throw new Error(
        "Host-local inference startup selection drifted from the accepted application.",
      );
    }
    const expectedProvider = hostLocalInferenceGatewayProvider(selected.request);
    if (input.provider !== expectedProvider) {
      throw new Error("Host-local inference startup selection drifted from the accepted provider.");
    }
    if (
      selected.request.service !== "llama-cpp" &&
      (selected.request.service !== "ollama" || "managed" in selected.request) &&
      selected.request.recover !== undefined &&
      typeof selected.request.recover !== "boolean"
    ) {
      throw new Error("Host-local inference startup selection has invalid recovery authority.");
    }
    const hasDurableToolCallingAuthority =
      selected.request.service === "ollama" && "endpoint" in selected.request
        ? input.recover
        : selected.request.service === "llama-cpp"
          ? selected.request.publishedRoute
          : selected.request.resumeReceipt !== undefined || selected.request.recover === true;
    const expectedToolCalling =
      input.requireToolCalling ??
      (hasDurableToolCallingAuthority ? null : input.freshRequireToolCalling);
    const selectedModel = hostLocalInferenceRequestModel(selected.request);
    const acceptedModel =
      selected.request.service === "ollama"
        ? normalizeHostLocalOllamaModelRef(input.model)
        : input.model;
    if (
      selectedModel !== acceptedModel ||
      (selected.request.service === "ollama" &&
        "endpoint" in selected.request &&
        selected.request.endpoint.acceleration !== input.acceleration) ||
      (expectedToolCalling !== null &&
        hostLocalInferenceRequestToolCalling(selected.request) !== expectedToolCalling)
    ) {
      throw new Error(
        "Host-local inference startup selection drifted from the accepted model proof.",
      );
    }
    if (selected.request.service === "llama-cpp") {
      if (
        input.acceleration !== "nvidia-gpu" ||
        selected.request.publishedRoute !== input.allowPublishedResume
      ) {
        throw new Error("Managed llama.cpp startup selection drifted from recovery authority.");
      }
    } else if (selected.request.service !== "ollama" || "managed" in selected.request) {
      if (input.acceleration !== "nvidia-gpu") {
        throw new Error(
          "Managed host-local inference requires accepted NVIDIA GPU passthrough authority.",
        );
      }
      const hasPublishedResume = selected.request.resumeReceipt !== undefined;
      const hasInterruptedRecovery = selected.request.recover === true;
      // Canonical managed Ollama recovery also admits the exact journaled
      // route-publication gap: its runtime is interrupted and its receipt is
      // not published yet. Other canonical managed routes remain published-only.
      const recoveryAuthorityMatches = input.recover
        ? input.allowPublishedResume &&
          ((hasPublishedResume && !hasInterruptedRecovery) ||
            (selected.request.service === "ollama" &&
              !hasPublishedResume &&
              hasInterruptedRecovery))
        : selected.request.service === "ollama"
          ? input.allowPublishedResume
            ? hasPublishedResume && !hasInterruptedRecovery
            : !hasPublishedResume && !hasInterruptedRecovery
          : input.allowPublishedResume
            ? !(hasPublishedResume && hasInterruptedRecovery)
            : !hasPublishedResume && !hasInterruptedRecovery;
      if (!recoveryAuthorityMatches) {
        throw new Error("Host-local inference startup selection drifted from recovery authority.");
      }
    }
  }
  return selected ? { hostLocalInference: selected } : {};
}

type EarlyManagedHostLocalLifecycleSelection = {
  readonly sandboxName: string;
  readonly setupOptions: HostLocalInferenceSetupOptions;
};

function resolveEarlyManagedHostLocalLifecycleSelection(input: {
  readonly resumeProviderSelection: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly sandboxName: string | null;
  readonly application: string;
  readonly acceleration: HostLocalOllamaAccelerationAuthority;
  readonly effectiveResume: boolean;
  readonly endpointUrl: string | null;
  readonly endpointSource: InferenceEndpointSource | null;
  readonly resolver: HostLocalInferenceStartupSelectionResolver;
}): EarlyManagedHostLocalLifecycleSelection | null {
  if (
    !input.resumeProviderSelection ||
    (input.provider !== "llama-cpp-local" && input.provider !== "ollama-local") ||
    typeof input.model !== "string" ||
    typeof input.sandboxName !== "string"
  ) {
    return null;
  }
  return {
    sandboxName: input.sandboxName,
    setupOptions: hostLocalInferenceSetupOptions(input.resolver, {
      application: input.application,
      sandboxName: input.sandboxName,
      provider: input.provider,
      model: input.model,
      acceleration: input.acceleration,
      requireToolCalling: null,
      freshRequireToolCalling: true,
      allowPublishedResume: true,
      recover: isCanonicalHostLocalResume({
        effectiveResume: input.effectiveResume,
        provider: input.provider,
        endpointUrl: input.endpointUrl,
        endpointSource: input.endpointSource,
      }),
    }),
  };
}

async function ensureLegacyManagedLlamaCppResumeReady(
  selection: EarlyManagedHostLocalLifecycleSelection | null,
  provider: string | null,
  sandboxName: string | null,
  ensure: (
    provider: string | null | undefined,
    sandboxName: string | null | undefined,
    revalidatePolicyRequirements?: (operation: string) => void,
  ) => Promise<boolean>,
  revalidatePolicyRequirements?: (operation: string) => void,
): Promise<void> {
  if (selection?.setupOptions.hostLocalInference) return;
  await ensure(provider, sandboxName, revalidatePolicyRequirements);
}

function endpointSourceForCurrentUrl(
  endpointSource: InferenceEndpointSource | null,
  endpointUrl: string | null,
  onboardEndpointUrl: string | null,
): InferenceEndpointSource | null {
  return endpointSource === "onboard" && (!onboardEndpointUrl || endpointUrl !== onboardEndpointUrl)
    ? null
    : endpointSource;
}

function resolvedHostLocalPolicyRouteEvidence(
  setupOptions: HostLocalInferenceSetupOptions,
  provider: string,
  route: {
    endpointUrl: string | null;
    endpointSource: InferenceEndpointSource | null;
    onboardEndpointUrl: string | null;
  },
): {
  routeOnly: boolean;
  proofAuthority: HostLocalInferenceSandboxProofAuthority | null;
  routeKnown: boolean;
} | null {
  if (setupOptions.hostLocalInference) {
    const resolvedRoute = resolvedHostLocalInferenceRoute(setupOptions.hostLocalInference, route);
    return {
      routeOnly: resolvedRoute.routeOnly,
      proofAuthority: resolvedRoute.proofAuthority,
      routeKnown: true,
    };
  }
  return isHostLocalInferenceProvider(provider)
    ? { routeOnly: false, proofAuthority: null, routeKnown: true }
    : null;
}

function resolveInitialHostLocalPolicyRoute(input: {
  resumeProviderSelection: boolean;
  sandboxName: string | null;
  provider: string | null;
  model: string | null;
  application: string;
  acceleration: HostLocalOllamaAccelerationAuthority;
  effectiveResume: boolean;
  endpointUrl: string | null;
  endpointSource: InferenceEndpointSource | null;
  onboardEndpointUrl: string | null;
  resolver: HostLocalInferenceStartupSelectionResolver;
}): {
  routeOnly: boolean;
  proofAuthority: HostLocalInferenceSandboxProofAuthority | null;
  routeKnown: boolean;
  selection: {
    sandboxName: string;
    provider: string;
    model: string;
    setupOptions: HostLocalInferenceSetupOptions;
  } | null;
} {
  if (
    !input.resumeProviderSelection ||
    !input.sandboxName ||
    !input.provider ||
    !input.model ||
    !isHostLocalInferenceProvider(input.provider)
  ) {
    return {
      routeOnly: false,
      proofAuthority: null,
      routeKnown: !isHostLocalInferenceProvider(input.provider ?? ""),
      selection: null,
    };
  }
  const setupOptions = hostLocalInferenceSetupOptions(input.resolver, {
    application: input.application,
    sandboxName: input.sandboxName,
    provider: input.provider,
    model: input.model,
    acceleration: input.acceleration,
    requireToolCalling: null,
    freshRequireToolCalling: true,
    allowPublishedResume: true,
    recover: isCanonicalHostLocalResume({
      effectiveResume: input.effectiveResume,
      provider: input.provider,
      endpointUrl: input.endpointUrl,
      endpointSource: input.endpointSource,
    }),
  });
  const routeEvidence = resolvedHostLocalPolicyRouteEvidence(setupOptions, input.provider, input);
  if (!routeEvidence) {
    throw new Error("Host-local inference policy route evidence was not resolved.");
  }
  return {
    ...routeEvidence,
    selection: {
      sandboxName: input.sandboxName,
      provider: input.provider,
      model: input.model,
      setupOptions,
    },
  };
}

function hasActiveMessagingChannels(
  selectedMessagingChannels: string[],
  session: Session | null,
): boolean {
  if (selectedMessagingChannels.length > 0) return true;
  const channels = session?.messagingPlan?.channels;
  return Boolean(
    Array.isArray(channels) &&
    channels.some((channel) => channel.active === true && channel.disabled !== true),
  );
}

function shouldRefreshCompatibleEndpointRouteForMessaging(
  provider: string | null,
  selectedMessagingChannels: string[],
  session: Session | null,
  agent: unknown,
): boolean {
  return (
    provider === "compatible-endpoint" &&
    agentName(agent) === "openclaw" &&
    hasActiveMessagingChannels(selectedMessagingChannels, session)
  );
}

function assertOnboardReasoningEffortRoute(
  request: ReasoningEffortRequest,
  provider: string | null,
  inferenceApi: string | null,
): void {
  if (!request.explicit) return;
  if (provider !== "compatible-endpoint") {
    throw new Error(`${REASONING_EFFORT_ENV} applies only to the compatible-endpoint provider.`);
  }
  if (inferenceApi !== "openai-completions") {
    throw new Error(
      `${REASONING_EFFORT_ENV} applies only to compatible-endpoint routes using openai-completions.`,
    );
  }
}

interface CompatibleEndpointReasoningReplayDeps {
  cliName(): string;
  log(message?: string): void;
  configureCompatibleEndpointReasoning(storedValue?: string | null): Promise<"true" | "false">;
  configureCompatibleEndpointReasoningEffort(
    storedValue?: unknown,
    env?: NodeJS.ProcessEnv,
    allowRequestFallback?: boolean,
  ): Promise<ReasoningEffort | null>;
}

// A recovered selection that reuses the registered gateway credential skips the
// custom-endpoint validation, and that validation is where a compatible endpoint
// configures its reasoning mode and effort. Replay the recorded configuration for
// the same route — including the process env the sandbox image patch reads — so a
// rebuild recreate cannot silently replace it with no reasoning configuration
// (#7940). Report before configuring, like the resumed-selection path: the
// recorded value wins over an ambient one, and #7462 requires that replay to name
// the recorded value instead of silently discarding the exported variable. A
// rebuild recreate seeds the env from the same recorded configuration, so it stays
// silent.
async function replayRecoveredCompatibleEndpointReasoning(
  deps: CompatibleEndpointReasoningReplayDeps,
  recorded: { reasoning: string | null; effort: string | null },
  env: NodeJS.ProcessEnv,
): Promise<{ reasoning: "true" | "false"; effort: ReasoningEffort | null }> {
  const ignoredReasoning = describeIgnoredReasoningEnv(recorded.reasoning, deps.cliName(), env);
  if (ignoredReasoning) deps.log(ignoredReasoning);
  const ignoredEffort = describeIgnoredReasoningEffortEnv(recorded.effort, deps.cliName(), env);
  if (ignoredEffort) deps.log(ignoredEffort);
  return {
    reasoning: await deps.configureCompatibleEndpointReasoning(recorded.reasoning),
    effort: await deps.configureCompatibleEndpointReasoningEffort(recorded.effort, env, false),
  };
}

function provenResumeSandboxName(
  session: Session | null,
  sandboxName: string | null,
  effectiveResume: boolean,
  authoritativeResumeConfig: boolean,
  requestedSandboxName: string | null,
): string | null {
  if (!effectiveResume || !sandboxName) return null;
  // #8953: when a resume cannot prompt, the non-interactive resume name
  // check in session-bootstrap.ts instructs the operator to pass --name
  // (or NEMOCLAW_SANDBOX_NAME). The operator supplied this name on the
  // current run, so the resume gate reuses it; the sandbox step still
  // records the durable checkpoint identity through its own writer.
  // handleProviderInferenceState passes requestedSandboxName only when
  // deps.isNonInteractive() returns true, so an interactive resume keeps
  // prompting.
  return authoritativeResumeConfig ||
    checkpointSandboxIdentityMatches(session, sandboxName) ||
    sandboxName === requestedSandboxName
    ? sandboxName
    : null;
}

function reviewRecoveryState(session: Session | null, sandboxName: string | null) {
  return (
    session?.steps?.provider_selection?.status === "failed" &&
    session.sandboxPromptProgress.sandboxName === true &&
    session.sandboxName === sandboxName
  );
}

function canResumeProviderSelection(
  forceProviderSelection: boolean,
  effectiveResume: boolean,
  authoritativeResumeConfig: boolean,
  session: Session | null,
  interruptedReview: boolean,
  provider: string | null,
  model: string | null,
): boolean {
  return (
    !forceProviderSelection &&
    effectiveResume &&
    (authoritativeResumeConfig ||
      session?.steps?.provider_selection?.status === "complete" ||
      interruptedReview) &&
    typeof provider === "string" &&
    typeof model === "string"
  );
}

type ResumeReasoningDeps = Pick<
  ProviderInferenceStateOptions<unknown, unknown, unknown>["deps"],
  | "clearCompatibleEndpointReasoning"
  | "clearCompatibleEndpointReasoningEffort"
  | "cliName"
  | "configureCompatibleEndpointReasoning"
  | "configureCompatibleEndpointReasoningEffort"
  | "log"
>;

async function configureResumeReasoning(
  provider: string,
  reasoning: string | null,
  effort: string | null,
  env: NodeJS.ProcessEnv,
  deps: ResumeReasoningDeps,
): Promise<{ reasoning: string | null; effort: string | null }> {
  if (provider !== "compatible-endpoint") {
    return {
      reasoning: deps.clearCompatibleEndpointReasoning(),
      effort: deps.clearCompatibleEndpointReasoningEffort(),
    };
  }
  const ignoredReasoning = describeIgnoredReasoningEnv(reasoning, deps.cliName());
  if (ignoredReasoning) deps.log(ignoredReasoning);
  const ignoredEffort = describeIgnoredReasoningEffortEnv(effort, deps.cliName(), env);
  if (ignoredEffort) deps.log(ignoredEffort);
  return {
    reasoning: await deps.configureCompatibleEndpointReasoning(reasoning),
    effort: await deps.configureCompatibleEndpointReasoningEffort(effort, env, false),
  };
}

type LocalInferenceRepairDeps = Pick<
  ProviderInferenceStateOptions<unknown, unknown, unknown>["deps"],
  "recordRepairEvent" | "repairLocalInferenceSystemdOverrideOrExit"
>;

async function repairResumedLocalInference(
  provider: string,
  model: string,
  agent: unknown,
  deps: LocalInferenceRepairDeps,
): Promise<void> {
  const options = {
    provider,
    model,
    contextWindowFloor: getOllamaContextWindowFloorForAgent(agentName(agent)),
    isNonInteractive: () => false,
  };
  if (provider !== "ollama-local") {
    deps.repairLocalInferenceSystemdOverrideOrExit(options);
    return;
  }
  const metadata = { repair: "ollama-systemd-loopback" };
  await deps.recordRepairEvent("state.repair.started", {
    state: "provider_selection",
    metadata,
  });
  try {
    deps.repairLocalInferenceSystemdOverrideOrExit(options);
  } catch (error) {
    await deps.recordRepairEvent("state.repair.failed", {
      state: "provider_selection",
      error: error instanceof Error ? error.message : String(error),
      metadata,
    });
    throw error;
  }
  await deps.recordRepairEvent("state.repair.completed", {
    state: "provider_selection",
    metadata,
  });
}

type ResumedHostLocalInferenceRepairDeps = LocalInferenceRepairDeps &
  Pick<
    ProviderInferenceStateOptions<unknown, unknown, unknown>["deps"],
    "isNonInteractive" | "log"
  >;

async function repairOrRecoverResumedHostLocalInference(
  selection: EarlyManagedHostLocalLifecycleSelection | null,
  provider: string,
  model: string,
  agent: unknown,
  revalidatePolicyRequirements: (operation: string, requiredProvider?: string | null) => void,
  forceInferenceSetup: boolean,
  deps: ResumedHostLocalInferenceRepairDeps,
): Promise<boolean> {
  const request = selection?.setupOptions.hostLocalInference?.request;
  if (request?.service === "ollama" && "managed" in request) {
    deps.log("  [resume] Recovering managed Ollama through its receipt-bound runtime.");
    return true;
  }
  revalidatePolicyRequirements(
    `repair local inference provider ${JSON.stringify(provider)}`,
    provider,
  );
  await repairResumedLocalInference(provider, model, agent, {
    ...deps,
    repairLocalInferenceSystemdOverrideOrExit: (options) =>
      deps.repairLocalInferenceSystemdOverrideOrExit({
        ...options,
        isNonInteractive: deps.isNonInteractive,
      }),
  });
  return forceInferenceSetup;
}

type ConfigurationReviewDeps<Agent> = Pick<
  ProviderInferenceStateOptions<unknown, Agent, unknown>["deps"],
  | "checkpointSandboxIdentity"
  | "cliName"
  | "exitProcess"
  | "formatOnboardConfigSummary"
  | "isNonInteractive"
  | "log"
  | "prompt"
  | "promptValidatedSandboxName"
  | "recordStepRejected"
  | "startRecordedStep"
>;

interface ConfigurationReviewInput<Agent> {
  sandboxName: string | null;
  agent: Agent;
  provider: string;
  model: string;
  credentialEnv: string | null;
  hermesAuthMethod: HermesAuthMethod | null;
  webSearchConfig: WebSearchConfig | null;
  hermesToolGateways: string[];
  selectedMessagingChannels: string[];
  session: Session | null;
  buildEstimateNote: string | null;
}

async function reviewProviderConfiguration<Agent>(
  input: ConfigurationReviewInput<Agent>,
  deps: ConfigurationReviewDeps<Agent>,
): Promise<{ sandboxName: string; editInference: boolean }> {
  let sandboxName = input.sandboxName;
  const needsSelectionRecovery = input.session?.steps?.provider_selection?.status !== "complete";
  let selectionRecoveryStarted = false;

  while (true) {
    if (!sandboxName) sandboxName = await deps.promptValidatedSandboxName(input.agent);
    deps.log(
      deps.formatOnboardConfigSummary({
        provider: input.provider,
        model: input.model,
        credentialEnv: input.credentialEnv,
        hermesAuthMethod: input.hermesAuthMethod,
        webSearchConfig: input.webSearchConfig,
        hermesToolGateways: input.hermesToolGateways,
        enabledChannels:
          input.selectedMessagingChannels.length > 0 ? input.selectedMessagingChannels : null,
        sandboxName,
        servingProfileProvenance: input.session?.servingProfileProvenance ?? null,
        notes: input.buildEstimateNote ? [input.buildEstimateNote] : [],
      }),
    );
    deps.log("  Web search and messaging channels will be prompted next.");
    // This secret-free checkpoint makes an interrupted review resumable without
    // claiming that provider registration or inference setup completed.
    await deps.checkpointSandboxIdentity(sandboxName, input.agent);
    if (needsSelectionRecovery && !selectionRecoveryStarted) {
      await deps.startRecordedStep("provider_selection", {
        provider: input.provider,
        model: input.model,
      });
      selectionRecoveryStarted = true;
    }
    if (deps.isNonInteractive()) return { sandboxName, editInference: false };

    const action = await promptOnboardConfigurationReview({
      prompt: deps.prompt,
      log: deps.log,
    });
    if (action === "apply") return { sandboxName, editInference: false };
    if (action === "edit-inference") return { sandboxName, editInference: true };
    if (action === "exit") {
      await deps.recordStepRejected("provider_selection");
      deps.log(`  Aborted. Re-run \`${deps.cliName()} onboard\` to start over.`);
      deps.log("  Credentials entered so far were only staged in memory for this run.");
      deps.log("  No new gateway credential was registered because onboarding stopped here.");
      deps.exitProcess(1);
    }
    sandboxName = await deps.promptValidatedSandboxName(input.agent, sandboxName);
  }
}

export async function handleProviderInferenceState<Gpu, Agent, Host>({
  gatewayName,
  resume,
  fresh,
  session,
  gpu,
  gpuPassthrough,
  sandboxName,
  requestedSandboxName = null,
  agent,
  forceProviderSelection: initialForceProviderSelection = false,
  forceInferenceSetup: initialForceInferenceSetup = false,
  authoritativeResumeConfig = false,
  providerRecoveryReceipt = null,
  providerRecoveryReceiptLedger,
  initial,
  selectedMessagingChannels,
  env,
  constants,
  deps,
}: ProviderInferenceStateOptions<Gpu, Agent, Host>): Promise<ProviderInferenceStateResult> {
  // Parse the ambient request before provider selection, recovery, or route
  // mutation. Every provider must reject malformed input even though only a
  // compatible OpenAI Completions route can apply it.
  const reasoningEffortRequest = resolveReasoningEffortRequest(null, env);
  let model = initial.model;
  let provider = initial.provider;
  let endpointUrl = initial.endpointUrl;
  let credentialEnv = initial.credentialEnv;
  let hermesAuthMethod =
    deps.normalizeHermesAuthMethod(initial.hermesAuthMethod) ||
    (provider === constants.hermesProviderName &&
    credentialEnv === constants.hermesApiKeyCredentialEnv
      ? constants.hermesApiKeyAuthMethod
      : null);
  let hermesToolGateways = initial.hermesToolGateways;
  // Sessions persisted before #6294/#6289 can carry an API family that the
  // selected agent cannot safely use. Normalize the seed before the resume
  // shortcut so the gateway provider is revalidated and, when necessary,
  // re-registered on the matching protocol surface before sandbox creation.
  let preferredInferenceApi = resolveAgentProviderInferenceApi(
    agentName(agent),
    agent,
    provider,
    initial.preferredInferenceApi,
  );
  let compatibleEndpointReasoning = initial.compatibleEndpointReasoning;
  let compatibleEndpointReasoningEffort = initial.compatibleEndpointReasoningEffort;
  let nimContainer = initial.nimContainer;
  const webSearchConfig = initial.webSearchConfig;
  const observabilityEnabled = session?.observabilityEnabled === true;
  let forceProviderSelection = initialForceProviderSelection;
  let allowToolsIncompatible = false;
  let skipHostInferenceSmoke = false;
  let reuseGatewayCredentialWithoutLocalKey = false;
  let endpointPinnedAddresses: string[] | undefined;
  let endpointSource: InferenceEndpointSource | null = initial.endpointSource ?? null;
  let onboardEndpointUrl =
    endpointSource === "onboard" && initial.onboardEndpointUrl === initial.endpointUrl
      ? initial.onboardEndpointUrl
      : null;
  endpointSource = endpointSourceForCurrentUrl(endpointSource, endpointUrl, onboardEndpointUrl);
  let endpointTrustedPrivateCapability: TrustedPrivateEndpointCapability | undefined;
  let inferenceCapabilityCache: OnboardInferenceCapabilityCache | undefined;
  let vllmModelIdentity: string | undefined;
  const effectiveResume = resume && !fresh;
  let hostLocalInferenceRouteOnly = false;
  let hostLocalInferenceRouteKnown = !isHostLocalInferenceProvider(provider ?? "");
  let hostLocalInferenceProofAuthority: HostLocalInferenceSandboxProofAuthority | null = null;
  const hostLocalInferenceResolutionCache = new Map<
    string,
    HostLocalInferenceStartupSelection | null
  >();
  const resolveHostLocalInferenceStartupSelection: HostLocalInferenceStartupSelectionResolver = (
    input,
  ) => {
    const key = JSON.stringify(input);
    if (hostLocalInferenceResolutionCache.has(key)) {
      return hostLocalInferenceResolutionCache.get(key) ?? null;
    }
    const selection = deps.resolveHostLocalInferenceStartupSelection(input);
    hostLocalInferenceResolutionCache.set(key, selection);
    return selection;
  };
  let prospectiveHostLocalPolicyRoute: {
    sandboxName: string;
    provider: string;
    model: string;
    setupOptions: HostLocalInferenceSetupOptions;
  } | null = null;
  const readProspectiveHostLocalPolicyRoute = () => prospectiveHostLocalPolicyRoute;
  const resolveProspectiveHostLocalPolicyRoute = (route: ProviderInferenceProbeRoute): void => {
    const routeProvider = route.provider?.trim() ?? "";
    const routeModel = route.model?.trim() ?? "";
    if (!isHostLocalInferenceProvider(routeProvider) || !sandboxName || !routeModel) {
      hostLocalInferenceRouteOnly = false;
      hostLocalInferenceProofAuthority = null;
      hostLocalInferenceRouteKnown = true;
      prospectiveHostLocalPolicyRoute = null;
      return;
    }
    const setupOptions = hostLocalInferenceSetupOptions(resolveHostLocalInferenceStartupSelection, {
      application: agentName(agent),
      sandboxName,
      provider: routeProvider,
      model: routeModel,
      acceleration: selectedHostLocalOllamaAcceleration(gpu, gpuPassthrough),
      requireToolCalling: true,
      freshRequireToolCalling: true,
      allowPublishedResume: false,
      recover: false,
    });
    const resolvedRoute = resolvedHostLocalInferenceRoute(setupOptions.hostLocalInference, {
      endpointUrl: route.endpointUrl ?? null,
      endpointSource,
      onboardEndpointUrl,
    });
    hostLocalInferenceRouteOnly = resolvedRoute.routeOnly;
    hostLocalInferenceProofAuthority = resolvedRoute.proofAuthority;
    hostLocalInferenceRouteKnown = true;
    prospectiveHostLocalPolicyRoute = {
      sandboxName,
      provider: routeProvider,
      model: routeModel,
      setupOptions,
    };
  };
  const reusableResumeSandboxName = provenResumeSandboxName(
    session,
    sandboxName,
    effectiveResume,
    authoritativeResumeConfig,
    deps.isNonInteractive() ? requestedSandboxName : null,
  );
  const initialResumeProviderSelection = canResumeProviderSelection(
    forceProviderSelection,
    effectiveResume,
    authoritativeResumeConfig,
    session,
    reviewRecoveryState(session, sandboxName),
    provider,
    model,
  );
  const initialHostLocalPolicyRoute = resolveInitialHostLocalPolicyRoute({
    resumeProviderSelection: initialResumeProviderSelection,
    sandboxName: reusableResumeSandboxName,
    provider,
    model,
    application: agentName(agent),
    acceleration: selectedHostLocalOllamaAcceleration(gpu, gpuPassthrough),
    effectiveResume,
    endpointUrl,
    endpointSource,
    onboardEndpointUrl,
    resolver: resolveHostLocalInferenceStartupSelection,
  });
  hostLocalInferenceRouteOnly = initialHostLocalPolicyRoute.routeOnly;
  hostLocalInferenceProofAuthority = initialHostLocalPolicyRoute.proofAuthority;
  hostLocalInferenceRouteKnown = initialHostLocalPolicyRoute.routeKnown;
  prospectiveHostLocalPolicyRoute = initialHostLocalPolicyRoute.selection;
  const stateResults: OnboardStateTransitionResult[] = [];
  const retryStateResults: OnboardStateTransitionResult[] = [];

  const revalidatePolicyRequirements = (
    operation: string,
    requiredProvider: string | null = provider,
  ): void => {
    const routeKnownForProvider =
      requiredProvider === provider
        ? hostLocalInferenceRouteKnown
        : prospectiveHostLocalPolicyRoute?.provider === requiredProvider;
    deps.preflightPolicyRequirements({
      gatewayName,
      sandboxName,
      agent,
      selectedMessagingChannels,
      hermesToolGateways,
      gpuPassthrough,
      provider: requiredProvider,
      hostLocalInferenceRouteOnly: routeKnownForProvider && hostLocalInferenceRouteOnly,
      webSearchConfig,
      observabilityEnabled,
      operation,
    });
  };

  revalidatePolicyRequirements("select an inference provider");

  while (true) {
    // Drop a context window auto-detected by a prior compatible-endpoint pass
    // before every provider-selection path — fresh, resume, and repair — so a
    // retry to a different provider/endpoint cannot inherit endpoint A's probed
    // max_model_len as a bogus user override. Only clears a value this process
    // auto-detected, never a user override or a legitimately resumed window
    // (#6177; resume/repair coverage per PR #6293 PRA-3).
    clearAutoDetectedCompatibleContextWindow(process.env);
    let forceInferenceSetup = initialForceInferenceSetup;
    let recoveredRecordedProvider = false;
    const providerRecovery = createRecovery(fresh, sandboxName, session, deps, {
      recoveryReceipt: providerRecoveryReceipt,
      recoveryReceiptLedger: providerRecoveryReceiptLedger,
      gatewayName,
    });
    const completeRecoveredReviewSelectionAfterInference = reviewRecoveryState(
      session,
      sandboxName,
    );
    let deferProviderSelectionUntilInference = completeRecoveredReviewSelectionAfterInference;
    const reviewRecoveredInteractively =
      completeRecoveredReviewSelectionAfterInference && !deps.isNonInteractive();
    const resumeProviderSelection = canResumeProviderSelection(
      forceProviderSelection,
      effectiveResume,
      authoritativeResumeConfig,
      session,
      completeRecoveredReviewSelectionAfterInference,
      provider,
      model,
    );
    const earlyManagedHostLocalLifecycleSelection = resolveEarlyManagedHostLocalLifecycleSelection({
      resumeProviderSelection,
      provider,
      model,
      sandboxName,
      application: agentName(agent),
      acceleration: selectedHostLocalOllamaAcceleration(gpu, gpuPassthrough),
      effectiveResume,
      endpointUrl,
      endpointSource,
      resolver: resolveHostLocalInferenceStartupSelection,
    });
    let shouldRecordProviderSelection = false;
    // A review interruption selected a provider but did not configure its
    // route. Do not let a coincidentally ready gateway route skip setup.
    forceInferenceSetup ||=
      completeRecoveredReviewSelectionAfterInference || reviewRecoveredInteractively;
    if (resumeProviderSelection) {
      assertOnboardReasoningEffortRoute(reasoningEffortRequest, provider, preferredInferenceApi);
      assertProviderInferenceRouteCompatible(deps, gatewayName, sandboxName, {
        provider,
        model,
        endpointUrl,
        credentialEnv,
        preferredInferenceApi,
      });
      // A completed provider-selection checkpoint is not proof that a managed
      // host runtime survived a process or gateway restart. Recover the exact
      // gateway-owned llama.cpp lifecycle before the selection shortcut can
      // skip setup. The dependency is a no-op for operator-attached llama.cpp
      // routes because those routes have no matching managed owner state.
      revalidatePolicyRequirements(
        `recover managed runtime for inference provider ${JSON.stringify(provider)}`,
      );
      await ensureLegacyManagedLlamaCppResumeReady(
        earlyManagedHostLocalLifecycleSelection,
        provider,
        sandboxName,
        deps.ensureManagedLlamaCppResumeReady,
        (operation) => revalidatePolicyRequirements(operation, provider),
      );
      revalidatePolicyRequirements(`recover inference provider ${JSON.stringify(provider)}`);
      const recovery = await deps.ensureResumeProviderReady(
        gatewayName,
        provider,
        credentialEnv,
        (operation) => revalidatePolicyRequirements(operation, provider),
      );
      forceInferenceSetup ||= recovery.forceInferenceSetup;
      credentialEnv = recovery.credentialEnv;
      // Rebuild may be resuming a legacy session whose step marker was never
      // completed even though the pre-delete registry selection was validated
      // and rewritten into the session. Persist that trusted selection so a
      // later plain `onboard --resume` recovery cannot fall back to ambient or
      // default provider selection if the recreate fails after this point.
      shouldRecordProviderSelection = authoritativeResumeConfig;
      if (preferredInferenceApi !== initial.preferredInferenceApi) {
        // #6294/#6289 heal: the pre-fix session can leave the gateway provider
        // registered for a protocol that no longer matches the agent route.
        // Re-run inference setup so the provider surface is revalidated and
        // refreshed. Persist the adjusted value only after setup succeeds.
        forceInferenceSetup = true;
      }
      if (
        !deps.isResumeProviderSurfaceReady(
          gatewayName,
          provider,
          preferredInferenceApi,
          credentialEnv,
          endpointUrl,
        )
      ) {
        forceInferenceSetup = true;
        deps.log(
          "  [resume] Refreshing the gateway provider to match the required inference surface.",
        );
      }
      const hydratedCredential = deps.hydrateCredentialEnv(credentialEnv);
      // A rebuild recreate may leave `openshell inference get` reporting the
      // same provider/model while the newly created messaging sandbox's
      // `inference.local` route is not actually wired to the compatible
      // endpoint. For the OpenClaw+messaging path that later performs a
      // sandbox-side compatible-endpoint smoke, refresh the gateway route in
      // the inference phase instead of trusting the provider/model-only resume
      // shortcut. If the local key is absent, force provider selection through
      // the strict recovered-route checks; only that path can authorize reuse
      // of the stored gateway credential and suppression of the unauthenticated
      // host smoke.
      if (
        shouldRefreshCompatibleEndpointRouteForMessaging(
          provider,
          selectedMessagingChannels,
          session,
          agent,
        )
      ) {
        if (!hydratedCredential) {
          deps.log(
            "  [resume] Revalidating recovered compatible-endpoint identity before reusing its gateway credential.",
          );
          forceProviderSelection = true;
          continue;
        }
        forceInferenceSetup = true;
        deps.log("  [resume] Refreshing compatible-endpoint inference route for messaging.");
      }
      revalidatePolicyRequirements("record resumed provider selection");
      deps.skippedStepMessage("provider_selection", `${provider} / ${model}`);
      const selectedAgentName = (agent as { name?: string } | null)?.name;
      if ((!selectedAgentName || selectedAgentName === "openclaw") && reusableResumeSandboxName) {
        deps.log(`  [resume] Reusing sandbox name: ${reusableResumeSandboxName}.`);
      }
      await deps.recordStateSkipped("provider_selection", {
        reason: "resume",
        provider,
        model,
      });
      const resumedSelection = requireSelection(provider, model, deps);
      const configuredReasoning = await configureResumeReasoning(
        resumedSelection.provider,
        compatibleEndpointReasoning,
        compatibleEndpointReasoningEffort,
        env,
        deps,
      );
      compatibleEndpointReasoning = configuredReasoning.reasoning;
      compatibleEndpointReasoningEffort = configuredReasoning.effort;
      forceInferenceSetup = await repairOrRecoverResumedHostLocalInference(
        earlyManagedHostLocalLifecycleSelection,
        resumedSelection.provider,
        resumedSelection.model,
        agent,
        revalidatePolicyRequirements,
        forceInferenceSetup,
        deps,
      );
    } else {
      // An incomplete Station Express resume intentionally retries setupNim here. The outer
      // Station resume wrapper restores the exact provider/model as non-interactive env input,
      // so this re-runs the failed managed install without presenting selection prompts and
      // obtains a fresh checkpoint identity before the provider step is committed.
      revalidatePolicyRequirements("record provider selection start");
      await deps.startRecordedStep("provider_selection");
      const recoverRecordedProvider = providerRecovery.shouldRecover();
      const selection = await withProviderSelectionTrace(
        sandboxName,
        (agent as { name?: string } | null)?.name,
        () =>
          deps.setupNim(
            gpu,
            sandboxName,
            agent,
            recoverRecordedProvider,
            gatewayName,
            (route) => guardProviderInferenceRouteSelection(deps, gatewayName, sandboxName, route),
            (provider) => {
              const preflight = deps.preflightGatewayRouteDiscovery({
                gatewayName,
                sandboxName,
                route: {
                  provider,
                  model: null,
                  endpointUrl: null,
                  preferredInferenceApi: null,
                  credentialEnv: null,
                },
              });
              return preflight.ok || isAdvisoryGatewayRouteConflict(preflight.result);
            },
            providerRecovery.sessionId,
            (route, operation) => {
              resolveProspectiveHostLocalPolicyRoute(route);
              revalidatePolicyRequirements(operation, route.provider ?? null);
            },
          ),
      );
      model = selection.model;
      provider = selection.provider;
      const selectedProspectiveHostLocalPolicyRoute = readProspectiveHostLocalPolicyRoute();
      if (
        selectedProspectiveHostLocalPolicyRoute?.provider !== provider ||
        selectedProspectiveHostLocalPolicyRoute.model !== model
      ) {
        hostLocalInferenceRouteOnly = false;
        hostLocalInferenceProofAuthority = null;
        hostLocalInferenceRouteKnown = !isHostLocalInferenceProvider(provider);
        prospectiveHostLocalPolicyRoute = null;
      }
      endpointUrl = selection.endpointUrl;
      credentialEnv = selection.credentialEnv;
      hermesAuthMethod = selection.hermesAuthMethod;
      hermesToolGateways = selection.hermesToolGateways;
      preferredInferenceApi = selection.preferredInferenceApi;
      compatibleEndpointReasoning = selection.compatibleEndpointReasoning;
      compatibleEndpointReasoningEffort = selection.compatibleEndpointReasoningEffort;
      nimContainer = selection.nimContainer;
      allowToolsIncompatible = selection.allowToolsIncompatible === true;
      skipHostInferenceSmoke = selection.skipHostInferenceSmoke === true;
      reuseGatewayCredentialWithoutLocalKey =
        selection.reuseGatewayCredentialWithoutLocalKey === true;
      recoveredRecordedProvider = selection.recoveredFromSandbox === true;
      forceInferenceSetup ||= recoveredRecordedProvider;
      endpointPinnedAddresses = selection.endpointPinnedAddresses;
      endpointSource = selection.endpointSource ?? null;
      onboardEndpointUrl =
        endpointSource === "onboard" && selection.endpointUrl ? selection.endpointUrl : null;
      endpointTrustedPrivateCapability = selection.endpointTrustedPrivateCapability;
      inferenceCapabilityCache = selection.inferenceCapabilityCache;
      vllmModelIdentity = selection.vllmModelIdentity;
      shouldRecordProviderSelection = true;
      if (
        reuseGatewayCredentialWithoutLocalKey &&
        provider === "compatible-endpoint" &&
        initial.provider === "compatible-endpoint"
      ) {
        const replayed = await replayRecoveredCompatibleEndpointReasoning(
          deps,
          {
            reasoning: compatibleEndpointReasoning ?? initial.compatibleEndpointReasoning,
            effort: compatibleEndpointReasoningEffort ?? initial.compatibleEndpointReasoningEffort,
          },
          env,
        );
        compatibleEndpointReasoning = replayed.reasoning;
        compatibleEndpointReasoningEffort = replayed.effort;
      }
    }

    // Persist a repaired API family only together with a successful inference
    // step. A failed heal must leave the stale seed in place so resume re-arms.
    const healAdjustedInferenceApi =
      resumeProviderSelection && preferredInferenceApi !== initial.preferredInferenceApi;
    const selected = requireSelection(provider, model, deps);
    const selectedProvider = selected.provider;
    const selectedModel = selected.model;
    provider = selectedProvider;
    model = selectedModel;
    preferredInferenceApi = resolveAgentProviderInferenceApi(
      agentName(agent),
      agent,
      provider,
      preferredInferenceApi,
    );
    if (!resumeProviderSelection) {
      assertOnboardReasoningEffortRoute(reasoningEffortRequest, provider, preferredInferenceApi);
      assertProviderInferenceRouteCompatible(deps, gatewayName, sandboxName, {
        provider,
        model,
        endpointUrl,
        credentialEnv,
        preferredInferenceApi,
      });
    }
    revalidatePolicyRequirements(`configure inference provider ${JSON.stringify(provider)}`);
    if (
      shouldRecordProviderSelection &&
      (authoritativeResumeConfig || effectiveResume) &&
      !completeRecoveredReviewSelectionAfterInference
    ) {
      // Authoritative rebuild selections are already route-validated. Persist
      // them before inference setup so their reservation can retain the
      // authoritative session identity.
      session = await deps.recordStepComplete(
        "provider_selection",
        deps.toSessionUpdates({
          provider,
          model,
          endpointUrl,
          credentialEnv,
          hermesAuthMethod,
          hermesToolGateways,
          preferredInferenceApi: healAdjustedInferenceApi
            ? initial.preferredInferenceApi
            : preferredInferenceApi,
          compatibleEndpointReasoning,
          compatibleEndpointReasoningEffort,
          nimContainer,
          stationExpressModelIdentity: vllmModelIdentity,
        }),
      );
    }
    stateResults.push(
      advanceTo("inference", {
        metadata: { state: "provider_selection", provider, model },
      }),
    );
    env.NEMOCLAW_OPENSHELL_BIN = deps.getOpenshellBinary();
    endpointSource = endpointSourceForCurrentUrl(endpointSource, endpointUrl, onboardEndpointUrl);
    if (endpointSource !== "onboard") onboardEndpointUrl = null;
    const needsBedrockRuntimeAdapter = deps.needsBedrockRuntimeAdapter(provider, endpointUrl);
    const canonicalHostLocalResume = isCanonicalHostLocalResume({
      effectiveResume,
      provider: selectedProvider,
      endpointUrl,
      endpointSource,
    });
    const acceptedHostLocalResume =
      effectiveResume && resumeProviderSelection && isHostLocalInferenceProvider(selectedProvider);
    const cachedProspectiveHostLocalPolicyRoute = readProspectiveHostLocalPolicyRoute();
    const resolveCachedHostLocalInferenceSetupOptions = createCachedHostLocalInferenceSetupResolver(
      {
        resolver: resolveHostLocalInferenceStartupSelection,
        application: agentName(agent),
        provider: selectedProvider,
        model: selectedModel,
        acceleration: selectedHostLocalOllamaAcceleration(gpu, gpuPassthrough),
        requireToolCalling: hostLocalToolCallingRequirement(
          acceptedHostLocalResume,
          allowToolsIncompatible,
        ),
        freshRequireToolCalling: !allowToolsIncompatible,
        allowPublishedResume: acceptedHostLocalResume,
        recover: canonicalHostLocalResume,
        recordToolCallingRequirement: (required) => {
          allowToolsIncompatible = !required;
        },
        initial:
          earlyManagedHostLocalLifecycleSelection ??
          (cachedProspectiveHostLocalPolicyRoute?.provider === selectedProvider &&
          cachedProspectiveHostLocalPolicyRoute.model === selectedModel
            ? {
                sandboxName: cachedProspectiveHostLocalPolicyRoute.sandboxName,
                setupOptions: cachedProspectiveHostLocalPolicyRoute.setupOptions,
              }
            : undefined),
      },
    );
    const hostLocalResume = await resolveHostLocalResumeSetup({
      sandboxName,
      effectiveResume,
      provider: selectedProvider,
      canonicalResume: canonicalHostLocalResume,
      promptSandboxName: () => deps.promptValidatedSandboxName(agent),
      resolve: resolveCachedHostLocalInferenceSetupOptions,
    });
    sandboxName = hostLocalResume.sandboxName;
    const resumeHostLocalInferenceSetupOptions = hostLocalResume.setupOptions;
    const resumedHostLocalPolicyRouteEvidence = resolvedHostLocalPolicyRouteEvidence(
      resumeHostLocalInferenceSetupOptions,
      selectedProvider,
      { endpointUrl, endpointSource, onboardEndpointUrl },
    );
    if (resumedHostLocalPolicyRouteEvidence) {
      hostLocalInferenceRouteOnly = resumedHostLocalPolicyRouteEvidence.routeOnly;
      hostLocalInferenceProofAuthority = resumedHostLocalPolicyRouteEvidence.proofAuthority;
      hostLocalInferenceRouteKnown = resumedHostLocalPolicyRouteEvidence.routeKnown;
    }
    const resumeInference = canResumeInferenceRoute({
      needsBedrockRuntimeAdapter,
      hasHostLocalInference: Boolean(resumeHostLocalInferenceSetupOptions.hostLocalInference),
      forceProviderSelection,
      forceInferenceSetup,
      effectiveResume,
      routeReady: () => deps.isInferenceRouteReady(gatewayName, selectedProvider, selectedModel),
    });
    if (resumeInference) {
      if (provider === constants.hermesProviderName) {
        let inferenceResult: ProviderInferenceRetry;
        try {
          if (!sandboxName) sandboxName = await deps.promptValidatedSandboxName(agent);
          const confirmedSandboxName = sandboxName;
          const inferenceOptions = {
            gatewayName,
            allowToolsIncompatible,
            revalidatePolicyRequirements,
            ...(skipHostInferenceSmoke ? { skipHostInferenceSmoke } : {}),
            ...(reuseGatewayCredentialWithoutLocalKey
              ? { reuseGatewayCredentialWithoutLocalKey }
              : {}),
            ...(preferredInferenceApi ? { preferredInferenceApi } : {}),
            ...(endpointPinnedAddresses ? { endpointPinnedAddresses } : {}),
            endpointSource,
            ...(endpointSource === "onboard" && onboardEndpointUrl ? { onboardEndpointUrl } : {}),
            ...(endpointTrustedPrivateCapability ? { endpointTrustedPrivateCapability } : {}),
            ...(inferenceCapabilityCache ? { inferenceCapabilityCache } : {}),
            reservationSessionId: session?.sessionId,
            ...resolveCachedHostLocalInferenceSetupOptions(confirmedSandboxName),
          };
          await deps.startRecordedStep("inference", { provider, model });
          inferenceResult = await withInferenceTrace(
            confirmedSandboxName,
            selectedProvider,
            selectedModel,
            credentialEnv,
            () => {
              revalidatePolicyRequirements(
                `configure inference provider ${JSON.stringify(provider)}`,
              );
              return deps.setupInference(
                confirmedSandboxName,
                selectedModel,
                selectedProvider,
                endpointUrl,
                credentialEnv,
                hermesAuthMethod,
                hermesToolGateways,
                inferenceOptions,
              );
            },
          );
        } finally {
          clearStagedCredentialEnv(deps, credentialEnv);
        }
        if (inferenceResult?.retry === "selection") {
          const retryStateResult = retryTo("provider_selection", {
            metadata: { state: "inference", provider, model, reason: "selection_retry" },
          });
          retryStateResults.push(retryStateResult);
          stateResults.push(retryStateResult);
          forceProviderSelection = true;
          continue;
        }
        revalidatePolicyRequirements("record successful resumed inference configuration");
        session = await deps.recordStepComplete(
          "inference",
          deps.toSessionUpdates({
            provider,
            model,
            hermesAuthMethod,
            compatibleEndpointReasoning,
            compatibleEndpointReasoningEffort,
            nimContainer,
            hermesToolGateways,
          }),
        );
        revalidatePolicyRequirements("finish successful resumed inference configuration");
        break;
      }
      const sandboxStepComplete = session?.steps?.sandbox?.status === "complete";
      const resumeReservationName =
        authoritativeResumeConfig ||
        session?.machine.recoveryReceipt?.reason === "failed_terminal_snapshot" ||
        !sandboxStepComplete
          ? (reusableResumeSandboxName ?? (await deps.promptValidatedSandboxName(agent)))
          : null;
      if (resumeReservationName) sandboxName = resumeReservationName;
      const routedInferenceProvider = deps.isRoutedInferenceProvider(provider);
      if (routedInferenceProvider) {
        // #4564: re-upsert the gateway provider with the sandbox-facing
        // endpoint so a stale localhost base URL recorded by an earlier run is
        // repaired on resume instead of surviving and breaking inference.local.
        const withRouterPortLifecycleLock =
          deps.withModelRouterPortLifecycleLock ?? withModelRouterPortLifecycleLock;
        const getRouterPort = deps.getModelRouterPort ?? resolveModelRouterPort;
        const routedRepair = await deps.withGatewayRouteMutationLock(gatewayName, () =>
          withRouterPortLifecycleLock(getRouterPort(), async () => {
            assertProviderInferenceRouteCompatible(deps, gatewayName, sandboxName, {
              provider: selectedProvider,
              model: selectedModel,
              endpointUrl,
              credentialEnv,
              preferredInferenceApi,
            });
            revalidatePolicyRequirements(
              `reconcile model router for inference provider ${JSON.stringify(provider)}`,
            );
            try {
              await deps.reconcileModelRouter();
            } catch (err) {
              deps.error(
                `  ✗ Failed to reconcile model router: ${err instanceof Error ? err.message : String(err)}`,
              );
              deps.exitProcess(1);
            }
            revalidatePolicyRequirements(
              `update routed inference provider ${JSON.stringify(provider)}`,
            );
            const reupserted = deps.reupsertRoutedProvider(
              gatewayName,
              selectedProvider,
              endpointUrl,
              credentialEnv,
            );
            if (reupserted.ok && resumeReservationName) {
              revalidatePolicyRequirements(
                `reserve routed inference route for sandbox ${JSON.stringify(resumeReservationName)}`,
              );
            }
            const reservationEndpointSource = endpointSourceForCurrentUrl(
              endpointSource,
              reupserted.endpointUrl,
              onboardEndpointUrl,
            );
            const reserved =
              reupserted.ok && resumeReservationName
                ? deps.reserveSandboxInferenceRoute(resumeReservationName, {
                    provider: selectedProvider,
                    model: selectedModel,
                    endpointUrl: reupserted.endpointUrl,
                    endpointSource: reservationEndpointSource,
                    credentialEnv,
                    preferredInferenceApi,
                    gatewayName,
                    reservationSessionId: session?.sessionId,
                  })
                : null;
            return { reupserted, reservationEndpointSource, reserved };
          }),
        );
        const { reupserted, reservationEndpointSource, reserved } = routedRepair;
        if (!reupserted.ok) {
          deps.error(
            `  ${reupserted.message ?? "Failed to update the routed inference provider."}`,
          );
          deps.exitProcess(reupserted.status ?? 1);
        }
        if (reserved === false) {
          deps.error(`  Failed to reserve inference route for sandbox '${resumeReservationName}'.`);
          deps.exitProcess(1);
        }
        endpointUrl = reupserted.endpointUrl;
        endpointSource = reservationEndpointSource;
        if (endpointSource !== "onboard") onboardEndpointUrl = null;
      }
      if (resumeReservationName && !routedInferenceProvider) {
        const reserved = await deps.withGatewayRouteMutationLock(gatewayName, () => {
          assertProviderInferenceRouteCompatible(deps, gatewayName, resumeReservationName, {
            provider: selectedProvider,
            model: selectedModel,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
          });
          revalidatePolicyRequirements(
            `reserve inference route for sandbox ${JSON.stringify(resumeReservationName)}`,
          );
          return deps.reserveSandboxInferenceRoute(resumeReservationName, {
            provider: selectedProvider,
            model: selectedModel,
            endpointUrl,
            endpointSource,
            credentialEnv,
            preferredInferenceApi,
            gatewayName,
            reservationSessionId: session?.sessionId,
          });
        });
        if (!reserved) {
          deps.error(`  Failed to reserve inference route for sandbox '${resumeReservationName}'.`);
          deps.exitProcess(1);
        }
      }
      revalidatePolicyRequirements("record reused inference setup");
      deps.skippedStepMessage("inference", `${provider} / ${model}`);
      await deps.recordStateSkipped("inference", {
        reason: "resume",
        provider,
        model,
      });
      revalidatePolicyRequirements("record successful reused inference configuration");
      if (nimContainer && sandboxName) deps.registryUpdateSandbox(sandboxName, { nimContainer });
      session = await deps.recordStepComplete(
        "inference",
        deps.toSessionUpdates({
          provider,
          model,
          hermesAuthMethod,
          compatibleEndpointReasoning,
          compatibleEndpointReasoningEffort,
          nimContainer,
          hermesToolGateways,
        }),
      );
      revalidatePolicyRequirements("finish successful reused inference configuration");
      break;
    }

    let inferenceResult: ProviderInferenceRetry;
    let activeHostLocalInferenceSetupOptions: {
      hostLocalInference?: HostLocalInferenceStartupSelection;
    } = {};
    try {
      const buildEstimateNote =
        env.NEMOCLAW_IGNORE_RUNTIME_RESOURCES === "1"
          ? null
          : deps.formatSandboxBuildEstimateNote(deps.assessHost());
      const review = await reviewProviderConfiguration(
        {
          sandboxName,
          agent,
          provider,
          model,
          credentialEnv,
          hermesAuthMethod,
          webSearchConfig,
          hermesToolGateways,
          selectedMessagingChannels,
          session,
          buildEstimateNote,
        },
        deps,
      );
      sandboxName = review.sandboxName;
      if (review.editInference) {
        forceProviderSelection = true;
        continue;
      }
      const confirmedSandboxName = review.sandboxName;
      activeHostLocalInferenceSetupOptions =
        resolveCachedHostLocalInferenceSetupOptions(confirmedSandboxName);
      const prospectiveHostLocalRoute = resolvedHostLocalInferenceRoute(
        activeHostLocalInferenceSetupOptions.hostLocalInference,
        { endpointUrl, endpointSource, onboardEndpointUrl },
      );
      hostLocalInferenceRouteOnly = prospectiveHostLocalRoute.routeOnly;
      hostLocalInferenceProofAuthority = prospectiveHostLocalRoute.proofAuthority;
      hostLocalInferenceRouteKnown = true;
      const freshManagedOllama =
        activeHostLocalInferenceSetupOptions.hostLocalInference?.request.service === "ollama" &&
        "managed" in activeHostLocalInferenceSetupOptions.hostLocalInference.request;
      deferProviderSelectionUntilInference =
        completeRecoveredReviewSelectionAfterInference || freshManagedOllama;
      // Ordinary selections retain the accepted provider/model before setup.
      // Fresh managed Ollama stays in progress until its runtime, route,
      // receipt, and registry reservation have committed together.
      if (
        shouldRecordProviderSelection &&
        !effectiveResume &&
        !deferProviderSelectionUntilInference
      ) {
        revalidatePolicyRequirements("record reviewed provider selection");
        session = await deps.recordStepComplete(
          "provider_selection",
          deps.toSessionUpdates({
            provider,
            model,
            endpointUrl,
            credentialEnv,
            hermesAuthMethod,
            hermesToolGateways,
            preferredInferenceApi,
            compatibleEndpointReasoning,
            compatibleEndpointReasoningEffort,
            nimContainer,
            stationExpressModelIdentity: vllmModelIdentity,
          }),
        );
      }
      // The injected host-local transaction owns its runtime and uses a
      // secret-free route. Do not start or persist the legacy host Ollama
      // proxy alongside it; that would leave cross-engine residue before the
      // provider-owned transaction can prove and commit its authority.
      revalidatePolicyRequirements(`prepare local inference provider ${JSON.stringify(provider)}`);
      const preparedOllamaProxyToken = await prepareSelectedLocalProvider(
        activeHostLocalInferenceSetupOptions.hostLocalInference,
        provider,
        deps.prepareLocalProviderForInference,
      );
      const inferenceOptions = {
        gatewayName,
        allowToolsIncompatible,
        revalidatePolicyRequirements,
        ...(preparedOllamaProxyToken ? { preparedOllamaProxyToken } : {}),
        ...(skipHostInferenceSmoke ? { skipHostInferenceSmoke } : {}),
        ...(reuseGatewayCredentialWithoutLocalKey ? { reuseGatewayCredentialWithoutLocalKey } : {}),
        ...(preferredInferenceApi ? { preferredInferenceApi } : {}),
        ...(endpointPinnedAddresses ? { endpointPinnedAddresses } : {}),
        endpointSource,
        ...(endpointSource === "onboard" && onboardEndpointUrl ? { onboardEndpointUrl } : {}),
        ...(endpointTrustedPrivateCapability ? { endpointTrustedPrivateCapability } : {}),
        ...(inferenceCapabilityCache ? { inferenceCapabilityCache } : {}),
        ...(freshManagedOllama ? { reservationSessionId: session?.sessionId } : {}),
        ...providerRecovery.setupOptions(
          recoveredRecordedProvider,
          confirmedSandboxName,
          session?.sessionId,
        ),
        ...activeHostLocalInferenceSetupOptions,
      };
      revalidatePolicyRequirements("record inference setup start");
      await deps.startRecordedStep("inference", { provider, model });
      inferenceResult = await withInferenceTrace(
        confirmedSandboxName,
        selectedProvider,
        selectedModel,
        credentialEnv,
        () => {
          revalidatePolicyRequirements(`configure inference provider ${JSON.stringify(provider)}`);
          return deps.setupInference(
            confirmedSandboxName,
            selectedModel,
            selectedProvider,
            endpointUrl,
            credentialEnv,
            hermesAuthMethod,
            hermesToolGateways,
            inferenceOptions,
          );
        },
      );
    } finally {
      clearStagedCredentialEnv(deps, credentialEnv);
    }
    if (inferenceResult?.retry === "selection") {
      const retryStateResult = retryTo("provider_selection", {
        metadata: { state: "inference", provider, model, reason: "selection_retry" },
      });
      retryStateResults.push(retryStateResult);
      stateResults.push(retryStateResult);
      forceProviderSelection = true;
      continue;
    }
    const hostLocalRoute = resolvedHostLocalInferenceRoute(
      activeHostLocalInferenceSetupOptions.hostLocalInference,
      { endpointUrl, endpointSource, onboardEndpointUrl },
    );
    hostLocalInferenceRouteOnly = hostLocalRoute.routeOnly;
    hostLocalInferenceProofAuthority = hostLocalRoute.proofAuthority;
    endpointUrl = hostLocalRoute.endpointUrl;
    endpointSource = hostLocalRoute.endpointSource;
    onboardEndpointUrl = hostLocalRoute.onboardEndpointUrl;
    revalidatePolicyRequirements("record inference runtime metadata");
    if (nimContainer && sandboxName) deps.registryUpdateSandbox(sandboxName, { nimContainer });
    if (deferProviderSelectionUntilInference) {
      // Provider selection remains in progress until its inference route has
      // configured successfully. This retains the selected provider/model for
      // interruption recovery without claiming a usable route prematurely.
      revalidatePolicyRequirements("record successful deferred provider selection");
      session = await deps.recordStepComplete(
        "provider_selection",
        deps.toSessionUpdates({
          provider,
          model,
          endpointUrl,
          credentialEnv,
          hermesAuthMethod,
          hermesToolGateways,
          preferredInferenceApi: healAdjustedInferenceApi
            ? initial.preferredInferenceApi
            : preferredInferenceApi,
          compatibleEndpointReasoning,
          compatibleEndpointReasoningEffort,
          nimContainer,
          stationExpressModelIdentity: vllmModelIdentity,
        }),
      );
    }
    revalidatePolicyRequirements("record successful inference configuration");
    session = await deps.recordStepComplete(
      "inference",
      deps.toSessionUpdates({
        provider,
        model,
        hermesAuthMethod,
        compatibleEndpointReasoning,
        compatibleEndpointReasoningEffort,
        nimContainer,
        hermesToolGateways,
        ...hostLocalInferenceSessionRoute(hostLocalInferenceRouteOnly, endpointUrl, endpointSource),
        // The forced #6294/#6289 heal succeeded: the gateway registration now
        // matches the adjusted route, so the stale session seed can be replaced.
        ...(healAdjustedInferenceApi ? { preferredInferenceApi } : {}),
      }),
    );
    break;
  }

  const stateResult = advanceTo("sandbox", {
    metadata: { state: "inference", provider, model },
  });
  stateResults.push(stateResult);

  return {
    sandboxName,
    model,
    provider,
    endpointUrl,
    endpointSource,
    onboardEndpointUrl,
    credentialEnv,
    hermesAuthMethod,
    hermesToolGateways,
    preferredInferenceApi,
    compatibleEndpointReasoning,
    compatibleEndpointReasoningEffort,
    nimContainer,
    webSearchConfig,
    hostLocalInferenceRouteOnly,
    hostLocalInferenceSandboxProofAuthority: hostLocalInferenceProofAuthority,
    session,
    stateResult,
    stateResults,
    retryStateResults,
  };
}
