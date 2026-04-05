// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Inference provider selection config, model resolution, and gateway
 * inference output parsing. All functions are pure.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DEFAULT_OLLAMA_MODEL } = require("../../bin/lib/local-inference");

export const INFERENCE_ROUTE_URL = "https://inference.local/v1";
export const DEFAULT_CLOUD_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const CLOUD_MODEL_OPTIONS = [
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" },
  { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5" },
  { id: "z-ai/glm5", label: "GLM-5" },
  { id: "minimaxai/minimax-m2.5", label: "MiniMax M2.5" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
];
export const DEFAULT_ROUTE_PROFILE = "inference-local";
export const DEFAULT_ROUTE_CREDENTIAL_ENV = "OPENAI_API_KEY";
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

export function getProviderSelectionConfig(
  provider: string,
  model?: string,
): ProviderSelectionConfig | null {
  const base = {
    endpointType: "custom" as const,
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
    case "vllm-local":
      return {
        ...base,
        model: model || "vllm-local",
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        providerLabel: "Local vLLM",
      };
    case "ollama-local":
      return {
        ...base,
        model: model || DEFAULT_OLLAMA_MODEL,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        providerLabel: "Local Ollama",
      };
    default:
      return null;
  }
}

export function getOpenClawPrimaryModel(provider: string, model?: string): string {
  const resolvedModel =
    model || (provider === "ollama-local" ? DEFAULT_OLLAMA_MODEL : DEFAULT_CLOUD_MODEL);
  return `${MANAGED_PROVIDER_ID}/${resolvedModel}`;
}

export function parseGatewayInference(output: string | null | undefined): GatewayInference | null {
  if (!output) return null;
  // eslint-disable-next-line no-control-regex
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
