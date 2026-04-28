// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Provider metadata, lookup helpers, and gateway provider CRUD.

const { redact } = require("./runner");
const { DEFAULT_CLOUD_MODEL } = require("./inference-config");
const { isSafeModelId } = require("./validation");
const { compactText } = require("./url-utils");

// ── Constants ────────────────────────────────────────────────────

const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const OPENAI_ENDPOINT_URL = "https://api.openai.com/v1";
const ANTHROPIC_ENDPOINT_URL = "https://api.anthropic.com";
const GEMINI_ENDPOINT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

const REMOTE_PROVIDER_CONFIG = {
  build: {
    label: "NVIDIA Endpoints",
    providerName: "nvidia-prod",
    providerType: "nvidia",
    credentialEnv: "NVIDIA_API_KEY",
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
    default:
      return providerKey;
  }
}

// ── Non-interactive helpers ──────────────────────────────────────

function getNonInteractiveProvider() {
  const providerKey = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  if (!providerKey) return null;
  const aliases = {
    cloud: "build",
    nim: "nim-local",
    vllm: "vllm",
    anthropiccompatible: "anthropicCompatible",
  };
  const normalized = aliases[providerKey] || providerKey;
  const validProviders = new Set([
    "build",
    "openai",
    "anthropic",
    "anthropicCompatible",
    "gemini",
    "ollama",
    "custom",
    "nim-local",
    "vllm",
  ]);
  if (!validProviders.has(normalized)) {
    console.error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
    console.error(
      "  Valid values: build, openai, anthropic, anthropicCompatible, gemini, ollama, custom, nim-local, vllm",
    );
    process.exit(1);
  }
  return normalized;
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
 * @returns {string[]} Argument array for runOpenshell().
 */
function buildProviderArgs(action, name, type, credentialEnv, baseUrl) {
  const args =
    action === "create"
      ? ["provider", "create", "--name", name, "--type", type, "--credential", credentialEnv]
      : ["provider", "update", name, "--credential", credentialEnv];
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
 * uses `create` for new providers and `update` for existing ones.
 * @param {string} name - Provider name (e.g. "discord-bridge", "inference").
 * @param {string} type - Provider type ("openai", "anthropic", "generic").
 * @param {string} credentialEnv - Environment variable name for the credential.
 * @param {string|null} baseUrl - Optional base URL for the provider endpoint.
 * @param {Record<string, string>} env - Environment variables for the openshell command.
 * @param {Function} _runOpenshell - Injected runOpenshell from onboard.ts.
 * @returns {{ ok: boolean, status?: number, message?: string }}
 */
function upsertProvider(name, type, credentialEnv, baseUrl, env, _runOpenshell) {
  const exists = providerExistsInGateway(name, _runOpenshell);
  const action = exists ? "update" : "create";
  const args = buildProviderArgs(action, name, type, credentialEnv, baseUrl);
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
 * Exits the process if any upsert fails.
 * @param {Array<{name: string, envKey: string, token: string|null}>} tokenDefs
 * @param {Function} _runOpenshell - Injected runOpenshell from onboard.ts.
 * @returns {string[]} Provider names that were upserted.
 */
function upsertMessagingProviders(tokenDefs, _runOpenshell) {
  const upserted = [];
  for (const { name, envKey, token } of tokenDefs) {
    if (!token) continue;
    const result = upsertProvider(name, "generic", envKey, null, { [envKey]: token }, _runOpenshell);
    if (!result.ok) {
      console.error(`\n  ✗ Failed to create messaging provider '${name}': ${result.message}`);
      process.exit(1);
    }
    upserted.push(name);
  }
  return upserted;
}

// ── Sandbox inference config ─────────────────────────────────────

function getSandboxInferenceConfig(model, provider = null, preferredInferenceApi = null) {
  let providerKey;
  let primaryModelRef;
  let inferenceBaseUrl = "https://inference.local/v1";
  let inferenceApi = preferredInferenceApi || "openai-completions";
  let inferenceCompat = null;

  switch (provider) {
    case "openai-api":
      providerKey = "openai";
      primaryModelRef = `openai/${model}`;
      break;
    case "anthropic-prod":
    case "compatible-anthropic-endpoint":
      providerKey = "anthropic";
      primaryModelRef = `anthropic/${model}`;
      inferenceBaseUrl = "https://inference.local";
      inferenceApi = "anthropic-messages";
      break;
    case "gemini-api":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "compatible-endpoint":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "nvidia-prod":
    case "nvidia-nim":
    default:
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      break;
  }

  return { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat };
}

module.exports = {
  BUILD_ENDPOINT_URL,
  OPENAI_ENDPOINT_URL,
  ANTHROPIC_ENDPOINT_URL,
  GEMINI_ENDPOINT_URL,
  REMOTE_PROVIDER_CONFIG,
  LOCAL_INFERENCE_PROVIDERS,
  DISCORD_SNOWFLAKE_RE,
  getProviderLabel,
  getEffectiveProviderName,
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
