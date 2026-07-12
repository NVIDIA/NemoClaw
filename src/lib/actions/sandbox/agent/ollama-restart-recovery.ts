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
  getResolvedOllamaHost,
  OLLAMA_HOST_DOCKER_INTERNAL,
  OLLAMA_LOCALHOST,
  type RunCaptureExFn,
} from "../../../inference/local";
import {
  type OllamaRuntimeModelStatus,
  type OllamaRuntimeRunCaptureFn,
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
    runCaptureImpl?: OllamaRuntimeRunCaptureFn,
  ) => OllamaRuntimeModelStatus;
  runCaptureExImpl?: RunCaptureExFn;
  getOllamaHost?: () => string;
  runCaptureImpl?: OllamaRuntimeRunCaptureFn;
}

export type OllamaRestartRecoveryFailureReason =
  | "timeout"
  | "command-failed"
  | "ollama-error"
  | "invalid-response"
  | "spawn-failed";

export type OllamaRestartRecoveryResult =
  | { kind: "skipped"; reason: "not-ollama" | "missing-model" | "already-loaded" | "unreachable" }
  | { kind: "warmed"; ok: true; timedOut: false }
  | {
      kind: "warmed";
      ok: false;
      timedOut: boolean;
      reason: OllamaRestartRecoveryFailureReason;
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
  return [
    "curl",
    ...buildValidatedCurlCommandArgs([
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
  ];
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
  const probe = deps.probeRuntimeModelStatus ?? probeOllamaRuntimeModelStatus;
  let status: OllamaRuntimeModelStatus;
  try {
    status = probe(model, () => rawHost, deps.runCaptureImpl);
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
    const result = captureEx(buildWarmCommand(model, rawHost));
    if (result.timedOut) {
      return { kind: "warmed", ok: false, timedOut: true, reason: "timeout" };
    }
    if (result.exitCode !== 0) {
      return { kind: "warmed", ok: false, timedOut: false, reason: "command-failed" };
    }
    const response = validateWarmResponse(result.stdout);
    if (response !== "ok") {
      return { kind: "warmed", ok: false, timedOut: false, reason: response };
    }
    return { kind: "warmed", ok: true, timedOut: false };
  } catch {
    return { kind: "warmed", ok: false, timedOut: false, reason: "spawn-failed" };
  }
}
