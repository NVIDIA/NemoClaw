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
  getOllamaApiCommand,
  getResolvedOllamaHost,
  ollamaInventoryContainsModel,
  OLLAMA_HOST_DOCKER_INTERNAL,
  OLLAMA_LOCALHOST,
  prepareOllamaApiExecution,
  probeOllamaEndpointInventory,
  type RunCaptureFn,
  type RunCaptureExFn,
} from "../../../inference/local";
import {
  type OllamaRuntimeModelStatus,
  probeOllamaRuntimeModelStatus,
} from "../../../inference/ollama-runtime-context";
import { runCaptureEx } from "../../../runner";

export interface OllamaRestartRecoveryRoute {
  provider?: string | null;
  model?: string | null;
  endpointUrl?: string | null;
}

export interface OllamaRestartRecoveryDeps {
  probeRuntimeModelStatus?: (
    model: string,
    getOllamaHost: () => string,
    runCaptureImpl?: RunCaptureFn,
  ) => OllamaRuntimeModelStatus;
  probeModelInventory?: (host: string, runCaptureImpl?: RunCaptureFn) => string[] | null;
  runCaptureExImpl?: RunCaptureExFn;
  getOllamaHost?: () => string;
  runCaptureImpl?: RunCaptureFn;
  prepareDockerEnvironment?: Parameters<typeof createOllamaApiCapture>[2];
  prepareOllamaApiExecution?: typeof prepareOllamaApiExecution;
}

export type OllamaRestartRecoveryFailureReason =
  | "timeout"
  | "command-failed"
  | "ollama-error"
  | "invalid-response"
  | "spawn-failed";

export type OllamaRestartRecoveryResult =
  | { kind: "skipped"; reason: "not-ollama" | "missing-model" | "already-loaded" | "unreachable" }
  | { kind: "skipped"; reason: "model-absent"; endpoint: string; inventoryLabel: string }
  | { kind: "warmed"; ok: true; timedOut: false }
  | {
      kind: "warmed";
      ok: false;
      timedOut: boolean;
      reason: OllamaRestartRecoveryFailureReason;
      endpoint: string;
      detail: string;
    };

export const OLLAMA_LOCAL_PROVIDER = "ollama-local";
const OLLAMA_RESTART_RECOVERY_TIMEOUT_SECONDS = 300;
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

function buildWarmCommand(model: string, hostname: string): string[] {
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
      String(OLLAMA_RESTART_RECOVERY_TIMEOUT_SECONDS),
      "-H",
      "Content-Type: application/json",
      "-d",
      body,
      `http://${hostname}:${OLLAMA_PORT}/api/generate`,
    ]),
    hostname,
  );
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

function boundedWarmFailureDetail(value: unknown, fallback: string): string {
  const detail = String(value ?? "")
    .replace(/\s+/g, " ")
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
  const probe = deps.probeRuntimeModelStatus ?? probeOllamaRuntimeModelStatus;
  const rawCapture = createOllamaApiCapture(
    deps.runCaptureImpl,
    rawHost,
    deps.prepareDockerEnvironment,
  );
  let status: OllamaRuntimeModelStatus;
  try {
    status = probe(model, () => rawHost, rawCapture);
  } catch {
    return { kind: "skipped", reason: "unreachable" };
  }
  if (!status.probed) {
    return { kind: "skipped", reason: "unreachable" };
  }
  if (status.loaded) {
    return { kind: "skipped", reason: "already-loaded" };
  }

  const captureEx = deps.runCaptureExImpl ?? runCaptureEx;
  try {
    const execution = (deps.prepareOllamaApiExecution ?? prepareOllamaApiExecution)(
      buildWarmCommand(model, rawHost),
      rawHost,
      { operation: `Ollama restart warm-up for '${model}'` },
    );
    let result;
    try {
      result = captureEx(execution.command, {
        ...(execution.env === undefined ? {} : { env: execution.env }),
      });
    } finally {
      execution.cleanup();
    }
    if (result.timedOut) {
      return {
        kind: "warmed",
        ok: false,
        timedOut: true,
        reason: "timeout",
        endpoint: rawEndpoint,
        detail: boundedWarmFailureDetail(
          result.stderr,
          `warm-up exceeded ${OLLAMA_RESTART_RECOVERY_TIMEOUT_SECONDS} seconds`,
        ),
      };
    }
    if (result.exitCode !== 0) {
      return {
        kind: "warmed",
        ok: false,
        timedOut: false,
        reason: "command-failed",
        endpoint: rawEndpoint,
        detail: boundedWarmFailureDetail(
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
      const probeInventory = deps.probeModelInventory ?? probeOllamaEndpointInventory;
      const inventory = probeInventory(rawHost, rawCapture);
      if (inventory && !ollamaInventoryContainsModel(inventory, model)) {
        return {
          kind: "skipped",
          reason: "model-absent",
          endpoint: `http://${rawHost}:${OLLAMA_PORT}`,
          inventoryLabel: describeModelInventory(inventory),
        };
      }
    }
    if (response !== "ok") {
      return {
        kind: "warmed",
        ok: false,
        timedOut: false,
        reason: response,
        endpoint: rawEndpoint,
        detail: boundedWarmFailureDetail(result.stdout, `Ollama returned ${response}`),
      };
    }
    return { kind: "warmed", ok: true, timedOut: false };
  } catch (error) {
    return {
      kind: "warmed",
      ok: false,
      timedOut: false,
      reason: "spawn-failed",
      endpoint: rawEndpoint,
      detail: boundedWarmFailureDetail(
        error instanceof Error ? error.message : error,
        "warm-up process could not start",
      ),
    };
  }
}
