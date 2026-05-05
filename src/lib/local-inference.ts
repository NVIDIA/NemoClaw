// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local inference provider helpers — URL mappers, Ollama parsers,
 * health checks, and command generators for vLLM and Ollama.
 */

import type { CurlProbeResult } from "./http-probe";
import { runCurlProbe } from "./http-probe";

const { shellQuote, runCapture } = require("./runner");

import { VLLM_PORT, OLLAMA_PORT, OLLAMA_PROXY_PORT } from "./ports";
import { sleepSeconds } from "./wait";

const { isWsl } = require("./platform");

/** Port containers use to reach Ollama — proxy on non-WSL, direct on WSL2. */
export const OLLAMA_CONTAINER_PORT = isWsl() ? OLLAMA_PORT : OLLAMA_PROXY_PORT;

export const HOST_GATEWAY_URL = "http://host.openshell.internal";
export const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
export const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";
export const SMALL_OLLAMA_MODEL = "qwen2.5:7b";
export const LARGE_OLLAMA_MIN_MEMORY_MB = 32768;

export type RunCaptureFn = (cmd: string | string[], opts?: { ignoreError?: boolean }) => string;

// Hosts that the WSL-side onboard CLI tries when probing Ollama. Native Linux
// and macOS only ever reach Ollama on the local loopback. WSL with Docker
// Desktop can also reach a Windows-host Ollama through the docker-desktop
// integration's `host.docker.internal` alias when Ollama is bound to a
// non-loopback interface (typically OLLAMA_HOST=0.0.0.0).
export const OLLAMA_LOCALHOST = "127.0.0.1";
export const OLLAMA_HOST_DOCKER_INTERNAL = "host.docker.internal";

let _resolvedOllamaHost: string | null = null;

function ollamaCandidateHosts(): string[] {
  return isWsl() ? [OLLAMA_LOCALHOST, OLLAMA_HOST_DOCKER_INTERNAL] : [OLLAMA_LOCALHOST];
}

// Probe each candidate host for a responding Ollama. Returns the first host
// whose `/api/tags` succeeds, or null if none responds. Result is cached for
// the rest of the onboard run; call resetOllamaHostCache() in tests.
export function findReachableOllamaHost(runCaptureImpl?: RunCaptureFn): string | null {
  if (_resolvedOllamaHost !== null) return _resolvedOllamaHost;
  const capture = runCaptureImpl ?? runCapture;
  for (const host of ollamaCandidateHosts()) {
    // Explicit timeouts: a blackholed host (e.g., firewalled host.docker.internal)
    // would otherwise stall the synchronous onboard probe for the OS connect
    // timeout (~75-130s on Linux). Matches the convention used in
    // getLocalProviderHealthStatus probes.
    const result = capture(
      [
        "curl",
        "-sf",
        "--connect-timeout",
        "3",
        "--max-time",
        "5",
        `http://${host}:${OLLAMA_PORT}/api/tags`,
      ],
      { ignoreError: true },
    );
    if (result) {
      _resolvedOllamaHost = host;
      return host;
    }
  }
  return null;
}

// Returns the resolved host if a probe has succeeded, otherwise OLLAMA_LOCALHOST.
// Used by URL-builder helpers that need a string and don't want to re-probe.
export function getResolvedOllamaHost(): string {
  return _resolvedOllamaHost ?? OLLAMA_LOCALHOST;
}

export function resetOllamaHostCache(): void {
  _resolvedOllamaHost = null;
}

// Explicitly pin the resolved host without probing. Used after a deliberate
// switch (e.g., user picked the Windows-host launch flow).
export function setResolvedOllamaHost(host: string): void {
  _resolvedOllamaHost = host;
}

export interface GpuInfo {
  totalMemoryMB: number;
}

export interface ValidationResult {
  ok: boolean;
  message?: string;
  diagnostic?: string;
}

export interface LocalProviderHealthStatus {
  ok: boolean;
  providerLabel: string;
  endpoint: string;
  detail: string;
}

export interface LocalProviderHealthProbeOptions {
  runCurlProbeImpl?: (argv: string[]) => CurlProbeResult;
}

export function validateOllamaPortConfiguration(): ValidationResult {
  if (!isWsl() && OLLAMA_PORT === OLLAMA_PROXY_PORT) {
    return {
      ok: false,
      message:
        `NEMOCLAW_OLLAMA_PORT and NEMOCLAW_OLLAMA_PROXY_PORT both resolve to ${OLLAMA_PORT}. ` +
        "Run Ollama on a different port or set NEMOCLAW_OLLAMA_PROXY_PORT to a free port so " +
        "the auth proxy does not route back to itself.",
    };
  }

  return { ok: true };
}

export function getLocalProviderBaseUrl(provider: string): string | null {
  switch (provider) {
    case "vllm-local":
      return `${HOST_GATEWAY_URL}:${VLLM_PORT}/v1`;
    case "ollama-local":
      // Containers reach Ollama through the auth proxy, not directly.
      return `${HOST_GATEWAY_URL}:${OLLAMA_CONTAINER_PORT}/v1`;
    default:
      return null;
  }
}

export function getLocalProviderValidationBaseUrl(provider: string): string | null {
  switch (provider) {
    case "vllm-local":
      return `http://127.0.0.1:${VLLM_PORT}/v1`;
    case "ollama-local":
      return `http://${getResolvedOllamaHost()}:${OLLAMA_PORT}/v1`;
    default:
      return null;
  }
}

export function getLocalProviderHealthEndpoint(provider: string): string | null {
  switch (provider) {
    case "vllm-local":
      return `http://127.0.0.1:${VLLM_PORT}/v1/models`;
    case "ollama-local":
      return `http://${getResolvedOllamaHost()}:${OLLAMA_PORT}/api/tags`;
    default:
      return null;
  }
}

export function getLocalProviderHealthCheck(provider: string): string[] | null {
  const endpoint = getLocalProviderHealthEndpoint(provider);
  return endpoint ? ["curl", "-sf", endpoint] : null;
}

export function getLocalProviderLabel(provider: string): string | null {
  switch (provider) {
    case "vllm-local":
      return "Local vLLM";
    case "ollama-local":
      return "Local Ollama";
    default:
      return null;
  }
}

function buildLocalProviderProbeDetail(
  provider: string,
  endpoint: string,
  result: CurlProbeResult,
): string {
  const label = getLocalProviderLabel(provider) || "Local inference provider";
  if (result.httpStatus === 0) {
    switch (provider) {
      case "ollama-local":
        return (
          `${label} is selected for inference, but the host probe to ${endpoint} failed. ` +
          `Start Ollama and retry. (${result.message})`
        );
      case "vllm-local":
        return (
          `${label} is selected for inference, but the host probe to ${endpoint} failed. ` +
          `Start the local vLLM server and retry. (${result.message})`
        );
      default:
        return `${label} is selected for inference, but the host probe to ${endpoint} failed. (${result.message})`;
    }
  }
  return `${label} is reachable on ${endpoint}, but the health probe failed. (${result.message})`;
}

export function probeLocalProviderHealth(
  provider: string,
  options: LocalProviderHealthProbeOptions = {},
): LocalProviderHealthStatus | null {
  const endpoint = getLocalProviderHealthEndpoint(provider);
  const providerLabel = getLocalProviderLabel(provider);
  if (!endpoint || !providerLabel) {
    return null;
  }

  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const result = runCurlProbeImpl(["-sS", "--connect-timeout", "3", "--max-time", "5", endpoint]);

  if (result.ok) {
    return {
      ok: true,
      providerLabel,
      endpoint,
      detail: `${providerLabel} is reachable on ${endpoint}.`,
    };
  }

  return {
    ok: false,
    providerLabel,
    endpoint,
    detail: buildLocalProviderProbeDetail(provider, endpoint, result),
  };
}

export function getLocalProviderContainerReachabilityCheck(provider: string): string[] | null {
  switch (provider) {
    case "vllm-local":
      return [
        "docker",
        "run",
        "--rm",
        "--add-host",
        "host.openshell.internal:host-gateway",
        CONTAINER_REACHABILITY_IMAGE,
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        "-sf",
        `http://host.openshell.internal:${VLLM_PORT}/v1/models`,
      ];
    case "ollama-local":
      // Check the auth proxy port, not Ollama directly. The proxy listens
      // on 0.0.0.0 and is reachable from containers; Ollama is on 127.0.0.1.
      return [
        "docker",
        "run",
        "--rm",
        "--add-host",
        "host.openshell.internal:host-gateway",
        CONTAINER_REACHABILITY_IMAGE,
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        "-sf",
        `http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}/api/tags`,
      ];
    default:
      return null;
  }
}

const CONTAINER_CHECK_MAX_ATTEMPTS = 3;
const CONTAINER_CHECK_RETRY_DELAY_SECS = 2;

export function validateLocalProvider(
  provider: string,
  runCaptureImpl?: RunCaptureFn,
  sleepFn?: (seconds: number) => void,
): ValidationResult {
  if (provider === "ollama-local") {
    const portValidation = validateOllamaPortConfiguration();
    if (!portValidation.ok) {
      return portValidation;
    }
  }

  const capture = runCaptureImpl ?? runCapture;
  const sleep = sleepFn ?? sleepSeconds;
  const command = getLocalProviderHealthCheck(provider);
  if (!command) {
    return { ok: true };
  }

  const output = capture(command, { ignoreError: true });
  if (!output) {
    switch (provider) {
      case "vllm-local":
        return {
          ok: false,
          message: `Local vLLM was selected, but nothing is responding on http://127.0.0.1:${VLLM_PORT}.`,
        };
      case "ollama-local":
        return {
          ok: false,
          message: `Local Ollama was selected, but nothing is responding on http://${getResolvedOllamaHost()}:${OLLAMA_PORT}.`,
        };
      default:
        return { ok: false, message: "The selected local inference provider is unavailable." };
    }
  }

  const containerCommand = getLocalProviderContainerReachabilityCheck(provider);
  if (!containerCommand) {
    return { ok: true };
  }

  // Retry container reachability check with backoff
  for (let attempt = 1; attempt <= CONTAINER_CHECK_MAX_ATTEMPTS; attempt++) {
    const containerOutput = capture(containerCommand, { ignoreError: true });
    if (containerOutput) {
      return { ok: true };
    }
    if (attempt < CONTAINER_CHECK_MAX_ATTEMPTS) {
      sleep(CONTAINER_CHECK_RETRY_DELAY_SECS);
    }
  }

  // All retries exhausted — collect diagnostics
  const diagnostic = collectContainerDiagnostic(provider, capture);

  switch (provider) {
    case "vllm-local":
      return {
        ok: false,
        message: `Local vLLM is responding on 127.0.0.1, but the Docker container reachability check failed for http://host.openshell.internal:${VLLM_PORT}. This may be a Docker networking issue — the sandbox uses a different network path and may still work.`,
        diagnostic,
      };
    case "ollama-local":
      return {
        ok: false,
        message: `Local Ollama is responding on ${getResolvedOllamaHost()}, but the Docker container reachability check failed for http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}. This may be a Docker networking issue — the sandbox uses a different network path and may still work.`,
        diagnostic,
      };
    default:
      return {
        ok: false,
        message: "The selected local inference provider is unavailable from containers.",
        diagnostic,
      };
  }
}

function getContainerCheckUrl(provider: string): string {
  switch (provider) {
    case "vllm-local":
      return `http://host.openshell.internal:${VLLM_PORT}/v1/models`;
    case "ollama-local":
      return `http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}/api/tags`;
    default:
      return "http://host.openshell.internal/";
  }
}

function collectContainerDiagnostic(provider: string, capture: RunCaptureFn): string {
  const url = getContainerCheckUrl(provider);
  try {
    // Get HTTP status code
    const httpStatus = capture(
      [
        "docker", "run", "--rm",
        "--add-host", "host.openshell.internal:host-gateway",
        CONTAINER_REACHABILITY_IMAGE,
        "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "--connect-timeout", "5", "--max-time", "10",
        url,
      ],
      { ignoreError: true },
    );

    // Get /etc/hosts to see host-gateway resolution
    const hostsOutput = capture(
      [
        "docker", "run", "--rm",
        "--add-host", "host.openshell.internal:host-gateway",
        CONTAINER_REACHABILITY_IMAGE,
        "cat", "/etc/hosts",
      ],
      { ignoreError: true },
    );

    if (!httpStatus && !hostsOutput) {
      return `Docker command failed (image pull error or runtime failure). Retried ${CONTAINER_CHECK_MAX_ATTEMPTS} times.`;
    }

    const parts: string[] = [];
    if (httpStatus) {
      parts.push(`Container curl returned HTTP ${httpStatus.trim()}`);
    }
    if (hostsOutput) {
      const gwLine = hostsOutput.split(/\r?\n/).find((l: string) => l.includes("host.openshell.internal"));
      if (gwLine) {
        const ip = gwLine.trim().split(/\s+/)[0];
        parts.push(`host-gateway resolved to: ${ip}`);
      }
    }
    parts.push(`Retried ${CONTAINER_CHECK_MAX_ATTEMPTS} times over ~${(CONTAINER_CHECK_MAX_ATTEMPTS - 1) * CONTAINER_CHECK_RETRY_DELAY_SECS}s`);
    return parts.join(". ") + ".";
  } catch {
    return `Docker command failed (image pull error or runtime failure). Retried ${CONTAINER_CHECK_MAX_ATTEMPTS} times.`;
  }
}

export function parseOllamaList(output: string | null | undefined): string[] {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^NAME\s+/i.test(line))
    .map((line) => line.split(/\s{2,}/)[0])
    .filter(Boolean);
}

export function parseOllamaTags(output: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(String(output || ""));
    return Array.isArray(parsed?.models)
      ? parsed.models.map((model: { name?: string }) => model && model.name).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

export function getOllamaModelOptions(runCaptureImpl?: RunCaptureFn): string[] {
  const capture = runCaptureImpl ?? runCapture;
  const host = getResolvedOllamaHost();
  const tagsOutput = capture(
    [
      "curl",
      "-sf",
      "--connect-timeout",
      "3",
      "--max-time",
      "5",
      `http://${host}:${OLLAMA_PORT}/api/tags`,
    ],
    { ignoreError: true },
  );
  const tagsParsed = parseOllamaTags(tagsOutput);
  if (tagsParsed.length > 0) {
    return tagsParsed;
  }

  // The `ollama list` CLI fallback talks to the local daemon. Skip it when
  // the resolved host is not loopback (e.g. host.docker.internal pointing
  // at the Windows-host daemon) — otherwise we would surface WSL models
  // and skip pulling them on the Windows host, then fail validation.
  if (host !== OLLAMA_LOCALHOST) {
    return [];
  }
  const listOutput = capture(["ollama", "list"], { ignoreError: true });
  return parseOllamaList(listOutput);
}

export function getBootstrapOllamaModelOptions(gpu: GpuInfo | null): string[] {
  const options = [SMALL_OLLAMA_MODEL];
  if (gpu && gpu.totalMemoryMB >= LARGE_OLLAMA_MIN_MEMORY_MB) {
    options.push(DEFAULT_OLLAMA_MODEL);
  }
  return options;
}

export function getDefaultOllamaModel(
  gpu: GpuInfo | null = null,
  runCaptureImpl?: RunCaptureFn,
): string {
  const models = getOllamaModelOptions(runCaptureImpl);
  if (models.length === 0) {
    const bootstrap = getBootstrapOllamaModelOptions(gpu);
    return bootstrap[0];
  }
  return models.includes(DEFAULT_OLLAMA_MODEL) ? DEFAULT_OLLAMA_MODEL : models[0];
}

export function getOllamaWarmupCommand(model: string, keepAlive = "15m"): string[] {
  const payload = JSON.stringify({
    model,
    prompt: "Hello, reply in less than 5 words",
    stream: false,
    keep_alive: keepAlive,
    options: { num_predict: 16 },
  });
  const host = getResolvedOllamaHost();
  // backgrounding (nohup ... &) and output redirection require a shell wrapper.
  // The payload is safe: model name is JSON-serialized (escaping all special
  // chars) then shellQuote'd (single-quoted), so injection through model
  // names is not feasible. This is the one intentional bash -c exception.
  return [
    "bash",
    "-c",
    `nohup curl -s http://${host}:${OLLAMA_PORT}/api/generate -H 'Content-Type: application/json' -d ${shellQuote(payload)} >/dev/null 2>&1 &`,
  ];
}

export function getOllamaProbeCommand(
  model: string,
  timeoutSeconds = 120,
  keepAlive = "15m",
): string[] {
  const payload = JSON.stringify({
    model,
    prompt: "Hello, reply in less than 5 words",
    stream: false,
    keep_alive: keepAlive,
    options: { num_predict: 16 },
  });
  const host = getResolvedOllamaHost();
  return [
    "curl",
    "-sS",
    "--max-time",
    String(timeoutSeconds),
    `http://${host}:${OLLAMA_PORT}/api/generate`,
    "-H",
    "Content-Type: application/json",
    "-d",
    payload,
  ];
}

export function validateOllamaModel(
  model: string,
  runCaptureImpl?: RunCaptureFn,
): ValidationResult {
  const capture = runCaptureImpl ?? runCapture;
  const probeCmd = getOllamaProbeCommand(model);
  const output = capture(probeCmd, { ignoreError: true });
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
    /* ignored */
  }

  return { ok: true };
}
