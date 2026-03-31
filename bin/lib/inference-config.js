// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const INFERENCE_ROUTE_URL = "https://inference.local/v1";
const DEFAULT_CLOUD_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const CLOUD_MODEL_OPTIONS = [
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" },
  { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5" },
  { id: "z-ai/glm5", label: "GLM-5" },
  { id: "minimaxai/minimax-m2.5", label: "MiniMax M2.5" },
  { id: "qwen/qwen3.5-397b-a17b", label: "Qwen3.5 397B A17B" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
];
const DEFAULT_ROUTE_PROFILE = "inference-local";
const DEFAULT_ROUTE_CREDENTIAL_ENV = "OPENAI_API_KEY";
const MANAGED_PROVIDER_ID = "inference";
const { DEFAULT_OLLAMA_MODEL } = require("./local-inference");

function getProviderSelectionConfig(provider, model) {
  switch (provider) {
    case "nvidia-prod":
    case "nvidia-nim":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || DEFAULT_CLOUD_MODEL,
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        provider,
        providerLabel: "NVIDIA Endpoints",
      };
    case "openai-api":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || "gpt-5.4",
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: "OPENAI_API_KEY",
        provider,
        providerLabel: "OpenAI",
      };
    case "anthropic-prod":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || "claude-sonnet-4-6",
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: "ANTHROPIC_API_KEY",
        provider,
        providerLabel: "Anthropic",
      };
    case "compatible-anthropic-endpoint":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || "custom-anthropic-model",
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        provider,
        providerLabel: "Other Anthropic-compatible endpoint",
      };
    case "gemini-api":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || "gemini-2.5-flash",
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: "GEMINI_API_KEY",
        provider,
        providerLabel: "Google Gemini",
      };
    case "compatible-endpoint":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || "custom-model",
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: "COMPATIBLE_API_KEY",
        provider,
        providerLabel: "Other OpenAI-compatible endpoint",
      };
    case "vllm-local":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || "vllm-local",
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        provider,
        providerLabel: "Local vLLM",
      };
    case "ollama-local":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || DEFAULT_OLLAMA_MODEL,
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        provider,
        providerLabel: "Local Ollama",
      };
    case "bedrock":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || "nvidia.nemotron-super-3-120b",
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: "BEDROCK_API_KEY",
        provider,
        providerLabel: "Amazon Bedrock (OpenAI-compatible)",
      };
    default:
      return null;
  }
}

function getOpenClawPrimaryModel(provider, model) {
  const resolvedModel =
    model || (provider === "ollama-local" ? DEFAULT_OLLAMA_MODEL : DEFAULT_CLOUD_MODEL);
  return resolvedModel ? `${MANAGED_PROVIDER_ID}/${resolvedModel}` : null;
}

function parseGatewayInference(output) {
  if (!output || /Not configured/i.test(output)) return null;
  const provider = output.match(/Provider:\s*(.+)/);
  const model = output.match(/Model:\s*(.+)/);
  if (!provider && !model) return null;
  return {
    provider: provider ? provider[1].trim() : null,
    model: model ? model[1].trim() : null,
  };
}

module.exports = {
  CLOUD_MODEL_OPTIONS,
  DEFAULT_CLOUD_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_ROUTE_CREDENTIAL_ENV,
  DEFAULT_ROUTE_PROFILE,
  INFERENCE_ROUTE_URL,
  MANAGED_PROVIDER_ID,
  getOpenClawPrimaryModel,
  getProviderSelectionConfig,
  parseGatewayInference,
};
