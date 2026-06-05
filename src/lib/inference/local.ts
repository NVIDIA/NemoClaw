// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local inference provider helpers — URL mappers, Ollama parsers,
 * health checks, and command generators for vLLM and Ollama.
 */

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type { CurlProbeResult } from "../adapters/http/probe";
import { runCurlProbe } from "../adapters/http/probe";
import type { CaptureResult } from "../runner";
import { buildSubprocessEnv } from "../subprocess-env";
import {
  applyOllamaRuntimeContextWindow as applyOllamaRuntimeContextWindowWithHost,
  MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
  parsePositiveInteger,
  probeOllamaRuntimeModelStatus as probeOllamaRuntimeModelStatusWithHost,
  resetOllamaRuntimeContextWindowAutoState,
  resolveOllamaRuntimeContextWindow as resolveOllamaRuntimeContextWindowWithHost,
} from "./ollama-runtime-context";
import type { OllamaRuntimeModelStatus } from "./ollama-runtime-context";
import {
  applyVllmRuntimeContextWindow as applyVllmRuntimeContextWindowFromModels,
} from "./vllm-runtime-context";
export type { OllamaRuntimeModelStatus } from "./ollama-runtime-context";

const { shellQuote, runCapture, runCaptureEx } = require("../runner");

import { OLLAMA_PORT, OLLAMA_PROXY_PORT, VLLM_PORT } from "../core/ports";
import { sleepSeconds } from "../core/wait";
import {
  anyRegistryModelFits,
  effectiveGpuMemoryMB,
  fittableOllamaModelTags,
  largestFittableOllamaModelTag,
  modelFitsAvailableMemory,
  OLLAMA_MODEL_REGISTRY,
  SMALLEST_OLLAMA_MODEL_TAG,
} from "./ollama-model-registry";

const { containerCanReachHostLoopback, isWsl } = require("../platform");
const { detectContainerRuntimeFromDockerInfo } =
  require("../adapters/docker/runtime") as typeof import("../adapters/docker/runtime");
const { detectNvidiaPlatform } = require("./nim");

/**
 * Port containers use to reach Ollama. Returns the raw Ollama port when the
 * container can reach the host's 127.0.0.1 directly (Docker Desktop on WSL),
 * and the auth proxy port otherwise (native Docker on any host, macOS, etc.).
 * Memoised — call resetOllamaContainerPortCache() in tests.
 */
let _ollamaContainerPort: number | null = null;
export function getOllamaContainerPort(): number {
  if (_ollamaContainerPort !== null) return _ollamaContainerPort;
  const runtime = detectContainerRuntimeFromDockerInfo();
  _ollamaContainerPort = containerCanReachHostLoopback(runtime) ? OLLAMA_PORT : OLLAMA_PROXY_PORT;
  return _ollamaContainerPort;
}
export function resetOllamaContainerPortCache(): void {
  _ollamaContainerPort = null;
}

export const HOST_GATEWAY_URL = "http://host.openshell.internal";
export const LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV = "NEMOCLAW_LOCAL_INFERENCE_SANDBOX_HOST_URL";
export const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
// These tags are convenience aliases for callers that want to refer to a
// specific bootstrap model by role rather than by string. The canonical
// metadata (memory requirements, download sizes) lives in
// `ollama-model-registry.ts`; the assertion below makes module load fail
// loudly if a registry edit drops a tag a caller still references by
// name, so the two stay in sync.
function assertRegistryTag(tag: string): string {
  if (!OLLAMA_MODEL_REGISTRY.some((entry) => entry.tag === tag)) {
    throw new Error(
      `Tag '${tag}' is not in OLLAMA_MODEL_REGISTRY. Update the registry first.`,
    );
  }
  return tag;
}

export const SMALL_OLLAMA_MODEL = SMALLEST_OLLAMA_MODEL_TAG;
export const DEFAULT_OLLAMA_MODEL = assertRegistryTag("nemotron-3-nano:30b");
export const QWEN3_6_OLLAMA_MODEL = assertRegistryTag("qwen3.6:35b");

export type RunCaptureFn = (cmd: string | string[], opts?: { ignoreError?: boolean }) => string;

export {
  getInstalledOllamaVersion,
  getRunningOllamaDaemonVersion,
  isOllamaVersionAtLeast,
  MIN_OLLAMA_VERSION,
} from "./ollama-version";

export type RunCaptureExFn = (cmd: string[]) => CaptureResult;

// Hosts that the WSL-side onboard CLI tries when probing Ollama. Native Linux
// and macOS only ever reach Ollama on the local loopback. WSL with Docker
// Desktop can also reach a Windows-host Ollama through the docker-desktop
// integration's `host.docker.internal` alias when that host explicitly exposes
// Ollama outside Windows loopback.
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
  // Optional, narrows the GpuDetection union from inference/nim.ts. Used to
  // gate the large-Ollama-model defaults so a partially-identified device
  // does not get sized as if it were confirmed NVIDIA / Apple Silicon
  // (#3510).
  type?: string;
  // Currently free GPU memory at probe time. Populated by `detectGpu` from
  // `nvidia-smi memory.free`, `MemAvailable` on unified-memory hosts, or
  // `vm_stat` reclaimable pages on macOS. Used by the bootstrap-model
  // selector so an idle 128 GiB Spark and a 128 GiB Spark with another
  // GPU workload eating 116 GiB do not get the same model recommendation.
  // Absent => the selector falls back to `totalMemoryMB`, preserving the
  // previous behaviour.
  availableMemoryMB?: number;
}

export interface ValidationResult {
  ok: boolean;
  message?: string;
  diagnostic?: string;
  /**
   * Set when the failure points at the Ollama daemon / model runner itself,
   * not the chosen model. Callers escape the Ollama-model loop instead of
   * asking for another tag that would hit the same failure. (#4365)
   */
  daemonFailure?: boolean;
}

/**
 * Recognises Ollama probe errors that mean the daemon's model runner crashed,
 * stopped, or otherwise died (rather than the chosen model being unsuitable).
 * Picking a different model would loop on the same failure, so the wizard
 * escapes back to provider selection. (#4365)
 */
export function isOllamaRunnerCrash(errText: string | null | undefined): boolean {
  const text = String(errText || "");
  if (!text) return false;
  return /\brunner\b[\s\S]{0,80}\b(?:stopped|terminated|crashed|exited|died|killed)\b/i.test(
    text,
  );
}

export interface LocalProviderHealthStatus {
  ok: boolean;
  providerLabel: string;
  endpoint: string;
  detail: string;
  /**
   * Specific failure mode, rendered as the status word (e.g. `unauthorized`,
   * `unreachable`). Absent on `ok:true`; defaults to `unreachable` at the
   * render layer if absent on `ok:false`. (#3265)
   */
  failureLabel?: "unreachable" | "unhealthy" | "unauthorized";
  /**
   * Short qualifier (e.g. "auth proxy") rendered as `Inference (<probeLabel>):`
   * for additional hops so multi-hop health surfaces in the status output.
   * Absent for the main backend probe. (#3265)
   */
  probeLabel?: string;
  /**
   * Additional probes that share the same Inference rendering — currently
   * used to surface the Ollama auth-proxy hop alongside the backend probe so
   * a failing proxy doesn't get hidden behind a healthy backend. (#3265)
   */
  subprobes?: LocalProviderHealthStatus[];
}

export interface LocalProviderHealthProbeOptions {
  runCurlProbeImpl?: (argv: string[]) => CurlProbeResult;
  /**
   * Lets callers that perform their own Ollama auth-proxy check avoid the
   * legacy inline proxy subprobe. The inline subprobe is retained for status
   * rendering paths that still need a combined backend/proxy result.
   */
  skipOllamaAuthProxySubprobe?: boolean;
  /**
   * Reads the persisted Ollama auth-proxy bearer token. Injectable for tests.
   * Default reads from `~/.nemoclaw/ollama-proxy-token` (written by
   * inference/ollama/proxy.ts during onboard).
   */
  loadOllamaProxyTokenImpl?: () => string | null;
}

function defaultLoadOllamaProxyToken(): string | null {
  const tokenPath = nodePath.join(os.homedir(), ".nemoclaw", "ollama-proxy-token");
  try {
    if (fs.existsSync(tokenPath)) {
      const token = fs.readFileSync(tokenPath, "utf-8").trim();
      return token || null;
    }
  } catch {
    /* ignore — null means "no auth-proxy onboarded; skip the subprobe" */
  }
  return null;
}

function runLocalCurlProbe(argv: string[]): CurlProbeResult {
  return runCurlProbe(argv, { env: buildSubprocessEnv(), replaceEnv: true });
}

// A 200 response on `/api/tags` alone is not enough to call Ollama healthy —
// a captive HTTP_PROXY, a stale listener, or a stub on the loopback port can
// all answer with arbitrary 2xx bodies that look healthy at the curl-status
// level. The authoritative signal is the Ollama wire format itself:
// `{ "models": [...] }`. An empty array is fine — that just means no models
// pulled yet — but a body that doesn't parse as JSON-with-array-`models` did
// not come from Ollama and the probe should not call it healthy. (#4275)
function isValidOllamaTagsResponseBody(body: string): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.models);
  } catch {
    return false;
  }
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

function normalizeLocalInferenceHostUrl(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return null;
  if (/^[A-Za-z0-9_.-]+$/.test(value)) return `http://${value}`;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" && parsed.hostname) return `http://${parsed.hostname}`;
  } catch {
    return null;
  }
  return null;
}

function getLocalInferenceSandboxHostUrl(): string {
  return normalizeLocalInferenceHostUrl(process.env[LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV]) || HOST_GATEWAY_URL;
}

export function getLocalProviderBaseUrl(
  provider: string,
  options: { hostUrl?: string | null } = {},
): string | null {
  const hostUrl = normalizeLocalInferenceHostUrl(options.hostUrl) || getLocalInferenceSandboxHostUrl();
  switch (provider) {
    case "vllm-local":
      return `${hostUrl}:${VLLM_PORT}/v1`;
    case "ollama-local":
      // Containers reach Ollama through the auth proxy, not directly.
      return `${hostUrl}:${getOllamaContainerPort()}/v1`;
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

/**
 * Probe the Ollama auth proxy on :11435 with the persisted bearer token.
 *
 * Returns `null` when no token has been persisted (no Ollama onboard ever
 * ran), so callers omit the line rather than report a misleading
 * "unreachable". Returns `ok:false` with a "401 unauthorized" detail when
 * the proxy is reachable but rejects the token — this is the exact signal
 * the false-positive in #3265 was hiding (e.g. when the proxy fails to
 * inject NEMOCLAW_OLLAMA_PROXY_TOKEN, #3198). (#3265)
 */
export function probeOllamaAuthProxyHealth(
  options: LocalProviderHealthProbeOptions = {},
): LocalProviderHealthStatus | null {
  const loadToken = options.loadOllamaProxyTokenImpl ?? defaultLoadOllamaProxyToken;
  const token = loadToken();
  if (!token) {
    return null;
  }
  const endpoint = `http://127.0.0.1:${OLLAMA_PROXY_PORT}/api/tags`;
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runLocalCurlProbe;
  const result = runCurlProbeImpl([
    "-sS",
    "--connect-timeout",
    "3",
    "--max-time",
    "5",
    "-H",
    `Authorization: Bearer ${token}`,
    endpoint,
  ]);

  const base = {
    providerLabel: "Ollama auth proxy",
    endpoint,
    probeLabel: "auth proxy",
  };
  if (result.ok) {
    // A 200 from the proxy alone is not a healthy signal — the proxy may be
    // serving a captive HTTP_PROXY page, or its upstream Ollama backend may
    // be down but the proxy returned a stub. Confirm with the wire format. (#4275)
    if (!isValidOllamaTagsResponseBody(result.body)) {
      return {
        ...base,
        ok: false,
        failureLabel: "unhealthy",
        detail:
          `Ollama auth proxy returned HTTP ${result.httpStatus} on ${endpoint} but the body ` +
          `is not a valid /api/tags response. The proxy is reachable but its upstream Ollama ` +
          `backend is not, or an HTTP proxy is intercepting the loopback. ` +
          `Restart \`ollama serve\` and check HTTP_PROXY/NO_PROXY.`,
      };
    }
    return { ...base, ok: true, detail: `Ollama auth proxy is reachable on ${endpoint}.` };
  }
  if (result.httpStatus === 401) {
    return {
      ...base,
      ok: false,
      failureLabel: "unauthorized",
      detail:
        `Ollama auth proxy returned 401 on ${endpoint} — the persisted token is no longer ` +
        `accepted. Re-run \`nemoclaw onboard\` (Ollama path) to rotate the proxy token.`,
    };
  }
  if (result.httpStatus === 0) {
    return {
      ...base,
      ok: false,
      failureLabel: "unreachable",
      detail:
        `Ollama auth proxy is unreachable on ${endpoint}. The proxy process may have stopped; ` +
        `re-run \`nemoclaw <sandbox> connect\` to restart it. (${result.message})`,
    };
  }
  return {
    ...base,
    ok: false,
    failureLabel: "unhealthy",
    detail:
      `Ollama auth proxy returned HTTP ${result.httpStatus} on ${endpoint}. (${result.message})`,
  };
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

  const runCurlProbeImpl = options.runCurlProbeImpl ?? runLocalCurlProbe;
  const result = runCurlProbeImpl(["-sS", "--connect-timeout", "3", "--max-time", "5", endpoint]);

  // Per #3265 the status line is renamed `Inference (<backend>):` for local
  // providers so the upcoming `Inference (auth proxy):` subprobe lines render
  // in parallel and the user can see which hop is broken.
  const probeLabel =
    provider === "ollama-local" ? "ollama backend" :
    provider === "vllm-local" ? "vllm backend" : undefined;

  const subprobes: LocalProviderHealthStatus[] = [];
  if (provider === "ollama-local" && !options.skipOllamaAuthProxySubprobe) {
    const proxyProbe = probeOllamaAuthProxyHealth(options);
    if (proxyProbe) subprobes.push(proxyProbe);
  }
  const attachSubprobes = subprobes.length > 0 ? { subprobes } : {};
  const attachProbeLabel = probeLabel ? { probeLabel } : {};

  if (result.ok) {
    // For ollama-local, a 200 is necessary but not sufficient: a captive
    // HTTP_PROXY, a stale listener on 11434, or any other HTTP responder
    // can return 200 with an arbitrary body. Treat the probe as healthy
    // only when the response is the Ollama /api/tags JSON shape. (#4275)
    if (provider === "ollama-local" && !isValidOllamaTagsResponseBody(result.body)) {
      return {
        ok: false,
        providerLabel,
        endpoint,
        failureLabel: "unhealthy",
        detail:
          `${providerLabel} responded on ${endpoint} with HTTP ${result.httpStatus} but the ` +
          `body is not a valid /api/tags response. The listener may not be Ollama (e.g. a ` +
          `stale process or an HTTP proxy intercepting the loopback). Restart \`ollama serve\` ` +
          `and verify HTTP_PROXY/NO_PROXY.`,
        ...attachProbeLabel,
        ...attachSubprobes,
      };
    }
    return {
      ok: true,
      providerLabel,
      endpoint,
      detail: `${providerLabel} is reachable on ${endpoint}.`,
      ...attachProbeLabel,
      ...attachSubprobes,
    };
  }

  return {
    ok: false,
    providerLabel,
    endpoint,
    detail: buildLocalProviderProbeDetail(provider, endpoint, result),
    ...attachProbeLabel,
    ...attachSubprobes,
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
      // Use -w %{http_code} (instead of -sf) so an authenticated-but-401
      // response still proves the network path works — the proxy now
      // requires a Bearer token on every endpoint (#3338) and the ephemeral
      // probe container doesn't carry one, but the goal here is connectivity
      // not authorisation.
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
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        `http://host.openshell.internal:${getOllamaContainerPort()}/api/tags`,
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
        message: `Local Ollama is responding on ${getResolvedOllamaHost()}, but the Docker container reachability check failed for http://host.openshell.internal:${getOllamaContainerPort()}. This may be a Docker networking issue — the sandbox uses a different network path and may still work.`,
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
      return `http://host.openshell.internal:${getOllamaContainerPort()}/api/tags`;
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

export { MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW, parsePositiveInteger };

export function probeOllamaRuntimeModelStatus(
  model: string,
  runCaptureImpl?: RunCaptureFn,
): OllamaRuntimeModelStatus {
  return probeOllamaRuntimeModelStatusWithHost(model, getResolvedOllamaHost, runCaptureImpl);
}

export function resolveOllamaRuntimeContextWindow(
  model: string,
  currentContextWindow: string | null | undefined = null,
  runCaptureImpl?: RunCaptureFn,
): number | null {
  return resolveOllamaRuntimeContextWindowWithHost(
    model,
    currentContextWindow,
    getResolvedOllamaHost,
    runCaptureImpl,
  );
}

export { resetOllamaRuntimeContextWindowAutoState };

export function applyOllamaRuntimeContextWindow(selectedModel: string): void {
  applyOllamaRuntimeContextWindowWithHost(selectedModel, getResolvedOllamaHost);
}

export function applyVllmRuntimeContextWindow(
  modelsResponse: unknown,
  modelId: string | null | undefined,
): void {
  applyVllmRuntimeContextWindowFromModels(modelsResponse, modelId);
}

function formatOllamaCpuOnlyDiagnostic(model: string, status: OllamaRuntimeModelStatus): string {
  const observed: string[] = [];
  if (status.processor) observed.push(`processor=${status.processor}`);
  if (status.sizeVram !== undefined) observed.push(`size_vram=${status.sizeVram}`);
  const observedText = observed.length > 0 ? ` (${observed.join(", ")})` : "";
  return (
    `Selected Ollama model '${model}' answered the local probe, but Ollama reports it is loaded on CPU only${observedText}. ` +
    "DGX Spark should use the CUDA v13 backend; check `ollama ps`, `sudo systemctl cat ollama`, " +
    "and `journalctl -u ollama.service --since \"10 min ago\" | grep -iE \"gpu|cuda|vram|compute|library\"`, then retry onboarding."
  );
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
  // Delegate to the registry so the menu reflects what the host can
  // actually load right now. Only confirmed-NVIDIA and Apple-Silicon
  // devices get larger options; ambiguous device types fall back to the
  // smallest model so a partial GPU detection cannot promote a host to a
  // 22 GB model.
  return fittableOllamaModelTags(gpu);
}

/**
 * Resolve the non-interactive Ollama model selection. When the caller has
 * passed an explicit `NEMOCLAW_MODEL` / recovered-session model that the
 * registry knows is too big for the host's currently available memory,
 * log a warning and fall back to the largest fittable registry entry so
 * onboarding does not pull a model the runner will crash on. Unknown
 * model tags (user-supplied values the registry has never seen) are
 * respected as-is — the runner's own validation surfaces the failure if
 * the choice was wrong.
 */
export function resolveNonInteractiveOllamaModel(
  requestedModel: string | null,
  recoveredModel: string | null,
  gpu: GpuInfo | null,
  log: (message: string) => void = (m) => console.warn(m),
  runCaptureImpl?: RunCaptureFn,
): string {
  const explicit = requestedModel || recoveredModel;
  if (explicit && !modelFitsAvailableMemory(explicit, gpu)) {
    const fallback = largestFittableOllamaModelTag(gpu);
    log(
      `  ! Requested Ollama model '${explicit}' is unlikely to fit currently available GPU memory; ` +
        `falling back to '${fallback}'. Override by freeing memory and re-running, or unset NEMOCLAW_MODEL.`,
    );
    if (!anyRegistryModelFits(gpu)) {
      warnNoBootstrapModelFits(gpu, log);
    }
    return fallback;
  }
  if (!explicit && !anyRegistryModelFits(gpu)) {
    warnNoBootstrapModelFits(gpu, log);
  }
  return explicit || getDefaultOllamaModel(gpu, runCaptureImpl);
}

function warnNoBootstrapModelFits(
  gpu: GpuInfo | null,
  log: (message: string) => void,
): void {
  const memory = effectiveGpuMemoryMB(gpu);
  log(
    `  ! No known Ollama bootstrap model fits the host's currently available GPU memory` +
      `${memory ? ` (~${memory} MB free)` : ""}. Proceeding with the smallest known model; ` +
      "the runner may still reject the load — free memory and re-run if it does.",
  );
}

export function getDefaultOllamaModel(
  gpu: GpuInfo | null = null,
  runCaptureImpl?: RunCaptureFn,
): string {
  const models = getOllamaModelOptions(runCaptureImpl);
  if (models.length === 0) {
    // No installed models — pick the largest registry entry that fits the
    // host's currently available memory.
    return largestFittableOllamaModelTag(gpu);
  }
  // Filter the installed list to entries we either don't know (unmanaged
  // user pulls — let the runner validate) or that fit the registry's
  // memory requirement at probe time. If everything has been filtered out,
  // fall back to the largest registry entry that fits so the wizard never
  // suggests a model the host can't load.
  const fittingInstalled = models.filter((tag) => modelFitsAvailableMemory(tag, gpu));
  const pool = fittingInstalled.length > 0 ? fittingInstalled : null;
  if (pool === null) {
    return largestFittableOllamaModelTag(gpu);
  }
  return pool.includes(DEFAULT_OLLAMA_MODEL) && modelFitsAvailableMemory(DEFAULT_OLLAMA_MODEL, gpu)
    ? DEFAULT_OLLAMA_MODEL
    : pool[0];
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
  isSparkImpl?: () => boolean,
  runCaptureExImpl?: RunCaptureExFn,
  options: { allowToolsIncompatible?: boolean } = {},
): ValidationResult {
  const capture = runCaptureImpl ?? runCapture;
  const captureEx = runCaptureExImpl ?? runCaptureEx;
  const isSpark = isSparkImpl ?? (() => detectNvidiaPlatform() === "spark");
  const sparkHost = isSpark();
  const probeCmd = getOllamaProbeCommand(model);
  const probeResult = captureEx(probeCmd);
  let output = probeResult.stdout;
  // On DGX Spark (128 GB unified memory), loading a large model from disk can take >2 min.
  // Only retry with a 300 s timeout when the initial probe genuinely timed out — fast
  // failures (connection refused, Ollama not running) surface immediately. (#3251)
  if (sparkHost && probeResult.timedOut) {
    const retryResult = captureEx(getOllamaProbeCommand(model, 300));
    output = retryResult.stdout;
  }
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
      const errText = parsed.error.trim();
      if (/does not support tools/i.test(errText)) {
        if (options.allowToolsIncompatible !== true) {
          return {
            ok: false,
            message:
              `Selected Ollama model '${model}' does not support tool calling, which ` +
              `NemoClaw agents require. Run \`ollama show <model>\` to inspect a ` +
              `model's capabilities and pick one whose list includes 'tools'.`,
          };
        }
        // Override accepted — log and fall through to the Spark CPU-only
        // runtime check below so it still enforces. (#4241)
        console.warn(
          `  ⚠ Ollama model '${model}' confirmed not to support tools; ` +
            `continuing because the no-tools override was accepted.`,
        );
      } else {
        // Ollama checks available RAM instead of total; false positive on DGX Spark
        // unified-memory hosts where GPU and CPU share the same 128 GB pool. (#3251)
        const memMatch = errText.match(
          /model requires more system memory \(([0-9.]+)\s*GiB\) than is available \([0-9.]+\s*GiB\)/i,
        );
        if (memMatch && sparkHost) {
          const requiresGiB = parseFloat(memMatch[1]);
          const freeOut = capture(["free", "-m"], { ignoreError: true });
          if (freeOut) {
            const memLine = freeOut.split("\n").find((l: string) => l.includes("Mem:"));
            if (memLine) {
              const totalMB = parseInt(memLine.trim().split(/\s+/)[1], 10) || 0;
              const totalGiB = totalMB / 1024;
              if (totalGiB >= requiresGiB) {
                return { ok: true };
              }
            }
          }
        }
        return {
          ok: false,
          message: `Selected Ollama model '${model}' failed the local probe: ${errText}`,
          ...(isOllamaRunnerCrash(errText) ? { daemonFailure: true } : {}),
        };
      }
    }
  } catch {
    /* ignored */
  }

  if (sparkHost) {
    const runtimeStatus = probeOllamaRuntimeModelStatus(model, capture);
    if (runtimeStatus.cpuOnly) {
      return {
        ok: false,
        message: formatOllamaCpuOnlyDiagnostic(model, runtimeStatus),
      };
    }
  }

  return { ok: true };
}

// Helpers for threading the user's "use this no-tools Ollama model anyway"
// override (see #4241) through onboard validators so they don't loop the
// wizard back to model selection after the user already accepted.

export function buildOllamaProbeOptions(allowToolsIncompatible: boolean): {
  skipResponsesProbe: true;
  requireChatCompletionsToolCalling: boolean;
  allowHostDockerInternal: boolean;
} {
  return {
    skipResponsesProbe: true,
    requireChatCompletionsToolCalling: !allowToolsIncompatible,
    allowHostDockerInternal: getResolvedOllamaHost() === OLLAMA_HOST_DOCKER_INTERNAL,
  };
}

export function validateOllamaModelWithToolsOverride(
  model: string,
  allowToolsIncompatible: boolean,
): ValidationResult {
  return validateOllamaModel(model, undefined, undefined, undefined, { allowToolsIncompatible });
}

// ─── Tools-capability probe (issue #2667) ─────────────────────────
//
// Ollama exposes a model's declared capabilities via /api/show. Tool calling
// is gated on a "tools" entry in that array. Models without it raise
// "400 ... does not support tools" the first time the agent issues a tool
// call — too late to recover gracefully. The onboard flow probes this up
// front and warns or blocks before the user wastes a long pull.

export interface OllamaCapabilities {
  source: "api" | "unknown";
  capabilities: string[];
  supportsTools: boolean | null;
  rawError?: string;
}

/**
 * Probe `/api/show` for a model's declared capabilities. Returns
 * `{source:"api", supportsTools: bool}` when the response is well-formed,
 * or `{source:"unknown", supportsTools: null, rawError}` on any failure
 * (network, HTTP error, malformed JSON, missing field, unexpected shape).
 *
 * Defensive parsing is intentional: older Ollama daemons and custom registries
 * may omit the `capabilities` field. We never block on probe failure.
 */
export function probeOllamaModelCapabilities(
  model: string,
  runCaptureImpl?: RunCaptureFn,
): OllamaCapabilities {
  const capture = runCaptureImpl ?? runCapture;
  const host = getResolvedOllamaHost();
  const body = JSON.stringify({ model });
  let output: string;
  try {
    output = capture(
      [
        "curl",
        "-sS",
        "--connect-timeout",
        "3",
        "--max-time",
        "5",
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-d",
        body,
        `http://${host}:${OLLAMA_PORT}/api/show`,
      ],
      { ignoreError: true },
    );
  } catch (err) {
    return {
      source: "unknown",
      capabilities: [],
      supportsTools: null,
      rawError: err instanceof Error ? err.message : String(err),
    };
  }

  if (!output || !String(output).trim()) {
    return {
      source: "unknown",
      capabilities: [],
      supportsTools: null,
      rawError: "empty response from /api/show",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(output));
  } catch (err) {
    return {
      source: "unknown",
      capabilities: [],
      supportsTools: null,
      rawError: err instanceof Error ? err.message : "JSON parse error",
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      source: "unknown",
      capabilities: [],
      supportsTools: null,
      rawError: "unexpected /api/show payload shape",
    };
  }

  const capsRaw = (parsed as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(capsRaw)) {
    // Ollama returned a body but no capabilities array (older version,
    // custom registry, or shape change). Degrade to unknown.
    const errText =
      typeof (parsed as { error?: unknown }).error === "string"
        ? String((parsed as { error?: unknown }).error)
        : "missing capabilities field";
    return {
      source: "unknown",
      capabilities: [],
      supportsTools: null,
      rawError: errText,
    };
  }

  const capabilities = capsRaw.filter((c: unknown): c is string => typeof c === "string");
  return {
    source: "api",
    capabilities,
    supportsTools: capabilities.includes("tools"),
  };
}
