// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellOptions, CaptureOpenshellResult } from "../adapters/openshell/client";
import { captureOpenshell, getOpenshellBinary } from "../adapters/openshell/runtime";
import { CLI_NAME } from "../cli/branding";
import { shellQuote } from "../core/shell-quote";
import { applyHermesManagedRoute } from "../hermes-managed-route";
import { isBedrockRuntimeEndpoint } from "../inference/bedrock-runtime";
import {
  getProviderSelectionConfig,
  getSandboxInferenceConfig,
  resolveAgentInferenceApi,
  type SandboxInferenceConfig,
} from "../inference/config";
import { resolveContextWindowForModel } from "../inference/context-window";
import { withGatewayRouteMutationLock } from "../inference/gateway-route-mutation-lock";
import { parseHttpsPinRouteId } from "../inference/https-pin-runtime";
import {
  ensureHttpsPinRuntimeAdapter,
  revokeHttpsPinRuntimeAdapterRoute,
} from "../inference/https-pin-runtime-adapter";
import { type ValidationResult, validateLocalProvider } from "../inference/local";
import {
  inferenceSelectionRegistryFields,
  type ReasoningEffortRequest,
  resolveReasoningEffortRequest,
} from "../inference/selection";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding";
import {
  matchesGatewayProviderBinding,
  parseGatewayProviderMetadata,
} from "../onboard/gateway-provider-metadata";
import { ensureLocalProviderReachable } from "../onboard/local-inference-topology";
import {
  assertNoOpenShellGatewayEndpointOverride,
  OpenShellGatewayEndpointOverrideError,
} from "../openshell-gateway-endpoint-guard";
import {
  type AgentConfigTarget,
  type HermesDashboardReseedResult,
  readSandboxConfig,
  recomputeSandboxConfigHash,
  resolveAgentConfig,
  rewriteConfigUrlsWithDnsPinning,
  SandboxConfigError,
  seedHermesDashboardConfig,
  writeSandboxConfig,
} from "../sandbox/config";
import type { ConfigObject, ConfigValue } from "../security/credential-filter";
import { isConfigObject, isConfigValue } from "../security/credential-filter";
import { withSandboxMutationLock } from "../state/mcp-lifecycle-lock";
import * as onboardSession from "../state/onboard-session";
import { appendAuditEntry } from "../state/audit/operational";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
import { enforceRemovedImmutabilityMigrationBoundary } from "../state/migrations/removed-immutability";
import { isSafeModelId } from "../validation";
import { resolveRuntimeInferenceApi } from "./inference-route-api";
import {
  InferenceSetError,
  OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
  openshellReportsProviderNotFound,
} from "./inference-set-error";
import {
  completeInferencePostCommit,
  defaultInferenceGatewayRestart,
  finalizeInferenceMutation,
  type InferenceGatewayRestartDeps,
  type InferenceMutation,
  readPreviousOpenClawInferenceApi,
  settleInferenceSetOpenClawPairing,
} from "./inference-set-gateway-restart";
import {
  type InferenceSetSandboxRouteProbe,
  assertInferenceSetCommandAvailable,
  assertInferenceSetProviderOwnership,
  prepareInferenceSetProviderBinding,
  probeInferenceSetSandboxRoute,
  probeInferenceSetSandboxRouteUntilConverged,
  type RuntimeProviderBundleRegistry,
  RuntimeProviderSelectionError,
  requireInferenceSetRuntimeAuthority,
  sleepInferenceSetRouteConvergence,
} from "./inference-set-provider";
import { buildInferenceSetFailure } from "./inference-set-provider-diagnostics";
import {
  applyOpenClawAnthropicReplyBudget,
  readOpenClawPrimaryReplyBudget,
} from "./inference-set-reply-budget";
import {
  type EnsureHttpsPinRuntimeAdapterFn,
  finalizeInferenceSetRoute,
  type InferenceSetProviderBinding,
  isSandboxBridgeProviderBinding,
  prepareInferenceSetRoute,
  type RegistryInferenceMetadata,
  sandboxCustomCompatibleCredentialEnv,
  usesLoopbackNoAuthProxyRoute,
} from "./inference-set-route-containment";

export {
  ENDPOINT_URL_NOT_ALLOWED_PREFIX,
  normalizeCustomEndpointUrl,
} from "./inference-set-route-containment";
export { InferenceSetError };

export interface InferenceSetOptions {
  provider: string;
  model: string;
  sandboxName?: string | null;
  noVerify?: boolean;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  inferenceApi?: string | null;
  reasoningEffort?: string | null;
}

export interface InferenceSetResult {
  sandboxName: string;
  provider: string;
  model: string;
  primaryModelRef: string;
  providerKey: string;
  configChanged: boolean;
  sessionUpdated: boolean;
  inSandboxConfigSynced: boolean;
}

interface InferenceSetMutationResult extends InferenceSetResult {
  /** Internal post-commit convergence state used before returning to the CLI caller. */
  dashboardConverged?: boolean;
}

export interface InferenceSetDeps extends InferenceGatewayRestartDeps {
  getDefaultSandbox: () => string | null;
  getSandbox: (name: string) => SandboxEntry | null;
  listSandboxes: () => {
    sandboxes: SandboxEntry[];
    defaultSandbox: string | null;
  };
  updateSandbox: (name: string, updates: Partial<SandboxEntry>) => boolean;
  getRequestedAgent: () => string | null | undefined;
  loadSession: () => onboardSession.Session | null;
  updateSession: (
    mutator: (session: onboardSession.Session) => onboardSession.Session | void,
  ) => onboardSession.Session;
  resolveAgentConfig: (sandboxName: string) => AgentConfigTarget;
  readSandboxConfig: (sandboxName: string, target: AgentConfigTarget) => ConfigObject;
  writeSandboxConfig: (
    sandboxName: string,
    target: AgentConfigTarget,
    config: ConfigObject,
  ) => void;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  recomputeSandboxConfigHash: (sandboxName: string, target: AgentConfigTarget) => void;
  seedHermesDashboardConfig: (
    sandboxName: string,
    target: AgentConfigTarget,
  ) => HermesDashboardReseedResult;
  prepareRunOpenshell: () => void;
  captureOpenshell: (
    args: string[],
    opts?: Pick<
      CaptureOpenshellOptions,
      "env" | "ignoreError" | "includeStreams" | "maxBuffer" | "timeout"
    >,
  ) => CaptureOpenshellResult;
  isLocalInferenceProvider: (provider: string) => boolean;
  validateLocalProvider: (provider: string) => ValidationResult;
  ensureLocalProviderReachable: (provider: string) => boolean;
  resolveContextWindowForModel: (provider: string, model: string) => number | null;
  rewriteConfigUrlsWithDnsPinning: (value: ConfigValue) => Promise<ConfigValue>;
  resolveCredentialValue: (credentialEnv: string) => string;
  ensureHttpsPinRuntimeAdapter: EnsureHttpsPinRuntimeAdapterFn;
  revokeHttpsPinRuntimeAdapterRoute: (routeId: string) => Promise<boolean>;
  probeSandboxRoute: InferenceSetSandboxRouteProbe;
  sleep: (milliseconds: number) => Promise<void>;
  withGatewayRouteMutationLock: typeof withGatewayRouteMutationLock;
}

const SUPPORTED_PROVIDER_NAMES = [
  "nvidia-prod",
  "nvidia-nim",
  "nvidia-router",
  "openai-api",
  "openrouter-api",
  "anthropic-prod",
  "compatible-anthropic-endpoint",
  "gemini-api",
  "compatible-endpoint",
  "hermes-provider",
  "ollama-local",
  "vllm-local",
] as const;

// #6321: `nemoclaw onboard` accepts installer-style provider keys
// (`anthropicCompatible`, `build`, `openai`, …) while `inference set` only
// accepted the OpenShell provider names (`compatible-anthropic-endpoint`,
// `nvidia-prod`, `openai-api`, …). A user who onboarded with
// `NEMOCLAW_PROVIDER=anthropicCompatible` could not switch the same sandbox
// with `inference set --provider anthropicCompatible` — the two commands used
// different vocabularies for the same provider. Normalize the installer alias
// to its OpenShell provider name before validation so both commands accept the
// same names. Keys are lowercased; values must each be a SUPPORTED_PROVIDER_NAMES
// entry (asserted by the sync test in inference-set-provider-alias.test.ts).
// This mirrors REMOTE_PROVIDER_CONFIG[key].providerName and
// getEffectiveProviderName() in src/lib/onboard/providers.ts; kept as a small
// local map rather than importing that @ts-nocheck onboard module into this
// hot action path.
const INSTALLER_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  anthropiccompatible: "compatible-anthropic-endpoint",
  build: "nvidia-prod",
  cloud: "nvidia-prod",
  openai: "openai-api",
  "open-router": "openrouter-api",
  openrouter: "openrouter-api",
  openrouterai: "openrouter-api",
  anthropic: "anthropic-prod",
  gemini: "gemini-api",
  // Hermes Provider (Nous portal) is reachable under several onboard synonyms;
  // accept the same set here so a sandbox onboarded with any of them can be
  // switched under the same name. (`hermes-provider` is already an OpenShell
  // provider name and passes through without an entry, but is listed for
  // parity clarity.)
  hermesprovider: "hermes-provider",
  hermes: "hermes-provider",
  nous: "hermes-provider",
  "nous-portal": "hermes-provider",
  custom: "compatible-endpoint",
  ollama: "ollama-local",
  vllm: "vllm-local",
  nim: "nvidia-nim",
  "nim-local": "nvidia-nim",
  routed: "nvidia-router",
};

/**
 * Map an installer-style provider key (the vocabulary `nemoclaw onboard`
 * accepts) to its OpenShell provider name (the vocabulary `inference set`
 * validates against). Inputs that are already OpenShell provider names — or
 * any unrecognized value — pass through unchanged so validation still rejects
 * genuinely unsupported providers. See #6321.
 */
export function normalizeInferenceSetProvider(provider: string): string {
  const trimmed = provider.trim();
  return INSTALLER_PROVIDER_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/** Exposed for the alias-sync regression test. */
export const INFERENCE_SET_SUPPORTED_PROVIDER_NAMES = SUPPORTED_PROVIDER_NAMES;
export const INFERENCE_SET_INSTALLER_PROVIDER_ALIASES = INSTALLER_PROVIDER_ALIASES;

function defaultDeps(): InferenceSetDeps {
  return {
    getDefaultSandbox: registry.getDefault,
    getSandbox: registry.getSandbox,
    listSandboxes: registry.listSandboxes,
    updateSandbox: registry.updateSandbox,
    getRequestedAgent: () => process.env.NEMOCLAW_AGENT,
    loadSession: onboardSession.loadSession,
    updateSession: onboardSession.updateSession,
    resolveAgentConfig,
    readSandboxConfig,
    writeSandboxConfig,
    recomputeSandboxConfigHash,
    seedHermesDashboardConfig,
    prepareRunOpenshell: () => {
      getOpenshellBinary();
    },
    captureOpenshell: (args, opts) => captureOpenshell(args, opts),
    appendAuditEntry,
    log: console.log,
    isLocalInferenceProvider: (provider) =>
      provider === "ollama-local" || provider === "vllm-local",
    validateLocalProvider,
    ensureLocalProviderReachable,
    resolveContextWindowForModel,
    rewriteConfigUrlsWithDnsPinning,
    resolveCredentialValue: (credentialEnv) => process.env[credentialEnv] ?? "",
    ensureHttpsPinRuntimeAdapter: (options) => {
      if (!options.discoverAllowedSourceCidrs) {
        throw new Error("HTTPS Pin Runtime adapter is missing runtime-provider network authority.");
      }
      return ensureHttpsPinRuntimeAdapter({
        ...options,
        discoverAllowedSourceCidrs: options.discoverAllowedSourceCidrs,
      });
    },
    revokeHttpsPinRuntimeAdapterRoute,
    probeSandboxRoute: probeInferenceSetSandboxRoute,
    sleep: sleepInferenceSetRouteConvergence,
    withGatewayRouteMutationLock,
    restartSandboxGateway: defaultInferenceGatewayRestart,
    settleOpenClawPairing: settleInferenceSetOpenClawPairing,
  };
}

function trimRequired(value: string | null | undefined, label: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new InferenceSetError(`${label} is required.`);
  return trimmed;
}

function assertSupportedProvider(provider: string, model: string): void {
  if (getProviderSelectionConfig(provider, model) || provider === "nvidia-router") return;
  throw new InferenceSetError(
    `Unsupported provider '${provider}'. Supported providers: ${SUPPORTED_PROVIDER_NAMES.join(", ")}.`,
    2,
  );
}

function assertInferenceSetRuntimeAuthority(
  entry: SandboxEntry,
  providers: RuntimeProviderBundleRegistry | undefined,
): ReturnType<typeof requireInferenceSetRuntimeAuthority> {
  try {
    return requireInferenceSetRuntimeAuthority(entry, providers);
  } catch (error) {
    if (!(error instanceof RuntimeProviderSelectionError)) throw error;
    throw new InferenceSetError(error.message, 2);
  }
}

function normalizeSandboxAgent(agentName: string | null | undefined): string {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return (trimmed || "openclaw").toLowerCase();
}

function assertSandboxRouteReservationComplete(entry: SandboxEntry): void {
  if (entry.pendingRouteReservation === true) {
    throw new InferenceSetError(
      `Sandbox '${entry.name}' is still being created by onboarding. Wait for onboarding to finish or remove the incomplete sandbox before changing inference.`,
      2,
    );
  }
}

function resolveTargetSandbox(
  sandboxName: string | null | undefined,
  deps: Pick<
    InferenceSetDeps,
    "getDefaultSandbox" | "getSandbox" | "listSandboxes" | "getRequestedAgent"
  >,
): { sandboxName: string; entry: SandboxEntry; agentName: string } {
  const explicitName = sandboxName?.trim();
  if (explicitName) {
    const entry = deps.getSandbox(explicitName);
    if (!entry) {
      throw new InferenceSetError(`Sandbox '${explicitName}' is not registered.`, 2);
    }
    assertSandboxRouteReservationComplete(entry);
    return {
      sandboxName: explicitName,
      entry,
      agentName: normalizeSandboxAgent(entry.agent),
    };
  }

  if (normalizeSandboxAgent(deps.getRequestedAgent()) === "hermes") {
    const hermesSandboxes = deps
      .listSandboxes()
      .sandboxes.filter(
        (entry) =>
          entry.pendingRouteReservation !== true && normalizeSandboxAgent(entry.agent) === "hermes",
      );
    if (hermesSandboxes.length === 1) {
      const entry = hermesSandboxes[0];
      return { sandboxName: entry.name, entry, agentName: "hermes" };
    }
    if (hermesSandboxes.length === 0) {
      throw new InferenceSetError(
        "No registered Hermes sandbox found. Pass --sandbox <name> to target a sandbox explicitly.",
        2,
      );
    }
    throw new InferenceSetError(
      `Multiple Hermes sandboxes are registered (${hermesSandboxes
        .map((entry) => entry.name)
        .join(", ")}). Pass --sandbox <name> to choose one.`,
      2,
    );
  }

  const targetName = deps.getDefaultSandbox();
  if (!targetName) {
    throw new InferenceSetError(
      "No sandbox selected. Pass --sandbox <name> or create a sandbox with nemoclaw onboard.",
      2,
    );
  }

  const entry = deps.getSandbox(targetName);
  if (!entry) {
    throw new InferenceSetError(`Sandbox '${targetName}' is not registered.`, 2);
  }
  assertSandboxRouteReservationComplete(entry);
  return {
    sandboxName: targetName,
    entry,
    agentName: normalizeSandboxAgent(entry.agent),
  };
}

function ensureObject(record: ConfigObject, key: string): ConfigObject {
  const existing = record[key];
  if (isConfigObject(existing)) return existing;
  const created: ConfigObject = {};
  record[key] = created;
  return created;
}

function cloneConfigObject(value: ConfigValue | undefined): ConfigObject {
  if (!isConfigObject(value)) return {};
  return { ...value };
}

const OPENCLAW_UPSTREAM_PROVIDER_HEADER = "X-NemoClaw-Upstream-Provider";

// The image environment records the onboarding provider, but inference-set can
// switch the live route without rebuilding. Carry the current non-secret
// provider identity with OpenClaw's runtime config; the sandbox preload removes
// this private marker before forwarding the request.
function withOpenClawUpstreamProviderHeader(
  existing: ConfigObject,
  upstreamProvider: string,
): ConfigObject {
  const headers = cloneConfigObject(existing.headers);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === OPENCLAW_UPSTREAM_PROVIDER_HEADER.toLowerCase()) {
      delete headers[key];
    }
  }
  headers[OPENCLAW_UPSTREAM_PROVIDER_HEADER] = upstreamProvider;
  return { ...existing, headers };
}

function asConfigObject(value: Record<string, unknown>): ConfigObject {
  const result: ConfigObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isConfigValue(entry as ConfigValue)) result[key] = entry as ConfigValue;
  }
  return result;
}

function updateAgentPrimary(config: ConfigObject, primaryModelRef: string): void {
  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  const model = ensureObject(defaults, "model");
  model.primary = primaryModelRef;
  updatePrimaryAgentListModel(agents, primaryModelRef);
}

function updatePrimaryAgentListModel(agents: ConfigObject, primaryModelRef: string): void {
  const list = agents.list;
  if (!Array.isArray(list)) return;
  let defaultAgent: ConfigObject | undefined;
  for (const entry of list) {
    if (!isConfigObject(entry)) continue;
    if (entry.id === "main") {
      if (typeof entry.model === "string") {
        entry.model = primaryModelRef;
      }
      return;
    }
    if (!defaultAgent && entry.default === true) {
      defaultAgent = entry;
    }
  }
  if (defaultAgent && typeof defaultAgent.model === "string") {
    defaultAgent.model = primaryModelRef;
  }
}

// Scoped to the provider whose registry row records the effort. Writing it for
// any other provider would patch a config that the next rebuild silently drops.
function applyReasoningEffortParams(
  modelEntry: ConfigObject,
  provider: string,
  route: SandboxInferenceConfig,
  request: ReasoningEffortRequest,
): void {
  const canCarryReasoningEffort =
    provider === "compatible-endpoint" && route.inferenceApi === "openai-completions";
  if (!request.explicit && canCarryReasoningEffort) return;
  const params = isConfigObject(modelEntry.params) ? { ...modelEntry.params } : {};
  const extraBody = isConfigObject(params.extra_body) ? { ...params.extra_body } : {};
  if (request.effort && canCarryReasoningEffort) {
    extraBody.reasoning_effort = request.effort;
  } else {
    delete extraBody.reasoning_effort;
  }
  if (Object.keys(extraBody).length > 0) {
    params.extra_body = extraBody;
  } else {
    delete params.extra_body;
  }
  if (Object.keys(params).length > 0) {
    modelEntry.params = params;
  } else {
    delete modelEntry.params;
  }
}

function buildProviderConfig(
  existing: ConfigObject,
  model: string,
  provider: string,
  route: SandboxInferenceConfig,
  contextWindow?: number,
  inheritedMaxTokens?: number,
  upstreamProviderMarker?: string,
  reasoningEffort: ReasoningEffortRequest = { effort: null, explicit: false },
): ConfigObject {
  const firstExistingModel = Array.isArray(existing.models)
    ? cloneConfigObject(existing.models[0])
    : {};
  delete firstExistingModel.compat;
  firstExistingModel.id = model;
  firstExistingModel.name = route.primaryModelRef;
  // Recompute for the new model rather than inheriting the prior model's window.
  // Omitted (undefined) → keep whatever the existing entry had.
  if (typeof contextWindow === "number") {
    firstExistingModel.contextWindow = contextWindow;
  }
  if (route.inferenceApi === "anthropic-messages") {
    applyOpenClawAnthropicReplyBudget(firstExistingModel, inheritedMaxTokens);
  }
  if (route.inferenceCompat) {
    firstExistingModel.compat = asConfigObject(route.inferenceCompat);
  }
  applyReasoningEffortParams(firstExistingModel, provider, route, reasoningEffort);

  const providerConfig: ConfigObject = {
    ...existing,
    baseUrl: route.inferenceBaseUrl,
    apiKey: typeof existing.apiKey === "string" && existing.apiKey ? existing.apiKey : "unused",
    api: route.inferenceApi,
    models: [firstExistingModel],
  };
  return upstreamProviderMarker
    ? withOpenClawUpstreamProviderHeader(providerConfig, upstreamProviderMarker)
    : providerConfig;
}

export function patchOpenClawInferenceConfig(
  config: ConfigObject,
  provider: string,
  model: string,
  preferredInferenceApi: string | null = null,
  contextWindow?: number,
  upstreamProviderMarker?: string,
  reasoningEffort: ReasoningEffortRequest = { effort: null, explicit: false },
): { changed: boolean; route: SandboxInferenceConfig } {
  const before = JSON.stringify(config);
  const route = getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  const inheritedMaxTokens = readOpenClawPrimaryReplyBudget(config);

  updateAgentPrimary(config, route.primaryModelRef);

  const models = ensureObject(config, "models");
  models.mode = "merge";
  const providers = ensureObject(models, "providers");
  const existingProvider = cloneConfigObject(providers[route.providerKey]);
  providers[route.providerKey] = buildProviderConfig(
    existingProvider,
    model,
    provider,
    route,
    contextWindow,
    inheritedMaxTokens,
    upstreamProviderMarker,
    reasoningEffort,
  );

  return { changed: before !== JSON.stringify(config), route };
}

export function patchHermesInferenceConfig(
  config: ConfigObject,
  provider: string,
  model: string,
  preferredInferenceApi: string | null = null,
  contextWindow?: number,
): { changed: boolean; route: SandboxInferenceConfig } {
  const before = JSON.stringify(config);
  const route = getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  applyHermesManagedRoute(config, {
    model,
    baseUrl: route.inferenceBaseUrl,
    upstreamProvider: provider,
    inferenceApi: route.inferenceApi,
    contextWindow,
  });

  return { changed: before !== JSON.stringify(config), route };
}

function resolveHermesContextWindowForSwitch(
  provider: string,
  model: string,
  deps: Pick<InferenceSetDeps, "resolveContextWindowForModel" | "log">,
): number | undefined {
  const contextWindow = deps.resolveContextWindowForModel(provider, model);
  if (contextWindow != null) {
    deps.log(`  Context window for '${model}': ${contextWindow} tokens`);
    return contextWindow;
  }
  deps.log(
    `  Warning: could not determine the context window for '${model}'; omitting ` +
      `context_length so Hermes can discover it from the selected model.`,
  );
  return undefined;
}

function updateMatchingOnboardSession(
  sandboxName: string,
  provider: string,
  model: string,
  route: SandboxInferenceConfig,
  registryMetadata: RegistryInferenceMetadata,
  deps: Pick<InferenceSetDeps, "loadSession" | "updateSession">,
  reasoningEffort: ReasoningEffortRequest = { effort: null, explicit: false },
): boolean {
  const session = deps.loadSession();
  if (!session || session.sandboxName !== sandboxName) return false;
  deps.updateSession((current) => {
    if (current.sandboxName !== sandboxName) return current;
    current.provider = provider;
    current.model = model;
    current.endpointUrl =
      registryMetadata.endpointUrl ??
      getProviderSelectionConfig(provider, model)?.endpointUrl ??
      current.endpointUrl;
    current.credentialEnv =
      registryMetadata.credentialEnv ??
      getProviderSelectionConfig(provider, model)?.credentialEnv ??
      current.credentialEnv;
    current.preferredInferenceApi = registryMetadata.preferredInferenceApi ?? route.inferenceApi;
    if (provider !== "compatible-endpoint" || route.inferenceApi !== "openai-completions") {
      current.compatibleEndpointReasoningEffort = null;
    } else if (reasoningEffort.explicit) {
      current.compatibleEndpointReasoningEffort = reasoningEffort.effort;
    }
    current.nimContainer = registryMetadata.nimContainer ?? null;
    return current;
  });
  return true;
}

function resolveScopedReasoningEffortRequest(value: unknown): ReasoningEffortRequest {
  return resolveReasoningEffortRequest(value);
}

function assertReasoningEffortProvider(request: ReasoningEffortRequest, provider: string): void {
  if (!request.explicit || provider === "compatible-endpoint") return;
  throw new InferenceSetError(
    "--reasoning-effort applies only to the compatible-endpoint provider.",
    2,
  );
}

function assertReasoningEffortRoute(
  request: ReasoningEffortRequest,
  provider: string,
  inferenceApi: string | null,
): void {
  assertReasoningEffortProvider(request, provider);
  if (!request.explicit) return;
  if (inferenceApi !== "openai-completions") {
    throw new InferenceSetError(
      "--reasoning-effort applies only to compatible-endpoint routes using openai-completions.",
      2,
    );
  }
}

function openshellInferenceSetArgs(options: {
  gatewayName: string;
  provider: string;
  model: string;
  noVerify?: boolean;
}): string[] {
  const args = [
    "inference",
    "set",
    "-g",
    options.gatewayName,
    "--provider",
    options.provider,
    "--model",
    options.model,
  ];
  if (options.noVerify) args.push("--no-verify");
  return args;
}

function recordedDirectProviderBindingMismatches(options: {
  entry: SandboxEntry;
  provider: string;
  binding: InferenceSetProviderBinding;
}): string[] {
  return [
    options.entry.provider === options.provider ? null : "provider",
    options.entry.endpointUrl === options.binding.baseUrl ? null : "endpoint URL",
    options.entry.credentialEnv === options.binding.credentialEnv
      ? null
      : "credential environment variable",
  ].filter((field): field is string => field !== null);
}

function getPreferredInferenceApi(config: ConfigObject): string | null {
  const models = config.models;
  if (!isConfigObject(models)) return null;
  const providers = models.providers;
  if (!isConfigObject(providers)) return null;
  const inferenceProvider = providers.inference;
  if (!isConfigObject(inferenceProvider)) return null;
  return typeof inferenceProvider.api === "string" ? inferenceProvider.api : null;
}

function assertHermesCompatibleAnthropicOpenAiProvider(
  sandboxName: string,
  agentName: string,
  gatewayName: string,
  provider: string,
  endpointUrl: string | null,
  deps: InferenceSetDeps,
  httpsPinProviderBinding: {
    providerType: "openai" | "anthropic";
  } | null = null,
): void {
  if (
    agentName !== "hermes" ||
    provider !== "compatible-anthropic-endpoint" ||
    isBedrockRuntimeEndpoint(endpointUrl)
  ) {
    return;
  }
  if (httpsPinProviderBinding?.providerType === "openai") return;

  const result = deps.captureOpenshell(["provider", "get", "-g", gatewayName, provider], {
    ignoreError: true,
    includeStreams: true,
    maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
  });
  const output = result.output || `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const metadata = result.status === 0 ? parseGatewayProviderMetadata(output) : null;
  if (
    matchesGatewayProviderBinding(metadata, {
      name: provider,
      type: "openai",
      credentialKey: "COMPATIBLE_ANTHROPIC_API_KEY",
      configKey: "OPENAI_BASE_URL",
    })
  ) {
    return;
  }

  throw new InferenceSetError(
    `Hermes requires provider '${provider}' to be registered on its verified OpenAI-compatible surface. ` +
      `Run '${CLI_NAME} ${sandboxName} rebuild' to migrate this sandbox, or re-run onboarding for the endpoint before using inference set.`,
    2,
  );
}

/**
 * Read the in-sandbox agent config, converting a `SandboxConfigError` (the
 * in-sandbox config could not be read or parsed — most commonly because the
 * sandbox container is stopped) into a clean `InferenceSetError`. Callers use
 * this as a pre-flight gate before the gateway route and registry are mutated,
 * so an unreadable config aborts the command cleanly instead of crashing with a
 * raw stack after a half-applied switch (#6997).
 */
export function readInSandboxConfigOrFail(
  deps: Pick<InferenceSetDeps, "readSandboxConfig">,
  sandboxName: string,
  target: AgentConfigTarget,
): ConfigObject {
  try {
    return deps.readSandboxConfig(sandboxName, target);
  } catch (error) {
    if (error instanceof SandboxConfigError) {
      const lines = [...error.lines];
      // `readSandboxConfig` also raises this for a corrupt/unparseable config,
      // which starting the sandbox would NOT fix — only add the start hint for
      // the stopped-sandbox case (the one that asks "Is the sandbox running?").
      if (lines.some((line) => /is the sandbox running/i.test(line))) {
        lines.push("  Start the sandbox and retry.");
      }
      throw new InferenceSetError(lines.join("\n"), error.exitCode);
    }
    throw error;
  }
}

async function runInferenceSetWithoutHostLock(
  options: InferenceSetOptions,
  deps: InferenceSetDeps,
  expectedGatewayName: string,
  runtimeProvider: ReturnType<typeof requireInferenceSetRuntimeAuthority>,
): Promise<InferenceMutation<InferenceSetMutationResult>> {
  // #6321: accept the installer-style provider name onboard uses (e.g.
  // `anthropicCompatible`) as well as the OpenShell provider name, by
  // normalizing to the OpenShell name before validation and all downstream use.
  const provider = normalizeInferenceSetProvider(trimRequired(options.provider, "provider"));
  const model = trimRequired(options.model, "model");
  const reasoningEffortRequest = resolveScopedReasoningEffortRequest(options.reasoningEffort);
  assertSupportedProvider(provider, model);
  assertReasoningEffortProvider(reasoningEffortRequest, provider);
  if (!isSafeModelId(model)) {
    throw new InferenceSetError(
      "Invalid model id. Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.",
      2,
    );
  }

  const { sandboxName, entry, agentName } = resolveTargetSandbox(options.sandboxName, deps);
  const priorHttpsPinRouteId = parseHttpsPinRouteId(entry.endpointUrl);
  if (agentName !== "openclaw" && agentName !== "hermes") {
    // #6321: Deep Agents Code (langchain-deepagents-code) bakes its model into
    // the sandbox image at build time (agents/langchain-deepagents-code/Dockerfile
    // ARG NEMOCLAW_MODEL → ~/.deepagents/config.toml), so — unlike OpenClaw and
    // Hermes — it has no runtime inference-set config-mutation path. The blunt
    // "supports OpenClaw and Hermes" message left dcode users with no next step;
    // point them at the only way to change a Deep Agents model: re-onboard with
    // a new selection.
    const dcodeHint =
      agentName === "langchain-deepagents-code"
        ? ` Deep Agents Code bakes its model into the sandbox image at build time, so it has no runtime inference-set path. To change the model, re-onboard with the new selection: \`${CLI_NAME} onboard --agent dcode --name ${shellQuote(sandboxName)} --fresh\` (set NEMOCLAW_PROVIDER / NEMOCLAW_MODEL for the target model).`
        : "";
    throw new InferenceSetError(
      `nemoclaw inference set supports OpenClaw and Hermes sandboxes; '${sandboxName}' uses '${agentName}'.${dcodeHint}`,
      2,
    );
  }
  const session = deps.loadSession();
  const explicitInferenceApi =
    typeof options.inferenceApi === "string" && options.inferenceApi.trim()
      ? options.inferenceApi.trim()
      : null;
  const explicitOrRecordedInferenceApi =
    explicitInferenceApi ??
    (entry.provider === provider ? (entry.preferredInferenceApi ?? null) : null);
  if (
    agentName === "hermes" &&
    provider === "compatible-anthropic-endpoint" &&
    explicitInferenceApi !== null &&
    explicitInferenceApi !== "openai-completions"
  ) {
    throw new InferenceSetError(
      "Hermes custom Anthropic endpoints require the managed openai-completions frontend. " +
        "Set --inference-api openai-completions or omit --inference-api so NemoClaw selects it.",
      2,
    );
  }
  const hasExplicitCustomRoute = Boolean(
    options.endpointUrl || options.credentialEnv || options.inferenceApi,
  );
  const customRoute = hasExplicitCustomRoute
    ? {
        ...options,
        // A same-provider request may omit --inference-api because the durable
        // registry row already identifies the route family. New provider
        // routes still require the operator to supply a complete identity.
        inferenceApi: resolveAgentInferenceApi(agentName, provider, explicitOrRecordedInferenceApi),
      }
    : options;
  const routeEntry = {
    ...entry,
    preferredInferenceApi: resolveAgentInferenceApi(
      agentName,
      provider,
      entry.preferredInferenceApi ?? null,
    ),
  };
  const routeSession = session
    ? {
        ...session,
        preferredInferenceApi: resolveAgentInferenceApi(
          agentName,
          provider,
          session.preferredInferenceApi ?? null,
        ),
      }
    : null;
  // Registered peers are compared exactly as recorded. In particular, a
  // stopped legacy Hermes row that still records the Anthropic frontend will
  // depend on that route when restarted and must not be normalized away.
  const routeSandboxes = deps.listSandboxes().sandboxes;
  const preparedRoute = prepareInferenceSetRoute({
    entry: routeEntry,
    sandboxName,
    provider,
    model,
    customRoute,
    session: routeSession,
    sandboxes: routeSandboxes,
  });
  if (preparedRoute.gatewayName !== expectedGatewayName) {
    throw new InferenceSetError(
      `Sandbox '${sandboxName}' moved from OpenShell gateway '${expectedGatewayName}' to ` +
        `'${preparedRoute.gatewayName}' while waiting for the route mutation lock. Retry the command.`,
      2,
    );
  }

  const target = deps.resolveAgentConfig(sandboxName);
  const targetAgent = normalizeSandboxAgent(target.agentName);
  if (targetAgent !== agentName) {
    throw new InferenceSetError(
      `Sandbox '${sandboxName}' is registered as '${agentName}' but resolved config for '${target.agentName}'.`,
      2,
    );
  }
  // Explicit custom routes may start an HTTPS-pin adapter during finalization,
  // so reject an unsupported API family before that first possible mutation.
  if (preparedRoute.preliminaryExplicitMetadata) {
    assertReasoningEffortRoute(
      reasoningEffortRequest,
      provider,
      preparedRoute.preliminaryExplicitMetadata.preferredInferenceApi ?? null,
    );
  }
  const {
    registryMetadata,
    explicitPreferredInferenceApi,
    directProviderBinding,
    httpsPinProviderBinding,
  } = await finalizeInferenceSetRoute({
    prepared: preparedRoute,
    sandboxName,
    provider,
    model,
    canReuseRecordedRoute:
      entry.provider === provider &&
      typeof entry.endpointUrl === "string" &&
      entry.endpointUrl.trim().length > 0 &&
      typeof entry.preferredInferenceApi === "string" &&
      entry.preferredInferenceApi.trim().length > 0,
    onboardEndpointUrl:
      entry.provider === provider && entry.endpointSource === "onboard"
        ? (entry.endpointUrl ?? null)
        : null,
    getSandboxes: () => deps.listSandboxes().sandboxes,
    rewriteUrlWithDnsPinning: deps.rewriteConfigUrlsWithDnsPinning,
    resolveCredentialValue: deps.resolveCredentialValue,
    ensureHttpsPinRuntimeAdapter: (adapterOptions) =>
      deps.ensureHttpsPinRuntimeAdapter({
        ...adapterOptions,
        discoverAllowedSourceCidrs: () =>
          runtimeProvider.gateway
            .prepareHostRuntime({ environment: process.env, platform: process.platform })
            .network.sandboxSourceCidrs(),
      }),
    effectiveInferenceApi: preparedRoute.preliminaryExplicitMetadata?.preferredInferenceApi ?? null,
  });

  // Local providers (ollama-local, vllm-local) route through the sandbox-facing
  // host.openshell.internal hostname, which the host-side `openshell inference set`
  // verify cannot resolve — its default verification is a guaranteed false negative
  // on a valid route. Validate the host stack ourselves, then skip the gateway-side
  // verify. Only a genuinely-unreachable host stack hard-fails here, before the
  // route is touched.
  let effectiveNoVerify = options.noVerify === true;
  // A loopback endpoint onboarded without authentication is published to the
  // gateway through the local no-auth proxy on NemoClaw's sandbox bridge, so
  // the provider's base URL is a `host.openshell.internal` address even though
  // the registry records the operator's loopback URL. The host-side OpenShell
  // verifier cannot resolve that address; verify from inside the sandbox
  // instead, exactly like an explicit bridge route.
  const loopbackNoAuthProxyRoute = usesLoopbackNoAuthProxyRoute(entry, provider);
  const probeDirectSandboxBridge =
    isSandboxBridgeProviderBinding(directProviderBinding) || loopbackNoAuthProxyRoute;
  // Adapter routes and explicit custom routes on NemoClaw's sandbox bridge
  // resolve only from inside the sandbox network. The host-side OpenShell
  // verifier cannot resolve host.openshell.internal, so its result would be a
  // guaranteed false negative. HTTPS-pin adapters retain their local-health
  // verification; direct bridge routes are probed from the sandbox below.
  if (httpsPinProviderBinding || probeDirectSandboxBridge) {
    effectiveNoVerify = true;
  }
  if (deps.isLocalInferenceProvider(provider)) {
    const localValidation = deps.validateLocalProvider(provider);
    if (localValidation.ok) {
      effectiveNoVerify = true;
    } else if (deps.ensureLocalProviderReachable(provider)) {
      if (localValidation.message) deps.log(`  ⚠ ${localValidation.message}`);
      deps.log(
        "  Host inference service is reachable — proceeding. The sandbox reaches it " +
          "through the gateway route at runtime; host-side verification cannot resolve " +
          "the container hostname, so it is skipped.",
      );
      effectiveNoVerify = true;
    } else {
      throw new InferenceSetError(
        `Cannot reach local provider '${provider}': ${
          localValidation.message ?? "the host inference service is not responding."
        }${localValidation.diagnostic ? `\n  Diagnostic: ${localValidation.diagnostic}` : ""}`,
        1,
      );
    }
  }

  // `inference set` changes the selected route but cannot change a gateway
  // provider's protocol type. Fail before mutation when a legacy Anthropic
  // registration would make the required Hermes OpenAI frontend unroutable.
  assertHermesCompatibleAnthropicOpenAiProvider(
    sandboxName,
    agentName,
    preparedRoute.gatewayName,
    provider,
    registryMetadata.endpointUrl ?? null,
    deps,
    httpsPinProviderBinding ?? directProviderBinding,
  );

  // Read the in-sandbox config *before* mutating the gateway route or registry.
  // If it is unreadable (e.g. a stopped sandbox), the mutations below would have
  // committed the gateway route and registry first (only the in-sandbox layer is
  // `rebuild`-recoverable), so gate on the read here to abort cleanly instead of
  // leaving a half-applied switch across the three config layers (#6997).
  // Route finalization has no side effect when metadata is reused; explicit
  // custom routes were capability-checked before finalization above.
  const config = readInSandboxConfigOrFail(deps, sandboxName, target);
  const preMutationInferenceApi =
    explicitPreferredInferenceApi ??
    resolveRuntimeInferenceApi({
      agentName,
      config,
      currentProvider: entry.provider,
      provider,
      sandboxName,
      session,
    });
  const previousInferenceApi = resolveRuntimeInferenceApi({
    agentName,
    config,
    currentProvider: entry.provider,
    provider: entry.provider ?? "",
    sandboxName,
    session,
  });
  assertReasoningEffortRoute(reasoningEffortRequest, provider, preMutationInferenceApi);
  const previousProvider = typeof entry.provider === "string" ? entry.provider.trim() : "";
  const previousModel = typeof entry.model === "string" ? entry.model.trim() : "";
  if (probeDirectSandboxBridge && (!previousProvider || !previousModel)) {
    throw new InferenceSetError(
      `Cannot verify the sandbox-only provider route because sandbox '${sandboxName}' does not record ` +
        "the previous provider and model needed to restore its OpenShell inference selection.",
      2,
    );
  }

  let appliedProvider = false;
  let appliedInferenceSelection = false;
  let restoredSelectionAfterProviderFailure = false;
  let providerMutation: ReturnType<typeof prepareInferenceSetProviderBinding> | null = null;
  const restorePreviousInferenceSelection = (): string | null => {
    let restoreResult: CaptureOpenshellResult;
    try {
      restoreResult = deps.captureOpenshell(
        openshellInferenceSetArgs({
          gatewayName: preparedRoute.gatewayName,
          provider: previousProvider,
          model: previousModel,
          noVerify: true,
        }),
        {
          ignoreError: true,
          includeStreams: true,
          maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
        },
      );
    } catch {
      return "the restore command could not be invoked";
    }
    if (restoreResult.status !== 0) {
      return `the restore command exited with status ${restoreResult.status ?? "unknown"}`;
    }
    appliedInferenceSelection = false;
    return null;
  };
  try {
    const providerBinding = httpsPinProviderBinding ?? directProviderBinding;
    if (providerBinding) {
      providerMutation = prepareInferenceSetProviderBinding({
        gatewayName: preparedRoute.gatewayName,
        providerName: provider,
        binding: providerBinding,
        captureOpenshell: deps.captureOpenshell,
        allowCreate: !loopbackNoAuthProxyRoute,
      });
      if (directProviderBinding && providerMutation.action === "update") {
        const bindingMismatches = recordedDirectProviderBindingMismatches({
          entry,
          provider,
          binding: directProviderBinding,
        });
        if (bindingMismatches.length > 0) {
          throw new InferenceSetError(
            `Cannot replace existing provider '${provider}' because the requested binding differs in: ${bindingMismatches.join(", ")}. ` +
              `OpenShell does not expose the previous provider configuration required for rollback. ` +
              `Re-run onboarding with the requested binding. If this sandbox already uses '${provider}', omit the endpoint options to switch only the model.`,
            2,
          );
        }
        // OpenShell redacts provider configuration values. The matching
        // registry route is the only durable evidence that this request does
        // not replace the provider binding.
        providerMutation = null;
      }
    } else if (loopbackNoAuthProxyRoute) {
      // A model-only switch builds no provider binding, so nothing above
      // inspects the live provider. This route's credential is the local
      // no-auth proxy token that OpenShell holds and sends on selection, and
      // its host-side verification is skipped, so confirm the durable binding
      // is still the one onboarding registered before selecting it.
      assertInferenceSetProviderOwnership({
        gatewayName: preparedRoute.gatewayName,
        providerName: provider,
        providerType: preMutationInferenceApi === "anthropic-messages" ? "anthropic" : "openai",
        credentialEnv: sandboxCustomCompatibleCredentialEnv(entry, provider),
        captureOpenshell: deps.captureOpenshell,
      });
    }
    if (providerMutation) {
      appliedProvider = providerMutation.action === "create";
      if (providerMutation.action === "update" && (!previousProvider || !previousModel)) {
        throw new InferenceSetError(
          `Cannot update existing ${httpsPinProviderBinding ? "HTTPS-pinned " : ""}provider '${provider}' because sandbox '${sandboxName}' ` +
            `does not record the previous provider and model needed to restore its inference selection.`,
          2,
        );
      }
    }

    deps.log(`  Setting OpenShell inference route: ${provider} / ${model}`);
    const setInferenceRoute = () =>
      deps.captureOpenshell(
        openshellInferenceSetArgs({
          gatewayName: preparedRoute.gatewayName,
          provider,
          model,
          noVerify: effectiveNoVerify,
        }),
        {
          ignoreError: true,
          includeStreams: true,
          maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
        },
      );
    let setResult = setInferenceRoute();
    if (
      setResult.status !== 0 &&
      directProviderBinding &&
      openshellReportsProviderNotFound(
        `${setResult.stderr ?? ""}\n${setResult.stdout ?? ""}`,
        provider,
      )
    ) {
      setResult = setInferenceRoute();
    }
    if (setResult.status !== 0) {
      const failure = buildInferenceSetFailure(setResult, provider, deps);
      throw new InferenceSetError(failure.message, failure.exitCode);
    }
    appliedInferenceSelection = true;
    if (providerMutation) {
      try {
        providerMutation.commit();
        appliedProvider = true;
      } catch (providerError) {
        const providerDetail =
          providerError instanceof Error ? providerError.message : String(providerError);
        const providerExitCode =
          providerError instanceof InferenceSetError ? providerError.exitCode : 1;
        const restoreFailure = restorePreviousInferenceSelection();
        if (restoreFailure) {
          throw new InferenceSetError(
            `${providerDetail}\n  Failed to restore the previous OpenShell inference selection ` +
              `'${previousProvider}' / '${previousModel}': ${restoreFailure}. ` +
              `The live selection and provider binding may be split; re-run onboarding before using this route.`,
            providerExitCode,
          );
        }
        restoredSelectionAfterProviderFailure = true;
        throw new InferenceSetError(
          `${providerDetail}\n  The previous OpenShell inference selection was restored to ` +
            `'${previousProvider}' / '${previousModel}'. Provider state may still be partial; ` +
            `retry this command or re-run onboarding to reconcile it.`,
          providerExitCode,
        );
      }
    }

    if (probeDirectSandboxBridge) {
      let probe: ReturnType<InferenceSetSandboxRouteProbe>;
      try {
        probe = await probeInferenceSetSandboxRouteUntilConverged(
          {
            input: {
              sandboxName,
              provider,
              model,
              preferredInferenceApi: preMutationInferenceApi,
            },
            previousProvider,
            previousModel,
            previousInferenceApi,
            targetInferenceApi: preMutationInferenceApi,
          },
          {
            probe: deps.probeSandboxRoute,
            sleep: deps.sleep,
            onRetry: (result, delayMs, attempt) => {
              if (result.ok) return;
              deps.log(
                `  Waiting ${delayMs / 1_000}s for OpenShell route convergence after HTTP ${result.httpStatus} (probe ${attempt}/3)...`,
              );
            },
          },
        );
      } catch (probeError) {
        const probeFailureDetail =
          probeError instanceof Error && probeError.message
            ? (onboardSession.redactSensitiveText(probeError.message)?.trim() ?? "")
            : "";
        probe = {
          ok: false,
          detail: probeFailureDetail
            ? `sandbox inference invocation probe was unavailable: ${probeFailureDetail}`
            : "sandbox inference invocation probe was unavailable",
          httpStatus: null,
        };
      }
      if (!probe.ok) {
        const restoreFailure = restorePreviousInferenceSelection();
        if (restoreFailure) {
          throw new InferenceSetError(
            `Sandbox-side verification rejected provider '${provider}' / '${model}': ${probe.detail}. ` +
              `Failed to restore the previous OpenShell inference selection '${previousProvider}' / ` +
              `'${previousModel}': ${restoreFailure}. Re-run onboarding before using this route.`,
          );
        }
        throw new InferenceSetError(
          `Sandbox-side verification rejected provider '${provider}' / '${model}': ${probe.detail}. ` +
            `The previous OpenShell inference selection was restored to '${previousProvider}' / '${previousModel}'.`,
        );
      }
    }

    // Write minimal registry state before any sandbox-facing config read so the
    // gateway and registry cannot split if the in-sandbox layer is unavailable.
    const registryFields = (preferredInferenceApi: string | null) =>
      inferenceSelectionRegistryFields({
        provider,
        model,
        endpointUrl: registryMetadata.endpointUrl ?? null,
        endpointSource: registryMetadata.endpointSource ?? null,
        credentialEnv: registryMetadata.credentialEnv ?? null,
        preferredInferenceApi,
        compatibleEndpointReasoningEffort:
          provider === "compatible-endpoint" && preferredInferenceApi === "openai-completions"
            ? reasoningEffortRequest.explicit
              ? reasoningEffortRequest.effort
              : (entry.compatibleEndpointReasoningEffort ?? null)
            : null,
        nimContainer: registryMetadata.nimContainer ?? null,
      });
    if (
      !deps.updateSandbox(
        sandboxName,
        registryFields(
          resolveAgentInferenceApi(
            agentName,
            provider,
            registryMetadata.preferredInferenceApi ?? null,
          ),
        ),
      )
    ) {
      throw new InferenceSetError(
        `Failed to update NemoClaw registry for sandbox '${sandboxName}'.`,
      );
    }

    const previousOpenClawInferenceApi = readPreviousOpenClawInferenceApi(agentName, config);
    const preferredInferenceApi =
      explicitPreferredInferenceApi ??
      resolveRuntimeInferenceApi({
        agentName,
        config,
        currentProvider: entry.provider,
        provider,
        sandboxName,
        session,
      });
    const effectiveRegistryMetadata: RegistryInferenceMetadata = {
      ...registryMetadata,
      preferredInferenceApi,
    };
    // Refresh the registry with config-derived API-family metadata before the
    // crash-prone in-sandbox sync (#3725/#3726). Explicit operator-supplied
    // metadata remains authoritative when present.
    if (!deps.updateSandbox(sandboxName, registryFields(preferredInferenceApi))) {
      throw new InferenceSetError(
        `Failed to update NemoClaw registry for sandbox '${sandboxName}'.`,
      );
    }

    const currentHttpsPinRouteId = parseHttpsPinRouteId(registryMetadata.endpointUrl);
    if (priorHttpsPinRouteId && priorHttpsPinRouteId !== currentHttpsPinRouteId) {
      try {
        const peerStillReferencesRoute = deps
          .listSandboxes()
          .sandboxes.some(
            (candidate) =>
              candidate.name !== sandboxName &&
              parseHttpsPinRouteId(candidate.endpointUrl) === priorHttpsPinRouteId,
          );
        if (!peerStillReferencesRoute) {
          const revoked = await deps.revokeHttpsPinRuntimeAdapterRoute(priorHttpsPinRouteId);
          if (!revoked) throw new Error("the adapter did not confirm route revocation");
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(
          `  Warning: the new inference route is committed, but superseded HTTPS Pin Runtime route ` +
            `'${priorHttpsPinRouteId}' could not be revoked: ${detail}. The raw upstream endpoint was not restored; ` +
            `uninstall NemoClaw to stop the adapter and purge its in-memory credentials if this persists.`,
        );
      }
    }

    let patched: { changed: boolean; route: SandboxInferenceConfig };
    if (agentName === "hermes") {
      const contextWindow = resolveHermesContextWindowForSwitch(provider, model, deps);
      patched = patchHermesInferenceConfig(
        config,
        provider,
        model,
        preferredInferenceApi,
        contextWindow,
      );
    } else {
      // Recompute the context window for the model being switched to, so it does
      // not inherit the prior model's window (#context-window-on-switch).
      const contextWindow = deps.resolveContextWindowForModel(provider, model);
      if (contextWindow != null) {
        deps.log(`  Context window for '${model}': ${contextWindow} tokens`);
      } else {
        deps.log(
          `  Warning: could not determine the context window for '${model}'; keeping the ` +
            `existing value. Run '${CLI_NAME} ${sandboxName} rebuild' to re-probe it.`,
        );
      }
      patched = patchOpenClawInferenceConfig(
        config,
        provider,
        model,
        preferredInferenceApi || getPreferredInferenceApi(config),
        contextWindow ?? undefined,
        provider,
        reasoningEffortRequest,
      );
    }

    deps.log(
      agentName === "hermes"
        ? `  Syncing Hermes model route in sandbox '${sandboxName}'...`
        : `  Syncing OpenClaw model identity in sandbox '${sandboxName}'...`,
    );
    // In-sandbox config is the last, crash-prone layer (gateway + registry already consistent).
    // OpenClaw keeps its existing degraded result on failure. Hermes finalizes the committed
    // route and registry, then returns an error so automation cannot accept partial convergence.
    // Two degraded states, both fixed by `rebuild` (regenerates openclaw.json + .config-hash from registry):
    //   - write fails:           config left old (old .config-hash still matches it)
    //   - hash recompute fails:  config new but .config-hash stale -> integrity-guard mismatch
    let inSandboxConfigSynced = false;
    try {
      deps.writeSandboxConfig(sandboxName, target, config);
      try {
        deps.recomputeSandboxConfigHash(sandboxName, target);
        inSandboxConfigSynced = true;
      } catch (hashError) {
        const detail =
          hashError instanceof Error && hashError.message ? hashError.message : String(hashError);
        deps.log(
          `  Warning: wrote the in-sandbox config for '${sandboxName}' but failed to refresh its ` +
            `integrity hash: ${detail}`,
        );
        deps.log(`  Run '${CLI_NAME} ${sandboxName} rebuild' to resync the in-sandbox config.`);
      }
    } catch (writeError) {
      const detail =
        writeError instanceof Error && writeError.message ? writeError.message : String(writeError);
      deps.log(
        `  Warning: gateway and registry now use ${provider} / ${model}, but writing the ` +
          `in-sandbox config failed: ${detail}`,
      );
      deps.log(
        `  Run '${CLI_NAME} ${sandboxName} rebuild' to finish applying the model inside the sandbox.`,
      );
    }
    // Hermes keeps an isolated dashboard profile config that only mirrors the gateway
    // config's model routing at sandbox startup. Re-seed it after an in-place
    // switch so Dashboard Chat (and /api/model/info) converge on the new model
    // instead of silently staying on the previous one (#6893).
    //   - "converged": dashboard now matches the switch.
    //   - "absent":    Dashboard disabled — nothing to converge, still a success.
    //   - "failed":    warn and fail after the committed mutation is finalized so
    //                  callers cannot accept a partially converged switch.
    let dashboardConverged: boolean | undefined;
    if (agentName === "hermes" && inSandboxConfigSynced) {
      const reseed = deps.seedHermesDashboardConfig(sandboxName, target);
      dashboardConverged = reseed !== "failed";
      if (reseed === "failed") {
        deps.log(
          `  Warning: updated the Hermes model route but could not refresh the dashboard ` +
            `config for '${sandboxName}'. Restart the sandbox to converge Dashboard Chat.`,
        );
      }
    }
    const sessionUpdated = updateMatchingOnboardSession(
      sandboxName,
      provider,
      model,
      patched.route,
      effectiveRegistryMetadata,
      deps,
      reasoningEffortRequest,
    );

    const mutation = finalizeInferenceMutation(
      {
        agentName,
        configChanged: patched.changed,
        nextApi: patched.route.inferenceApi,
        openClawPairingTarget:
          agentName === "openclaw"
            ? {
                sandboxName,
                gatewayName: expectedGatewayName,
                openclawVersion: entry.agentVersion ?? "",
                stateDirectory: target.configDir,
              }
            : undefined,
        previousApi: previousOpenClawInferenceApi,
        result: {
          sandboxName,
          provider,
          model,
          primaryModelRef: patched.route.primaryModelRef,
          providerKey: patched.route.providerKey,
          configChanged: patched.changed,
          sessionUpdated,
          inSandboxConfigSynced,
          dashboardConverged,
        },
      },
      deps,
    );
    if (agentName === "hermes" && !inSandboxConfigSynced) {
      throw new InferenceSetError(
        `Hermes inference route synchronization did not complete for '${sandboxName}'. ` +
          `The OpenShell route and NemoClaw registry remain committed, but the in-sandbox ` +
          `Hermes configuration did not fully converge. Run '${CLI_NAME} ${sandboxName} rebuild' to converge it.`,
      );
    }
    return mutation;
  } catch (error) {
    if (!providerMutation) throw error;
    if (restoredSelectionAfterProviderFailure) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const exitCode = error instanceof InferenceSetError ? error.exitCode : 1;
    if (!appliedInferenceSelection) {
      try {
        providerMutation.rollback();
      } catch (rollbackError) {
        const rollbackDetail =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new InferenceSetError(
          `${detail}\n  ${rollbackDetail} Re-run onboarding before retrying this switch.`,
          exitCode,
        );
      }
      const unchanged =
        providerMutation.action === "create"
          ? "The newly created OpenShell provider was removed; the inference selection was not changed."
          : "The existing OpenShell provider binding and inference selection were not changed.";
      throw new InferenceSetError(`${detail}\n  ${unchanged}`, exitCode);
    }
    const residual = appliedProvider
      ? httpsPinProviderBinding
        ? "The OpenShell provider and inference selection remain committed to the safer HTTPS-pinned adapter, but NemoClaw state may not have converged. Retry this command; if convergence still fails, rebuild the sandbox."
        : "The OpenShell provider and inference selection remain committed, but NemoClaw state may not have converged. Retry this command; if convergence still fails, rebuild the sandbox."
      : httpsPinProviderBinding
        ? "The inference selection changed, but the HTTPS-pinned provider binding did not converge. Retry this command immediately; if convergence still fails, rebuild the sandbox."
        : "The inference selection changed, but the OpenShell provider binding did not converge. Retry this command immediately; if convergence still fails, rebuild the sandbox.";
    throw new InferenceSetError(`${detail}\n  ${residual}`, exitCode);
  }
}

export async function runInferenceSet(
  options: InferenceSetOptions,
  deps: InferenceSetDeps = defaultDeps(),
): Promise<InferenceSetResult> {
  try {
    const provider = normalizeInferenceSetProvider(trimRequired(options.provider, "provider"));
    assertReasoningEffortProvider(
      resolveScopedReasoningEffortRequest(options.reasoningEffort),
      provider,
    );
  } catch (error) {
    throw new InferenceSetError(error instanceof Error ? error.message : String(error), 2);
  }
  try {
    assertNoOpenShellGatewayEndpointOverride();
  } catch (error) {
    if (error instanceof OpenShellGatewayEndpointOverrideError) {
      throw new InferenceSetError(error.message, 2);
    }
    throw error;
  }
  // Resolve once before acquiring so a default-sandbox change cannot make the
  // protected callback mutate a different sandbox from the one whose lock we
  // hold. Prime the default OpenShell runner before acquiring too: its legacy
  // missing-binary path exits the process, which cannot be deferred safely by
  // an async lock. The inner resolution still validates the live registry entry.
  const selected = resolveTargetSandbox(options.sandboxName, deps);
  try {
    enforceRemovedImmutabilityMigrationBoundary(selected.sandboxName);
  } catch (error) {
    throw new InferenceSetError(error instanceof Error ? error.message : String(error), 2);
  }
  assertInferenceSetRuntimeAuthority(selected.entry, deps.runtimeProviders);
  assertInferenceSetCommandAvailable(selected.sandboxName);
  deps.prepareRunOpenshell();
  return withSandboxMutationLock(selected.sandboxName, async () => {
    enforceRemovedImmutabilityMigrationBoundary(selected.sandboxName);
    assertInferenceSetCommandAvailable(selected.sandboxName);
    const lockedSelection = resolveTargetSandbox(selected.sandboxName, deps);
    const runtimeProvider = assertInferenceSetRuntimeAuthority(
      lockedSelection.entry,
      deps.runtimeProviders,
    );
    const gatewayName = resolveSandboxGatewayName(lockedSelection.entry);
    const mutation = await deps.withGatewayRouteMutationLock(gatewayName, () =>
      runInferenceSetWithoutHostLock(
        { ...options, sandboxName: selected.sandboxName },
        deps,
        gatewayName,
        runtimeProvider,
      ),
    );
    // Retain the outer sandbox lifecycle lock so another process cannot replace
    // this sandbox between the committed write, an optional restart, and
    // device-scope convergence.
    completeInferencePostCommit(mutation, deps);
    if (mutation.result.dashboardConverged === false) {
      throw new InferenceSetError(
        `Inference route and main Hermes config were updated for '${mutation.result.sandboxName}', ` +
          `but the Dashboard config did not converge. The committed route was not rolled back. ` +
          `Restart the sandbox to converge Dashboard Chat.`,
      );
    }
    return mutation.result;
  });
}
