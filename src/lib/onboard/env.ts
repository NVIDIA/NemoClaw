// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MAX_INFERENCE_ROUTE_TIMEOUT_SECONDS } from "../adapters/openshell/inference-route";

/** Parse a numeric env var, returning `fallback` when unset or non-finite. */
export function envInt(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // A negative override is invalid input, not a request for zero. Clamping it
  // to 0 picked the most damaging reading available for these knobs -- an
  // empty poll loop, a zero-second readiness budget, a timeout that expires
  // before its first attempt -- while any other unparseable value already fell
  // back to the caller's default. Treat both the same way, which is what the
  // sibling `readNonNegativeNumberEnv` has always done (#7881).
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
}

/** Inference timeout (seconds) for local providers (Ollama, vLLM, NIM). */
export const LOCAL_INFERENCE_TIMEOUT_SECS = envInt("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", 180);

/** Providers whose shared OpenShell route request timeout is the local inference timeout. */
export const LOCAL_INFERENCE_TIMEOUT_ROUTE_PROVIDERS: readonly string[] = [
  "compatible-endpoint",
  "ollama-local",
  "vllm-local",
];

/**
 * The local inference timeout is also the OpenShell route request timeout, which
 * NemoClaw accepts only from 1 to MAX_INFERENCE_ROUTE_TIMEOUT_SECONDS. Name the
 * variable and the range so callers can stop before they change anything.
 */
export function localInferenceTimeoutRangeError(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const seconds = envInt("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", 180, env);
  if (seconds >= 1 && seconds <= MAX_INFERENCE_ROUTE_TIMEOUT_SECONDS) return null;
  return (
    `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must be from 1 to ${MAX_INFERENCE_ROUTE_TIMEOUT_SECONDS} ` +
    `seconds; got ${JSON.stringify(env.NEMOCLAW_LOCAL_INFERENCE_TIMEOUT)}.`
  );
}

/** Sandbox Ready wait after OpenShell create returns but k3s is still converging. */
export const SANDBOX_READY_TIMEOUT_SECS = envInt("NEMOCLAW_SANDBOX_READY_TIMEOUT", 180);
