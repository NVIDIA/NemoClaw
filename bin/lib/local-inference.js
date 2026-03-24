// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { shellQuote } = require("./runner");

const HOST_GATEWAY_URL = "http://host.openshell.internal";
const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";
const SMALL_OLLAMA_MODEL = "qwen2.5:7b";
const LARGE_OLLAMA_MIN_MEMORY_MB = 32768;

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

function getLocalProviderValidationBaseUrl(provider) {
  switch (provider) {
    case "vllm-local":
      return "http://localhost:8000/v1";
    case "ollama-local":
      return "http://localhost:11434/v1";
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

function getLocalProviderContainerReachabilityCheck(provider) {
  switch (provider) {
    case "vllm-local":
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:8000/v1/models 2>/dev/null`;
    case "ollama-local":
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`;
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
  if (!output) {
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

  const containerCommand = getLocalProviderContainerReachabilityCheck(provider);
  if (!containerCommand) {
    return { ok: true };
  }

  const containerOutput = runCapture(containerCommand, { ignoreError: true });
  if (containerOutput) {
    return { ok: true };
  }

  switch (provider) {
    case "vllm-local":
      return {
        ok: false,
        message:
          "Local vLLM is responding on localhost, but containers cannot reach http://host.openshell.internal:8000. Ensure the server is reachable from containers, not only from the host shell.",
      };
    case "ollama-local":
      return {
        ok: false,
        message:
          "Local Ollama is responding on localhost, but containers cannot reach http://host.openshell.internal:11434. Ensure Ollama listens on 0.0.0.0:11434 instead of 127.0.0.1 so sandboxes can reach it.",
      };
    default:
      return { ok: false, message: "The selected local inference provider is unavailable from containers." };
  }
}

function parseOllamaList(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^NAME\s+/i.test(line))
    .map((line) => line.split(/\s{2,}/)[0])
    .filter(Boolean);
}

function parseOllamaTags(output) {
  try {
    const parsed = JSON.parse(String(output || ""));
    return Array.isArray(parsed?.models)
      ? parsed.models.map((model) => model && model.name).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function getOllamaModelOptions(runCapture) {
  const tagsOutput = runCapture("curl -sf http://localhost:11434/api/tags 2>/dev/null", { ignoreError: true });
  const tagsParsed = parseOllamaTags(tagsOutput);
  if (tagsParsed.length > 0) {
    return tagsParsed;
  }

  const listOutput = runCapture("ollama list 2>/dev/null", { ignoreError: true });
  return parseOllamaList(listOutput);
}

function getBootstrapOllamaModelOptions(gpu) {
  const options = [SMALL_OLLAMA_MODEL];
  if (gpu && gpu.totalMemoryMB >= LARGE_OLLAMA_MIN_MEMORY_MB) {
    options.push(DEFAULT_OLLAMA_MODEL);
  }
  return options;
}

function getDefaultOllamaModel(runCapture, gpu = null) {
  const models = getOllamaModelOptions(runCapture);
  if (models.length === 0) {
    const bootstrap = getBootstrapOllamaModelOptions(gpu);
    return bootstrap[0];
  }
  return models.includes(DEFAULT_OLLAMA_MODEL) ? DEFAULT_OLLAMA_MODEL : models[0];
}

function getOllamaWarmupCommand(model, keepAlive = "15m") {
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  return `nohup curl -s http://localhost:11434/api/generate -H 'Content-Type: application/json' -d ${shellQuote(payload)} >/dev/null 2>&1 &`;
}

function getOllamaProbeCommand(model, timeoutSeconds = 120, keepAlive = "15m") {
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  return `curl -sS --max-time ${timeoutSeconds} http://localhost:11434/api/generate -H 'Content-Type: application/json' -d ${shellQuote(payload)} 2>/dev/null`;
}

function validateOllamaModel(model, runCapture) {
  const output = runCapture(getOllamaProbeCommand(model), { ignoreError: true });
  if (!output) {
    return {
      ok: false,
      message:
        `Selected Ollama model '${model}' did not answer the local probe in time. ` +
        "It may still be loading, too large for the host, or otherwise unhealthy.",
    };
  }

  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
      return {
        ok: false,
        message: `Selected Ollama model '${model}' failed the local probe: ${parsed.error.trim()}`,
      };
    }
  } catch {}

  return { ok: true };
}

module.exports = {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_MODEL,
  HOST_GATEWAY_URL,
  LARGE_OLLAMA_MIN_MEMORY_MB,
  SMALL_OLLAMA_MODEL,
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getLocalProviderBaseUrl,
  getLocalProviderValidationBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaModelOptions,
  parseOllamaTags,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  parseOllamaList,
  validateOllamaModel,
  validateLocalProvider,
};
