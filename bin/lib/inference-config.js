// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const INFERENCE_ROUTE_URL = "https://inference.local/v1";
// On OpenShell 0.0.10, the inference.local virtual host is not registered in
// CoreDNS, so DNS resolution fails inside the sandbox. For local providers
// (Ollama, vLLM), route directly via the Docker host-gateway alias instead.
// TODO: Remove these direct URLs once OpenShell fixes inference.local DNS
// registration (tracked in OpenShell — affects all local providers).
const { HOST_GATEWAY_URL, getLocalProviderBaseUrl } = require("./local-inference");
const OLLAMA_DIRECT_URL = getLocalProviderBaseUrl("ollama-local");
const VLLM_DIRECT_URL = getLocalProviderBaseUrl("vllm-local");
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
    case "nvidia-nim":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || DEFAULT_CLOUD_MODEL,
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        provider,
        providerLabel: "NVIDIA Cloud API",
      };
    case "vllm-local":
      return {
        endpointType: "custom",
        endpointUrl: VLLM_DIRECT_URL,
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
        // Use host-gateway URL directly instead of inference.local, which
        // fails DNS resolution inside the sandbox on OpenShell 0.0.10.
        endpointUrl: OLLAMA_DIRECT_URL,
        ncpPartner: null,
        model: model || DEFAULT_OLLAMA_MODEL,
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        provider,
        providerLabel: "Local Ollama",
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
};
