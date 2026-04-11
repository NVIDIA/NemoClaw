// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local inference provider helpers — URL mappers, Ollama parsers,
 * health checks, and command generators for vLLM and Ollama.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { shellQuote } = require("../../bin/lib/runner");

export const HOST_GATEWAY_URL = "http://host.openshell.internal";
export const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
export const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";
export const SMALL_OLLAMA_MODEL = "qwen2.5:7b";
export const LARGE_OLLAMA_MIN_MEMORY_MB = 32768;

export type RunCaptureFn = (cmd: string, opts?: { ignoreError?: boolean }) => string;

export interface GpuInfo {
  totalMemoryMB: number;
}

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

/**
 * Build the base URL for a local inference provider.
 * @param hostIp — When provided, use this IPv4 address instead of
 *   `host.openshell.internal`.  On WSL2 + Docker Desktop the gateway
 *   hostname is unreachable, so callers should pass the WSL2 eth0 IP.
 */
export function getLocalProviderBaseUrl(provider: string, hostIp?: string): string | null {
  const host = hostIp ? `http://${hostIp}` : HOST_GATEWAY_URL;
  switch (provider) {
    case "vllm-local":
      return `${host}:8000/v1`;
    case "ollama-local":
      return `${host}:11434/v1`;
    default:
      return null;
  }
}

export function getLocalProviderValidationBaseUrl(provider: string): string | null {
  switch (provider) {
    case "vllm-local":
      return "http://localhost:8000/v1";
    case "ollama-local":
      return "http://localhost:11434/v1";
    default:
      return null;
  }
}

export function getLocalProviderHealthCheck(provider: string): string | null {
  switch (provider) {
    case "vllm-local":
      return "curl -sf http://localhost:8000/v1/models 2>/dev/null";
    case "ollama-local":
      return "curl -sf http://localhost:11434/api/tags 2>/dev/null";
    default:
      return null;
  }
}

/**
 * Build a container reachability check command.
 * @param hostIp — When provided, `--add-host` maps to this explicit IPv4
 *   instead of `host-gateway`.  On Docker Desktop / WSL2, `host-gateway`
 *   resolves to an IPv6 ULA or an un-routable gateway IP, so callers
 *   should resolve the WSL2 eth0 address and pass it here.
 */
export function getLocalProviderContainerReachabilityCheck(
  provider: string,
  hostIp?: string,
): string | null {
  const addHost = hostIp
    ? `--add-host host.openshell.internal:${hostIp}`
    : "--add-host host.openshell.internal:host-gateway";
  switch (provider) {
    case "vllm-local":
      return `docker run --rm ${addHost} ${CONTAINER_REACHABILITY_IMAGE} -4 -sf http://host.openshell.internal:8000/v1/models 2>/dev/null`;
    case "ollama-local":
      return `docker run --rm ${addHost} ${CONTAINER_REACHABILITY_IMAGE} -4 -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`;
    default:
      return null;
  }
}

/**
 * Detect the WSL2 distro's primary IPv4 address.
 * On Docker Desktop + WSL2, `host-gateway` resolves to an un-routable
 * address.  The WSL2 eth0 IP is the only address containers can reach.
 */
export function detectWsl2HostIp(runCapture: RunCaptureFn): string | null {
  const ip = runCapture("hostname -I 2>/dev/null", { ignoreError: true });
  const first = (ip || "").trim().split(/\s+/)[0];
  return first && /^\d+\.\d+\.\d+\.\d+$/.test(first) ? first : null;
}

export function validateLocalProvider(
  provider: string,
  runCapture: RunCaptureFn,
  opts: { isWsl?: boolean; isDockerDesktop?: boolean } = {},
): ValidationResult {
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
          message:
            "Local Ollama was selected, but nothing is responding on http://localhost:11434.",
        };
      default:
        return { ok: false, message: "The selected local inference provider is unavailable." };
    }
  }

  // On WSL2 + Docker Desktop, host-gateway is un-routable.
  // Resolve the WSL2 eth0 IP and pass it to the container check.
  const hostIp =
    opts.isWsl && opts.isDockerDesktop ? detectWsl2HostIp(runCapture) : undefined;
  const containerCommand = getLocalProviderContainerReachabilityCheck(
    provider,
    hostIp ?? undefined,
  );
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
          "Local Ollama is responding on localhost, but the container reachability check failed for http://host.openshell.internal:11434.\n" +
          "  Common causes:\n" +
          "  • Ollama is bound to 127.0.0.1 — set OLLAMA_HOST=0.0.0.0:11434\n" +
          "  • Docker Desktop on WSL2 resolves host-gateway to IPv6 — try installing Docker Engine natively in WSL2\n" +
          "  • A firewall is blocking container-to-host traffic on port 11434",
      };
    default:
      return {
        ok: false,
        message: "The selected local inference provider is unavailable from containers.",
      };
  }
}

export function parseOllamaList(output: unknown): string[] {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^NAME\s+/i.test(line))
    .map((line) => line.split(/\s{2,}/)[0])
    .filter(Boolean);
}

export function parseOllamaTags(output: unknown): string[] {
  try {
    const parsed = JSON.parse(String(output || ""));
    return Array.isArray(parsed?.models)
      ? parsed.models.map((model: { name?: string }) => model && model.name).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

export function getOllamaModelOptions(runCapture: RunCaptureFn): string[] {
  const tagsOutput = runCapture("curl -sf http://localhost:11434/api/tags 2>/dev/null", {
    ignoreError: true,
  });
  const tagsParsed = parseOllamaTags(tagsOutput);
  if (tagsParsed.length > 0) {
    return tagsParsed;
  }

  const listOutput = runCapture("ollama list 2>/dev/null", { ignoreError: true });
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
  runCapture: RunCaptureFn,
  gpu: GpuInfo | null = null,
): string {
  const models = getOllamaModelOptions(runCapture);
  if (models.length === 0) {
    const bootstrap = getBootstrapOllamaModelOptions(gpu);
    return bootstrap[0];
  }
  return models.includes(DEFAULT_OLLAMA_MODEL) ? DEFAULT_OLLAMA_MODEL : models[0];
}

export function getOllamaWarmupCommand(model: string, keepAlive = "15m"): string {
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  return `nohup curl -s http://localhost:11434/api/generate -H 'Content-Type: application/json' -d ${shellQuote(payload)} >/dev/null 2>&1 &`;
}

export function getOllamaProbeCommand(
  model: string,
  timeoutSeconds = 120,
  keepAlive = "15m",
): string {
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  return `curl -sS --max-time ${timeoutSeconds} http://localhost:11434/api/generate -H 'Content-Type: application/json' -d ${shellQuote(payload)} 2>/dev/null`;
}

export function validateOllamaModel(
  model: string,
  runCapture: RunCaptureFn,
): ValidationResult {
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
  } catch {
    /* ignored */
  }

  return { ok: true };
}
