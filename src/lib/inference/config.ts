// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Inference provider selection config, model resolution, and gateway
 * inference output parsing. All functions are pure.
 */

import { shouldSkipResponsesProbe } from "../validation";
import { DEFAULT_OLLAMA_MODEL } from "./local";

export const INFERENCE_ROUTE_URL = "https://inference.local/v1";
export const NOUS_RECOMMENDED_MODELS_URL =
  "https://portal.nousresearch.com/api/nous/recommended-models";
export const DEFAULT_CLOUD_MODEL = "nvidia/nemotron-3-super-120b-a12b";
// Fallback context window used when no per-model value is known. Cloud providers
// have no per-model context metadata today (CLOUD_MODEL_OPTIONS carries only
// id/label), so they fall back to this; matches the onboarding build default in
// scripts/generate-openclaw-config.mts. Per-model cloud accuracy is tracked
// separately (cloud context-window registry).
export const DEFAULT_CONTEXT_WINDOW = 131072;
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
  "nvidia/nemotron-3-super-120b-a12b",
  "arcee-ai/trinity-large-thinking",
  "openai/gpt-5.5-pro",
  "openai/gpt-5.4-nano",
] as const;
export const DEFAULT_HERMES_PROVIDER_MODEL = HERMES_PROVIDER_MODEL_OPTIONS[0];
export const CLOUD_MODEL_OPTIONS = [
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra 550B" },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", label: "Nemotron 3 Nano Omni 30B" },
  { id: "z-ai/glm-5.1", label: "GLM-5" },
  { id: "minimaxai/minimax-m2.7", label: "MiniMax M2.7" },
  { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
  { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];
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
  // Providers without a /v1/responses endpoint must never be configured with the
  // Responses API. On a provider switch the runtime API resolves to null and the
  // caller falls back to the persisted (shared "inference") provider api, which
  // can carry a prior provider's "openai-responses" over to e.g. nvidia-prod and
  // 404 every request. Force completions here, mirroring how anthropic-prod
  // forces anthropic-messages below.
  if (provider && shouldSkipResponsesProbe(provider)) {
    inferenceApi = "openai-completions";
  }
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
    case "ollama-local":
      providerKey = MANAGED_PROVIDER_ID;
      primaryModelRef = `${MANAGED_PROVIDER_ID}/${model}`;
      // Source-of-truth boundary: once local Ollama is routed through the
      // managed "inference" provider, OpenClaw no longer sees an
      // ollama/ollama-local provider key and cannot apply its Ollama streaming
      // usage fallback. Seed the compat flag here, while NemoClaw still knows
      // the original host-side provider selection. Remove this only after
      // OpenClaw infers include_usage for inference.local Ollama routes or
      // NemoClaw stops mapping ollama-local through the managed provider.
      inferenceCompat = {
        supportsUsageInStreaming: true,
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

export interface RecordedInferenceRoute {
  provider: string;
  model: string;
}

export type InferenceRoutePlan =
  | { kind: "aligned" }
  | { kind: "repair" }
  | { kind: "diverged"; live: GatewayInference; recorded: RecordedInferenceRoute };

// Decide how `connect` reconciles the live gateway route with a sandbox's
// recorded route. `diverged` (valid but different) must be surfaced loudly by
// the caller — silently overriding it was #3726.
export function planInferenceRouteReconcile(
  live: GatewayInference | null,
  recorded: RecordedInferenceRoute,
): InferenceRoutePlan {
  // No usable live route (absent or partial) → repair, not a loud override.
  if (!live || !live.provider || !live.model) {
    return { kind: "repair" };
  }
  if (live.provider !== recorded.provider || live.model !== recorded.model) {
    return { kind: "diverged", live, recorded };
  }
  return { kind: "aligned" };
}

// Strip control chars so untrusted route values can't inject terminal escapes when printed.
export function sanitizeRouteValueForDisplay(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}
