// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local inference provider helpers — URL mappers, Ollama parsers,
 * health checks, and command generators for vLLM and Ollama.
 */

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  detectContainerRuntimeFromDockerInfo,
  mergeIsolatedDockerClientEnv,
  prepareDockerBuildEnvironment,
  type PreparedDockerBuildEnvironment,
  warnIfDockerBuildEnvironmentCleanupFailed,
} from "../adapters/docker";
import { createBearerAuthConfig } from "../adapters/http/auth-config";
import { CONTAINER_REACHABILITY_IMAGE } from "../adapters/http/container-curl-probe";
import { buildValidatedCurlCommandArgs } from "../adapters/http/curl-args";
import type { CurlProbeOptions, CurlProbeResult } from "../adapters/http/probe";
import { runCurlProbe } from "../adapters/http/probe";
import { isObjectRecord } from "../core/json-types";
import { OLLAMA_PORT, OLLAMA_PROXY_PORT, VLLM_PORT } from "../core/ports";

import { retryUntil } from "../core/retry";
import { sleepSeconds } from "../core/wait";
import { containerCanReachHostLoopback, isWsl, type WslDetectionOptions } from "../platform";
import { type CaptureResult, run, runCapture, runCaptureEx, shellQuote } from "../runner";
import { buildSubprocessEnv } from "../subprocess-env";

import {
  isLocalOllamaRouteOwner,
  OLLAMA_HOST_DOCKER_INTERNAL,
  OLLAMA_LOCALHOST,
  readLocalAdapterJsonFile,
  removeLocalAdapterFile,
  resolveSharedLocalAdapterStateRoot,
  type OllamaRouteHolder,
  writeLocalAdapterJsonFile,
} from "./local-adapter-lifecycle";
import { detectNvidiaPlatform } from "./nim";
import {
  anyRegistryModelFits,
  DEFAULT_OLLAMA_MODEL_TAG,
  effectiveGpuMemoryMB,
  fittableOllamaModelTags,
  largestFittableOllamaModelTag,
  modelFitsAvailableMemory,
  OLLAMA_MODEL_REGISTRY,
  SMALLEST_OLLAMA_MODEL_TAG,
} from "./ollama-model-registry";
import type {
  ApplyOllamaRuntimeContextWindowOptions,
  ApplyOllamaRuntimeContextWindowResult,
  OllamaRuntimeModelStatus,
} from "./ollama-runtime-context";
import {
  applyOllamaRuntimeContextWindow as applyOllamaRuntimeContextWindowWithHost,
  fetchOllamaModelShowMetadata,
  getOllamaContextWindowFloorForAgent,
  MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
  MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
  parsePositiveInteger,
  probeOllamaRuntimeModelStatus as probeOllamaRuntimeModelStatusWithHost,
  resetOllamaRuntimeContextWindowAutoState,
  resolveOllamaRuntimeContextWindow as resolveOllamaRuntimeContextWindowWithHost,
} from "./ollama-runtime-context";
import {
  type RecoveredManagedClusterVllmEndpoint,
  recoverInstalledManagedClusterVllmEndpoint,
} from "./serving/managed-cluster-runtime-receipt";
import {
  recoverHostLocalManagedVllmEndpoint,
  resolveManagedVllmBridgeHost,
} from "./serving/vllm-host-local-lifecycle";
import { loadManagedVllmApiKey } from "./vllm-api-key";
import { applyVllmRuntimeContextWindow as applyVllmRuntimeContextWindowFromModels } from "./vllm-runtime-context";
import { getDualStationManagedVllmBaseUrl } from "./vllm-station-cluster-lifecycle";

export type { OllamaRuntimeModelStatus } from "./ollama-runtime-context";

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
export { CONTAINER_REACHABILITY_IMAGE } from "../adapters/http/container-curl-probe";
export { OLLAMA_PORT };

// These tags are convenience aliases for callers that want to refer to a
// specific bootstrap model by role rather than by string. The canonical
// metadata (memory requirements, download sizes) lives in
// `ollama-model-registry.ts`; the assertion below makes module load fail
// loudly if a registry edit drops a tag a caller still references by
// name, so the two stay in sync.
function assertRegistryTag(tag: string): string {
  if (!OLLAMA_MODEL_REGISTRY.some((entry) => entry.tag === tag)) {
    throw new Error(`Tag '${tag}' is not in OLLAMA_MODEL_REGISTRY. Update the registry first.`);
  }
  return tag;
}

export const SMALL_OLLAMA_MODEL = SMALLEST_OLLAMA_MODEL_TAG;
export const DEFAULT_OLLAMA_MODEL = assertRegistryTag(DEFAULT_OLLAMA_MODEL_TAG);
export const QWEN3_6_OLLAMA_MODEL = assertRegistryTag("qwen3.6:35b");

export type RunCaptureFn = (
  cmd: readonly string[],
  opts?: { ignoreError?: boolean; env?: NodeJS.ProcessEnv },
) => string;
type PrepareDockerEnvironmentFn = () => PreparedDockerBuildEnvironment;

export {
  getInstalledOllamaVersion,
  getRunningOllamaDaemonVersion,
  isOllamaVersionAtLeast,
  MIN_OLLAMA_VERSION,
} from "./ollama-version";

export type RunCaptureExFn = (cmd: string[], opts?: { env?: NodeJS.ProcessEnv }) => CaptureResult;

// Hosts that local-provider discovery may try when probing Ollama. The Windows
// onboarding path separately checks host.docker.internal from Docker Desktop's
// network context because the alias may not resolve from the WSL host.
export {
  isLocalOllamaRouteOwner,
  OLLAMA_HOST_DOCKER_INTERNAL,
  OLLAMA_LOCALHOST,
} from "./local-adapter-lifecycle";

/** Build the credential-free Docker Desktop probe for Windows-host Ollama. */
export function getWindowsHostOllamaDockerReachabilityArgs(): string[] {
  return [
    "run",
    "--rm",
    CONTAINER_REACHABILITY_IMAGE,
    "-sf",
    "--connect-timeout",
    "2",
    "--max-time",
    "5",
    `http://${OLLAMA_HOST_DOCKER_INTERNAL}:${OLLAMA_PORT}/api/tags`,
  ];
}

let _resolvedOllamaHost: string | null = null;
const OLLAMA_HOST_RECEIPT_NAME = "ollama-host.json";

type OllamaHostReceipt = {
  readonly schemaVersion: 1;
  readonly host: typeof OLLAMA_LOCALHOST | typeof OLLAMA_HOST_DOCKER_INTERNAL;
};

function isSupportedOllamaHost(
  host: unknown,
): host is typeof OLLAMA_LOCALHOST | typeof OLLAMA_HOST_DOCKER_INTERNAL {
  return host === OLLAMA_LOCALHOST || host === OLLAMA_HOST_DOCKER_INTERNAL;
}

function ollamaHostReceiptPath(stateRoot: string): string {
  return nodePath.join(stateRoot, OLLAMA_HOST_RECEIPT_NAME);
}

function ollamaCandidateHosts(wslDetection: WslDetectionOptions = {}): string[] {
  return isWsl(wslDetection) ? [OLLAMA_LOCALHOST, OLLAMA_HOST_DOCKER_INTERNAL] : [OLLAMA_LOCALHOST];
}

// Probe each candidate host for a responding Ollama. Returns the first host
// whose `/api/tags` succeeds, or null if none responds. Result is cached for
// the rest of the onboard run; call resetOllamaHostCache() in tests.
// wslDetection pins the WSL decision so a caller on any host can exercise the
// WSL candidate order; isWsl otherwise answers false off Linux before reading
// the environment.
export function findReachableOllamaHost(
  runCaptureImpl?: RunCaptureFn,
  wslDetection: WslDetectionOptions = {},
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): string | null {
  if (_resolvedOllamaHost !== null) return _resolvedOllamaHost;
  const persistedHost = loadPersistedOllamaHost(stateRoot);
  const capture = runCaptureImpl ?? runCapture;
  const candidates = [
    ...(persistedHost ? [persistedHost] : []),
    ...ollamaCandidateHosts(wslDetection).filter((host) => host !== persistedHost),
  ];
  for (const host of candidates) {
    // Explicit timeouts: a blackholed host (e.g., firewalled host.docker.internal)
    // would otherwise stall the synchronous onboard probe for the OS connect
    // timeout (~75-130s on Linux). Matches the convention used in
    // getLocalProviderHealthStatus probes.
    const result = createOllamaApiCapture(capture, host)(
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
    if (host === persistedHost) clearPersistedOllamaHost(stateRoot);
  }
  return null;
}

// Returns the resolved host if a probe has succeeded, otherwise OLLAMA_LOCALHOST.
// Used by URL-builder helpers that need a string and don't want to re-probe.
export function getResolvedOllamaHost(): string {
  return _resolvedOllamaHost ?? OLLAMA_LOCALHOST;
}

/**
 * Persist the accepted host-global Ollama route for later CLI processes.
 * `ollama-local` is one gateway provider backed by one host auth proxy, so all
 * sandboxes using that provider share the same daemon target. Discovery probes
 * this receipt first and changes it only after the recorded target is stale.
 */
export function persistResolvedOllamaHost(
  host: string = getResolvedOllamaHost(),
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): () => void {
  if (!isSupportedOllamaHost(host)) {
    throw new Error(`Refusing to persist unexpected Ollama host: ${host}`);
  }
  const receiptPath = ollamaHostReceiptPath(stateRoot);
  const previousHost = loadPersistedOllamaHost(stateRoot);
  writeLocalAdapterJsonFile(receiptPath, {
    schemaVersion: 1,
    host,
  } satisfies OllamaHostReceipt);
  return () => {
    if (previousHost) {
      writeLocalAdapterJsonFile(receiptPath, {
        schemaVersion: 1,
        host: previousHost,
      } satisfies OllamaHostReceipt);
    } else {
      removeLocalAdapterFile(receiptPath);
    }
  };
}

/** Read only the two fixed local Ollama routes NemoClaw can establish. */
export function loadPersistedOllamaHost(
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): typeof OLLAMA_LOCALHOST | typeof OLLAMA_HOST_DOCKER_INTERNAL | null {
  const receipt = readLocalAdapterJsonFile(ollamaHostReceiptPath(stateRoot));
  return receipt?.schemaVersion === 1 && isSupportedOllamaHost(receipt.host) ? receipt.host : null;
}

export function clearPersistedOllamaHost(
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): void {
  removeLocalAdapterFile(ollamaHostReceiptPath(stateRoot));
  _resolvedOllamaHost = null;
}

export function clearPersistedOllamaHostIfUnused(
  routes: readonly OllamaRouteHolder[],
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): boolean {
  const selectedHost = loadPersistedOllamaHost(stateRoot);
  if (routes.some((route) => isLocalOllamaRouteOwner(route, selectedHost))) return false;
  clearPersistedOllamaHost(stateRoot);
  return true;
}

/** Keep Windows-host Ollama requests in Docker Desktop's verified network context. */
export function getOllamaApiCommand(
  curlArgs: readonly string[],
  host: string = getResolvedOllamaHost(),
): string[] {
  return host === OLLAMA_HOST_DOCKER_INTERNAL
    ? ["docker", "run", "--rm", CONTAINER_REACHABILITY_IMAGE, ...curlArgs]
    : ["curl", ...curlArgs];
}

export type PreparedOllamaApiExecution = {
  readonly command: string[];
  readonly env?: NodeJS.ProcessEnv;
  cleanup(): void;
};

/** Own command translation and Docker-client isolation for one Ollama API process. */
export function prepareOllamaApiExecution(
  command: readonly string[],
  host: string = getResolvedOllamaHost(),
  options: {
    env?: NodeJS.ProcessEnv;
    operation?: string;
    prepareDockerEnvironment?: PrepareDockerEnvironmentFn;
  } = {},
): PreparedOllamaApiExecution {
  const [executable, ...args] = command;
  const translated = executable === "curl" ? getOllamaApiCommand(args, host) : [...command];
  if (translated[0] !== "docker") {
    return { command: translated, env: options.env, cleanup: () => {} };
  }
  const prepared = (options.prepareDockerEnvironment ?? prepareIsolatedDockerEnvironment)();
  let cleaned = false;
  return {
    command: translated,
    env: mergeIsolatedDockerClientEnv(options.env ?? {}, prepared),
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      warnIfDockerBuildEnvironmentCleanupFailed(
        prepared.cleanup(),
        options.operation ?? "Windows-host Ollama API request",
      );
    },
  };
}

export function createOllamaApiCapture(
  runCaptureImpl?: RunCaptureFn,
  host: string = getResolvedOllamaHost(),
  prepareDockerEnvironment: PrepareDockerEnvironmentFn = prepareIsolatedDockerEnvironment,
): RunCaptureFn {
  const capture = runCaptureImpl ?? runCapture;
  return (command, options) => {
    const execution = prepareOllamaApiExecution(command, host, {
      env: options?.env,
      prepareDockerEnvironment,
    });
    try {
      return capture(execution.command, {
        ...options,
        ...(execution.env === undefined ? {} : { env: execution.env }),
      });
    } finally {
      execution.cleanup();
    }
  };
}

export function createOllamaApiCaptureEx(
  runCaptureExImpl: RunCaptureExFn = runCaptureEx,
  host: string = getResolvedOllamaHost(),
  prepareDockerEnvironment: PrepareDockerEnvironmentFn = prepareIsolatedDockerEnvironment,
): RunCaptureExFn {
  return (command, options) => {
    const execution = prepareOllamaApiExecution(command, host, {
      env: options?.env,
      prepareDockerEnvironment,
    });
    try {
      return runCaptureExImpl(execution.command, {
        ...options,
        ...(execution.env === undefined ? {} : { env: execution.env }),
      });
    } finally {
      execution.cleanup();
    }
  };
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
  /**
   * `true` for integrated/iGPU class devices whose token-generation throughput
   * is too low to clear agent-loop timeouts on 30B-class models, even when
   * advertised memory ostensibly fits. Populated for Jetson (Tegra/Thor/Orin)
   * platforms and the Windows-ARM N1X integrated GPU (the JMJWOA-Generic
   * placeholder that clears the bounded Docker CUDA proof). Drives the
   * `computeIntensive` exclusion in the bootstrap-model selector so
   * compute-constrained hosts are not steered onto 30B+ tags.
   */
  computeConstrained?: boolean;
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
  return /\brunner\b[\s\S]{0,80}\b(?:stopped|terminated|crashed|exited|died|killed)\b/i.test(text);
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
  /** Configured runtime model that must be present in the provider inventory. */
  model?: string | null;
  runCurlProbeImpl?: (argv: string[], opts?: CurlProbeOptions) => CurlProbeResult;
  /** Executes the translated Windows-host Docker probe. Injectable for transport tests. */
  ollamaRunCaptureExImpl?: RunCaptureExFn;
  findReachableOllamaHostImpl?: () => string | null;
  /**
   * Lets callers that perform their own Ollama auth-proxy check avoid the
   * legacy inline proxy subprobe. The inline subprobe is retained for status
   * rendering paths that still need a combined backend/proxy result.
   */
  skipOllamaAuthProxySubprobe?: boolean;
  /**
   * Reads the persisted Ollama auth-proxy bearer token. Injectable for tests.
   * Default reads from `ollama-proxy-token` in the selected gateway's host
   * state root (written by inference/ollama/proxy.ts during onboard).
   */
  loadOllamaProxyTokenImpl?: () => string | null;
  /** Reads the host-global managed vLLM key. Injectable so tests stay deterministic. */
  loadVllmApiKeyImpl?: () => string | null;
  /** Recovers a managed Station endpoint while validating the injected key. */
  getManagedVllmBaseUrlImpl?: ManagedStationVllmBaseUrlResolver;
  /** Recovers a receipt-owned managed cluster endpoint. */
  recoverManagedClusterVllmEndpointImpl?: ManagedClusterVllmEndpointResolver;
}

function defaultLoadOllamaProxyToken(): string | null {
  const tokenPath = nodePath.join(resolveSharedLocalAdapterStateRoot(), "ollama-proxy-token");
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

function runLocalCurlProbe(argv: string[], opts: CurlProbeOptions = {}): CurlProbeResult {
  return runCurlProbe(argv, { ...opts, env: buildSubprocessEnv(), replaceEnv: true });
}

function runOllamaLocalCurlProbe(
  argv: string[],
  host: string,
  runCaptureExImpl: RunCaptureExFn = runCaptureEx,
): CurlProbeResult {
  const command = getOllamaApiCommand(buildValidatedCurlCommandArgs(["-f", ...argv]), host);
  const result = createOllamaApiCaptureEx(runCaptureExImpl, host)(command);
  const ok = result.exitCode === 0;
  const stderr = String(result.stderr ?? "");
  return {
    ok,
    httpStatus: ok ? 200 : 0,
    curlStatus: result.exitCode ?? 1,
    body: result.stdout,
    stderr,
    message: ok
      ? "HTTP 200"
      : (stderr || result.stdout || `Docker Ollama probe exited ${String(result.exitCode)}`)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300),
  };
}

export interface VllmModelsProbeOptions {
  runCurlProbeImpl?: (argv: string[], opts?: CurlProbeOptions) => CurlProbeResult;
}

/** Query vLLM's authoritative model inventory without exposing its bearer in process argv. */
export function probeVllmModels(
  baseUrl: string,
  apiKey: string,
  options: VllmModelsProbeOptions = {},
): CurlProbeResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runLocalCurlProbe;
  let authConfig: ReturnType<typeof createBearerAuthConfig> | undefined;
  try {
    authConfig = createBearerAuthConfig(apiKey, { prefix: "nemoclaw-vllm-auth" });
    return runCurlProbeImpl(
      [
        "-sS",
        "--connect-timeout",
        "3",
        "--max-time",
        "5",
        ...authConfig.args,
        `${baseUrl.replace(/\/+$/, "")}/models`,
      ],
      {
        trustedConfigFiles: authConfig.trustedConfigFiles,
        // Managed dual-Station endpoints are recovered from owned container
        // labels and use a direct-attached RFC1918 rail. Never delegate that
        // request through an ambient HTTP proxy.
        pinnedAddresses: [],
      },
    );
  } catch {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 1,
      body: "",
      stderr: "",
      message: "Could not prepare the authenticated vLLM model probe.",
    };
  } finally {
    authConfig?.cleanup();
  }
}

// A 200 response on `/api/tags` alone is not enough to call Ollama healthy —
// a captive HTTP_PROXY, a stale listener, or a stub on the loopback port can
// all answer with arbitrary 2xx bodies that look healthy at the curl-status
// level. The authoritative signal is the Ollama wire format itself:
// `{ "models": [...] }`. An empty array is fine — that just means no models
// pulled yet — but a body that doesn't parse as JSON-with-array-`models` did
// not come from Ollama and the probe should not call it healthy. (#4275)
function parseModelInventory(provider: string, body: string): string[] | null {
  try {
    const parsed = JSON.parse(body);
    if (!isObjectRecord(parsed)) return null;
    const entries = provider === "ollama-local" ? parsed.models : parsed.data;
    if (!Array.isArray(entries)) return null;
    if (provider !== "ollama-local") {
      return entries.flatMap((entry) => {
        if (!isObjectRecord(entry)) return [];
        return typeof entry.id === "string" && entry.id !== "" ? [entry.id] : [];
      });
    }
    const inventory: string[] = [];
    for (const entry of entries) {
      if (!isObjectRecord(entry)) return null;
      const values = [entry.name, entry.model];
      const names = values.filter(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      if (names.length === 0) return null;
      inventory.push(...names);
    }
    return inventory;
  } catch {
    return null;
  }
}

export function isValidOllamaTagsResponseBody(body: string): boolean {
  return parseOllamaModelInventory(body) !== null;
}

function normalizeOllamaModel(value: string): string {
  return value.endsWith(":latest") ? value.slice(0, -":latest".length) : value;
}

function inventoryContainsModel(provider: string, inventory: string[], model: string): boolean {
  if (provider !== "ollama-local") return inventory.includes(model);
  const expected = normalizeOllamaModel(model);
  return inventory.some((candidate) => normalizeOllamaModel(candidate) === expected);
}

/** Parse a complete Ollama `/api/tags` inventory, or return null when any entry is malformed. */
export function parseOllamaModelInventory(body: string): string[] | null {
  return parseModelInventory("ollama-local", body);
}

export function ollamaInventoryContainsModel(inventory: string[], model: string): boolean {
  return inventoryContainsModel("ollama-local", inventory, model);
}

function sanitizeModelNameForDisplay(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return sanitized.length > 120 ? `${sanitized.slice(0, 117)}...` : sanitized;
}

/** Render a model inventory for an operator-facing message, bounded and sanitised. */
export function describeModelInventory(inventory: readonly string[]): string {
  if (inventory.length === 0) return "none";
  return inventory
    .slice(0, 5)
    .map((entry) => sanitizeModelNameForDisplay(entry) || "<invalid>")
    .join(", ");
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
  const value = String(raw || "")
    .trim()
    .replace(/\/+$/, "");
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

function configuredLocalInferenceHostUrl(hostUrl?: string | null): string | null {
  return (
    normalizeLocalInferenceHostUrl(hostUrl) ||
    normalizeLocalInferenceHostUrl(process.env[LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV])
  );
}

type RecoveredManagedVllmBinding =
  | { readonly kind: "available"; readonly binding: ManagedVllmProviderBinding | null }
  | { readonly kind: "unavailable" };

function recoveredManagedVllmBinding(): RecoveredManagedVllmBinding {
  if (configuredLocalInferenceHostUrl()) return { kind: "available", binding: null };
  try {
    return { kind: "available", binding: getManagedVllmProviderBinding() };
  } catch {
    return { kind: "unavailable" };
  }
}

export interface ManagedVllmProviderBinding {
  baseUrl: string;
  validationBaseUrl?: string;
  apiKey: string;
}

type ManagedStationVllmBaseUrlResolver = (overrides?: {
  loadApiKey?: () => string | null;
  onManagedHeadObserved?: () => void;
}) => string | null;

type ManagedClusterVllmEndpointResolver = (options?: {
  loadApiKey?: () => string | null;
}) => Pick<RecoveredManagedClusterVllmEndpoint, "baseUrl" | "apiKey"> | null;

type HostLocalManagedVllmEndpointResolver = (options?: {
  loadApiKey?: () => string | null;
}) => { baseUrl: string; apiKey: string } | null;

export type ManagedVllmProviderState =
  | { kind: "absent" }
  | { kind: "invalid-auth"; reason: "missing" | "unsafe" | "mismatched" }
  | ({ kind: "ready" } & ManagedVllmProviderBinding);

export interface ManagedVllmProviderBindingOptions {
  hostUrl?: string | null;
  /** Compatibility seam for the Station lifecycle resolver. */
  getManagedBaseUrlImpl?: ManagedStationVllmBaseUrlResolver;
  loadApiKeyImpl?: () => string | null;
  recoverManagedClusterVllmEndpointImpl?: ManagedClusterVllmEndpointResolver;
  recoverHostLocalManagedVllmEndpointImpl?: HostLocalManagedVllmEndpointResolver;
}

function getManagedStationVllmProviderState(
  options: ManagedVllmProviderBindingOptions,
  loadApiKey: () => string | null,
): ManagedVllmProviderState {
  let keyRead = false;
  let managedHeadObserved = false;
  let apiKey: string | null = null;
  let authFailure: "missing" | "unsafe" | null = null;
  let managedBaseUrl: string | null;
  try {
    managedBaseUrl = (options.getManagedBaseUrlImpl ?? getDualStationManagedVllmBaseUrl)({
      onManagedHeadObserved: () => {
        managedHeadObserved = true;
      },
      loadApiKey: () => {
        keyRead = true;
        try {
          apiKey = loadApiKey();
          if (!apiKey) authFailure = "missing";
          return apiKey;
        } catch {
          authFailure = "unsafe";
          return null;
        }
      },
    });
  } catch (error) {
    // A malformed key can make lifecycle fingerprint validation throw. Once
    // key recovery began, treat every such failure as unsafe authentication;
    // unrelated endpoint-inspection failures retain their existing behavior.
    if (keyRead) return { kind: "invalid-auth", reason: "unsafe" };
    throw error;
  }

  // Production recovery reports a structurally owned managed head before it
  // validates fingerprint metadata. Test resolvers may still signal ownership
  // by invoking the key reader, so only the absence of both signals permits the
  // legacy single-host path.
  if (!managedHeadObserved && !keyRead) return { kind: "absent" };
  if (!managedBaseUrl || !apiKey) {
    return { kind: "invalid-auth", reason: authFailure ?? "mismatched" };
  }
  return { kind: "ready", baseUrl: `${managedBaseUrl.replace(/\/+$/, "")}/v1`, apiKey };
}

/** Recover the one owned managed endpoint and credential as a validated state. */
export function getManagedVllmProviderState(
  options: ManagedVllmProviderBindingOptions = {},
): ManagedVllmProviderState {
  if (configuredLocalInferenceHostUrl(options.hostUrl)) return { kind: "absent" };

  const loadApiKey = options.loadApiKeyImpl ?? loadManagedVllmApiKey;
  let managedClusterAuthFailure: "missing" | "unsafe" | null = null;
  let managedClusterEndpoint: Pick<
    RecoveredManagedClusterVllmEndpoint,
    "baseUrl" | "apiKey"
  > | null;
  try {
    managedClusterEndpoint = (
      options.recoverManagedClusterVllmEndpointImpl ?? recoverInstalledManagedClusterVllmEndpoint
    )({
      loadApiKey: () => {
        try {
          const apiKey = loadApiKey();
          if (!apiKey) managedClusterAuthFailure = "missing";
          return apiKey;
        } catch {
          managedClusterAuthFailure = "unsafe";
          return null;
        }
      },
    });
  } catch (error) {
    if (managedClusterAuthFailure) {
      return { kind: "invalid-auth", reason: managedClusterAuthFailure };
    }
    throw error;
  }

  const stationState = getManagedStationVllmProviderState(options, loadApiKey);
  const hostLocalEndpoint = options.recoverHostLocalManagedVllmEndpointImpl
    ? options.recoverHostLocalManagedVllmEndpointImpl({ loadApiKey })
    : options.getManagedBaseUrlImpl
      ? null
      : recoverHostLocalManagedVllmEndpoint({ loadApiKey });
  const presentCount =
    Number(Boolean(managedClusterEndpoint)) +
    Number(Boolean(hostLocalEndpoint)) +
    Number(stationState.kind !== "absent");
  if (managedClusterEndpoint && stationState.kind !== "absent" && !hostLocalEndpoint) {
    throw new Error(
      "Both managed cluster and Station vLLM state are present; refusing to select either endpoint.",
    );
  }
  if (presentCount > 1) {
    throw new Error("Multiple managed vLLM runtimes are present; refusing to select an endpoint.");
  }
  if (hostLocalEndpoint) {
    let recoveredUrl: URL;
    try {
      recoveredUrl = new URL(hostLocalEndpoint.baseUrl);
    } catch {
      throw new Error("Managed host-local vLLM returned an invalid loopback endpoint.");
    }
    const recoveredPort = Number(recoveredUrl.port);
    if (
      recoveredUrl.protocol !== "http:" ||
      recoveredUrl.hostname !== "127.0.0.1" ||
      recoveredUrl.pathname !== "/" ||
      recoveredUrl.username ||
      recoveredUrl.password ||
      recoveredUrl.search ||
      recoveredUrl.hash ||
      !Number.isSafeInteger(recoveredPort) ||
      recoveredPort < 1024 ||
      recoveredPort > 65_535
    ) {
      throw new Error("Managed host-local vLLM returned an invalid loopback endpoint.");
    }
    return {
      kind: "ready",
      baseUrl: `${HOST_GATEWAY_URL}:${String(recoveredPort)}/v1`,
      validationBaseUrl: `${hostLocalEndpoint.baseUrl.replace(/\/+$/, "")}/v1`,
      apiKey: hostLocalEndpoint.apiKey,
    };
  }
  if (!managedClusterEndpoint) return stationState;
  return {
    kind: "ready",
    baseUrl: `${managedClusterEndpoint.baseUrl.replace(/\/+$/, "")}/v1`,
    apiKey: managedClusterEndpoint.apiKey,
  };
}

export function getManagedVllmProviderBinding(
  options: ManagedVllmProviderBindingOptions = {},
): ManagedVllmProviderBinding | null {
  const state = getManagedVllmProviderState(options);
  if (state.kind === "absent") return null;
  if (state.kind === "invalid-auth") {
    if (state.reason !== "missing") {
      throw new Error("Managed vLLM authentication is unsafe or mismatched.");
    }
    throw new Error("Managed vLLM authentication is missing.");
  }
  return {
    baseUrl: state.baseUrl,
    ...(state.validationBaseUrl ? { validationBaseUrl: state.validationBaseUrl } : {}),
    apiKey: state.apiKey,
  };
}

export function getLocalProviderBaseUrl(
  provider: string,
  options: { hostUrl?: string | null } = {},
): string | null {
  const configuredHostUrl = configuredLocalInferenceHostUrl(options.hostUrl);
  const hostUrl = configuredHostUrl || HOST_GATEWAY_URL;
  switch (provider) {
    case "vllm-local": {
      if (!configuredHostUrl) {
        const managed = recoveredManagedVllmBinding();
        if (managed.kind === "unavailable") return null;
        if (managed.binding) return managed.binding.baseUrl;
      }
      return `${hostUrl}:${VLLM_PORT}/v1`;
    }
    case "ollama-local":
      // Containers reach Ollama through the auth proxy, not directly.
      return `${hostUrl}:${getOllamaContainerPort()}/v1`;
    default:
      return null;
  }
}

export function getLocalProviderValidationBaseUrl(provider: string): string | null {
  switch (provider) {
    case "vllm-local": {
      const managed = recoveredManagedVllmBinding();
      if (managed.kind === "unavailable") return null;
      return managed.binding
        ? (managed.binding.validationBaseUrl ?? managed.binding.baseUrl)
        : `http://127.0.0.1:${VLLM_PORT}/v1`;
    }
    case "ollama-local":
      return `http://${getResolvedOllamaHost()}:${OLLAMA_PORT}/v1`;
    default:
      return null;
  }
}

export function getLocalProviderHealthEndpoint(provider: string): string | null {
  switch (provider) {
    case "vllm-local": {
      const managed = recoveredManagedVllmBinding();
      if (managed.kind === "unavailable") return null;
      const managedBaseUrl = managed.binding
        ? (managed.binding.validationBaseUrl ?? managed.binding.baseUrl)
        : null;
      return managedBaseUrl
        ? `${managedBaseUrl}/models`
        : `http://127.0.0.1:${VLLM_PORT}/v1/models`;
    }
    case "ollama-local":
      return `http://${getResolvedOllamaHost()}:${OLLAMA_PORT}/api/tags`;
    default:
      return null;
  }
}

/** Lightweight endpoint used only to prove that the local service is reachable. */
export function getLocalProviderAvailabilityEndpoint(provider: string): string | null {
  if (provider === "vllm-local") {
    const managed = recoveredManagedVllmBinding();
    if (managed.kind === "unavailable") return null;
    if (managed.binding) {
      const validationRoot = (managed.binding.validationBaseUrl ?? managed.binding.baseUrl).replace(
        /\/v1\/?$/,
        "",
      );
      return `${validationRoot}/health`;
    }
    return `http://127.0.0.1:${VLLM_PORT}/v1/models`;
  }
  return getLocalProviderHealthEndpoint(provider);
}

export function isLocalProviderProbeOutputHealthy(endpoint: string, output: string): boolean {
  const normalized = output.trim();
  if (!normalized || normalized === "000") return false;
  return endpoint.endsWith("/health") ? normalized === "200" : true;
}

export function getLocalProviderHealthCheck(provider: string): string[] | null {
  const endpoint = getLocalProviderAvailabilityEndpoint(provider);
  if (provider === "vllm-local" && endpoint?.endsWith("/health")) {
    return [
      "curl",
      "-sf",
      "--connect-timeout",
      "3",
      "--max-time",
      "5",
      "--noproxy",
      "*",
      "--write-out",
      "%{http_code}",
      endpoint,
    ];
  }
  if (!endpoint) return null;
  const curlArgs = buildValidatedCurlCommandArgs(["-sf", endpoint]);
  return provider === "ollama-local" ? getOllamaApiCommand(curlArgs) : ["curl", ...curlArgs];
}

/**
 * Positive host-side reachability signal for a local inference provider: does
 * it actually respond on its host loopback endpoint (127.0.0.1:<port>)?
 *
 * Unlike validateLocalProvider, this does NOT run the Docker `--add-host`
 * container-reachability emulation — that probe is unreliable on some Docker
 * setups (the real sandbox path is k3s CoreDNS), so its failure is not
 * evidence the route is down. Callers that need a positive "the provider is
 * up" signal (not merely "the host is not down") should use this.
 */
export function isLocalProviderHostHealthy(
  provider: string,
  runCaptureImpl?: RunCaptureFn,
): boolean {
  const command = getLocalProviderHealthCheck(provider);
  if (!command) return false;
  const capture = runCaptureImpl ?? runCapture;
  const hostCapture = provider === "ollama-local" ? createOllamaApiCapture(capture) : capture;
  return isLocalProviderProbeOutputHealthy(
    command.at(-1) ?? "",
    hostCapture(command, { ignoreError: true }),
  );
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
  const base = {
    providerLabel: "Ollama auth proxy",
    endpoint,
    probeLabel: "auth proxy",
  };
  let authConfig: ReturnType<typeof createBearerAuthConfig>;
  try {
    authConfig = createBearerAuthConfig(token);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      ok: false,
      failureLabel: "unhealthy",
      detail:
        `Ollama auth proxy health could not prepare the persisted token for ${endpoint}. ` +
        `(${reason})`,
    };
  }
  let result: CurlProbeResult;
  try {
    result = runCurlProbeImpl(
      ["-sS", "--connect-timeout", "3", "--max-time", "5", ...authConfig.args, endpoint],
      { trustedConfigFiles: authConfig.trustedConfigFiles },
    );
  } finally {
    authConfig.cleanup();
  }
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
    detail: `Ollama auth proxy returned HTTP ${result.httpStatus} on ${endpoint}. (${result.message})`,
  };
}

export function probeLocalProviderHealth(
  provider: string,
  options: LocalProviderHealthProbeOptions = {},
): LocalProviderHealthStatus | null {
  const providerLabel = getLocalProviderLabel(provider);
  if (!providerLabel) return null;
  if (provider === "ollama-local") {
    (options.findReachableOllamaHostImpl ?? findReachableOllamaHost)();
  }

  let managedState: ManagedVllmProviderState = { kind: "absent" };
  if (provider === "vllm-local") {
    try {
      managedState = getManagedVllmProviderState({
        getManagedBaseUrlImpl: options.getManagedVllmBaseUrlImpl,
        loadApiKeyImpl: options.loadVllmApiKeyImpl,
        recoverManagedClusterVllmEndpointImpl: options.recoverManagedClusterVllmEndpointImpl,
      });
    } catch {
      return {
        ok: false,
        providerLabel,
        endpoint: "managed vLLM",
        failureLabel: "unhealthy",
        probeLabel: "vllm backend",
        detail:
          "Managed vLLM state could not be inspected safely. Re-run `nemoclaw onboard` to repair the provider.",
      };
    }
  }
  if (managedState.kind === "invalid-auth") {
    const missingAuth = managedState.reason === "missing";
    return {
      ok: false,
      providerLabel,
      endpoint: "managed vLLM",
      failureLabel: missingAuth ? "unauthorized" : "unhealthy",
      probeLabel: "vllm backend",
      detail: missingAuth
        ? "Managed vLLM requires its bearer credential, but no private key is available. Re-run `nemoclaw onboard` to repair the provider."
        : "Managed vLLM authentication state is unsafe or does not match the service. Re-run `nemoclaw onboard` to repair the provider.",
    };
  }
  const managedBinding = managedState.kind === "ready" ? managedState : null;
  const managedValidationBaseUrl = managedBinding
    ? (managedBinding.validationBaseUrl ?? managedBinding.baseUrl)
    : null;
  const endpoint = managedValidationBaseUrl
    ? `${managedValidationBaseUrl}/models`
    : provider === "vllm-local"
      ? `http://127.0.0.1:${VLLM_PORT}/v1/models`
      : getLocalProviderHealthEndpoint(provider);
  if (!endpoint) return null;

  const resolvedOllamaHost =
    provider === "ollama-local" ? getResolvedOllamaHost() : OLLAMA_LOCALHOST;
  const runCurlProbeImpl =
    options.runCurlProbeImpl ??
    (provider === "ollama-local" && resolvedOllamaHost === OLLAMA_HOST_DOCKER_INTERNAL
      ? (argv: string[]) =>
          runOllamaLocalCurlProbe(argv, resolvedOllamaHost, options.ollamaRunCaptureExImpl)
      : runLocalCurlProbe);
  let result: CurlProbeResult;
  if (managedBinding) {
    result = probeVllmModels(managedValidationBaseUrl!, managedBinding.apiKey, {
      runCurlProbeImpl,
    });
  } else {
    result = runCurlProbeImpl(["-sS", "--connect-timeout", "3", "--max-time", "5", endpoint]);
  }

  // Per #3265 the status line is renamed `Inference (<backend>):` for local
  // providers so the upcoming `Inference (auth proxy):` subprobe lines render
  // in parallel and the user can see which hop is broken.
  const probeLabel =
    provider === "ollama-local"
      ? "ollama backend"
      : provider === "vllm-local"
        ? "vllm backend"
        : undefined;

  const subprobes: LocalProviderHealthStatus[] = [];
  if (provider === "ollama-local" && !options.skipOllamaAuthProxySubprobe) {
    const proxyProbe = probeOllamaAuthProxyHealth(options);
    if (proxyProbe) subprobes.push(proxyProbe);
  }
  const attachSubprobes = subprobes.length > 0 ? { subprobes } : {};
  const attachProbeLabel = probeLabel ? { probeLabel } : {};

  if (result.ok) {
    const inventory = parseModelInventory(provider, result.body);
    // For ollama-local, a 200 is necessary but not sufficient: a captive
    // HTTP_PROXY, a stale listener on 11434, or any other HTTP responder
    // can return 200 with an arbitrary body. Treat the probe as healthy
    // only when the response is the Ollama /api/tags JSON shape. (#4275)
    if (provider === "ollama-local" && !inventory) {
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
    const configuredModel = options.model?.trim();
    if (configuredModel) {
      const configuredModelDisplay = sanitizeModelNameForDisplay(configuredModel) || "<invalid>";
      if (!inventory) {
        return {
          ok: false,
          providerLabel,
          endpoint,
          failureLabel: "unhealthy",
          detail:
            `${providerLabel} responded on ${endpoint}, but its model inventory was invalid; ` +
            `could not verify configured model '${configuredModelDisplay}'.`,
          ...attachProbeLabel,
          ...attachSubprobes,
        };
      }
      if (!inventoryContainsModel(provider, inventory, configuredModel)) {
        return {
          ok: false,
          providerLabel,
          endpoint,
          failureLabel: "unhealthy",
          detail:
            `${providerLabel} is reachable on ${endpoint}, but configured model ` +
            `'${configuredModelDisplay}' is unavailable (reported models: ${describeModelInventory(inventory)}).`,
          ...attachProbeLabel,
          ...attachSubprobes,
        };
      }
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

export function getLocalProviderContainerReachabilityCheck(
  provider: "ollama-local",
  responseMode: "body",
): string[] | null;
export function getLocalProviderContainerReachabilityCheck(
  provider: string,
  responseMode?: "status",
): string[] | null;
export function getLocalProviderContainerReachabilityCheck(
  provider: string,
  responseMode: "status" | "body" = "status",
): string[] | null {
  switch (provider) {
    case "vllm-local": {
      const managed = recoveredManagedVllmBinding();
      if (managed.kind === "unavailable") return null;
      const managedBaseUrl = managed.binding?.baseUrl.replace(/\/v1\/?$/, "") ?? null;
      const hostAlias = managed.binding?.validationBaseUrl
        ? `host.openshell.internal:${resolveManagedVllmBridgeHost()}`
        : "host.openshell.internal:host-gateway";
      return [
        ...(managedBaseUrl ? ["docker", "--context", "default"] : ["docker"]),
        "run",
        "--rm",
        "--add-host",
        hostAlias,
        CONTAINER_REACHABILITY_IMAGE,
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        ...(managedBaseUrl ? ["--noproxy", "*"] : []),
        "-sf",
        ...(managedBaseUrl ? ["-w", "%{http_code}"] : []),
        managedBaseUrl
          ? `${managedBaseUrl}/health`
          : `http://host.openshell.internal:${VLLM_PORT}/v1/models`,
      ];
    }
    case "ollama-local": {
      // Check the host port reachable from containers: raw Ollama when host
      // loopback is reachable, otherwise the auth proxy.
      // Use -w %{http_code} (instead of -sf) so an authenticated-but-401
      // response still proves the network path works — the proxy now
      // requires a Bearer token on every endpoint (#3338) and the ephemeral
      // probe container doesn't carry one, but the goal here is connectivity
      // not authorisation.
      const containerPort =
        getResolvedOllamaHost() === OLLAMA_HOST_DOCKER_INTERNAL
          ? OLLAMA_PORT
          : getOllamaContainerPort();
      if (responseMode === "body" && containerPort !== OLLAMA_PORT) return null;
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
        ...(responseMode === "status" ? ["-s", "-o", "/dev/null", "-w", "%{http_code}"] : ["-sf"]),
        `http://host.openshell.internal:${containerPort}/api/tags`,
      ];
    }
    default:
      return null;
  }
}

/** Read the validated inventory from one raw Ollama daemon. */
export function probeOllamaEndpointInventory(
  host: string,
  runCaptureImpl?: RunCaptureFn,
): string[] | null {
  const capture = createOllamaApiCapture(runCaptureImpl, host);
  const body = capture(
    [
      "curl",
      ...buildValidatedCurlCommandArgs([
        "-sf",
        "--connect-timeout",
        "3",
        "--max-time",
        "5",
        `http://${host}:${OLLAMA_PORT}/api/tags`,
      ]),
    ],
    { ignoreError: true },
  );
  return parseOllamaModelInventory(body);
}

/**
 * Confirm the selected model exists on the host-bridge daemon recorded for the sandbox.
 * Only a valid inventory that lacks the model fails; an inconclusive Docker probe cannot
 * override the host-side validation already performed by `validateLocalProvider`.
 */
export function validateSandboxFacingOllamaModel(
  model: string,
  runCaptureImpl?: RunCaptureFn,
  prepareDockerEnvironment: PrepareDockerEnvironmentFn = prepareIsolatedDockerEnvironment,
): ValidationResult {
  const command = getLocalProviderContainerReachabilityCheck("ollama-local", "body");
  if (!command) return { ok: true };
  const selected = String(model ?? "").trim();
  if (!selected) return { ok: true };

  const prepared = prepareDockerEnvironment();
  try {
    const capture = isolateDockerClientCapture(runCaptureImpl ?? runCapture, prepared);
    const inventory = parseOllamaModelInventory(capture(command, { ignoreError: true }));
    if (!inventory || ollamaInventoryContainsModel(inventory, selected)) return { ok: true };

    const selectedDisplay = sanitizeModelNameForDisplay(selected) || "<invalid>";
    return {
      ok: false,
      message:
        `Selected Ollama model '${selectedDisplay}' is available on ` +
        `http://${getResolvedOllamaHost()}:${OLLAMA_PORT}, but the daemon answering ` +
        `http://host.openshell.internal:${getOllamaContainerPort()} reports it as unavailable ` +
        `(reported models: ${describeModelInventory(inventory)}). NemoClaw read that endpoint ` +
        `from a Docker probe container; two Ollama daemons are answering different endpoints. ` +
        `On WSL 2 that is a WSL daemon and a Windows-host daemon. Select a model that the ` +
        `probed endpoint reports, or stop one daemon so one daemon answers both endpoints.`,
    };
  } finally {
    warnIfDockerBuildEnvironmentCleanupFailed(
      prepared.cleanup(),
      `sandbox-facing Ollama model probe for '${selected}'`,
    );
  }
}

function prepareIsolatedDockerEnvironment(): PreparedDockerBuildEnvironment {
  return prepareDockerBuildEnvironment({ allowCredentialIsolation: true });
}

function isolateDockerClientCapture(
  capture: RunCaptureFn,
  prepared: PreparedDockerBuildEnvironment,
): RunCaptureFn {
  return (cmd, opts) => {
    if (cmd[0] !== "docker") return capture(cmd, opts);
    return capture(cmd, {
      ...opts,
      env: mergeIsolatedDockerClientEnv(opts?.env ?? {}, prepared),
    });
  };
}

function logIsolatedProbeImageConfig(prepared: PreparedDockerBuildEnvironment): void {
  if (!prepared.isolatedCredentialConfig) return;
  console.log(
    "  Docker Desktop credential helper is unavailable in this WSL session; using an isolated credential-free config for the local-inference probe image.",
  );
}

const CONTAINER_CHECK_MAX_ATTEMPTS = 3;
const CONTAINER_CHECK_RETRY_DELAY_SECS = 2;
export function validateLocalProvider(
  provider: string,
  runCaptureImpl?: RunCaptureFn,
  sleepFn?: (seconds: number) => void,
  prepareDockerEnvironment: PrepareDockerEnvironmentFn = prepareIsolatedDockerEnvironment,
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
    if (provider === "vllm-local") {
      return {
        ok: false,
        message:
          "Managed vLLM state could not be inspected safely. Re-run `nemoclaw onboard` to repair the provider.",
      };
    }
    return { ok: true };
  }

  const hostCapture = provider === "ollama-local" ? createOllamaApiCapture(capture) : capture;
  const output = hostCapture(command, { ignoreError: true });
  if (!isLocalProviderProbeOutputHealthy(command.at(-1) ?? "", output)) {
    switch (provider) {
      case "vllm-local":
        return {
          ok: false,
          message: `Local vLLM was selected, but nothing is responding on ${getLocalProviderHealthEndpoint(provider) ?? "the configured endpoint"}.`,
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
    if (provider === "vllm-local") {
      return {
        ok: false,
        message:
          "Managed vLLM state could not be inspected safely. Re-run `nemoclaw onboard` to repair the provider.",
      };
    }
    return { ok: true };
  }

  const sleep = sleepFn ?? sleepSeconds;
  const prepared = prepareDockerEnvironment();
  try {
    logIsolatedProbeImageConfig(prepared);
    const dockerCapture = isolateDockerClientCapture(capture, prepared);
    const containerOutput = retryUntil(
      () => dockerCapture(containerCommand, { ignoreError: true }),
      {
        accept: (output) =>
          isLocalProviderProbeOutputHealthy(containerCommand.at(-1) ?? "", output),
        retryDelaysMs: Array.from(
          { length: CONTAINER_CHECK_MAX_ATTEMPTS - 1 },
          () => CONTAINER_CHECK_RETRY_DELAY_SECS * 1_000,
        ),
        sleep: (milliseconds) => sleep(milliseconds / 1_000),
      },
    );
    if (isLocalProviderProbeOutputHealthy(containerCommand.at(-1) ?? "", containerOutput)) {
      return { ok: true };
    }

    const diagnostic = collectContainerDiagnostic(containerCommand, dockerCapture);

    if (diagnostic.probeImageUnavailable) {
      return probeImageUnavailableResult(provider, diagnostic.text);
    }

    switch (provider) {
      case "vllm-local":
        return {
          ok: false,
          message: `Local vLLM is responding on the host, but the Docker container reachability check failed for ${getContainerCheckUrl(provider)}. This may be a Docker networking issue — the sandbox uses a different network path and may still work.`,
          diagnostic: diagnostic.text,
        };
      case "ollama-local":
        return {
          ok: false,
          message: `Local Ollama is responding on ${getResolvedOllamaHost()}, but the Docker container reachability check failed for http://host.openshell.internal:${getOllamaContainerPort()}. This may be a Docker networking issue — the sandbox uses a different network path and may still work.`,
          diagnostic: diagnostic.text,
        };
      default:
        return {
          ok: false,
          message: "The selected local inference provider is unavailable from containers.",
          diagnostic: diagnostic.text,
        };
    }
  } finally {
    warnIfDockerBuildEnvironmentCleanupFailed(
      prepared.cleanup(),
      `local-inference container probe for '${provider}'`,
    );
  }
}

/**
 * Report a reachability check that never ran because Docker could not
 * provide the probe image (#9308). Blaming the provider's network path here
 * is a misreport: the reporter's environment had a working path once the
 * image existed.
 */
function probeImageUnavailableResult(provider: string, diagnostic: string): ValidationResult {
  const responding =
    provider === "vllm-local"
      ? "Local vLLM is responding on the host"
      : `Local Ollama is responding on ${getResolvedOllamaHost()}`;
  const providerLabel = provider === "vllm-local" ? "a vLLM" : "an Ollama";
  return {
    ok: false,
    message: `${responding}, but the container reachability check could not run because Docker could not provide its probe image. This is a Docker image-pull failure, not ${providerLabel} networking failure.`,
    diagnostic,
  };
}

function getContainerCheckUrl(provider: string): string | null {
  switch (provider) {
    case "vllm-local": {
      const managed = recoveredManagedVllmBinding();
      if (managed.kind === "unavailable") return null;
      const managedBaseUrl = managed.binding?.baseUrl.replace(/\/v1\/?$/, "") ?? null;
      return managedBaseUrl
        ? `${managedBaseUrl}/health`
        : `http://host.openshell.internal:${VLLM_PORT}/v1/models`;
    }
    case "ollama-local":
      return `http://host.openshell.internal:${getOllamaContainerPort()}/api/tags`;
    default:
      return "http://host.openshell.internal/";
  }
}

type ContainerDiagnostic = { text: string; probeImageUnavailable: boolean };

function containerRuntimeFailureDiagnostic(text: string): ContainerDiagnostic {
  return { text, probeImageUnavailable: false };
}

/**
 * Distinguish "Docker could not provide the probe image" from a general
 * runtime failure using the stdout-only capture seam: the daemon answers
 * `docker version` while `docker image inspect` finds no local copy of the
 * probe image. Credential-helper failures land here (#9308) — a remote login
 * session can lose access to Docker Desktop's credential store, so the pull
 * fails and every probe run produces empty stdout.
 *
 * Image-absent-after-run-attempts proves the pull failed: `docker run` pulls
 * an absent image before it creates the container, and `--add-host`, policy,
 * and seccomp failures all happen after that pull. Five runs precede this
 * check (three probes, two diagnostics), so a pullable image would be in the
 * cache by now and a run that failed for any post-pull reason keeps the
 * generic runtime diagnostic.
 */
function classifyContainerRunFailure(
  dockerCommand: string[],
  capture: RunCaptureFn,
): ContainerDiagnostic {
  const runtimeFailure = containerRuntimeFailureDiagnostic(
    `Docker command failed (image pull error or runtime failure). Retried ${CONTAINER_CHECK_MAX_ATTEMPTS} times.`,
  );
  const daemonVersion = capture([...dockerCommand, "version", "--format", "{{.Server.Version}}"], {
    ignoreError: true,
  });
  if (!daemonVersion) return runtimeFailure;
  const probeImageId = capture(
    [...dockerCommand, "image", "inspect", "--format", "{{.Id}}", CONTAINER_REACHABILITY_IMAGE],
    { ignoreError: true },
  );
  if (probeImageId) return runtimeFailure;
  return {
    text: `The probe image ${CONTAINER_REACHABILITY_IMAGE} is not in the local Docker image cache, and Docker could not pull it. The image is public and needs no credentials, but a Docker credential helper (credsStore in ~/.docker/config.json) can fail in a remote login session and block every pull. Pre-pull the image with an isolated Docker config, then resume: DOCKER_CONFIG=$(mktemp -d) docker pull ${CONTAINER_REACHABILITY_IMAGE} && nemoclaw onboard --resume`,
    probeImageUnavailable: true,
  };
}

function collectContainerDiagnostic(
  containerCommand: string[],
  capture: RunCaptureFn,
): ContainerDiagnostic {
  const url = containerCommand.at(-1);
  const dockerRunIndex = containerCommand.indexOf("run");
  const addHostIndex = containerCommand.indexOf("--add-host");
  const hostAlias = containerCommand[addHostIndex + 1];
  if (!url || dockerRunIndex < 1 || addHostIndex < 0 || !hostAlias) {
    return containerRuntimeFailureDiagnostic(
      `Docker command failed (invalid reachability command). Retried ${CONTAINER_CHECK_MAX_ATTEMPTS} times.`,
    );
  }
  const dockerCommand = containerCommand.slice(0, dockerRunIndex);
  try {
    // Reuse the exact Docker context, host mapping, and URL from the failed check.
    const httpStatus = capture(
      [
        ...dockerCommand,
        "run",
        "--rm",
        "--add-host",
        hostAlias,
        CONTAINER_REACHABILITY_IMAGE,
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        url,
      ],
      { ignoreError: true },
    );

    // Confirm that Docker applied the same host mapping used by the failed check.
    const hostsOutput = capture(
      [
        ...dockerCommand,
        "run",
        "--rm",
        "--add-host",
        hostAlias,
        CONTAINER_REACHABILITY_IMAGE,
        "cat",
        "/etc/hosts",
      ],
      { ignoreError: true },
    );

    if (!httpStatus && !hostsOutput) {
      return classifyContainerRunFailure(dockerCommand, capture);
    }

    const parts: string[] = [];
    if (httpStatus) {
      parts.push(`Container curl returned HTTP ${httpStatus.trim()}`);
    }
    if (hostsOutput) {
      const gwLine = hostsOutput
        .split(/\r?\n/)
        .find((l: string) => l.includes("host.openshell.internal"));
      if (gwLine) {
        parts.push(`host.openshell.internal resolved to: ${gwLine.trim().split(/\s+/)[0]}`);
      }
    }
    parts.push(
      `Retried ${CONTAINER_CHECK_MAX_ATTEMPTS} times over ~${(CONTAINER_CHECK_MAX_ATTEMPTS - 1) * CONTAINER_CHECK_RETRY_DELAY_SECS}s`,
    );
    return containerRuntimeFailureDiagnostic(parts.join(". ") + ".");
  } catch {
    return containerRuntimeFailureDiagnostic(
      `Docker command failed (image pull error or runtime failure). Retried ${CONTAINER_CHECK_MAX_ATTEMPTS} times.`,
    );
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

export {
  getOllamaContextWindowFloorForAgent,
  MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
  MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
  parsePositiveInteger,
};

export function probeOllamaRuntimeModelStatus(
  model: string,
  runCaptureImpl?: RunCaptureFn,
): OllamaRuntimeModelStatus {
  return probeOllamaRuntimeModelStatusWithHost(
    model,
    getResolvedOllamaHost,
    createOllamaApiCapture(runCaptureImpl),
  );
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
    createOllamaApiCapture(runCaptureImpl),
  );
}

export { resetOllamaRuntimeContextWindowAutoState };

/** Apply Ollama runtime context-window adoption using the resolved local host. */
export function applyOllamaRuntimeContextWindow(
  selectedModel: string,
  options: Pick<
    ApplyOllamaRuntimeContextWindowOptions,
    "contextWindowFloor" | "env" | "logger" | "runCaptureImpl"
  > = {},
): ApplyOllamaRuntimeContextWindowResult {
  return applyOllamaRuntimeContextWindowWithHost(selectedModel, getResolvedOllamaHost, {
    ...options,
    runCaptureImpl: createOllamaApiCapture(options.runCaptureImpl),
  });
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
    'and `journalctl -u ollama.service --since "10 min ago" | grep -iE "gpu|cuda|vram|compute|library"`, then retry onboarding.'
  );
}

export function getOllamaModelOptions(
  runCaptureImpl?: RunCaptureFn,
  sleepMilliseconds: (milliseconds: number) => void = (milliseconds) =>
    sleepSeconds(milliseconds / 1_000),
): string[] {
  const host = getResolvedOllamaHost();
  const capture = createOllamaApiCapture(runCaptureImpl, host);
  const modelDiscoveryRetryDelaysMs = [500, 1_000] as const;
  // Docker Desktop owns Windows-host reachability because host.docker.internal
  // may not resolve from WSL. Keep model discovery on the verified transport.
  const tagsCommand = [
    "curl",
    ...buildValidatedCurlCommandArgs([
      "-sf",
      "--connect-timeout",
      "3",
      "--max-time",
      "5",
      `http://${host}:${OLLAMA_PORT}/api/tags`,
    ]),
  ];
  const readTags = () => {
    const tagsOutput = capture(tagsCommand, { ignoreError: true });
    return parseOllamaModelInventory(String(tagsOutput || ""));
  };
  // The daemon can become unreachable after the earlier readiness check.
  // Retry only an invalid response; a valid empty inventory is authoritative,
  // and GET /api/tags does not mutate Ollama.
  const tagsParsed = retryUntil(readTags, {
    accept: (models) => models !== null,
    retryDelaysMs: modelDiscoveryRetryDelaysMs,
    sleep: sleepMilliseconds,
  });
  // Do not select a model from a different discovery path after the endpoint
  // returned a malformed inventory. A valid empty inventory may still use the
  // local CLI fallback below.
  if (tagsParsed === null) {
    throw new Error(
      `Could not read Ollama models from ${host}:${OLLAMA_PORT} after ${modelDiscoveryRetryDelaysMs.length + 1} attempts. ` +
        `Verify that Ollama is reachable at http://${host}:${OLLAMA_PORT}, then retry onboarding.`,
    );
  }
  if (tagsParsed.length > 0) return tagsParsed;

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
  installedModelsOrLog?: readonly string[] | ((message: string) => void),
  runCaptureImpl?: RunCaptureFn,
): string {
  const log =
    typeof installedModelsOrLog === "function"
      ? installedModelsOrLog
      : (message: string) => console.warn(message);
  const installedModels =
    typeof installedModelsOrLog === "function" ? undefined : installedModelsOrLog;
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
  if (explicit) return explicit;
  return selectDefaultOllamaModel(installedModels ?? getOllamaModelOptions(runCaptureImpl), gpu);
}

function warnNoBootstrapModelFits(gpu: GpuInfo | null, log: (message: string) => void): void {
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
  return selectDefaultOllamaModel(getOllamaModelOptions(runCaptureImpl), gpu);
}

export function selectDefaultOllamaModel(
  models: readonly string[],
  gpu: GpuInfo | null = null,
): string {
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
  // `ollama list`/`/api/tags` order reflects install/pull order, not size,
  // so use the registry's largest-first order. Keep Ollama's list order when
  // every installed tag is unregistered.
  return OLLAMA_MODEL_REGISTRY.find((entry) => pool.includes(entry.tag))?.tag ?? pool[0];
}

export function getOllamaWarmupRequestCommand(model: string, keepAlive = "15m"): string[] {
  const payload = JSON.stringify({
    model,
    prompt: "Hello, reply in less than 5 words",
    stream: false,
    keep_alive: keepAlive,
    options: { num_predict: 16 },
  });
  const host = getResolvedOllamaHost();
  return getOllamaApiCommand(
    [
      "-s",
      "--connect-timeout",
      "10",
      "--max-time",
      "120",
      `http://${host}:${OLLAMA_PORT}/api/generate`,
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
    ],
    host,
  );
}

export function getOllamaWarmupCommand(model: string, keepAlive = "15m"): string[] {
  const command = getOllamaWarmupRequestCommand(model, keepAlive);
  // backgrounding (nohup ... &) and output redirection require a shell wrapper.
  // The payload is safe: model name is JSON-serialized (escaping all special
  // chars) then shellQuote'd (single-quoted), so injection through model
  // names is not feasible. This is the one intentional bash -c exception.
  return [
    "bash",
    "-c",
    `nohup ${command.map((arg) => shellQuote(arg)).join(" ")} >/dev/null 2>&1 &`,
  ];
}

export function runOllamaWarmup(
  model: string,
  runImpl: (
    command: readonly string[],
    options?: { ignoreError?: boolean; env?: NodeJS.ProcessEnv },
  ) => unknown = run,
  prepareDockerEnvironment: PrepareDockerEnvironmentFn = prepareIsolatedDockerEnvironment,
): void {
  const windowsHost = getResolvedOllamaHost() === OLLAMA_HOST_DOCKER_INTERNAL;
  const command = windowsHost
    ? getOllamaWarmupRequestCommand(model)
    : getOllamaWarmupCommand(model);
  const execution = prepareOllamaApiExecution(command, getResolvedOllamaHost(), {
    prepareDockerEnvironment,
    operation: `Windows-host Ollama warm-up for '${model}'`,
  });
  try {
    runImpl(execution.command, {
      ignoreError: true,
      ...(execution.env === undefined ? {} : { env: execution.env }),
    });
  } finally {
    execution.cleanup();
  }
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
  const endpoint = `http://${host}:${OLLAMA_PORT}/api/generate`;
  return getOllamaApiCommand(
    buildValidatedCurlCommandArgs([
      "-sS",
      "--max-time",
      String(timeoutSeconds),
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
      endpoint,
    ]),
    host,
  );
}

export function validateOllamaModel(
  model: string,
  runCaptureImpl?: RunCaptureFn,
  isSparkImpl?: () => boolean,
  runCaptureExImpl?: RunCaptureExFn,
  options: { allowToolsIncompatible?: boolean } = {},
): ValidationResult {
  const capture = runCaptureImpl ?? runCapture;
  const captureEx = createOllamaApiCaptureEx(runCaptureExImpl ?? runCaptureEx);
  const isSpark = isSparkImpl ?? (() => detectNvidiaPlatform() === "spark");
  const sparkHost = isSpark();
  const probeCmd = getOllamaProbeCommand(model);
  const probeResult = captureEx(probeCmd);
  let output = probeResult.stdout;
  // Cold-loading a large model from disk can routinely exceed the default 120 s
  // probe window — on DGX Spark unified-memory hosts (#3251) and also on
  // tight-VRAM dGPU hosts (e.g. NVIDIA L4 23 GB) where the runner spills GPU→CPU
  // during warm-up. Retry once with a 300 s budget whenever the initial probe
  // genuinely timed out. Fast failures (connection refused, Ollama not running)
  // keep `timedOut === false` and surface immediately.
  if (probeResult.timedOut) {
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
  retryChatCompletionsToolReadiness: boolean;

  pinnedAddresses: readonly string[];
  allowHostDockerInternal: boolean;
  probeFromDocker: { expectedPort: number } | null;
} {
  const windowsHostOllama = getResolvedOllamaHost() === OLLAMA_HOST_DOCKER_INTERNAL;
  return {
    skipResponsesProbe: true,
    requireChatCompletionsToolCalling: !allowToolsIncompatible,
    retryChatCompletionsToolReadiness: !allowToolsIncompatible,

    pinnedAddresses: [],
    allowHostDockerInternal: windowsHostOllama,
    probeFromDocker: windowsHostOllama ? { expectedPort: OLLAMA_PORT } : null,
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
  const metadata = fetchOllamaModelShowMetadata(
    model,
    getResolvedOllamaHost,
    createOllamaApiCapture(runCaptureImpl),
  );
  if (!metadata.ok) {
    return {
      source: "unknown",
      capabilities: [],
      supportsTools: null,
      rawError: metadata.error,
    };
  }

  const capsRaw = metadata.payload.capabilities;
  if (!Array.isArray(capsRaw)) {
    // Ollama returned a body but no capabilities array (older version,
    // custom registry, or shape change). Degrade to unknown.
    const errText =
      typeof metadata.payload.error === "string"
        ? metadata.payload.error
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
