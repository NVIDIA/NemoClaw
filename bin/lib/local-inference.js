// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HOST_GATEWAY_URL = "http://host.openshell.internal";

function getLocalProviderBaseUrl(provider) {
  switch (provider) {
    case "vllm-local":
      return `${HOST_GATEWAY_URL}:8000/v1`;
    case "ollama-local":
      return `${HOST_GATEWAY_URL}:11434/v1`;
    default:
      return null;
  }
}

function getLocalProviderHealthCheck(provider) {
  switch (provider) {
    case "vllm-local":
      return "curl -sf http://localhost:8000/v1/models 2>/dev/null";
    case "ollama-local":
      return "curl -sf http://localhost:11434/api/tags 2>/dev/null";
    default:
      return null;
  }
}

function validateLocalProvider(provider, runCapture) {
  const command = getLocalProviderHealthCheck(provider);
  if (!command) {
    return { ok: true };
  }

  const output = runCapture(command, { ignoreError: true });
  if (output) {
    return { ok: true };
  }

  switch (provider) {
    case "vllm-local":
      return {
        ok: false,
        message: "Local vLLM was selected, but nothing is responding on http://localhost:8000.",
      };
    case "ollama-local":
      return {
        ok: false,
        message: "Local Ollama was selected, but nothing is responding on http://localhost:11434.",
      };
    default:
      return { ok: false, message: "The selected local inference provider is unavailable." };
  }
}

module.exports = {
  HOST_GATEWAY_URL,
  getLocalProviderBaseUrl,
  getLocalProviderHealthCheck,
  validateLocalProvider,
};
