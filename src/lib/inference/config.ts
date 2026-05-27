// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Inference provider selection config, model resolution, and gateway
 * inference output parsing. All functions are pure.
 */

import { DEFAULT_OLLAMA_MODEL } from "./local";

export const INFERENCE_ROUTE_URL = "https://inference.local/v1";
export const NOUS_RECOMMENDED_MODELS_URL =
  "https://portal.nousresearch.com/api/nous/recommended-models";

/**
 * Nemotron Ultra upstream API.
 *
 * OpenAI Python/JS SDK: use NVIDIA_INFERENCE_OPENAI_BASE_URL (SDK appends `/v1`).
 * curl / gateway router: use NVIDIA_INFERENCE_API_BASE_URL (`.../v1/chat/completions`).
 *
 * Reference implementations:
 *   - scripts/examples/nemotron-ultra-inference.py (sync/async, streaming recommended)
 *
 * curl:
 *   curl --location 'https://inference-api.nvidia.com/v1/chat/completions' \
 *     --header 'Content-Type: application/json' \
 *     --header 'Authorization: Bearer $NVIDIA_API_KEY' \
 *     --data '{"model":"nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1",...}'
 *
 * Python (OpenAI SDK):
 *   from openai import OpenAI
 *   client = OpenAI(api_key="...", base_url="https://inference-api.nvidia.com")
 *   client.chat.completions.create(
 *     model="nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1",
 *     messages=[{"role": "user", "content": "Capital of United States"}],
 *     temperature=0.9, max_tokens=128, top_p=0.7, stream=True)
 */
export const NVIDIA_INFERENCE_OPENAI_BASE_URL = "https://inference-api.nvidia.com";

/** REST base URL including `/v1` (used by NemoClaw gateway registration and curl). */
export const NVIDIA_INFERENCE_API_BASE_URL = `${NVIDIA_INFERENCE_OPENAI_BASE_URL}/v1`;

/** NVIDIA Build / integrate API base (`NVIDIA_API_KEY`, `nvapi-*`). */
export const NVIDIA_INTEGRATE_API_BASE_URL = "https://integrate.api.nvidia.com/v1";

/**
 * Inference Hub chat completions URL (`NVIDIA_INFERENCE_HUB_API_KEY`, `sk-*`).
 * OpenShell registration uses {@link NVIDIA_INFERENCE_API_BASE_URL} (`.../v1`).
 */
export const NVIDIA_INFERENCE_HUB_CHAT_COMPLETIONS_URL =
  `${NVIDIA_INFERENCE_API_BASE_URL}/chat/completions`;

export const NVIDIA_NEMOTRON_ULTRA_MODEL = "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1";
export const NVIDIA_NEMOTRON_SUPER_MODEL = "nvidia/nemotron-3-super-120b-a12b";

export const NVIDIA_INFERENCE_HUB_KEY_HELP_URL = "https://inference.nvidia.com";
export const NVIDIA_BUILD_KEY_HELP_URL = "https://build.nvidia.com/settings/api-keys";

/**
 * NVIDIA API key (`nvapi-*`) for models on {@link NVIDIA_INTEGRATE_API_BASE_URL}.
 */
export const NVIDIA_BUILD_CREDENTIAL_ENV = "NVIDIA_API_KEY";

/**
 * Inference Hub API key (`sk-*`) for models on {@link NVIDIA_INFERENCE_API_BASE_URL}
 * (chat: {@link NVIDIA_INFERENCE_HUB_CHAT_COMPLETIONS_URL}).
 */
export const NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV = "NVIDIA_INFERENCE_HUB_API_KEY";

export interface CloudModelOption {
  id: string;
  label: string;
  /** Upstream OpenAI-compatible API base (includes `/v1`). */
  nvidiaApiBaseUrl?: string;
  keyHelpUrl?: string;
  /** Env var for the API key (see NVIDIA_BUILD_CREDENTIAL_ENV / NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV). */
  credentialEnv?: string;
}

// Default cloud model — see also nemoclaw/src/index.ts catalog entry.
export const DEFAULT_CLOUD_MODEL = NVIDIA_NEMOTRON_ULTRA_MODEL;
export const HERMES_PROVIDER_MODEL_OPTIONS = [
  "moonshotai/kimi-k2.6",
  "xiaomi/mimo-v2.5-pro",
  "xiaomi/mimo-v2.5",
  "tencent/hy3-preview",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.5",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.3-codex",
  "google/gemini-3-pro-preview",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-flash-lite-preview",
  "qwen/qwen3.5-plus-02-15",
  "qwen/qwen3.5-35b-a3b",
  "stepfun/step-3.5-flash",
  "minimax/minimax-m2.7",
  "minimax/minimax-m2.5",
  "minimax/minimax-m2.5:free",
  "z-ai/glm-5.1",
  "z-ai/glm-5v-turbo",
  "z-ai/glm-5-turbo",
  "x-ai/grok-4.20-beta",
  NVIDIA_NEMOTRON_ULTRA_MODEL,
  "arcee-ai/trinity-large-thinking",
  "openai/gpt-5.5-pro",
  "openai/gpt-5.4-nano",
] as const;
export const DEFAULT_HERMES_PROVIDER_MODEL = HERMES_PROVIDER_MODEL_OPTIONS[0];
export const CLOUD_MODEL_OPTIONS: CloudModelOption[] = [
  {
    id: NVIDIA_NEMOTRON_ULTRA_MODEL,
    label: "Nemotron Ultra 253B (inference-api.nvidia.com)",
    nvidiaApiBaseUrl: NVIDIA_INFERENCE_API_BASE_URL,
    keyHelpUrl: NVIDIA_INFERENCE_HUB_KEY_HELP_URL,
    credentialEnv: NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV,
  },
  {
    id: NVIDIA_NEMOTRON_SUPER_MODEL,
    label: "Nemotron 3 Super 120B (integrate.api.nvidia.com)",
    nvidiaApiBaseUrl: NVIDIA_INTEGRATE_API_BASE_URL,
    keyHelpUrl: NVIDIA_BUILD_KEY_HELP_URL,
    credentialEnv: NVIDIA_BUILD_CREDENTIAL_ENV,
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    label: "Nemotron 3 Nano Omni 30B",
    nvidiaApiBaseUrl: NVIDIA_INFERENCE_API_BASE_URL,
    keyHelpUrl: NVIDIA_INFERENCE_HUB_KEY_HELP_URL,
    credentialEnv: NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV,
  },
  {
    id: "z-ai/glm-5.1",
    label: "GLM-5",
    nvidiaApiBaseUrl: NVIDIA_INFERENCE_API_BASE_URL,
    keyHelpUrl: NVIDIA_INFERENCE_HUB_KEY_HELP_URL,
    credentialEnv: NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV,
  },
  {
    id: "minimaxai/minimax-m2.7",
    label: "MiniMax M2.7",
    nvidiaApiBaseUrl: NVIDIA_INFERENCE_API_BASE_URL,
    keyHelpUrl: NVIDIA_INFERENCE_HUB_KEY_HELP_URL,
    credentialEnv: NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV,
  },
  {
    id: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    nvidiaApiBaseUrl: NVIDIA_INFERENCE_API_BASE_URL,
    keyHelpUrl: NVIDIA_INFERENCE_HUB_KEY_HELP_URL,
    credentialEnv: NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV,
  },
  {
    id: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    nvidiaApiBaseUrl: NVIDIA_INFERENCE_API_BASE_URL,
    keyHelpUrl: NVIDIA_INFERENCE_HUB_KEY_HELP_URL,
    credentialEnv: NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV,
  },
  {
    id: "deepseek-ai/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    nvidiaApiBaseUrl: NVIDIA_INFERENCE_API_BASE_URL,
    keyHelpUrl: NVIDIA_INFERENCE_HUB_KEY_HELP_URL,
    credentialEnv: NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV,
  },
];

export interface NvidiaCloudModelRoute {
  apiBaseUrl: string;
  providerType: "openai" | "nvidia";
  keyHelpUrl: string;
  credentialEnv: string;
}

/** Resolve upstream API + OpenShell provider type for NVIDIA Endpoints cloud models. */
export function resolveNvidiaCloudModelRoute(modelId: string): NvidiaCloudModelRoute {
  const curated = CLOUD_MODEL_OPTIONS.find((option) => option.id === modelId);
  if (curated?.nvidiaApiBaseUrl) {
    const apiBaseUrl = curated.nvidiaApiBaseUrl;
    return {
      apiBaseUrl,
      providerType: apiBaseUrl.includes("inference-api") ? "openai" : "nvidia",
      keyHelpUrl: curated.keyHelpUrl ?? NVIDIA_BUILD_KEY_HELP_URL,
      credentialEnv:
        curated.credentialEnv ??
        (apiBaseUrl.includes("inference-api")
          ? NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV
          : NVIDIA_BUILD_CREDENTIAL_ENV),
    };
  }
  if (modelId === NVIDIA_NEMOTRON_ULTRA_MODEL || modelId.includes("nemotron-ultra")) {
    return {
      apiBaseUrl: NVIDIA_INFERENCE_API_BASE_URL,
      providerType: "openai",
      keyHelpUrl: NVIDIA_INFERENCE_HUB_KEY_HELP_URL,
      credentialEnv: NVIDIA_INFERENCE_HUB_CREDENTIAL_ENV,
    };
  }
  return {
    apiBaseUrl: NVIDIA_INTEGRATE_API_BASE_URL,
    providerType: "nvidia",
    keyHelpUrl: NVIDIA_BUILD_KEY_HELP_URL,
    credentialEnv: NVIDIA_BUILD_CREDENTIAL_ENV,
  };
}

export const DEFAULT_ROUTE_PROFILE = "inference-local";
export const DEFAULT_ROUTE_CREDENTIAL_ENV = "OPENAI_API_KEY";
// Dedicated credential env names for local inference. Decoupled from
// OPENAI_API_KEY so the sandbox-side OpenClaw and the host-side gateway
// never read the user's host OpenAI key for local providers. See GH #2519.
export const OLLAMA_LOCAL_CREDENTIAL_ENV = "NEMOCLAW_OLLAMA_PROXY_TOKEN";
export const VLLM_LOCAL_CREDENTIAL_ENV = "NEMOCLAW_VLLM_LOCAL_TOKEN";
export const MANAGED_PROVIDER_ID = "inference";
export { DEFAULT_OLLAMA_MODEL };

export interface ProviderSelectionConfig {
  endpointType: string;
  endpointUrl: string;
  ncpPartner: string | null;
  model: string;
  profile: string;
  credentialEnv: string;
  provider: string;
  providerLabel: string;
}

export interface GatewayInference {
  provider: string | null;
  model: string | null;
}

export interface SandboxInferenceConfig {
  providerKey: string;
  primaryModelRef: string;
  inferenceBaseUrl: string;
  inferenceApi: string;
  inferenceCompat: Record<string, unknown> | null;
}

export function getProviderSelectionConfig(
  provider: string,
  model?: string,
): ProviderSelectionConfig | null {
  const base: Omit<ProviderSelectionConfig, "model" | "credentialEnv" | "providerLabel"> = {
    endpointType: "custom",
    endpointUrl: INFERENCE_ROUTE_URL,
    ncpPartner: null,
    profile: DEFAULT_ROUTE_PROFILE,
    provider,
  };

  switch (provider) {
    case "nvidia-prod":
    case "nvidia-nim":
      return {
        ...base,
        model: model || DEFAULT_CLOUD_MODEL,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        providerLabel: "NVIDIA Endpoints",
      };
    case "openai-api":
      return {
        ...base,
        model: model || "gpt-5.4",
        credentialEnv: "OPENAI_API_KEY",
        providerLabel: "OpenAI",
      };
    case "anthropic-prod":
      return {
        ...base,
        model: model || "claude-sonnet-4-6",
        credentialEnv: "ANTHROPIC_API_KEY",
        providerLabel: "Anthropic",
      };
    case "compatible-anthropic-endpoint":
      return {
        ...base,
        model: model || "custom-anthropic-model",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        providerLabel: "Other Anthropic-compatible endpoint",
      };
    case "gemini-api":
      return {
        ...base,
        model: model || "gemini-2.5-flash",
        credentialEnv: "GEMINI_API_KEY",
        providerLabel: "Google Gemini",
      };
    case "compatible-endpoint":
      return {
        ...base,
        model: model || "custom-model",
        credentialEnv: "COMPATIBLE_API_KEY",
        providerLabel: "Other OpenAI-compatible endpoint",
      };
    case "hermes-provider":
      return {
        ...base,
        model: model || DEFAULT_HERMES_PROVIDER_MODEL,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        providerLabel: "Hermes Provider",
      };
    case "vllm-local":
      return {
        ...base,
        model: model || "vllm-local",
        credentialEnv: VLLM_LOCAL_CREDENTIAL_ENV,
        providerLabel: "Local vLLM",
      };
    case "ollama-local":
      return {
        ...base,
        model: model || DEFAULT_OLLAMA_MODEL,
        credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
        providerLabel: "Local Ollama",
      };
    default:
      return null;
  }
}

export function getOpenClawPrimaryModel(provider: string, model?: string): string {
  const resolvedModel =
    model || (provider === "ollama-local" ? DEFAULT_OLLAMA_MODEL : DEFAULT_CLOUD_MODEL);
  return getSandboxInferenceConfig(resolvedModel, provider).primaryModelRef;
}

export function getSandboxInferenceConfig(
  model: string,
  provider: string | null = null,
  preferredInferenceApi: string | null = null,
): SandboxInferenceConfig {
  let providerKey: string;
  let primaryModelRef: string;
  let inferenceBaseUrl = INFERENCE_ROUTE_URL;
  let inferenceApi = preferredInferenceApi || "openai-completions";
  let inferenceCompat: Record<string, unknown> | null = null;

  switch (provider) {
    case "openai-api":
      providerKey = "openai";
      primaryModelRef = `openai/${model}`;
      break;
    case "anthropic-prod":
    case "compatible-anthropic-endpoint":
      if (provider === "compatible-anthropic-endpoint" && inferenceApi === "openai-completions") {
        providerKey = MANAGED_PROVIDER_ID;
        primaryModelRef = `${MANAGED_PROVIDER_ID}/${model}`;
        inferenceCompat = {
          supportsStore: false,
        };
        break;
      }
      providerKey = "anthropic";
      primaryModelRef = `anthropic/${model}`;
      inferenceBaseUrl = "https://inference.local";
      inferenceApi = "anthropic-messages";
      break;
    case "gemini-api":
    case "hermes-provider":
      providerKey = MANAGED_PROVIDER_ID;
      primaryModelRef = `${MANAGED_PROVIDER_ID}/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "compatible-endpoint":
      providerKey = MANAGED_PROVIDER_ID;
      primaryModelRef = `${MANAGED_PROVIDER_ID}/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "nvidia-router":
      providerKey = MANAGED_PROVIDER_ID;
      primaryModelRef = `${MANAGED_PROVIDER_ID}/${model}`;
      break;
    case "nvidia-prod":
    case "nvidia-nim":
    default:
      providerKey = MANAGED_PROVIDER_ID;
      primaryModelRef = `${MANAGED_PROVIDER_ID}/${model}`;
      break;
  }

  return { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat };
}

export function parseGatewayInference(output: string | null | undefined): GatewayInference | null {
  if (!output) return null;
  const stripped = output.replace(/\u001b\[[0-9;]*m/g, "");
  const lines = stripped.split("\n");
  let inGateway = false;
  let provider: string | null = null;
  let model: string | null = null;
  for (const line of lines) {
    if (/^Gateway inference:\s*$/i.test(line)) {
      inGateway = true;
      continue;
    }
    if (inGateway && /^\S.*:$/.test(line)) {
      break;
    }
    if (inGateway) {
      const trimmed = line.trim();
      const p = trimmed.match(/^Provider:\s*(.+)/);
      const m = trimmed.match(/^Model:\s*(.+)/);
      if (p) provider = p[1].trim();
      if (m) model = m[1].trim();
    }
  }
  if (!provider && !model) return null;
  return { provider, model };
}
