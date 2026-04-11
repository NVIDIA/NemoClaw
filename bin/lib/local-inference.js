// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const { isWsl } = require("./platform");
const { shellQuote } = require("./runner");

const HOST_GATEWAY_URL = "http://host.openshell.internal";
const DOCKER_DESKTOP_HOST_URL = "http://host.docker.internal:11434";
const DOCKER_DESKTOP_GATEWAY_URL = "http://gateway.docker.internal:11434";
const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";
const SMALL_OLLAMA_MODEL = "qwen2.5:7b";
const LARGE_OLLAMA_MIN_MEMORY_MB = 32768;
const OLLAMA_DEFAULT_SERVICE_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_CONTEXT_WINDOW = 4096;
const DEFAULT_OLLAMA_MAX_TOKENS = 4096;
const OPENCLAW_MIN_CONTEXT_WINDOW = 16000;
const LOCAL_PROVIDER_HTTP_TIMEOUT_SECONDS = 5;

function buildTimedCurlSf(url, timeoutSeconds = LOCAL_PROVIDER_HTTP_TIMEOUT_SECONDS) {
  return `curl -sf --max-time ${timeoutSeconds} ${url} 2>/dev/null`;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeOllamaServiceUrl(value) {
  const normalized = trimTrailingSlash(value);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    url.pathname = url.pathname.replace(/\/v1$/i, "") || "/";
    url.search = "";
    url.hash = "";
    return trimTrailingSlash(url.toString());
  } catch {
    return null;
  }
}

function buildOllamaEndpoint(source, hostUrl, routeUrl = hostUrl, routeCandidates = [routeUrl]) {
  const normalizedHostUrl = normalizeOllamaServiceUrl(hostUrl);
  const normalizedRouteUrl = normalizeOllamaServiceUrl(routeUrl);
  const normalizedRouteCandidates = unique(
    routeCandidates.map((candidate) => normalizeOllamaServiceUrl(candidate)),
  );
  if (!normalizedHostUrl || !normalizedRouteUrl) return null;

  const host = new URL(normalizedHostUrl);
  const target = `${host.hostname}${host.port ? `:${host.port}` : ""}`;
  const displayTarget =
    source === "wsl-host"
      ? `Windows host ${target}`
      : source === "override"
        ? `configured host ${target}`
        : target;

  return {
    source,
    displayTarget,
    hostUrl: normalizedHostUrl,
    routeUrl: normalizedRouteCandidates[0] || normalizedRouteUrl,
    routeCandidates:
      normalizedRouteCandidates.length > 0 ? normalizedRouteCandidates : [normalizedRouteUrl],
    tagsUrl: `${normalizedHostUrl}/api/tags`,
    generateUrl: `${normalizedHostUrl}/api/generate`,
    openaiBaseUrl: `${normalizedRouteCandidates[0] || normalizedRouteUrl}/v1`,
  };
}

function getOllamaRouteCandidates(endpoint) {
  return unique(
    endpoint?.routeCandidates?.length ? endpoint.routeCandidates : [endpoint?.routeUrl],
  );
}

function withResolvedOllamaRoute(endpoint, routeUrl) {
  const normalizedRouteUrl = normalizeOllamaServiceUrl(routeUrl);
  if (!endpoint || !normalizedRouteUrl) return endpoint;

  return {
    ...endpoint,
    routeUrl: normalizedRouteUrl,
    routeCandidates: unique([normalizedRouteUrl, ...getOllamaRouteCandidates(endpoint)]),
    openaiBaseUrl: `${normalizedRouteUrl}/v1`,
  };
}

function parseResolvConfNameservers(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^nameserver\s+/i.test(line))
    .map((line) => line.split(/\s+/)[1])
    .filter((value) => value && !/^127\./.test(value));
}

function parseDefaultGateway(output) {
  const line = String(output || "")
    .split(/\r?\n/)
    .find((entry) => /^default\s+/i.test(entry.trim()));
  if (!line) return null;

  const match = line.match(/\bvia\s+([^\s]+)/i);
  return match ? match[1] : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getOllamaOverrideEndpoint(opts = {}) {
  const env = opts.env ?? process.env;
  const overrideUrl = normalizeOllamaServiceUrl(env.NEMOCLAW_OLLAMA_BASE_URL);
  return overrideUrl ? buildOllamaEndpoint("override", overrideUrl) : null;
}

function getWslHostCandidates(opts = {}) {
  const env = opts.env ?? process.env;
  if (
    !isWsl({
      platform: opts.platform,
      env,
      release: opts.release,
      procVersion: opts.procVersion,
    })
  ) {
    return [];
  }

  let resolvConf = opts.resolvConf;
  if (resolvConf === undefined) {
    try {
      resolvConf = fs.readFileSync("/etc/resolv.conf", "utf-8");
    } catch {
      resolvConf = "";
    }
  }

  const routeOutput =
    opts.routeOutput !== undefined
      ? opts.routeOutput
      : typeof opts.runCapture === "function"
        ? opts.runCapture("ip route show default 2>/dev/null", { ignoreError: true })
        : "";

  return unique([...parseResolvConfNameservers(resolvConf), parseDefaultGateway(routeOutput)]);
}

function getOllamaEndpointCandidates(opts = {}) {
  const candidates = [];
  const overrideEndpoint = getOllamaOverrideEndpoint(opts);
  if (overrideEndpoint) {
    candidates.push(overrideEndpoint);
  }

  candidates.push(
    buildOllamaEndpoint("localhost", OLLAMA_DEFAULT_SERVICE_URL, `${HOST_GATEWAY_URL}:11434`),
  );

  for (const address of getWslHostCandidates(opts)) {
    const hostUrl = `http://${address}:11434`;
    const endpoint = buildOllamaEndpoint("wsl-host", hostUrl, DOCKER_DESKTOP_HOST_URL, [
      DOCKER_DESKTOP_HOST_URL,
      DOCKER_DESKTOP_GATEWAY_URL,
      hostUrl,
    ]);
    if (endpoint) {
      candidates.push(endpoint);
    }
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate) return false;
    const key = `${candidate.hostUrl}|${candidate.routeUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveOllamaEndpoint(runCapture, opts = {}) {
  if (typeof runCapture !== "function") {
    return getOllamaOverrideEndpoint(opts) || getOllamaEndpointCandidates(opts)[0] || null;
  }

  for (const candidate of getOllamaEndpointCandidates({ ...opts, runCapture })) {
    const output = runCapture(buildTimedCurlSf(candidate.tagsUrl), { ignoreError: true });
    if (output) {
      return candidate;
    }
  }

  return null;
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

function getLocalProviderBaseUrl(provider, opts = {}) {
  switch (provider) {
    case "vllm-local":
      return `${HOST_GATEWAY_URL}:8000/v1`;
    case "ollama-local": {
      const endpoint = opts.endpoint || resolveOllamaEndpoint(opts.runCapture, opts);
      return endpoint?.openaiBaseUrl || `${HOST_GATEWAY_URL}:11434/v1`;
    }
    default:
      return null;
  }
}

function getLocalProviderHealthCheck(provider, opts = {}) {
  switch (provider) {
    case "vllm-local":
      return buildTimedCurlSf("http://localhost:8000/v1/models");
    case "ollama-local": {
      const endpoint = opts.endpoint || resolveOllamaEndpoint(opts.runCapture, opts);
      return buildTimedCurlSf(endpoint?.tagsUrl || `${OLLAMA_DEFAULT_SERVICE_URL}/api/tags`);
    }
    default:
      return null;
  }
}

function getLocalProviderContainerReachabilityCheck(provider, opts = {}) {
  switch (provider) {
    case "vllm-local":
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:8000/v1/models 2>/dev/null`;
    case "ollama-local": {
      const endpoint = opts.endpoint || resolveOllamaEndpoint(opts.runCapture, opts);
      const routeUrl =
        opts.routeUrl || getOllamaRouteCandidates(endpoint)[0] || `${HOST_GATEWAY_URL}:11434`;
      const tagsUrl = `${routeUrl}/api/tags`;
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf ${tagsUrl} 2>/dev/null`;
    }
    default:
      return null;
  }
}

function resolveOllamaContainerRoute(endpoint, runCapture) {
  if (!endpoint || typeof runCapture !== "function") {
    return endpoint;
  }

  for (const routeUrl of getOllamaRouteCandidates(endpoint)) {
    const command = getLocalProviderContainerReachabilityCheck("ollama-local", {
      endpoint,
      routeUrl,
    });
    const output = runCapture(command, { ignoreError: true });
    if (output) {
      return withResolvedOllamaRoute(endpoint, routeUrl);
    }
  }

  return null;
}

function getUnavailableLocalProviderResult(provider, endpoint) {
  switch (provider) {
    case "vllm-local":
      return {
        ok: false,
        message: "Local vLLM was selected, but nothing is responding on http://localhost:8000.",
      };
    case "ollama-local": {
      const unavailableTarget = endpoint?.displayTarget || "localhost:11434";
      return {
        ok: false,
        message:
          `Local Ollama was selected, but nothing is responding on ${unavailableTarget}. ` +
          "Set NEMOCLAW_OLLAMA_BASE_URL if Ollama is reachable on a different host.",
      };
    }
    default:
      return { ok: false, message: "The selected local inference provider is unavailable." };
  }
}

function getContainerUnavailableLocalProviderResult(provider, endpoint) {
  switch (provider) {
    case "vllm-local":
      return {
        ok: false,
        message:
          "Local vLLM is responding on localhost, but containers cannot reach http://host.openshell.internal:8000. Ensure the server is reachable from containers, not only from the host shell.",
      };
    case "ollama-local": {
      const routeTargets = getOllamaRouteCandidates(endpoint);
      const message =
        endpoint?.source === "wsl-host" || endpoint?.source === "override"
          ? `Local Ollama is responding on ${endpoint.displayTarget}, but containers cannot reach ${routeTargets.join(", ")}. Ensure Docker Desktop hostnames are available and the Windows firewall allows access to that host and port from containers.`
          : "Local Ollama is responding on localhost, but containers cannot reach http://host.openshell.internal:11434. Ensure Ollama listens on 0.0.0.0:11434 instead of 127.0.0.1 so sandboxes can reach it.";
      return { ok: false, message };
    }
    default:
      return {
        ok: false,
        message: "The selected local inference provider is unavailable from containers.",
      };
  }
}

function validateContainerReachability(provider, runCapture, opts, endpoint) {
  if (provider === "ollama-local") {
    const resolvedEndpoint = resolveOllamaContainerRoute(endpoint, runCapture);
    if (resolvedEndpoint) {
      return opts.returnEndpoint ? { ok: true, endpoint: resolvedEndpoint } : { ok: true };
    }
    return getContainerUnavailableLocalProviderResult(provider, endpoint);
  }

  const containerCommand = getLocalProviderContainerReachabilityCheck(provider, {
    ...opts,
    runCapture,
    endpoint,
  });
  if (!containerCommand) {
    return { ok: true };
  }

  const containerOutput = runCapture(containerCommand, { ignoreError: true });
  if (containerOutput) {
    return { ok: true };
  }

  return getContainerUnavailableLocalProviderResult(provider, endpoint);
}

function validateLocalProvider(provider, runCapture, opts = {}) {
  const endpoint =
    provider === "ollama-local"
      ? opts.endpoint || resolveOllamaEndpoint(runCapture, opts)
      : opts.endpoint || null;
  const command = getLocalProviderHealthCheck(provider, { ...opts, runCapture, endpoint });
  if (!command) {
    return { ok: true };
  }

  const output =
    provider === "ollama-local" && endpoint && !opts.endpoint
      ? "resolved"
      : runCapture(command, { ignoreError: true });
  if (!output) {
    return getUnavailableLocalProviderResult(provider, endpoint);
  }

  return validateContainerReachability(provider, runCapture, opts, endpoint);
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

function parseOllamaTagsResponse(output) {
  try {
    const parsed = JSON.parse(String(output || ""));
    if (!Array.isArray(parsed?.models)) {
      return [];
    }
    return parsed.models.map((entry) => entry?.name).filter(Boolean);
  } catch {
    return [];
  }
}

function parseOllamaPsResponse(output, model) {
  try {
    const parsed = JSON.parse(String(output || ""));
    if (!Array.isArray(parsed?.models)) {
      return null;
    }

    const entry = parsed.models.find(
      (candidate) => candidate?.name === model || candidate?.model === model,
    );
    const contextLength = Number(entry?.context_length);
    return Number.isFinite(contextLength) && contextLength > 0 ? contextLength : null;
  } catch {
    return null;
  }
}

function parseOllamaNumCtx(value) {
  const match = String(value || "").match(/(?:^|\n)\s*(?:PARAMETER\s+)?num_ctx\s+([0-9]+)/im);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseOllamaShowResponse(output) {
  try {
    const parsed = JSON.parse(String(output || ""));
    const configuredContext =
      parseOllamaNumCtx(parsed?.parameters) || parseOllamaNumCtx(parsed?.modelfile);
    if (configuredContext) {
      return configuredContext;
    }

    const contextEntry = Object.entries(parsed?.model_info || {}).find(([key, value]) => {
      return /\.context_length$/i.test(key) && Number.isFinite(Number(value)) && Number(value) > 0;
    });

    return contextEntry ? Number(contextEntry[1]) : null;
  } catch {
    return null;
  }
}

function getOllamaModelContextWindow(runCapture, model, opts = {}) {
  if (typeof runCapture !== "function" || !model) {
    return null;
  }

  const endpoint = opts.endpoint || resolveOllamaEndpoint(runCapture, opts);
  const hostUrl = endpoint?.hostUrl || OLLAMA_DEFAULT_SERVICE_URL;
  const psOutput = runCapture(buildTimedCurlSf(`${hostUrl}/api/ps`), { ignoreError: true });
  const runningContext = parseOllamaPsResponse(psOutput, model);
  if (runningContext) {
    return runningContext;
  }

  const showPayload = JSON.stringify({ model });
  const showOutput = runCapture(
    `curl -sf --max-time ${LOCAL_PROVIDER_HTTP_TIMEOUT_SECONDS} ${hostUrl}/api/show -H 'Content-Type: application/json' -d ${shellQuote(showPayload)} 2>/dev/null`,
    { ignoreError: true },
  );
  return parseOllamaShowResponse(showOutput);
}

function getOllamaModelMetadata(runCapture, model, opts = {}) {
  const discoveredContextWindow = getOllamaModelContextWindow(runCapture, model, opts);
  const contextWindow = discoveredContextWindow || DEFAULT_OLLAMA_CONTEXT_WINDOW;
  return {
    contextWindow,
    maxTokens: Math.min(contextWindow, DEFAULT_OLLAMA_MAX_TOKENS),
  };
}

function validateOllamaOpenClawCompatibility(model, metadata = {}) {
  const contextWindow = Number(metadata?.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { ok: true };
  }

  if (contextWindow < OPENCLAW_MIN_CONTEXT_WINDOW) {
    return {
      ok: false,
      message:
        `Selected Ollama model '${model}' is configured with a ${contextWindow}-token context window, ` +
        `but OpenClaw requires at least ${OPENCLAW_MIN_CONTEXT_WINDOW} tokens for the main agent and TUI. ` +
        "Increase Ollama num_ctx or use a different model before onboarding.",
    };
  }

  return { ok: true };
}

function getOllamaModelOptions(runCapture, opts = {}) {
  const output = runCapture("ollama list 2>/dev/null", { ignoreError: true });
  const parsed = parseOllamaList(output);
  if (parsed.length > 0) {
    return parsed;
  }

  const endpoint = opts.endpoint || resolveOllamaEndpoint(runCapture, opts);
  if (endpoint) {
    const tags = runCapture(buildTimedCurlSf(endpoint.tagsUrl), { ignoreError: true });
    const apiParsed = parseOllamaTagsResponse(tags);
    if (apiParsed.length > 0) {
      return apiParsed;
    }
  }

  return [DEFAULT_OLLAMA_MODEL];
}

function getDefaultOllamaModel(runCapture, opts = {}) {
  const models = getOllamaModelOptions(runCapture, opts);
  return models.includes(DEFAULT_OLLAMA_MODEL) ? DEFAULT_OLLAMA_MODEL : models[0];
}

function getBootstrapOllamaModelOptions(gpu) {
  const options = [SMALL_OLLAMA_MODEL];
  if (gpu && gpu.totalMemoryMB >= LARGE_OLLAMA_MIN_MEMORY_MB) {
    options.push(DEFAULT_OLLAMA_MODEL);
  }
  return options;
}

function getOllamaWarmupCommand(model, opts = {}) {
  const optionBag = /** @type {Record<string, any>} */ (
    typeof opts === "object" && opts !== null ? opts : {}
  );
  const keepAlive = typeof opts === "string" ? opts : optionBag.keepAlive || "15m";
  const endpoint = optionBag.endpoint || null;
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  const generateUrl = endpoint?.generateUrl || `${OLLAMA_DEFAULT_SERVICE_URL}/api/generate`;
  return `nohup curl -s ${generateUrl} -H 'Content-Type: application/json' -d ${shellQuote(payload)} >/dev/null 2>&1 &`;
}

function getOllamaProbeCommand(model, opts = {}) {
  const optionBag = /** @type {Record<string, any>} */ (
    typeof opts === "object" && opts !== null ? opts : {}
  );
  const timeoutSeconds = typeof opts === "number" ? opts : optionBag.timeoutSeconds || 120;
  const keepAlive = optionBag.keepAlive || "15m";
  const endpoint = optionBag.endpoint || null;
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  const generateUrl = endpoint?.generateUrl || `${OLLAMA_DEFAULT_SERVICE_URL}/api/generate`;
  return `curl -sS --max-time ${timeoutSeconds} ${generateUrl} -H 'Content-Type: application/json' -d ${shellQuote(payload)} 2>/dev/null`;
}

function validateOllamaModel(model, runCapture, opts = {}) {
  const output = runCapture(getOllamaProbeCommand(model, opts), { ignoreError: true });
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
  } catch {
    // Ignore JSON parse errors; treat as successful if no error string is found
  }

  return { ok: true };
}

module.exports = {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_CONTEXT_WINDOW,
  HOST_GATEWAY_URL,
  OPENCLAW_MIN_CONTEXT_WINDOW,
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getLocalProviderBaseUrl,
  getLocalProviderValidationBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaModelContextWindow,
  getOllamaModelMetadata,
  getOllamaEndpointCandidates,
  getOllamaModelOptions,
  getOllamaOverrideEndpoint,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  getWslHostCandidates,
  parseDefaultGateway,
  parseOllamaList,
  parseOllamaNumCtx,
  parseOllamaPsResponse,
  parseOllamaShowResponse,
  parseOllamaTagsResponse,
  parseResolvConfNameservers,
  resolveOllamaEndpoint,
  resolveOllamaContainerRoute,
  validateOllamaModel,
  validateOllamaOpenClawCompatibility,
  validateLocalProvider,
};
