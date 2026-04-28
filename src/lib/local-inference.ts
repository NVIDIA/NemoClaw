// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local inference provider helpers — URL mappers, Ollama parsers,
 * health checks, and command generators for vLLM and Ollama.
 */

import type { CurlProbeResult } from "./http-probe";
import { runCurlProbe } from "./http-probe";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { shellQuote, runCapture } = require("./runner");

import { VLLM_PORT, OLLAMA_PORT, OLLAMA_PROXY_PORT } from "./ports";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isWsl } = require("./platform");

/** Port containers use to reach Ollama — proxy on non-WSL, direct on WSL2. */
export const OLLAMA_CONTAINER_PORT = isWsl() ? OLLAMA_PORT : OLLAMA_PROXY_PORT;

export const HOST_GATEWAY_URL = "http://host.openshell.internal";
export const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
export const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";
export const SMALL_OLLAMA_MODEL = "qwen2.5:7b";
export const LARGE_OLLAMA_MIN_MEMORY_MB = 32768;

export type RunCaptureFn = (cmd: string | string[], opts?: { ignoreError?: boolean }) => string;

export interface GpuInfo {
  totalMemoryMB: number;
}

export interface ValidationResult {
  ok: boolean;
  message?: string;
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
      return `http://127.0.0.1:${OLLAMA_PORT}/v1`;
    default:
      return null;
  }
}

export function getLocalProviderHealthEndpoint(provider: string): string | null {
  switch (provider) {
    case "vllm-local":
      return `http://127.0.0.1:${VLLM_PORT}/v1/models`;
    case "ollama-local":
      return `http://127.0.0.1:${OLLAMA_PORT}/api/tags`;
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
        "-sf",
        `http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}/api/tags`,
      ];
    default:
      return null;
  }
}

export function validateLocalProvider(
  provider: string,
  runCaptureImpl?: RunCaptureFn,
): ValidationResult {
  if (provider === "ollama-local") {
    const portValidation = validateOllamaPortConfiguration();
    if (!portValidation.ok) {
      return portValidation;
    }
  }

  const capture = runCaptureImpl ?? runCapture;
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
          message: `Local Ollama was selected, but nothing is responding on http://127.0.0.1:${OLLAMA_PORT}.`,
        };
      default:
        return { ok: false, message: "The selected local inference provider is unavailable." };
    }
  }

  const containerCommand = getLocalProviderContainerReachabilityCheck(provider);
  if (!containerCommand) {
    return { ok: true };
  }

  const containerOutput = capture(containerCommand, { ignoreError: true });
  if (containerOutput) {
    return { ok: true };
  }

  switch (provider) {
    case "vllm-local":
      return {
        ok: false,
        message: `Local vLLM is responding on 127.0.0.1, but containers cannot reach http://host.openshell.internal:${VLLM_PORT}. Ensure the server is reachable from containers, not only from the host shell.`,
      };
    case "ollama-local":
      return {
        ok: false,
        message: `Local Ollama is responding on 127.0.0.1, but containers cannot reach the auth proxy at http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}. Ensure the Ollama auth proxy is running.`,
      };
    default:
      return {
        ok: false,
        message: "The selected local inference provider is unavailable from containers.",
      };
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
  const tagsOutput = capture(["curl", "-sf", `http://127.0.0.1:${OLLAMA_PORT}/api/tags`], {
    ignoreError: true,
  });
  const tagsParsed = parseOllamaTags(tagsOutput);
  if (tagsParsed.length > 0) {
    return tagsParsed;
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
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  // backgrounding (nohup ... &) and output redirection require a shell wrapper.
  // The payload is safe: model name is JSON-serialized (escaping all special
  // chars) then shellQuote'd (single-quoted), so injection through model
  // names is not feasible. This is the one intentional bash -c exception.
  return [
    "bash",
    "-c",
    `nohup curl -s http://127.0.0.1:${OLLAMA_PORT}/api/generate -H 'Content-Type: application/json' -d ${shellQuote(payload)} >/dev/null 2>&1 &`,
  ];
}

export function getOllamaProbeCommand(
  model: string,
  timeoutSeconds = 120,
  keepAlive = "15m",
): string[] {
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  return [
    "curl",
    "-sS",
    "--max-time",
    String(timeoutSeconds),
    `http://127.0.0.1:${OLLAMA_PORT}/api/generate`,
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
  const output = capture(getOllamaProbeCommand(model), { ignoreError: true });
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
