// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellOptions, CaptureOpenshellResult } from "../adapters/openshell/client";
import { captureOpenshell, getOpenshellBinary } from "../adapters/openshell/runtime";
import { CLI_NAME } from "../cli/branding";
import { HERMES_PROXY_API_KEY_PLACEHOLDER } from "../hermes-proxy-api-key";
import {
  getProviderSelectionConfig,
  getSandboxInferenceConfig,
  type SandboxInferenceConfig,
} from "../inference/config";
import { resolveContextWindowForModel } from "../inference/context-window";
import { type ValidationResult, validateLocalProvider } from "../inference/local";
import { inferenceSelectionRegistryFields } from "../inference/selection";
import { ensureLocalProviderReachable } from "../onboard/local-inference-topology";
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
import * as onboardSession from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
import { isSafeModelId } from "../validation";
import { hermesApiMode, resolveRuntimeInferenceApi } from "./inference-route-api";
import { InferenceSetError, OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER } from "./inference-set-error";
import { buildInferenceSetFailure } from "./inference-set-provider-diagnostics";

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

export interface InferenceSetDeps {
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
  appendAuditEntry: typeof appendAuditEntry;
  log: (message: string) => void;
  isLocalInferenceProvider: (provider: string) => boolean;
  validateLocalProvider: (provider: string) => ValidationResult;
  ensureLocalProviderReachable: (provider: string) => boolean;
  resolveContextWindowForModel: (provider: string, model: string) => number | null;
  isSandboxConfigMutable: (sandboxName: string) => boolean;
  rewriteConfigUrlsWithDnsPinning: (value: ConfigValue) => Promise<ConfigValue>;
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
    return {
      sandboxName: explicitName,
      entry,
      agentName: normalizeSandboxAgent(entry.agent),
    };
  }

  if (normalizeSandboxAgent(deps.getRequestedAgent()) === "hermes") {
    const hermesSandboxes = deps
      .listSandboxes()
      .sandboxes.filter((entry) => normalizeSandboxAgent(entry.agent) === "hermes");
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
}

function buildProviderConfig(
  existing: ConfigObject,
  model: string,
  route: SandboxInferenceConfig,
  contextWindow?: number,
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

  updateAgentPrimary(config, route.primaryModelRef);

  const models = ensureObject(config, "models");
  models.mode = "merge";
  const providers = ensureObject(models, "providers");
  const existingProvider = cloneConfigObject(providers[route.providerKey]);
  providers[route.providerKey] = buildProviderConfig(existingProvider, model, route, contextWindow);

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
  provider: string;
  model: string;
  noVerify?: boolean;
}): string[] {
  const args = [
    "inference",
    "set",
    "-g",
    "nemoclaw",
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

type RegistryInferenceMetadata = Pick<
  SandboxEntry,
  "endpointUrl" | "credentialEnv" | "preferredInferenceApi" | "nimContainer"
>;

const CUSTOM_COMPATIBLE_CREDENTIAL_ENV: Record<string, string> = {
  "compatible-endpoint": "COMPATIBLE_API_KEY",
  "compatible-anthropic-endpoint": "COMPATIBLE_ANTHROPIC_API_KEY",
};

const INFERENCE_SET_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
]);

function isCustomCompatibleProvider(provider: string): boolean {
  return provider === "compatible-endpoint" || provider === "compatible-anthropic-endpoint";
}

function hasExplicitCustomMetadata(options: InferenceSetOptions): boolean {
  return Boolean(options.endpointUrl || options.credentialEnv || options.inferenceApi);
}

// TRUST BOUNDARY: host.openshell.internal is the single sandbox-to-host bridge
// hostname provisioned by OpenShell. It resolves to the Docker host gateway
// only inside the sandbox network namespace. This exemption is intentionally
// limited below to HTTP, an explicit unprivileged port, and the exact hostname;
// do not extend it to HTTPS, wildcard subdomains, localhost, RFC1918 literals,
// or other internal DNS names.
const ALLOWED_PRIVATE_CUSTOM_ENDPOINT_HOSTS = new Set(["host.openshell.internal"]);

function normalizeEndpointUrlShape(value: string): { url: URL; normalized: string } {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("unsupported URL shape");
  }
  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname || "/";
  return {
    url,
    normalized: url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`,
  };
}

export async function normalizeCustomEndpointUrl(
  value: string | null | undefined,
  rewriteUrlWithDnsPinning: InferenceSetDeps["rewriteConfigUrlsWithDnsPinning"],
): Promise<string> {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw)
    throw new InferenceSetError("endpoint-url is required for custom-compatible metadata.", 2);
  let shaped: { url: URL; normalized: string };
  try {
    shaped = normalizeEndpointUrlShape(raw);
  } catch {
    throw new InferenceSetError(
      "endpoint-url must be a valid http(s) URL without embedded credentials.",
      2,
    );
  }

  const hostname = shaped.url.hostname.replace(/\.$/, "").toLowerCase();
  const port = Number(shaped.url.port);
  if (
    ALLOWED_PRIVATE_CUSTOM_ENDPOINT_HOSTS.has(hostname) &&
    shaped.url.protocol === "http:" &&
    Number.isInteger(port) &&
    port >= 1024
  ) {
    // This is the single sandbox-to-host bridge name that NemoClaw itself
    // provisions for local inference. Its supported routes are explicit
    // unprivileged HTTP listeners; do not generalize this exemption to HTTPS,
    // default/privileged ports, localhost, RFC1918 addresses, or arbitrary
    // internal DNS names.
    return shaped.normalized;
  }

  try {
    const validated = await rewriteUrlWithDnsPinning(shaped.normalized);
    if (typeof validated !== "string") throw new Error("URL validator returned a non-string value");
    return normalizeEndpointUrlShape(validated).normalized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InferenceSetError(`endpoint-url is not allowed: ${message}`, 2);
  }
}

function normalizeExplicitCredentialEnv(
  provider: string,
  value: string | null | undefined,
): string {
  const expected = CUSTOM_COMPATIBLE_CREDENTIAL_ENV[provider];
  const normalized = typeof value === "string" && value.trim() ? value.trim() : expected;
  if (normalized !== expected) {
    throw new InferenceSetError(
      `credential-env for '${provider}' must be '${expected}' so rebuild can safely reuse it.`,
      2,
    );
  }
  return normalized;
}

function allowedExplicitInferenceApis(provider: string): string[] {
  return provider === "compatible-endpoint"
    ? ["openai-completions", "openai-responses"]
    : Array.from(INFERENCE_SET_APIS);
}

function normalizeExplicitInferenceApi(
  provider: string,
  value: string | null | undefined,
): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return null;
  const allowed = allowedExplicitInferenceApis(provider);
  if (!allowed.includes(normalized)) {
    throw new InferenceSetError(
      `inference-api for '${provider}' must be one of: ${allowed.join(", ")}.`,
      2,
    );
  }
  return normalized;
}

async function explicitCustomProviderMetadata(
  provider: string,
  options: InferenceSetOptions,
  rewriteUrlWithDnsPinning: InferenceSetDeps["rewriteConfigUrlsWithDnsPinning"],
): Promise<RegistryInferenceMetadata | null> {
  if (!hasExplicitCustomMetadata(options)) return null;
  if (!isCustomCompatibleProvider(provider)) {
    throw new InferenceSetError(
      "endpoint-url, credential-env, and inference-api are only supported for compatible-endpoint and compatible-anthropic-endpoint.",
      2,
    );
  }

  // Source boundary: custom-compatible endpoint URLs are operator-supplied and
  // not discoverable from the gateway provider registry with a sandbox-scoped
  // trust guarantee. Treat these explicit flags as the durable metadata source
  // for this switch, after URL and credential-env validation, instead of
  // borrowing from an unrelated onboard session or global OpenShell provider.
  return {
    endpointUrl: await normalizeCustomEndpointUrl(options.endpointUrl, rewriteUrlWithDnsPinning),
    credentialEnv: normalizeExplicitCredentialEnv(provider, options.credentialEnv),
    preferredInferenceApi: normalizeExplicitInferenceApi(provider, options.inferenceApi),
    nimContainer: null,
  };
}

function matchingSessionMetadata(options: {
  session: onboardSession.Session | null;
  sandboxName: string;
  provider: string;
  model: string;
}): RegistryInferenceMetadata | null {
  const { session, sandboxName, provider, model } = options;
  if (
    session?.sandboxName !== sandboxName ||
    session.provider !== provider ||
    session.model !== model ||
    !session.endpointUrl
  ) {
    return null;
  }
  return {
    endpointUrl: session.endpointUrl,
    credentialEnv: session.credentialEnv ?? null,
    preferredInferenceApi: session.preferredInferenceApi ?? null,
    nimContainer: session.nimContainer ?? null,
  };
}

function registryMetadataForProviderSwitch(options: {
  entry: SandboxEntry;
  provider: string;
  model: string;
  sandboxName: string;
  session: onboardSession.Session | null;
  explicitMetadata: RegistryInferenceMetadata | null;
}): RegistryInferenceMetadata {
  const { entry, provider, model, sandboxName, session, explicitMetadata } = options;
  if (explicitMetadata) return explicitMetadata;
  if (entry.provider === provider) {
    return {
      endpointUrl: entry.endpointUrl ?? null,
      credentialEnv: entry.credentialEnv ?? null,
      preferredInferenceApi: entry.preferredInferenceApi ?? null,
      nimContainer: entry.nimContainer ?? null,
    };
  }
  const sessionMetadata = matchingSessionMetadata({ session, sandboxName, provider, model });
  if (sessionMetadata) return sessionMetadata;
  if (isCustomCompatibleProvider(provider)) {
    throw new InferenceSetError(
      `Cannot switch sandbox '${sandboxName}' to '${provider}' without trusted durable endpoint metadata. ` +
        `Re-run onboarding for this custom endpoint or restore a matching onboard session before using inference set.`,
      2,
    );
  }
  return {
    endpointUrl: null,
    credentialEnv: null,
    preferredInferenceApi: null,
    nimContainer: null,
  };
}

async function runInferenceSetWithoutHostLock(
  options: InferenceSetOptions,
  deps: InferenceSetDeps = defaultDeps(),
): Promise<InferenceSetResult> {
  const provider = trimRequired(options.provider, "provider");
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
    throw new InferenceSetError(
      `nemoclaw inference set supports OpenClaw and Hermes sandboxes; '${sandboxName}' uses '${agentName}'.`,
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
  const session = deps.loadSession();
  const explicitMetadata = await explicitCustomProviderMetadata(
    provider,
    options,
    deps.rewriteConfigUrlsWithDnsPinning,
  );
  const explicitPreferredInferenceApi = explicitMetadata?.preferredInferenceApi ?? null;
  const registryMetadata = registryMetadataForProviderSwitch({
    entry,
    provider,
    model,
    sandboxName,
    session,
    explicitMetadata,
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

  deps.log(`  Setting OpenShell inference route: ${provider} / ${model}`);
  const setResult = deps.captureOpenshell(
    openshellInferenceSetArgs({ provider, model, noVerify: effectiveNoVerify }),
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
    !deps.updateSandbox(sandboxName, registryFields(registryMetadata.preferredInferenceApi ?? null))
  ) {
    throw new InferenceSetError(`Failed to update NemoClaw registry for sandbox '${sandboxName}'.`);
  }

  const config = deps.readSandboxConfig(sandboxName, target);
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

  deps.appendAuditEntry({
    action: "inference_set",
    sandbox: sandboxName,
    timestamp: new Date().toISOString(),
    reason: `inference set ${agentName}:${provider}:${model}${
      inSandboxConfigSynced ? "" : " (in-sandbox sync incomplete)"
    }`,
  });

  // Only claim "synced" when the in-sandbox layer actually synced; otherwise the
  // warning above already described the degraded state.
  if (inSandboxConfigSynced) {
    deps.log(
      agentName === "hermes"
        ? `  Inference route synced for '${sandboxName}': ${model}`
        : `  Inference route synced for '${sandboxName}': ${patched.route.primaryModelRef}`,
    );
  }

  return {
    sandboxName,
    provider,
    model,
    primaryModelRef: patched.route.primaryModelRef,
    providerKey: patched.route.providerKey,
    configChanged: patched.changed,
    sessionUpdated,
    inSandboxConfigSynced,
  };
}

export async function runInferenceSet(
  options: InferenceSetOptions,
  deps: InferenceSetDeps = defaultDeps(),
): Promise<InferenceSetResult> {
  // Resolve once before acquiring so a default-sandbox change cannot make the
  // protected callback mutate a different sandbox from the one whose lock we
  // hold. Prime the default OpenShell runner before acquiring too: its legacy
  // missing-binary path exits the process, which cannot be deferred safely by
  // an async lock. The inner resolution still validates the live registry entry.
  const selected = resolveTargetSandbox(options.sandboxName, deps);
  deps.prepareRunOpenshell();
  return withTimerBoundShieldsMutationLockAsync(selected.sandboxName, "inference set", () =>
    runInferenceSetWithoutHostLock({ ...options, sandboxName: selected.sandboxName }, deps),
  );
}
