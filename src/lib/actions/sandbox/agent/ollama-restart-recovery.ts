// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Source-of-truth boundary for Ollama restart recovery.
//
// Invalid state: restarting the external Ollama daemon drops its loaded model,
// so the first OpenClaw turn can exhaust its request budget cold-loading it.
// Ollama owns daemon/model lifecycle; NemoClaw owns the persisted inference
// route and the host-side passthrough that can perform a bounded warm-up before
// dispatch. This cannot be fixed at the producer in this PR because Ollama does
// not persist loaded runners across daemon restarts. Focused tests cover direct
// and proxied route translation, unreachable/already-loaded states, timeouts,
// process failures, and semantic response validation. Remove this recovery when
// supported Ollama versions persist runners across restart, or when NemoClaw
// manages daemon lifecycle and can warm the model at restart time instead.

import { buildValidatedCurlCommandArgs } from "../../../adapters/http/curl-args";
import { OLLAMA_PORT, OLLAMA_PROXY_PORT } from "../../../core/ports";
import {
  describeModelInventory,
  createOllamaApiCapture,
  createOllamaApiCaptureEx,
  getOllamaApiCommand,
  getResolvedOllamaHost,
  ollamaInventoryContainsModel,
  OLLAMA_HOST_DOCKER_INTERNAL,
  OLLAMA_LOCALHOST,
  probeOllamaEndpointInventory,
  type RunCaptureFn,
  type RunCaptureExFn,
} from "../../../inference/local";
import {
  type OllamaRuntimeModelStatus,
  probeOllamaRuntimeModelStatus,
} from "../../../inference/ollama-runtime-context";
import { redact, redactFull } from "../../../runner";

export interface OllamaRestartRecoveryRoute {
  provider?: string | null;
  model?: string | null;
  endpointUrl?: string | null;
}

export interface OllamaRestartRecoveryOptions {
  timeoutSeconds?: number;
}

export interface OllamaRestartRecoveryDeps extends OllamaRestartRecoveryOptions {
  probeRuntimeModelStatus?: (
    model: string,
    getOllamaHost: () => string,
    runCaptureImpl?: RunCaptureFn,
    timeoutMilliseconds?: number,
  ) => OllamaRuntimeModelStatus;
  probeModelInventory?: (
    host: string,
    runCaptureImpl?: RunCaptureFn,
    timeoutMilliseconds?: number,
  ) => string[] | null;
  runCaptureExImpl?: RunCaptureExFn;
  getOllamaHost?: () => string;
  runCaptureImpl?: RunCaptureFn;
  prepareDockerEnvironment?: Parameters<typeof createOllamaApiCapture>[2];
  now?: () => number;
}

export type OllamaRestartRecoveryFailureReason =
  | "timeout"
  | "command-failed"
  | "ollama-error"
  | "invalid-response"
  | "spawn-failed";

export type OllamaRestartRecoveryResult =
  | { kind: "skipped"; reason: "not-ollama" | "missing-model" | "already-loaded" }
  | { kind: "skipped"; reason: "unreachable"; endpoint: string }
  | { kind: "skipped"; reason: "deadline-exhausted"; endpoint: string }
  | { kind: "skipped"; reason: "model-absent"; endpoint: string; inventoryLabel: string }
  | { kind: "warmed"; ok: true }
  | {
      kind: "warmed";
      ok: false;
      reason: OllamaRestartRecoveryFailureReason;
      endpoint: string;
      detail: string;
    };

export const OLLAMA_LOCAL_PROVIDER = "ollama-local";
const OLLAMA_RESTART_RECOVERY_TIMEOUT_SECONDS = 300;
const OLLAMA_RESTART_RECOVERY_PROBE_TIMEOUT_MILLISECONDS = 5_000;
const OPENSHELL_HOST_BRIDGE = "host.openshell.internal";
const ALLOWED_RAW_OLLAMA_HOSTS = new Set([
  OLLAMA_LOCALHOST,
  "localhost",
  OLLAMA_HOST_DOCKER_INTERNAL,
]);

function normalizeRouteValue(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeHostname(value: string): string {
  return (value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value)
    .replace(/\.$/, "")
    .toLowerCase();
}

function getAllowedFallbackHost(getOllamaHost: () => string): string {
  try {
    const host = normalizeHostname(getOllamaHost());
    return ALLOWED_RAW_OLLAMA_HOSTS.has(host) ? host : OLLAMA_LOCALHOST;
  } catch {
    return OLLAMA_LOCALHOST;
  }
}

/**
 * Translate the persisted sandbox-facing route back to the host-side daemon.
 * Only fixed local bridge names are accepted so edited registry data cannot
 * turn this recovery probe into an arbitrary host request.
 */
function resolveRawOllamaHost(
  endpointUrl: string | null | undefined,
  getOllamaHost: () => string,
): string {
  try {
    const endpoint = new URL(normalizeRouteValue(endpointUrl));
    const hostname = normalizeHostname(endpoint.hostname);
    const port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));

    if (
      endpoint.protocol === "http:" &&
      hostname === OPENSHELL_HOST_BRIDGE &&
      port === OLLAMA_PORT
    ) {
      return OLLAMA_HOST_DOCKER_INTERNAL;
    }
    if (
      endpoint.protocol === "http:" &&
      hostname === OPENSHELL_HOST_BRIDGE &&
      port === OLLAMA_PROXY_PORT
    ) {
      return OLLAMA_LOCALHOST;
    }
    if (
      endpoint.protocol === "http:" &&
      port === OLLAMA_PORT &&
      ALLOWED_RAW_OLLAMA_HOSTS.has(hostname)
    ) {
      return hostname;
    }
  } catch {
    // Missing and legacy registry endpoints use the process-local resolved host.
  }

  return getAllowedFallbackHost(getOllamaHost);
}

function buildWarmCommand(model: string, hostname: string, maxTimeSeconds: number): string[] {
  const body = JSON.stringify({
    model,
    prompt: "Hello, reply in less than 5 words",
    stream: false,
    think: false,
    keep_alive: "15m",
    options: { num_predict: 16 },
  });
  return getOllamaApiCommand(
    buildValidatedCurlCommandArgs([
      "-sS",
      "--connect-timeout",
      "3",
      "--max-time",
      String(maxTimeSeconds),
      "-H",
      "Content-Type: application/json",
      "-d",
      body,
      `http://${hostname}:${OLLAMA_PORT}/api/generate`,
    ]),
    hostname,
  );
}

function recoveryDeadlineMilliseconds(
  timeoutSeconds: number | undefined,
  now: () => number,
): number | null {
  if (timeoutSeconds === undefined) return null;
  return now() + Math.min(timeoutSeconds, OLLAMA_RESTART_RECOVERY_TIMEOUT_SECONDS) * 1000;
}

function remainingRecoveryMilliseconds(deadline: number | null, now: () => number): number {
  return deadline === null
    ? OLLAMA_RESTART_RECOVERY_TIMEOUT_SECONDS * 1000
    : Math.max(0, Math.floor(deadline - now()));
}

function validateWarmResponse(stdout: string): "ok" | "ollama-error" | "invalid-response" {
  try {
    const parsed = JSON.parse(stdout) as {
      done?: unknown;
      error?: unknown;
      response?: unknown;
      thinking?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error.trim() !== "") {
      return "ollama-error";
    }
    const response = typeof parsed.response === "string" ? parsed.response.trim() : "";
    const thinking = typeof parsed.thinking === "string" ? parsed.thinking.trim() : "";
    if (parsed.done !== true || (!response && !thinking)) {
      return "invalid-response";
    }
    return "ok";
  } catch {
    return "invalid-response";
  }
}

export function boundedOllamaRestartRecoveryDetail(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const detail = redactFull(redact(raw))
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (detail || fallback).slice(0, 300);
}

/**
 * Warm a registered local Ollama model only when `/api/ps` proves that the
 * daemon is reachable and the selected model is no longer loaded.
 */
export function maybeWarmOllamaAfterDaemonRestart(
  route: OllamaRestartRecoveryRoute,
  deps: OllamaRestartRecoveryDeps = {},
): OllamaRestartRecoveryResult {
  if (normalizeRouteValue(route.provider) !== OLLAMA_LOCAL_PROVIDER) {
    return { kind: "skipped", reason: "not-ollama" };
  }

  const model = normalizeRouteValue(route.model);
  if (!model) {
    return { kind: "skipped", reason: "missing-model" };
  }

  const getOllamaHost = deps.getOllamaHost ?? getResolvedOllamaHost;
  const rawHost = resolveRawOllamaHost(route.endpointUrl, getOllamaHost);
  const rawEndpoint = `http://${rawHost}:${OLLAMA_PORT}`;
  if (
    deps.timeoutSeconds !== undefined &&
    (!Number.isFinite(deps.timeoutSeconds) || deps.timeoutSeconds <= 0)
  ) {
    return { kind: "skipped", reason: "deadline-exhausted", endpoint: rawEndpoint };
  }
  const now = deps.now ?? Date.now;
  const recoveryDeadline = recoveryDeadlineMilliseconds(deps.timeoutSeconds, now);
  const probe = deps.probeRuntimeModelStatus ?? probeOllamaRuntimeModelStatus;
  const probeBudgetMilliseconds = remainingRecoveryMilliseconds(recoveryDeadline, now);
  if (probeBudgetMilliseconds === 0) {
    return { kind: "skipped", reason: "deadline-exhausted", endpoint: rawEndpoint };
  }
  const rawCapture = createOllamaApiCapture(
    deps.runCaptureImpl,
    rawHost,
    deps.prepareDockerEnvironment,
  );
  const rawCaptureEx = createOllamaApiCaptureEx(
    deps.runCaptureExImpl,
    rawHost,
    deps.prepareDockerEnvironment,
  );
  let status: OllamaRuntimeModelStatus;
  try {
    status = probe(
      model,
      () => rawHost,
      rawCapture,
      Math.min(OLLAMA_RESTART_RECOVERY_PROBE_TIMEOUT_MILLISECONDS, probeBudgetMilliseconds),
    );
  } catch {
    return { kind: "skipped", reason: "unreachable", endpoint: rawEndpoint };
  }
  if (!status.probed) {
    return { kind: "skipped", reason: "unreachable", endpoint: rawEndpoint };
  }
  if (status.loaded) {
    return { kind: "skipped", reason: "already-loaded" };
  }

  const warmupTimeoutMilliseconds = remainingRecoveryMilliseconds(recoveryDeadline, now);
  if (warmupTimeoutMilliseconds === 0) {
    return { kind: "skipped", reason: "deadline-exhausted", endpoint: rawEndpoint };
  }
  const warmupTimeoutSeconds = warmupTimeoutMilliseconds / 1000;

  try {
    const result = rawCaptureEx(buildWarmCommand(model, rawHost, warmupTimeoutSeconds), {
      timeout: warmupTimeoutMilliseconds,
    });
    if (result.timedOut) {
      return {
        kind: "warmed",
        ok: false,
        reason: "timeout",
        endpoint: rawEndpoint,
        detail: boundedOllamaRestartRecoveryDetail(
          result.stderr,
          `warm-up exceeded ${String(warmupTimeoutSeconds)} seconds`,
        ),
      };
    }
    if (result.exitCode !== 0) {
      return {
        kind: "warmed",
        ok: false,
        reason: "command-failed",
        endpoint: rawEndpoint,
        detail: boundedOllamaRestartRecoveryDetail(
          result.stderr || result.stdout,
          `warm-up exited ${String(result.exitCode)}`,
        ),
      };
    }
    const response = validateWarmResponse(result.stdout);
    // An Ollama error can mean a broken runner or a daemon that simply does not
    // hold this model. Only the second is an endpoint-ownership failure, and it
    // is the one a restart can introduce silently while the route still looks
    // valid (#9455). Ask the same daemon for its inventory to tell them apart;
    // an unreadable inventory keeps the original warm-failure reason.
    if (response === "ollama-error") {
      const inventoryBudgetMilliseconds = remainingRecoveryMilliseconds(recoveryDeadline, now);
      if (inventoryBudgetMilliseconds > 0) {
        const probeInventory = deps.probeModelInventory ?? probeOllamaEndpointInventory;
        let inventory: string[] | null = null;
        try {
          inventory = probeInventory(
            rawHost,
            rawCapture,
            Math.min(
              OLLAMA_RESTART_RECOVERY_PROBE_TIMEOUT_MILLISECONDS,
              inventoryBudgetMilliseconds,
            ),
          );
        } catch {
          // Inventory only refines the original warm-up error.
        }
        if (inventory && !ollamaInventoryContainsModel(inventory, model)) {
          return {
            kind: "skipped",
            reason: "model-absent",
            endpoint: `http://${rawHost}:${OLLAMA_PORT}`,
            inventoryLabel: describeModelInventory(inventory),
          };
        }
      }
    }
    if (response !== "ok") {
      return {
        kind: "warmed",
        ok: false,
        reason: response,
        endpoint: rawEndpoint,
        detail: boundedOllamaRestartRecoveryDetail(result.stdout, `Ollama returned ${response}`),
      };
    }
    return { kind: "warmed", ok: true };
  } catch (error) {
    return {
      kind: "warmed",
      ok: false,
      reason: "spawn-failed",
      endpoint: rawEndpoint,
      detail: boundedOllamaRestartRecoveryDetail(
        error instanceof Error ? error.message : error,
        "warm-up process could not start",
      ),
    };
  }
}
