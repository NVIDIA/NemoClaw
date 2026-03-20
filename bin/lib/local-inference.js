// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HOST_GATEWAY_URL = "http://host.openshell.internal";
const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";

// token-overdrive: llama.cpp DMR router (OpenAI-compatible, port 8101, Metal-accelerated)
const YAMA_PORT = 8101;
const DEFAULT_YAMA_MODEL = "qwen35-35b-a3b"; // 60 tps on Apple Silicon

function getLocalProviderBaseUrl(provider) {
  switch (provider) {
    case "vllm-local":
      return `${HOST_GATEWAY_URL}:8000/v1`;
    case "ollama-local":
      return `${HOST_GATEWAY_URL}:11434/v1`;
    case "token-overdrive":
      return `${HOST_GATEWAY_URL}:${YAMA_PORT}/v1`;
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
    case "token-overdrive":
      return `curl -sf http://localhost:${YAMA_PORT}/v1/models 2>/dev/null`;
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
    case "token-overdrive":
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:${YAMA_PORT}/v1/models 2>/dev/null`;
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
      case "token-overdrive":
        return {
          ok: false,
          message: `Local yama (llama.cpp DMR router) was selected, but nothing is responding on http://localhost:${YAMA_PORT}. Start the router with: python3 scripts/run_dmr_router_workflow.py --model <model-id>`,
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
    case "token-overdrive":
      return {
        ok: false,
        message:
          `Local yama router is responding on localhost, but containers cannot reach http://host.openshell.internal:${YAMA_PORT}. Ensure llama-server binds to 0.0.0.0:${YAMA_PORT} (add --host 0.0.0.0 to the router preset).`,
      };
    default:
      return { ok: false, message: "The selected local inference provider is unavailable from containers." };
  }
}

function getYamaModelOptions(runCapture) {
  const output = runCapture(`curl -sf http://localhost:${YAMA_PORT}/v1/models 2>/dev/null`, { ignoreError: true });
  if (!output) return [DEFAULT_YAMA_MODEL];
  try {
    const parsed = JSON.parse(output);
    const ids = (parsed.data || []).map((m) => m.id).filter(Boolean);
    return ids.length > 0 ? ids : [DEFAULT_YAMA_MODEL];
  } catch {
    return [DEFAULT_YAMA_MODEL];
  }
}

function getDefaultYamaModel(runCapture) {
  const models = getYamaModelOptions(runCapture);
  return models.includes(DEFAULT_YAMA_MODEL) ? DEFAULT_YAMA_MODEL : models[0];
}

function getYamaProbeCommand(model, timeoutSeconds = 30) {
  const payload = JSON.stringify({
    model,
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 8,
    stream: false,
  });
  return `curl -sS --max-time ${timeoutSeconds} http://localhost:${YAMA_PORT}/v1/chat/completions -H 'Content-Type: application/json' -d '${payload.replace(/'/g, "'\\''")}' 2>/dev/null`;
}

function validateYamaModel(model, runCapture) {
  const output = runCapture(getYamaProbeCommand(model), { ignoreError: true });
  if (!output) {
    return {
      ok: false,
      message:
        `yama model '${model}' did not answer the probe. The DMR router may need to load it first. ` +
        `Run: python3 scripts/run_dmr_router_workflow.py --model ${model}`,
    };
  }
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
      return { ok: false, message: `yama model '${model}' probe failed: ${parsed.error.trim()}` };
    }
  } catch {}
  return { ok: true };
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
  DEFAULT_YAMA_MODEL,
  HOST_GATEWAY_URL,
  YAMA_PORT,
  getDefaultOllamaModel,
  getDefaultYamaModel,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  getYamaModelOptions,
  getYamaProbeCommand,
  parseOllamaList,
  validateOllamaModel,
  validateYamaModel,
  validateLocalProvider,
};
