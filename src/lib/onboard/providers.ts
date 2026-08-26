// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Provider metadata, lookup helpers, and gateway provider CRUD.

const { redact, ROOT } = require("../runner");
const { normalizeCredentialValue, getCredential } = require("../credentials/store");
const {
  DEFAULT_CLOUD_MODEL,
  DEFAULT_HERMES_PROVIDER_MODEL,
  OLLAMA_LOCAL_CREDENTIAL_ENV,
  VLLM_LOCAL_CREDENTIAL_ENV,
  getSandboxInferenceConfig,
} = require("../inference/config");
const openrouter = require("../inference/openrouter");
const { isSafeModelId } = require("../validation");
const { compactText } = require("../core/url-utils");
const {
  LLAMA_CPP_CREDENTIAL_ENV,
  LLAMA_CPP_HOST_OPENAI_BASE_URL,
  LLAMA_CPP_PROVIDER_NAME,
} = require("../inference/llama-cpp/contract");
const {
  inspectGatewayCredentialOnlyProviderBinding,
  matchesGatewayCredentialOnlyProviderBinding,
  readGatewayProviderMetadata,
} = require("./gateway-provider-metadata");
const {
  ensureMessagingCredentialProviderProfile,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} = require("../messaging/provider-profile");

const MESSAGING_PROVIDER_BINDING_CONFLICT = "NEMOCLAW_MESSAGING_PROVIDER_BINDING_CONFLICT";

class MessagingProviderBindingConflictError extends Error {
  constructor(message, mutatedProviderNames = []) {
    super(message);
    this.name = "MessagingProviderBindingConflictError";
    this.code = MESSAGING_PROVIDER_BINDING_CONFLICT;
    this.mutatedProviderNames = mutatedProviderNames;
  }
}

function isMessagingProviderBindingConflict(error) {
  return error instanceof Error && error.code === MESSAGING_PROVIDER_BINDING_CONFLICT;
}

function attachMutatedProviderNames(error, names) {
  if (names.length === 0) return error;
  const failure = error instanceof Error ? error : new Error(String(error));
  const existing = Array.isArray(failure.mutatedProviderNames) ? failure.mutatedProviderNames : [];
  failure.mutatedProviderNames = [...new Set([...existing, ...names])];
  const providerNames = failure.mutatedProviderNames.map((name) => JSON.stringify(name)).join(", ");
  const diagnostic = `Provider registration changed gateway state for ${providerNames} before the operation stopped. Inspect those providers before retrying.`;
  if (!failure.message.includes(diagnostic)) failure.message = `${failure.message} ${diagnostic}`;
  return failure;
}

// ── Constants ────────────────────────────────────────────────────

const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const OPENAI_ENDPOINT_URL = "https://api.openai.com/v1";
const ANTHROPIC_ENDPOINT_URL = "https://api.anthropic.com";
const GEMINI_ENDPOINT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const HERMES_INFERENCE_ENDPOINT_URL = "https://inference-api.nousresearch.com/v1";
const HOSTED_INFERENCE_SOURCE_ENV = "NVIDIA_INFERENCE_API_KEY";
const HOSTED_INFERENCE_PROVIDER_KEY_ENV = "NEMOCLAW_PROVIDER_KEY";
const HOSTED_INFERENCE_CREDENTIAL_ENV = "COMPATIBLE_API_KEY";
const HOSTED_INFERENCE_ENDPOINT_URL = "https://inference-api.nvidia.com/v1";
const MODEL_ENV = "NEMOCLAW_MODEL";
// Compatibility for the NVIDIA QA non-interactive Ollama invocation tracked
// in #6869. Remove after that workflow migrates to NEMOCLAW_MODEL.
const PROVIDER_MODEL_ENV = "NEMOCLAW_PROVIDER_MODEL";
// Private CI-compatible Inference Hub endpoint model IDs use the
// provider/namespace/model convention. This endpoint is staged as a custom
// OpenAI-compatible provider, not as the public build.nvidia.com provider.
const HOSTED_INFERENCE_MODEL = "nvidia/nvidia/nemotron-3-ultra";
const NON_INTERACTIVE_PROVIDER_ALIASES = {
  cloud: "build",
  nim: "nim-local",
  vllm: "vllm",
  "open-router": "openrouter",
  openrouterai: "openrouter",
  anthropiccompatible: "anthropicCompatible",
  hermes: "hermesProvider",
  "hermes-provider": "hermesProvider",
  hermesprovider: "hermesProvider",
  nous: "hermesProvider",
  "nous-portal": "hermesProvider",
};
const NON_INTERACTIVE_PROVIDER_KEYS = new Set([
  "build",
  "openrouter",
  "openai",
  "anthropic",
  "anthropicCompatible",
  "gemini",
  "hermesProvider",
  "ollama",
  "llama-cpp",
  "install-llama-cpp",
  "custom",
  "nim-local",
  "vllm",
  "routed",
  "install-vllm",
  "install-ollama",
  "install-windows-ollama",
  "start-windows-ollama",
]);
const NON_INTERACTIVE_PROVIDER_VALID_VALUES =
  "Valid values: build, openrouter, openai, anthropic, anthropicCompatible, gemini, hermes-provider, ollama, llama-cpp, install-llama-cpp, custom, nim-local, vllm, routed, install-vllm, install-ollama, install-windows-ollama, start-windows-ollama";
const PROVIDER_KEY_ROUTE_VALUES = new Set(
  [
    "inference",
    ...Object.keys(NON_INTERACTIVE_PROVIDER_ALIASES),
    ...Array.from(NON_INTERACTIVE_PROVIDER_KEYS),
  ].map((value) => value.toLowerCase()),
);

const REMOTE_PROVIDER_CONFIG = {
  build: {
    label: "NVIDIA Endpoints",
    providerName: "nvidia-prod",
    providerType: "nvidia",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    endpointUrl: BUILD_ENDPOINT_URL,
    helpUrl: "https://build.nvidia.com/settings/api-keys",
    modelMode: "catalog",
    defaultModel: DEFAULT_CLOUD_MODEL,
    skipVerify: true,
  },
  openrouter: {
    label: "OpenRouter",
    providerName: openrouter.OPENROUTER_PROVIDER_NAME,
    providerType: openrouter.OPENROUTER_PROVIDER_TYPE,
    credentialEnv: openrouter.OPENROUTER_CREDENTIAL_ENV,
    endpointUrl: openrouter.OPENROUTER_ENDPOINT_URL,
    helpUrl: openrouter.OPENROUTER_HELP_URL,
    modelMode: "catalog",
    defaultModel: DEFAULT_CLOUD_MODEL,
    skipVerify: true,
  },
  openai: {
    label: "OpenAI",
    providerName: "openai-api",
    providerType: "openai",
    credentialEnv: "OPENAI_API_KEY",
    endpointUrl: OPENAI_ENDPOINT_URL,
    helpUrl: "https://platform.openai.com/api-keys",
    modelMode: "curated",
    defaultModel: "gpt-5.4",
    skipVerify: true,
  },
  anthropic: {
    label: "Anthropic",
    providerName: "anthropic-prod",
    providerType: "anthropic",
    credentialEnv: "ANTHROPIC_API_KEY",
    endpointUrl: ANTHROPIC_ENDPOINT_URL,
    helpUrl: "https://console.anthropic.com/settings/keys",
    modelMode: "curated",
    defaultModel: "claude-sonnet-4-6",
  },
  anthropicCompatible: {
    label: "Other Anthropic-compatible endpoint",
    providerName: "compatible-anthropic-endpoint",
    providerType: "anthropic",
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    endpointUrl: "",
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
  },
  gemini: {
    label: "Google Gemini",
    providerName: "gemini-api",
    providerType: "openai",
    credentialEnv: "GEMINI_API_KEY",
    endpointUrl: GEMINI_ENDPOINT_URL,
    helpUrl: "https://aistudio.google.com/app/apikey",
    modelMode: "curated",
    defaultModel: "gemini-3.6-flash",
    skipVerify: true,
  },
  // Hermes Provider is a single menu entry by design: every model family it
  // serves (Moonshot, Z-AI, MiniMax, Qwen, Xiaomi, Tencent, StepFun, xAI,
  // Arcee) routes through the same Nous portal endpoint and the same
  // credential. After this entry is selected, the model picker lists the
  // family options via nousModels.getHermesProviderModelOptions(). The label
  // names all nine families so QA scripts and operators can discover them
  // without first selecting the entry.
  hermesProvider: {
    label: "Hermes Provider (Moonshot, Z-AI, MiniMax, Qwen, Xiaomi, Tencent, StepFun, xAI, Arcee)",
    providerName: "hermes-provider",
    providerType: "openai",
    credentialEnv: "OPENAI_API_KEY",
    endpointUrl: HERMES_INFERENCE_ENDPOINT_URL,
    helpUrl: "https://portal.nousresearch.com/manage-subscription",
    modelMode: "curated",
    defaultModel: DEFAULT_HERMES_PROVIDER_MODEL,
    skipVerify: true,
  },
  custom: {
    label: "Other OpenAI-compatible endpoint",
    providerName: "compatible-endpoint",
    providerType: "openai",
    credentialEnv: "COMPATIBLE_API_KEY",
    endpointUrl: "",
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
    skipVerify: true,
  },
  "llama-cpp": {
    label: "Local llama.cpp",
    providerName: LLAMA_CPP_PROVIDER_NAME,
    providerType: "openai",
    credentialEnv: LLAMA_CPP_CREDENTIAL_ENV,
    endpointUrl: LLAMA_CPP_HOST_OPENAI_BASE_URL,
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
    skipVerify: true,
  },
};

// Providers that run on the host and need the local-inference policy preset.
const LOCAL_INFERENCE_PROVIDERS = ["ollama-local", "vllm-local"];
// Host-endpoint providers that need the declarative local-inference network policy.
// Keep this separate from LOCAL_INFERENCE_PROVIDERS: llama.cpp is operator-owned,
// credential-bearing, endpoint-bearing, and must never enter managed lifecycle paths.
const LOCAL_INFERENCE_POLICY_PROVIDERS = [...LOCAL_INFERENCE_PROVIDERS, "llama-cpp-local"];

// Re-exported alias matching the existing onboard.ts call sites. The canonical
// definitions live in inference-config.ts so that getProviderSelectionConfig
// (which writes the sandbox-side config) and the gateway-registration path
// here stay in sync. See GH #2519.
const OLLAMA_PROXY_CREDENTIAL_ENV = OLLAMA_LOCAL_CREDENTIAL_ENV;

const DISCORD_SNOWFLAKE_RE = /^[0-9]{17,19}$/;

// ── Provider label ───────────────────────────────────────────────

/**
 * Human-readable label for a provider name.
 * Consolidates the scattered if/else chains (printDashboard, etc.).
 */
function getProviderLabel(provider) {
  for (const cfg of Object.values(REMOTE_PROVIDER_CONFIG)) {
    if (cfg.providerName === provider) return cfg.label;
  }
  switch (provider) {
    case "nvidia-nim":
      return "NVIDIA Endpoints";
    case "nvidia-router":
      return "Model Router";
    case "vllm-local":
      return "Local vLLM";
    case "ollama-local":
      return "Local Ollama";
    case "llama-cpp-local":
      return "Local llama.cpp";
    default:
      return provider;
  }
}

// ── Provider name resolution ─────────────────────────────────────

function getEffectiveProviderName(providerKey) {
  if (!providerKey) return null;
  if (REMOTE_PROVIDER_CONFIG[providerKey]) {
    return REMOTE_PROVIDER_CONFIG[providerKey].providerName;
  }
  switch (providerKey) {
    case "nim-local":
      return "nvidia-nim";
    case "ollama":
      return "ollama-local";
    case "vllm":
      return "vllm-local";
    case "llama-cpp":
      return "llama-cpp-local";
    case "routed":
      return "nvidia-router";
    default:
      return providerKey;
  }
}

// ── Non-interactive helpers ──────────────────────────────────────

function getNonInteractiveProvider(allowHostedInferenceStaging = true) {
  if (allowHostedInferenceStaging) stageHostedInferenceSourceSecretEnv();
  const providerKey = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  if (!providerKey) return null;
  const normalized = NON_INTERACTIVE_PROVIDER_ALIASES[providerKey] || providerKey;
  if (!NON_INTERACTIVE_PROVIDER_KEYS.has(normalized)) {
    console.error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
    console.error(`  ${NON_INTERACTIVE_PROVIDER_VALID_VALUES}`);
    process.exit(1);
  }
  return normalized;
}

function stageHostedInferenceSourceSecretEnv() {
  const agentName = (process.env.NEMOCLAW_AGENT || "").trim().toLowerCase();
  let providerKeySource = "";
  if (agentName === "langchain-deepagents-code") {
    const rawProviderKeySource = normalizeCredentialValue(
      // check-direct-credential-env-ignore -- Deep Agents provider-key alias is immediately route-filtered and restaged as COMPATIBLE_API_KEY.
      process.env[HOSTED_INFERENCE_PROVIDER_KEY_ENV] ?? "",
    );
    // Deep Agents contract: NEMOCLAW_PROVIDER_KEY is a permanent
    // hosted-compatible credential alias for langchain-deepagents-code only.
    // It repairs the external env contract where older automation supplied
    // the hosted credential through the provider-key slot; selector-like
    // values remain source-of-truth provider choices and are rejected by the
    // invariant tied to NON_INTERACTIVE_PROVIDER_* below.
    providerKeySource = isHostedInferenceProviderKeyCredentialCandidate(rawProviderKeySource)
      ? rawProviderKeySource
      : "";
  }
  const hostedInferenceSourceKey = normalizeCredentialValue(
    // check-direct-credential-env-ignore -- hosted inference staging migrates this source env into COMPATIBLE_API_KEY.
    process.env[HOSTED_INFERENCE_SOURCE_ENV] ?? "",
  );
  const sourceKey = hostedInferenceSourceKey || providerKeySource;
  if (!sourceKey) return false;

  const rawProvider = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  const normalizedProvider = NON_INTERACTIVE_PROVIDER_ALIASES[rawProvider] || rawProvider;
  const hostedFlag = (process.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE || "").trim() === "1";
  const compatibleKey = normalizeCredentialValue(
    // check-direct-credential-env-ignore -- read-only guard to avoid overwriting an explicit compatible endpoint key.
    process.env[HOSTED_INFERENCE_CREDENTIAL_ENV] ?? "",
  );
  const explicitHostedCustom =
    normalizedProvider === "custom" &&
    (hostedFlag || (!compatibleKey && !sourceKey.startsWith("nvapi-")));
  const implicitHostedCustom =
    !normalizedProvider && (hostedFlag || !sourceKey.startsWith("nvapi-"));
  const shouldStage = explicitHostedCustom || implicitHostedCustom;

  if (!shouldStage) return false;

  if (!normalizedProvider) {
    process.env.NEMOCLAW_PROVIDER = "custom";
  }
  process.env.NEMOCLAW_ENDPOINT_URL =
    (process.env.NEMOCLAW_ENDPOINT_URL || "").trim() || HOSTED_INFERENCE_ENDPOINT_URL;
  const model =
    getRequestedModelFromEnv() ||
    (process.env.NEMOCLAW_COMPAT_MODEL || "").trim() ||
    (process.env.NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL || "").trim() ||
    HOSTED_INFERENCE_MODEL;
  process.env[MODEL_ENV] = model;
  process.env.NEMOCLAW_COMPAT_MODEL = (process.env.NEMOCLAW_COMPAT_MODEL || "").trim() || model;
  process.env.NEMOCLAW_PREFERRED_API =
    (process.env.NEMOCLAW_PREFERRED_API || "").trim() || "openai-completions";
  process.env[HOSTED_INFERENCE_CREDENTIAL_ENV] = sourceKey;
  return true;
}

function isHostedInferenceProviderKeyCredentialCandidate(value) {
  if (!value) return false;
  return !PROVIDER_KEY_ROUTE_VALUES.has(value.trim().toLowerCase());
}

const isProviderKeyCredentialCandidate = isHostedInferenceProviderKeyCredentialCandidate;

/**
 * Resolve the requested model from the preferred env var or its compatibility fallback.
 */
function getRequestedModelEnv(env = process.env, options = {}) {
  const model = (env[MODEL_ENV] || "").trim();
  if (model) return { value: model, source: MODEL_ENV };
  if (options.allowProviderModelFallback === false) return { value: "", source: null };
  const providerModel = (env[PROVIDER_MODEL_ENV] || "").trim();
  if (providerModel) return { value: providerModel, source: PROVIDER_MODEL_ENV };
  return { value: "", source: null };
}

/**
 * Return the requested model value without exposing which env var supplied it.
 */
function getRequestedModelFromEnv(env = process.env) {
  return getRequestedModelEnv(env).value || null;
}

function getNonInteractiveModel(providerKey, options = {}) {
  const { value: model, source } = getRequestedModelEnv(process.env, options);
  if (!model) return null;
  if (!isSafeModelId(model)) {
    console.error(`  Invalid ${source || MODEL_ENV} for provider '${providerKey}': ${model}`);
    console.error("  Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.");
    process.exit(1);
  }
  return model;
}

// No default for nonInteractive — onboard.ts wrapper supplies isNonInteractive().
function getRequestedProviderHint(nonInteractive, allowHostedInferenceStaging = true) {
  return nonInteractive ? getNonInteractiveProvider(allowHostedInferenceStaging) : null;
}

function getRequestedModelHint(nonInteractive, allowHostedInferenceStaging = true) {
  if (!nonInteractive) return null;
  const providerKey =
    getRequestedProviderHint(nonInteractive, allowHostedInferenceStaging) || "cloud";
  return getNonInteractiveModel(providerKey);
}

// ── Gateway provider CRUD ────────────────────────────────────────
// Functions that call runOpenshell accept it as the last parameter
// to avoid a circular dependency with onboard.ts.

/**
 * Build the argument array for an `openshell provider create` or `update` command.
 * @param {"create"|"update"} action - Whether to create or update.
 * @param {string} name - Provider name.
 * @param {string} type - Provider type (for example, "openai" or "nemoclaw-mcp-v1").
 * @param {string} credentialEnv - Credential environment variable name.
 * @param {string|null} baseUrl - Optional base URL for API-compatible endpoints.
 * @param {{ includeCredential?: boolean }} [opts] - When `includeCredential` is
 *   false, the `--credential` flag is omitted from the args. Used on the
 *   `provider update` path when the host env does not carry the credential and
 *   the gateway already holds it (no rotation needed). OpenShell's CLI rejects
 *   `--credential KEY` when the local env var is empty, so passing the flag
 *   would fail before reaching the gateway.
 * @returns {string[]} Argument array for runOpenshell().
 */
function buildProviderArgs(action, name, type, credentialEnv, baseUrl, opts = {}) {
  const { includeCredential = true } = opts;
  const args =
    action === "create"
      ? ["provider", "create", "--name", name, "--type", type]
      : ["provider", "update", name];
  if (includeCredential) {
    args.push("--credential", credentialEnv);
  }
  if (baseUrl && type === "openai") {
    args.push("--config", `OPENAI_BASE_URL=${baseUrl}`);
  } else if (baseUrl && type === "anthropic") {
    args.push("--config", `ANTHROPIC_BASE_URL=${baseUrl}`);
  }
  return args;
}

/**
 * Check whether an OpenShell provider exists in the gateway.
 *
 * Queries the gateway-level provider registry via `openshell provider get`.
 * Does NOT verify that the provider is attached to a specific sandbox —
 * OpenShell CLI does not currently expose a sandbox-scoped provider query.
 * @param {string} name - Provider name to look up (e.g. "discord-bridge").
 * @param {Function} _runOpenshell - Injected runOpenshell from onboard.ts.
 * @returns {boolean} True if the provider exists in the gateway.
 */
function providerExistsInGateway(name, _runOpenshell) {
  const result = _runOpenshell(["provider", "get", name], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

/**
 * Recheck the caller's policy receipt immediately before each OpenShell
 * provider command. Commands in one provider operation can be separated by
 * probes and recovery work, so one outer check is not sufficient.
 * @param {Function} runOpenshell
 * @param {((operation: string) => void)|undefined} revalidatePolicyRequirements
 * @param {string} operation
 * @returns {Function}
 */
function policyAuthorityCheckedRunner(runOpenshell, revalidatePolicyRequirements, operation) {
  if (!revalidatePolicyRequirements) return runOpenshell;
  return (...args) => {
    revalidatePolicyRequirements(operation);
    return runOpenshell(...args);
  };
}

/**
 * Create or update an OpenShell provider in the gateway.
 *
 * Checks whether the provider already exists via `openshell provider get`;
 * uses `create` for new providers and `update` for existing ones. When
 * `options.replaceExisting` is true an existing provider is deleted and
 * recreated instead of updated. This is required for provider-type changes that
 * `provider update` cannot apply (e.g. the Brave Search migration from the
 * legacy `generic` type to the `brave` profile). The caller must guarantee
 * the provider is detached from any live sandbox before opting in: OpenShell
 * rejects `provider delete` on attached providers.
 * @param {string} name - Provider name (e.g. "discord-bridge", "inference").
 * @param {string} type - Provider type (for example, "openai", "brave", or "nemoclaw-mcp-v1").
 * @param {string} credentialEnv - Environment variable name for the credential.
 * @param {string|null} baseUrl - Optional base URL for the provider endpoint.
 * @param {Record<string, string>} env - Environment variables for the openshell command.
 * @param {Function} _runOpenshell - Injected runOpenshell from onboard.ts.
 * @param {{replaceExisting?: boolean, knownExists?: boolean, allowedSandboxes?: readonly string[], requireExactBinding?: boolean, revalidatePolicyRequirements?: (operation: string) => void}} options - Optional replacement controls.
 * @returns {{ ok: boolean, status?: number, message?: string, reason?: string }}
 */
function upsertProvider(name, type, credentialEnv, baseUrl, env, _runOpenshell, options = {}) {
  const runOpenshell = policyAuthorityCheckedRunner(
    _runOpenshell,
    options.revalidatePolicyRequirements,
    `inspect or change provider ${JSON.stringify(name)}`,
  );
  const exists = options.knownExists ?? providerExistsInGateway(name, runOpenshell);
  if (
    exists &&
    options.requireExactBinding &&
    !options.replaceExisting &&
    !matchesGatewayCredentialOnlyProviderBinding(readGatewayProviderMetadata(name, runOpenshell), {
      name,
      type,
      credentialKey: credentialEnv,
    })
  ) {
    return {
      ok: false,
      status: 1,
      reason: "binding-conflict",
      message: `Existing provider '${name}' does not match the required '${type}' credential binding.`,
    };
  }
  if (exists && options.replaceExisting) {
    const { deleteProviderWithRecovery } = require("./sandbox-provider-cleanup");
    const r = deleteProviderWithRecovery(name, {
      runOpenshell,
      allowedSandboxes: options.allowedSandboxes,
    });
    if (!r.ok) {
      const base =
        compactText(redact(r.stderr)) ||
        compactText(redact(r.stdout)) ||
        `Failed to replace provider '${name}'.`;
      const detail =
        r.recoveryFailures.length > 0
          ? ` (detach failures: ${r.recoveryFailures.map((f) => `${f.sandbox}: ${compactText(redact(f.output))}`).join("; ")})`
          : "";
      return { ok: false, status: r.status || 1, message: `${base}${detail}` };
    }
  }
  const action = exists && !options.replaceExisting ? "update" : "create";
  // On the update path, the OpenShell CLI's `--credential KEY` form reads the
  // value from the host env and aborts when empty. If the caller did not stage
  // a credential value (rebuild after `channels add` with the original env
  // unset), drop the flag so `provider update` becomes a no-op merge — the
  // gateway already holds the secret.
  const credentialValueAvailable =
    !!credentialEnv && typeof env[credentialEnv] === "string" && env[credentialEnv].length > 0;
  const includeCredential = action === "create" || credentialValueAvailable;
  const args = buildProviderArgs(action, name, type, credentialEnv, baseUrl, { includeCredential });
  const runOpts = { ignoreError: true, env, stdio: ["ignore", "pipe", "pipe"] };
  const result = runOpenshell(args, runOpts);
  if (result.status !== 0) {
    const output =
      compactText(redact(`${result.stderr || ""}`)) ||
      compactText(redact(`${result.stdout || ""}`)) ||
      `Failed to ${action} provider '${name}'.`;
    return { ok: false, status: result.status || 1, message: output };
  }
  return { ok: true };
}

function preflightMessagingProviderBindings(tokenDefs, _runOpenshell) {
  const failures = [];
  for (const { name, envKey, token, providerType } of tokenDefs) {
    if (!token || !providerType || !providerExistsInGateway(name, _runOpenshell)) continue;
    const matches = matchesGatewayCredentialOnlyProviderBinding(
      readGatewayProviderMetadata(name, _runOpenshell),
      { name, type: providerType, credentialKey: envKey },
    );
    if (matches) continue;
    failures.push({
      name,
      message: `Existing provider '${name}' does not match the required '${providerType}' credential binding.`,
    });
  }
  return failures;
}

/**
 * Upsert all messaging providers that have tokens configured.
 * Returns the list of provider names that were successfully created/updated.
 * Exits the process if any upsert fails unless `options.bestEffort` is true.
 *
 * Pass `options.replaceExisting` true only when every entry is guaranteed
 * detached from any live sandbox (post-sandbox-delete on the recreate path);
 * reuse paths must omit it because `provider delete` fails for attached
 * providers. Pass `options.bestEffort` only from rollback paths that must
 * continue restoring registry state and report residual gateway work instead
 * of terminating the CLI.
 * @param {Array<{name: string, envKey: string, token: string|null, providerType?: string}>} tokenDefs
 * @param {Function} _runOpenshell - Injected runOpenshell from onboard.ts.
 * @param {{replaceExisting?: boolean, bestEffort?: boolean, allowedSandboxes?: readonly string[], requireExactBindings?: boolean, revalidatePolicyRequirements?: (operation: string) => void}} options - Forwarded to every upsertProvider call.
 * @returns {string[]} Provider names that were upserted.
 */
function upsertMessagingProviders(tokenDefs, _runOpenshell, options = {}) {
  const runMessagingBridgeOpenshell = policyAuthorityCheckedRunner(
    _runOpenshell,
    options.revalidatePolicyRequirements,
    "inspect or change a messaging bridge provider",
  );
  // Provider creation order. Bridges (e.g. Google Chat) need two steps bracketing
  // the uniform create loop, ordered around `provider create`:
  //
  //   ensureMessagingBridgeProfiles      <- BEFORE loop: import the profile
  //      provider profile import            (must exist before `provider create`)
  //          |
  //     +----v-------------------------------------------------+
  //     |  for (tokenDef of tokenDefs)   <- THE LOOP           |
  //     |     upsertProvider(name, providerType || "generic")  |  bridge created
  //     |       . slack       -> --type nemoclaw-mcp-v1        |  with a sentinel
  //     |       . googlechat  -> --type google-chat-bridge     |  token
  //     +----+-------------------------------------------------+
  //          |
  //   configureMessagingBridgeRefreshes  <- AFTER loop: refresh mints the real
  //      provider refresh configure         token, overwriting the sentinel
  //
  // A channel is a bridge by the PRESENCE of a co-located
  // channels/<channel>/provider-profile/<agent>.yaml (not a flag inside it); both
  // bracket steps self-gate when no bridge token def is present.
  if (options.requireExactBindings && !options.replaceExisting) {
    const bindingFailures = preflightMessagingProviderBindings(
      tokenDefs,
      runMessagingBridgeOpenshell,
    );
    if (bindingFailures.length > 0) {
      const message = bindingFailures
        .map(({ name, message: failure }) => `${name}: ${failure}`)
        .join("; ");
      if (options.bestEffort) {
        throw new MessagingProviderBindingConflictError(message);
      }
      console.error(`\n  ✗ Failed to create messaging provider: ${message}`);
      process.exit(1);
    }
  }

  const messagingBridgeProvider = require("./messaging-bridge-provider");
  if (tokenDefs.some(({ providerType }) => providerType === MESSAGING_CREDENTIAL_PROVIDER_TYPE)) {
    try {
      ensureMessagingCredentialProviderProfile({
        root: ROOT,
        runOpenshell: runMessagingBridgeOpenshell,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.bestEffort) throw new Error(message);
      console.error(`\n  ✗ ${message}`);
      process.exit(1);
    }
  }
  messagingBridgeProvider.ensureMessagingBridgeProfiles(tokenDefs, {
    root: ROOT,
    runOpenshell: runMessagingBridgeOpenshell,
    redact,
  });
  const upserted = [];
  const mutatedProviderNames = [];
  const failures = [];
  for (const { name, envKey, token, providerType } of tokenDefs) {
    if (!token) continue;
    let knownExists;
    let result;
    if (providerType === MESSAGING_CREDENTIAL_PROVIDER_TYPE) {
      const inspection = inspectGatewayCredentialOnlyProviderBinding(
        { name, type: providerType, credentialKey: envKey },
        runMessagingBridgeOpenshell,
      );
      if (inspection.kind === "indeterminate") {
        result = {
          ok: false,
          status: 1,
          message: `Could not inspect messaging provider '${name}'; no provider mutation was attempted.`,
        };
      } else if (inspection.kind === "collision" && !options.replaceExisting) {
        result = {
          ok: false,
          status: 1,
          message: `Messaging provider '${name}' does not match the required endpointless credential binding.`,
        };
      } else {
        knownExists = inspection.kind !== "missing";
      }
    }
    try {
      result ??= upsertProvider(
        name,
        providerType || "generic",
        envKey,
        null,
        { [envKey]: token },
        _runOpenshell,
        {
          replaceExisting: Boolean(options.replaceExisting),
          knownExists,
          allowedSandboxes: options.allowedSandboxes,
          revalidatePolicyRequirements: options.revalidatePolicyRequirements,
          requireExactBinding: Boolean(options.requireExactBindings && providerType),
        },
      );
      if (result.ok) mutatedProviderNames.push(name);
      if (result.ok && providerType === MESSAGING_CREDENTIAL_PROVIDER_TYPE) {
        const verified = inspectGatewayCredentialOnlyProviderBinding(
          { name, type: providerType, credentialKey: envKey },
          runMessagingBridgeOpenshell,
        );
        if (verified.kind !== "exact") {
          result = {
            ok: false,
            status: 1,
            message: `OpenShell did not confirm messaging provider '${name}' after mutation.`,
          };
        }
      }
    } catch (error) {
      throw attachMutatedProviderNames(error, mutatedProviderNames);
    }
    if (!result.ok) {
      if (options.bestEffort) {
        failures.push({ name, message: result.message, reason: result.reason });
        continue;
      }
      console.error(`\n  ✗ Failed to create messaging provider '${name}': ${result.message}`);
      process.exit(1);
    }
    upserted.push(name);
  }
  if (failures.length > 0) {
    const message = failures.map(({ name, message }) => `${name}: ${message}`).join("; ");
    if (failures.every(({ reason }) => reason === "binding-conflict")) {
      throw new MessagingProviderBindingConflictError(message, mutatedProviderNames);
    }
    throw new Error(message);
  }
  // Gateway-side token minting is configured AFTER the providers exist (best-effort,
  // self-gates without a bridge token def). Secret material stays gateway-side —
  // never written into the sandbox.
  let refreshResult;
  try {
    refreshResult = messagingBridgeProvider.configureMessagingBridgeRefreshes(tokenDefs, {
      runOpenshell: runMessagingBridgeOpenshell,
      redact,
      getCredential,
      env: process.env,
      normalizeCredentialValue,
    });
  } catch (error) {
    throw attachMutatedProviderNames(error, mutatedProviderNames);
  }
  // Fail-closed: an active bridge channel whose gateway token minting was not
  // configured can receive webhooks but cannot authenticate outbound replies.
  // Surface it instead of reporting a fully-configured channel (bestEffort/rollback
  // paths report residual work by throwing; the normal path exits like a failed
  // provider upsert above).
  if (refreshResult && !refreshResult.ok) {
    const failure = attachMutatedProviderNames(
      new Error("Failed to configure gateway token minting for a messaging bridge."),
      mutatedProviderNames,
    );
    if (options.bestEffort) {
      throw failure;
    }
    console.error(`\n  ✗ ${failure.message}`);
    process.exit(1);
  }
  return upserted;
}

module.exports = {
  isMessagingProviderBindingConflict,
  BUILD_ENDPOINT_URL,
  OPENAI_ENDPOINT_URL,
  ANTHROPIC_ENDPOINT_URL,
  GEMINI_ENDPOINT_URL,
  REMOTE_PROVIDER_CONFIG,
  LOCAL_INFERENCE_PROVIDERS,
  LOCAL_INFERENCE_POLICY_PROVIDERS,
  OLLAMA_PROXY_CREDENTIAL_ENV,
  VLLM_LOCAL_CREDENTIAL_ENV,
  DISCORD_SNOWFLAKE_RE,
  HOSTED_INFERENCE_SOURCE_ENV,
  HOSTED_INFERENCE_CREDENTIAL_ENV,
  HOSTED_INFERENCE_ENDPOINT_URL,
  HOSTED_INFERENCE_MODEL,
  NON_INTERACTIVE_PROVIDER_ALIASES,
  NON_INTERACTIVE_PROVIDER_KEYS,
  getProviderLabel,
  getEffectiveProviderName,
  stageHostedInferenceSourceSecretEnv,
  getNonInteractiveProvider,
  getNonInteractiveModel,
  getRequestedModelFromEnv,
  getRequestedProviderHint,
  getRequestedModelHint,
  isProviderKeyCredentialCandidate,
  buildProviderArgs,
  policyAuthorityCheckedRunner,
  upsertProvider,
  providerExistsInGateway,
  readGatewayProviderMetadata,
  upsertMessagingProviders,
  getSandboxInferenceConfig,
};
