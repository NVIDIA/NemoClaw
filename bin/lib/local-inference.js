// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { VLLM_PORT, OLLAMA_PORT } = require("./ports");
const { shellQuote } = require("./runner");

const HOST_GATEWAY_URL = "http://host.openshell.internal";
const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";

/** Return the base URL a sandbox uses to reach a local inference provider. */
function getLocalProviderBaseUrl(provider) {
  switch (provider) {
    case "vllm-local":
      return `${HOST_GATEWAY_URL}:${VLLM_PORT}/v1`;
    case "ollama-local":
      return `${HOST_GATEWAY_URL}:${OLLAMA_PORT}/v1`;
    default:
      return null;
  }
}

/** Return a curl command to check if a local provider is responding on localhost. */
function getLocalProviderHealthCheck(provider) {
  switch (provider) {
    case "vllm-local":
      return `curl -sf http://localhost:${VLLM_PORT}/v1/models 2>/dev/null`;
    case "ollama-local":
      return `curl -sf http://localhost:${OLLAMA_PORT}/api/tags 2>/dev/null`;
    default:
      return null;
  }
}

/** Return a docker curl command to verify a provider is reachable from containers. */
function getLocalProviderContainerReachabilityCheck(provider) {
  switch (provider) {
    case "vllm-local":
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:${VLLM_PORT}/v1/models 2>/dev/null`;
    case "ollama-local":
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:${OLLAMA_PORT}/api/tags 2>/dev/null`;
    default:
      return null;
  }
}

/** Validate that a local provider is responding on both localhost and from containers. */
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
          message: `Local vLLM was selected, but nothing is responding on http://localhost:${VLLM_PORT}.`,
        };
      case "ollama-local":
        return {
          ok: false,
          message: `Local Ollama was selected, but nothing is responding on http://localhost:${OLLAMA_PORT}.`,
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
          `Local vLLM is responding on localhost, but containers cannot reach http://host.openshell.internal:${VLLM_PORT}. Ensure the server is reachable from containers, not only from the host shell.`,
      };
    case "ollama-local":
      return {
        ok: false,
        message:
          `Local Ollama is responding on localhost, but containers cannot reach http://host.openshell.internal:${OLLAMA_PORT}. Ensure Ollama listens on 0.0.0.0:${OLLAMA_PORT} instead of 127.0.0.1 so sandboxes can reach it.`,
      };
    default:
      return { ok: false, message: "The selected local inference provider is unavailable from containers." };
  }
}

/** Parse `ollama list` output into an array of model name strings. */
function parseOllamaList(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^NAME\s+/i.test(line))
    .map((line) => line.split(/\s{2,}/)[0])
    .filter(Boolean);
}

/** Return available Ollama models, falling back to the default if none are listed. */
function getOllamaModelOptions(runCapture) {
  const output = runCapture("ollama list 2>/dev/null", { ignoreError: true });
  const parsed = parseOllamaList(output);
  if (parsed.length > 0) {
    return parsed;
  }
  return [DEFAULT_OLLAMA_MODEL];
}

/** Return the preferred Ollama model, or the first available one. */
function getDefaultOllamaModel(runCapture) {
  const models = getOllamaModelOptions(runCapture);
  return models.includes(DEFAULT_OLLAMA_MODEL) ? DEFAULT_OLLAMA_MODEL : models[0];
}

/** Build a background curl command that warms up an Ollama model. */
function getOllamaWarmupCommand(model, keepAlive = "15m") {
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  return `nohup curl -s http://localhost:${OLLAMA_PORT}/api/generate -H 'Content-Type: application/json' -d ${shellQuote(payload)} >/dev/null 2>&1 &`;
}

/** Build a foreground curl command that probes an Ollama model with a timeout. */
function getOllamaProbeCommand(model, timeoutSeconds = 120, keepAlive = "15m") {
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  return `curl -sS --max-time ${timeoutSeconds} http://localhost:${OLLAMA_PORT}/api/generate -H 'Content-Type: application/json' -d ${shellQuote(payload)} 2>/dev/null`;
}

/** Probe an Ollama model and return { ok, message } indicating whether it responded. */
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
  getDefaultOllamaModel,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  parseOllamaList,
  validateOllamaModel,
  validateLocalProvider,
};
