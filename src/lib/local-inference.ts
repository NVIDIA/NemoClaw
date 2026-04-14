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
  /**
   * When the caller is on WSL2 + Docker Desktop and one of the probed
   * host-IP candidates succeeded, this is that IP. Callers should pass
   * it into {@link getLocalProviderBaseUrl} so the gateway's
   * `OPENAI_BASE_URL` matches the address the container probe
   * validated. `undefined` on non-WSL2, mirrored-mode WSL2, or when
   * only the default `host-gateway` probe succeeded.
   */
  resolvedHostIp?: string;
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

const IPV4_RE = /^\d+\.\d+\.\d+\.\d+$/;

/** Addresses we never want to hand to a container as the "host IP". */
function isUsableHostIp(ip: string): boolean {
  if (!IPV4_RE.test(ip)) return false;
  if (ip === "127.0.0.1" || ip.startsWith("127.")) return false;
  if (ip.startsWith("169.254.")) return false; // link-local
  // Common docker bridge / k8s CNI ranges that are not the WSL host.
  if (ip.startsWith("172.17.") || ip.startsWith("172.18.")) return false;
  if (ip.startsWith("10.42.") || ip.startsWith("10.43.")) return false;
  return true;
}

/**
 * Gather candidate IPv4 addresses that might reach a host-side inference
 * server from inside a container on WSL2 + Docker Desktop. Returns a
 * priority-ordered, de-duplicated list.
 *
 * Two Ollama/vLLM placements are both valid and must both work:
 *   A. Server **inside WSL** (Linux install of Ollama) — reachable via
 *      the WSL distro's own eth0 IPv4.
 *   B. Server on the **Windows host** — reachable only via the WSL2
 *      default gateway IP (e.g. 172.x.x.1) in NAT networking mode.
 *
 * In mirrored networking mode the kernel reports no default route to a
 * WSL-only gateway, and `host.openshell.internal` / `host-gateway`
 * already works — callers treat an empty candidate list as the signal
 * to fall back to the default hostname.
 *
 * Probe order:
 *   1. `ip -4 -o route get 1.1.1.1` — outbound src, covers case (A).
 *   2. `ip -4 -o route show default` — gateway, covers case (B).
 *   3. `hostname -I` — last-resort interface enumeration.
 */
export function detectWsl2HostIpCandidates(runCapture: RunCaptureFn): string[] {
  const out: string[] = [];
  const push = (ip: string | null | undefined): void => {
    if (ip && isUsableHostIp(ip) && !out.includes(ip)) out.push(ip);
  };

  const routeGet = runCapture("ip -4 -o route get 1.1.1.1 2>/dev/null", {
    ignoreError: true,
  });
  push(String(routeGet || "").match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)\b/)?.[1]);

  const routeDefault = runCapture("ip -4 -o route show default 2>/dev/null", {
    ignoreError: true,
  });
  for (const line of String(routeDefault || "").split(/\r?\n/)) {
    push(line.match(/\bvia\s+(\d+\.\d+\.\d+\.\d+)\b/)?.[1]);
  }

  const hostnameOut = runCapture("hostname -I 2>/dev/null", { ignoreError: true });
  for (const tok of String(hostnameOut || "").trim().split(/\s+/)) push(tok);

  return out;
}

/**
 * First-choice host IP for WSL2. Retained for back-compat; new code
 * should call {@link detectWsl2HostIpCandidates} and probe each.
 */
export function detectWsl2HostIp(runCapture: RunCaptureFn): string | null {
  return detectWsl2HostIpCandidates(runCapture)[0] || null;
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

  // On WSL2 + Docker Desktop, `host-gateway` is often un-routable.
  // Try each candidate host IP (WSL eth0 + default gateway) and fall
  // back to the default hostname. Use the first one the container can
  // actually reach.
  const candidates: (string | undefined)[] =
    opts.isWsl && opts.isDockerDesktop
      ? [...detectWsl2HostIpCandidates(runCapture), undefined]
      : [undefined];

  for (const candidate of candidates) {
    const command = getLocalProviderContainerReachabilityCheck(provider, candidate);
    if (!command) return { ok: true };
    const out = runCapture(command, { ignoreError: true });
    if (out) return candidate ? { ok: true, resolvedHostIp: candidate } : { ok: true };
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
