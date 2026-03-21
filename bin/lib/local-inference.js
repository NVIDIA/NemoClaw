// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { isWsl } = require("./platform");
const { execSync } = require("child_process");

const HOST_GATEWAY_URL = "http://host.openshell.internal";
const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";

// ── WSL2 networking ─────────────────────────────────────────────
// On WSL2, containers use host.docker.internal to reach host services.
// On non-WSL, containers use host.openshell.internal via host-gateway.

let _wsl2HostIp = null;
function getWsl2HostIp() {
  if (_wsl2HostIp !== null) return _wsl2HostIp;
  if (!isWsl()) {
    _wsl2HostIp = "";
    return _wsl2HostIp;
  }
  try {
    _wsl2HostIp = execSync(
      "ip addr show eth0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1",
      { encoding: "utf-8" }
    ).trim();
  } catch {
    _wsl2HostIp = "";
  }
  return _wsl2HostIp;
}

function getHostUrl() {
  if (isWsl()) return "http://host.docker.internal";
  return HOST_GATEWAY_URL;
}

// ── Provider URL routing ────────────────────────────────────────

function getLocalProviderBaseUrl(provider) {
  const hostUrl = getHostUrl();
  switch (provider) {
    case "vllm-local":
      return `${hostUrl}:8000/v1`;
    case "ollama-local":
      return `${hostUrl}:11434/v1`;
    case "lmstudio-local":
      return `${hostUrl}:1234/v1`;
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
    case "lmstudio-local":
      return "curl -sf http://localhost:1234/v1/models 2>/dev/null";
    default:
      return null;
  }
}

function getLocalProviderContainerReachabilityCheck(provider) {
  const wsl = isWsl();
  const hostFlag = wsl
    ? ["--add-host", "host.docker.internal:host-gateway"]
    : ["--add-host", "host.openshell.internal:host-gateway"];
  const hostUrl = wsl ? "http://host.docker.internal" : "http://host.openshell.internal";
  const baseArgs = ["docker", "run", "--rm", ...hostFlag, CONTAINER_REACHABILITY_IMAGE, "-sf"];
  switch (provider) {
    case "vllm-local":
      return [...baseArgs, `${hostUrl}:8000/v1/models`].join(" ") + " 2>/dev/null";
    case "ollama-local":
      return [...baseArgs, `${hostUrl}:11434/api/tags`].join(" ") + " 2>/dev/null";
    case "lmstudio-local":
      return [...baseArgs, `${hostUrl}:1234/v1/models`].join(" ") + " 2>/dev/null";
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
      case "lmstudio-local":
        return {
          ok: false,
          message: "LM Studio was selected, but nothing is responding on http://localhost:1234.",
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
          "Local Ollama is responding on localhost, but containers cannot reach it. Ensure Ollama listens on 0.0.0.0:11434 instead of 127.0.0.1 so sandboxes can reach it.",
      };
    case "lmstudio-local":
      return {
        ok: false,
        message:
          "LM Studio is responding on localhost, but containers cannot reach it. Ensure LM Studio's server is bound to 0.0.0.0:1234.",
      };
    default:
      return { ok: false, message: "The selected local inference provider is unavailable from containers." };
  }
}

// ── Ollama binding check (WSL2) ─────────────────────────────────

function isOllamaBoundToAllInterfaces(runCapture) {
  const output = runCapture(
    "ss -tlnp 2>/dev/null | grep ':11434' | grep -E '\\*:|0\\.0\\.0\\.0:' && echo ok || true",
    { ignoreError: true }
  );
  return output && output.includes("ok");
}

// ── VRAM-aware model recommendation ─────────────────────────────

const OLLAMA_VRAM_TIERS = require("./ollama-models.json");

function getRecommendedOllamaModel(vramMB) {
  return OLLAMA_VRAM_TIERS.find((t) => vramMB >= t.minMB) || OLLAMA_VRAM_TIERS[OLLAMA_VRAM_TIERS.length - 1];
}

// ── Ollama model management ─────────────────────────────────────

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
  OLLAMA_VRAM_TIERS,
  getDefaultOllamaModel,
  getHostUrl,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  getRecommendedOllamaModel,
  getWsl2HostIp,
  isOllamaBoundToAllInterfaces,
  parseOllamaList,
  validateOllamaModel,
  validateLocalProvider,
};
