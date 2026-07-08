// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellOptions, CaptureOpenshellResult } from "../adapters/openshell/client";
import { captureOpenshell, getOpenshellBinary } from "../adapters/openshell/runtime";
import { CLI_NAME } from "../cli/branding";
import { shellQuote } from "../core/shell-quote";
import { HERMES_PROXY_API_KEY_PLACEHOLDER } from "../hermes-proxy-api-key";
import { isBedrockRuntimeEndpoint } from "../inference/bedrock-runtime";
import {
  getProviderSelectionConfig,
  getSandboxInferenceConfig,
  resolveAgentInferenceApi,
  type SandboxInferenceConfig,
} from "../inference/config";
import { resolveContextWindowForModel } from "../inference/context-window";
import { withGatewayRouteMutationLock } from "../inference/gateway-route-mutation-lock";
import { type ValidationResult, validateLocalProvider } from "../inference/local";
import { inferenceSelectionRegistryFields } from "../inference/selection";
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
  readSandboxConfig,
  recomputeSandboxConfigHash,
  resolveAgentConfig,
  rewriteConfigUrlsWithDnsPinning,
  writeSandboxConfig,
} from "../sandbox/config";
import type { ConfigObject, ConfigValue } from "../security/credential-filter";
import { isConfigObject, isConfigValue } from "../security/credential-filter";
import { appendAuditEntry } from "../shields/audit";
import { withTimerBoundShieldsMutationLockAsync } from "../shields/timer-bound-lock";
import { withSandboxMutationLock } from "../state/mcp-lifecycle-lock";
import * as onboardSession from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
import { isSafeModelId } from "../validation";
import { hermesApiMode, resolveRuntimeInferenceApi } from "./inference-route-api";
import { InferenceSetError, OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER } from "./inference-set-error";
import {
  completeInferenceGatewayRestart,
  defaultInferenceGatewayRestart,
  finalizeInferenceMutation,
  type InferenceGatewayRestartDeps,
  type InferenceMutation,
  readPreviousOpenClawInferenceApi,
} from "./inference-set-gateway-restart";
import { buildInferenceSetFailure } from "./inference-set-provider-diagnostics";
import {
  applyOpenClawAnthropicReplyBudget,
  readOpenClawPrimaryReplyBudget,
} from "./inference-set-reply-budget";
import {
  finalizeInferenceSetRoute,
  prepareInferenceSetRoute,
  type RegistryInferenceMetadata,
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

export interface InferenceSetDeps extends InferenceGatewayRestartDeps {
  getDefaultSandbox: () => string | null;
  getSandbox: (name: string) => SandboxEntry | null;
  listSandboxes: () => { sandboxes: SandboxEntry[]; defaultSandbox: string | null };
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
  recomputeSandboxConfigHash: (sandboxName: string, target: AgentConfigTarget) => void;
  prepareRunOpenshell: () => void;
  captureOpenshell: (
    args: string[],
    opts?: Pick<
      CaptureOpenshellOptions,
      "ignoreError" | "includeStreams" | "maxBuffer" | "timeout"
    >,
  ) => CaptureOpenshellResult;
  isLocalInferenceProvider: (provider: string) => boolean;
  validateLocalProvider: (provider: string) => ValidationResult;
  ensureLocalProviderReachable: (provider: string) => boolean;
  resolveContextWindowForModel: (provider: string, model: string) => number | null;
  isSandboxConfigMutable: (sandboxName: string) => boolean;
  rewriteConfigUrlsWithDnsPinning: (value: ConfigValue) => Promise<ConfigValue>;
  withGatewayRouteMutationLock: typeof withGatewayRouteMutationLock;
}

const SUPPORTED_PROVIDER_NAMES = [
  "nvidia-prod",
  "nvidia-nim",
  "nvidia-router",
  "openai-api",
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
    withGatewayRouteMutationLock,
    restartSandboxGateway: defaultInferenceGatewayRestart,
    isSandboxConfigMutable: (sandboxName) => {
      const { isShieldsDown }: typeof import("../shields") = require("../shields");
      return isShieldsDown(sandboxName, true);
    },
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
  return { sandboxName: targetName, entry, agentName: normalizeSandboxAgent(entry.agent) };
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

function buildProviderConfig(
  existing: ConfigObject,
  model: string,
  route: SandboxInferenceConfig,
  contextWindow?: number,
  inheritedMaxTokens?: number,
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

  return {
    ...existing,
    baseUrl: route.inferenceBaseUrl,
    apiKey: typeof existing.apiKey === "string" && existing.apiKey ? existing.apiKey : "unused",
    api: route.inferenceApi,
    models: [firstExistingModel],
  };
}

export function patchOpenClawInferenceConfig(
  config: ConfigObject,
  provider: string,
  model: string,
  preferredInferenceApi: string | null = null,
  contextWindow?: number,
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
    route,
    contextWindow,
    inheritedMaxTokens,
  );

  return { changed: before !== JSON.stringify(config), route };
}

export function patchHermesInferenceConfig(
  config: ConfigObject,
  provider: string,
  model: string,
  preferredInferenceApi: string | null = null,
): { changed: boolean; route: SandboxInferenceConfig } {
  const before = JSON.stringify(config);
  const route = getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  const upstream = ensureObject(config, "_nemoclaw_upstream");
  upstream.provider = provider;
  upstream.model = model;
  const modelConfig = ensureObject(config, "model");
  modelConfig.default = model;
  modelConfig.base_url = route.inferenceBaseUrl;
  modelConfig.provider = "custom";
  modelConfig.api_key = HERMES_PROXY_API_KEY_PLACEHOLDER;
  const apiMode = hermesApiMode(route.inferenceApi);
  if (apiMode) {
    modelConfig.api_mode = apiMode;
  } else {
    delete modelConfig.api_mode;
  }

  return { changed: before !== JSON.stringify(config), route };
}

function updateMatchingOnboardSession(
  sandboxName: string,
  provider: string,
  model: string,
  route: SandboxInferenceConfig,
  registryMetadata: RegistryInferenceMetadata,
  deps: Pick<InferenceSetDeps, "loadSession" | "updateSession">,
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
    current.nimContainer = registryMetadata.nimContainer ?? null;
    return current;
  });
  return true;
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
): void {
  if (
    agentName !== "hermes" ||
    provider !== "compatible-anthropic-endpoint" ||
    isBedrockRuntimeEndpoint(endpointUrl)
  ) {
    return;
  }

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

async function runInferenceSetWithoutHostLock(
  options: InferenceSetOptions,
  deps: InferenceSetDeps,
  expectedGatewayName: string,
): Promise<InferenceMutation<InferenceSetResult>> {
  // #6321: accept the installer-style provider name onboard uses (e.g.
  // `anthropicCompatible`) as well as the OpenShell provider name, by
  // normalizing to the OpenShell name before validation and all downstream use.
  const provider = normalizeInferenceSetProvider(trimRequired(options.provider, "provider"));
  const model = trimRequired(options.model, "model");
  assertSupportedProvider(provider, model);
  if (!isSafeModelId(model)) {
    throw new InferenceSetError(
      "Invalid model id. Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.",
      2,
    );
  }

  const { sandboxName, entry, agentName } = resolveTargetSandbox(options.sandboxName, deps);
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
  if (!deps.isSandboxConfigMutable(sandboxName)) {
    throw new InferenceSetError(
      `${agentName === "hermes" ? "Hermes" : "OpenClaw"} inference changes are unavailable while shields are up for '${sandboxName}'. Run '${CLI_NAME} ${sandboxName} shields down' first.`,
      2,
    );
  }
  const { registryMetadata, explicitPreferredInferenceApi } = await finalizeInferenceSetRoute({
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
    getSandboxes: () => deps.listSandboxes().sandboxes,
    rewriteUrlWithDnsPinning: deps.rewriteConfigUrlsWithDnsPinning,
  });

  // Local providers (ollama-local, vllm-local) route through the sandbox-facing
  // host.openshell.internal hostname, which the host-side `openshell inference set`
  // verify cannot resolve — its default verification is a guaranteed false negative
  // on a valid route. Validate the host stack ourselves, then skip the gateway-side
  // verify. Only a genuinely-unreachable host stack hard-fails here, before the
  // route is touched.
  let effectiveNoVerify = options.noVerify === true;
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
  );

  deps.log(`  Setting OpenShell inference route: ${provider} / ${model}`);
  const setResult = deps.captureOpenshell(
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
  if (setResult.status !== 0) {
    const failure = buildInferenceSetFailure(setResult, provider, deps);
    throw new InferenceSetError(failure.message, failure.exitCode);
  }

  // Write minimal registry state before any sandbox-facing config read so the
  // gateway and registry cannot split if the in-sandbox layer is unavailable.
  const registryFields = (preferredInferenceApi: string | null) =>
    inferenceSelectionRegistryFields({
      provider,
      model,
      endpointUrl: registryMetadata.endpointUrl ?? null,
      credentialEnv: registryMetadata.credentialEnv ?? null,
      preferredInferenceApi,
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
    throw new InferenceSetError(`Failed to update NemoClaw registry for sandbox '${sandboxName}'.`);
  }

  const config = deps.readSandboxConfig(sandboxName, target);
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
    throw new InferenceSetError(`Failed to update NemoClaw registry for sandbox '${sandboxName}'.`);
  }

  let patched: { changed: boolean; route: SandboxInferenceConfig };
  if (agentName === "hermes") {
    patched = patchHermesInferenceConfig(config, provider, model, preferredInferenceApi);
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
    );
  }

  deps.log(
    agentName === "hermes"
      ? `  Syncing Hermes model route in sandbox '${sandboxName}'...`
      : `  Syncing OpenClaw model identity in sandbox '${sandboxName}'...`,
  );
  // In-sandbox config is the last, crash-prone layer (gateway + registry already consistent):
  //   - don't abort on failure; track whether it synced, never report a false "synced"
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
  const sessionUpdated = updateMatchingOnboardSession(
    sandboxName,
    provider,
    model,
    patched.route,
    effectiveRegistryMetadata,
    deps,
  );

  return finalizeInferenceMutation(
    {
      agentName,
      configChanged: patched.changed,
      nextApi: patched.route.inferenceApi,
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
      },
    },
    deps,
  );
}

export async function runInferenceSet(
  options: InferenceSetOptions,
  deps: InferenceSetDeps = defaultDeps(),
): Promise<InferenceSetResult> {
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
  deps.prepareRunOpenshell();
  return withSandboxMutationLock(selected.sandboxName, async () => {
    const lockedSelection = resolveTargetSandbox(selected.sandboxName, deps);
    const gatewayName = resolveSandboxGatewayName(lockedSelection.entry);
    const mutation = await deps.withGatewayRouteMutationLock(gatewayName, () =>
      withTimerBoundShieldsMutationLockAsync(selected.sandboxName, "inference set", () =>
        runInferenceSetWithoutHostLock(
          { ...options, sandboxName: selected.sandboxName },
          deps,
          gatewayName,
        ),
      ),
    );
    // Release the config transition lock before the managed restart reacquires
    // it, but retain the outer sandbox lifecycle lock so another process cannot
    // destroy/recreate this name between the committed write and restart.
    completeInferenceGatewayRestart(mutation, deps);
    return mutation.result;
  });
}
