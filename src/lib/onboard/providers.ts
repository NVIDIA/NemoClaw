// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Provider metadata, lookup helpers, and gateway provider CRUD.

const { redact } = require("../runner");
const { normalizeCredentialValue } = require("../credentials/store");
const {
  DEFAULT_CLOUD_MODEL,
  DEFAULT_HERMES_PROVIDER_MODEL,
  OLLAMA_LOCAL_CREDENTIAL_ENV,
  VLLM_LOCAL_CREDENTIAL_ENV,
  getSandboxInferenceConfig,
} = require("../inference/config");
const { isSafeModelId } = require("../validation");
const { compactText } = require("../core/url-utils");

// ── Constants ────────────────────────────────────────────────────

const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const OPENAI_ENDPOINT_URL = "https://api.openai.com/v1";
const ANTHROPIC_ENDPOINT_URL = "https://api.anthropic.com";
const GEMINI_ENDPOINT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const HERMES_INFERENCE_ENDPOINT_URL = "https://inference-api.nousresearch.com/v1";
const HOSTED_INFERENCE_SOURCE_ENV = "NVIDIA_INFERENCE_API_KEY";
const HOSTED_INFERENCE_CREDENTIAL_ENV = "COMPATIBLE_API_KEY";
const HOSTED_INFERENCE_ENDPOINT_URL = "https://inference-api.nvidia.com/v1";
const HOSTED_INFERENCE_MODEL = "nvidia/nvidia/nemotron-3-super-v3";

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
    defaultModel: "gemini-2.5-flash",
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
};

// Providers that run on the host and need the local-inference policy preset.
const LOCAL_INFERENCE_PROVIDERS = ["ollama-local", "vllm-local"];

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
    case "routed":
      return "nvidia-router";
    default:
      return providerKey;
  }
}

// ── Non-interactive helpers ──────────────────────────────────────

function getNonInteractiveProvider() {
  stageHostedInferenceSourceSecretEnv();
  const providerKey = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  if (!providerKey) return null;
  const aliases = {
    cloud: "build",
    nim: "nim-local",
    vllm: "vllm",
    anthropiccompatible: "anthropicCompatible",
    hermes: "hermesProvider",
    "hermes-provider": "hermesProvider",
    hermesprovider: "hermesProvider",
    nous: "hermesProvider",
    "nous-portal": "hermesProvider",
  };
  const normalized = aliases[providerKey] || providerKey;
  const validProviders = new Set([
    "build",
    "openai",
    "anthropic",
    "anthropicCompatible",
    "gemini",
    "hermesProvider",
    "ollama",
    "custom",
    "nim-local",
    "vllm",
    "routed",
    "install-vllm",
    "install-ollama",
    "install-windows-ollama",
    "start-windows-ollama",
  ]);
  if (!validProviders.has(normalized)) {
    console.error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
    console.error(
      "  Valid values: build, openai, anthropic, anthropicCompatible, gemini, hermes-provider, ollama, custom, nim-local, vllm, routed, install-vllm, install-ollama, install-windows-ollama, start-windows-ollama",
    );
    process.exit(1);
  }
  return normalized;
}

function stageHostedInferenceSourceSecretEnv() {
  const sourceKey = normalizeCredentialValue(process.env[HOSTED_INFERENCE_SOURCE_ENV] ?? "");
  if (!sourceKey) return false;

  const rawProvider = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  const aliases = {
    cloud: "build",
    anthropiccompatible: "anthropicCompatible",
    hermes: "hermesProvider",
    "hermes-provider": "hermesProvider",
    hermesprovider: "hermesProvider",
    nous: "hermesProvider",
    "nous-portal": "hermesProvider",
  };
  const normalizedProvider = aliases[rawProvider] || rawProvider;
  const hostedFlag = (process.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE || "").trim() === "1";
  const compatibleKey = normalizeCredentialValue(
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
    (process.env.NEMOCLAW_MODEL || "").trim() ||
    (process.env.NEMOCLAW_COMPAT_MODEL || "").trim() ||
    (process.env.NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL || "").trim() ||
    HOSTED_INFERENCE_MODEL;
  process.env.NEMOCLAW_MODEL = model;
  process.env.NEMOCLAW_COMPAT_MODEL = (process.env.NEMOCLAW_COMPAT_MODEL || "").trim() || model;
  process.env.NEMOCLAW_PREFERRED_API =
    (process.env.NEMOCLAW_PREFERRED_API || "").trim() || "openai-completions";
  process.env[HOSTED_INFERENCE_CREDENTIAL_ENV] = sourceKey;
  return true;
}

function getNonInteractiveModel(providerKey) {
  const model = (process.env.NEMOCLAW_MODEL || "").trim();
  if (!model) return null;
  if (!isSafeModelId(model)) {
    console.error(`  Invalid NEMOCLAW_MODEL for provider '${providerKey}': ${model}`);
    console.error("  Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.");
    process.exit(1);
  }
  return model;
}

// No default for nonInteractive — onboard.ts wrapper supplies isNonInteractive().
function getRequestedProviderHint(nonInteractive) {
  return nonInteractive ? getNonInteractiveProvider() : null;
}

function getRequestedModelHint(nonInteractive) {
  if (!nonInteractive) return null;
  const providerKey = getRequestedProviderHint(nonInteractive) || "cloud";
  return getNonInteractiveModel(providerKey);
}

// ── Gateway provider CRUD ────────────────────────────────────────
// Functions that call runOpenshell accept it as the last parameter
// to avoid a circular dependency with onboard.ts.

/**
 * Build the argument array for an `openshell provider create` or `update` command.
 * @param {"create"|"update"} action - Whether to create or update.
 * @param {string} name - Provider name.
 * @param {string} type - Provider type (e.g. "openai", "anthropic", "generic").
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
 * Create or update an OpenShell provider in the gateway.
 *
 * Checks whether the provider already exists via `openshell provider get`;
 * uses `create` for new providers and `update` for existing ones. When
 * `options.replaceExisting` is true an existing provider is deleted and
 * recreated instead of updated — required for provider-type changes that
 * `provider update` cannot apply (e.g. the Brave Search migration from the
 * legacy `generic` type to the `brave` profile). The caller must guarantee
 * the provider is detached from any live sandbox before opting in: OpenShell
 * rejects `provider delete` on attached providers.
 * @param {string} name - Provider name (e.g. "discord-bridge", "inference").
 * @param {string} type - Provider type ("openai", "anthropic", "generic", "brave").
 * @param {string} credentialEnv - Environment variable name for the credential.
 * @param {string|null} baseUrl - Optional base URL for the provider endpoint.
 * @param {Record<string, string>} env - Environment variables for the openshell command.
 * @param {Function} _runOpenshell - Injected runOpenshell from onboard.ts.
 * @param {{replaceExisting?: boolean}} options - Optional replacement controls.
 * @returns {{ ok: boolean, status?: number, message?: string }}
 */
function upsertProvider(name, type, credentialEnv, baseUrl, env, _runOpenshell, options = {}) {
  const exists = providerExistsInGateway(name, _runOpenshell);
  if (exists && options.replaceExisting) {
    const { deleteProviderWithRecovery } = require("./sandbox-provider-cleanup");
    const r = deleteProviderWithRecovery(name, { runOpenshell: _runOpenshell });
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
  const result = _runOpenshell(args, runOpts);
  if (result.status !== 0) {
    const output =
      compactText(redact(`${result.stderr || ""}`)) ||
      compactText(redact(`${result.stdout || ""}`)) ||
      `Failed to ${action} provider '${name}'.`;
    return { ok: false, status: result.status || 1, message: output };
  }
  return { ok: true };
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
 * @param {{replaceExisting?: boolean, bestEffort?: boolean}} options - Forwarded to every upsertProvider call.
 * @returns {string[]} Provider names that were upserted.
 */
function upsertMessagingProviders(tokenDefs, _runOpenshell, options = {}) {
  const upserted = [];
  const failures = [];
  for (const { name, envKey, token, providerType } of tokenDefs) {
    if (!token) continue;
    const result = upsertProvider(
      name,
      providerType || "generic",
      envKey,
      null,
      { [envKey]: token },
      _runOpenshell,
      { replaceExisting: Boolean(options.replaceExisting) },
    );
    if (!result.ok) {
      if (options.bestEffort) {
        failures.push(`${name}: ${result.message}`);
        continue;
      }
      console.error(`\n  ✗ Failed to create messaging provider '${name}': ${result.message}`);
      process.exit(1);
    }
    upserted.push(name);
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  return upserted;
}

module.exports = {
  BUILD_ENDPOINT_URL,
  OPENAI_ENDPOINT_URL,
  ANTHROPIC_ENDPOINT_URL,
  GEMINI_ENDPOINT_URL,
  REMOTE_PROVIDER_CONFIG,
  LOCAL_INFERENCE_PROVIDERS,
  OLLAMA_PROXY_CREDENTIAL_ENV,
  VLLM_LOCAL_CREDENTIAL_ENV,
  DISCORD_SNOWFLAKE_RE,
  HOSTED_INFERENCE_SOURCE_ENV,
  HOSTED_INFERENCE_CREDENTIAL_ENV,
  HOSTED_INFERENCE_ENDPOINT_URL,
  HOSTED_INFERENCE_MODEL,
  getProviderLabel,
  getEffectiveProviderName,
  stageHostedInferenceSourceSecretEnv,
  getNonInteractiveProvider,
  getNonInteractiveModel,
  getRequestedProviderHint,
  getRequestedModelHint,
  buildProviderArgs,
  upsertProvider,
  providerExistsInGateway,
  upsertMessagingProviders,
  getSandboxInferenceConfig,
};
