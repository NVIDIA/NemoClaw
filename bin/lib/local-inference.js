// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// On macOS (Docker Desktop), host.docker.internal resolves to the host.
// On Linux, host.openshell.internal is injected by the network namespace.
const IS_MACOS = process.platform === "darwin";
const HOST_GATEWAY_URL = IS_MACOS
  ? "http://host.docker.internal"
  : "http://host.openshell.internal";
const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";

const LOCAL_PROVIDER_PORTS = {
  "vllm-local": 8000,
  "ollama-local": 11434,
  "omlx-local": 8080,
};

function getLocalProviderBaseUrl(provider) {
  const port = LOCAL_PROVIDER_PORTS[provider];
  if (!port) return null;
  return `${HOST_GATEWAY_URL}:${port}/v1`;
}

function getLocalProviderHealthCheck(provider) {
  const port = LOCAL_PROVIDER_PORTS[provider];
  if (!port) return null;
  if (provider === "ollama-local") {
    return `curl -sf http://localhost:${port}/api/tags 2>/dev/null`;
  }
  return `curl -sf http://localhost:${port}/v1/models 2>/dev/null`;
}

function getLocalProviderContainerReachabilityCheck(provider) {
  const port = LOCAL_PROVIDER_PORTS[provider];
  if (!port) return null;
  const addHost = IS_MACOS ? "" : "--add-host host.openshell.internal:host-gateway ";
  const hostUrl = IS_MACOS ? "host.docker.internal" : "host.openshell.internal";
  if (provider === "ollama-local") {
    return `docker run --rm ${addHost}${CONTAINER_REACHABILITY_IMAGE} -sf http://${hostUrl}:${port}/api/tags 2>/dev/null`;
  }
  return `docker run --rm ${addHost}${CONTAINER_REACHABILITY_IMAGE} -sf http://${hostUrl}:${port}/v1/models 2>/dev/null`;
}

function validateLocalProvider(provider, runCapture) {
  const command = getLocalProviderHealthCheck(provider);
  if (!command) {
    return { ok: true };
  }

  const output = runCapture(command, { ignoreError: true });
  if (!output) {
    const port = LOCAL_PROVIDER_PORTS[provider];
    const names = { "vllm-local": "vLLM", "ollama-local": "Ollama", "omlx-local": "oMLX" };
    const name = names[provider] || provider;
    return {
      ok: false,
      message: `Local ${name} was selected, but nothing is responding on http://localhost:${port}.`,
    };
  }

  const containerCommand = getLocalProviderContainerReachabilityCheck(provider);
  if (!containerCommand) {
    return { ok: true };
  }

  const containerOutput = runCapture(containerCommand, { ignoreError: true });
  if (containerOutput) {
    return { ok: true };
  }

  const port = LOCAL_PROVIDER_PORTS[provider];
  const hostUrl = IS_MACOS ? "host.docker.internal" : "host.openshell.internal";
  const names = { "vllm-local": "vLLM", "ollama-local": "Ollama", "omlx-local": "oMLX" };
  const name = names[provider] || provider;
  let hint = `Ensure the server is reachable from containers, not only from the host shell.`;
  if (provider === "ollama-local") {
    hint = "Ensure Ollama listens on 0.0.0.0:11434 instead of 127.0.0.1 so sandboxes can reach it.";
  }
  return {
    ok: false,
    message: `Local ${name} is responding on localhost, but containers cannot reach http://${hostUrl}:${port}. ${hint}`,
  };
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

function getOllamaModelOptions(runCapture) {
  const output = runCapture("ollama list 2>/dev/null", { ignoreError: true });
  const parsed = parseOllamaList(output);
  if (parsed.length > 0) {
    return parsed;
  }
  return [DEFAULT_OLLAMA_MODEL];
}

function getDefaultOllamaModel(runCapture) {
  const models = getOllamaModelOptions(runCapture);
  return models.includes(DEFAULT_OLLAMA_MODEL) ? DEFAULT_OLLAMA_MODEL : models[0];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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
