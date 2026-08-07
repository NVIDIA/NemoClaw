// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildSandboxInferenceRouteProbeArgs,
  parseSandboxInferenceRouteProbeResult,
} from "../actions/sandbox/connect-inference-route-probe";

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 500;
const INFERENCE_ROUTE_PROBE_TIMEOUT_MS = 10_000;

interface InferenceRouteCommandResult {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}

type RunInferenceRoute = (
  command: readonly string[],
  options: { ignoreError: true; suppressOutput: true; timeout: number },
) => InferenceRouteCommandResult;

function sleepMs(milliseconds: number): void {
  if (milliseconds <= 0 || !Number.isFinite(milliseconds)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export interface InferenceRouteConvergenceResult {
  ok: boolean;
  attempts: number;
  httpStatus: number;
}

export interface InferenceRouteConvergenceOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  run: RunInferenceRoute;
  sleep?: (milliseconds: number) => void;
}

/**
 * Require the Hermes inference route to be usable after a live policy
 * replacement. OpenShell's `policy set --wait` confirms the policy version is
 * active, but the inference proxy can briefly continue returning HTTP 503
 * after that acknowledgement. Shields down must not report completion during
 * that gap because callers immediately resume agent work.
 */
export function waitForHermesInferenceRouteConvergence(
  sandboxName: string,
  options: InferenceRouteConvergenceOptions,
): InferenceRouteConvergenceResult {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  const sleep = options.sleep ?? sleepMs;
  let httpStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const probe = options.run(
      buildSandboxInferenceRouteProbeArgs(sandboxName, { name: "hermes" }),
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: INFERENCE_ROUTE_PROBE_TIMEOUT_MS,
      },
    );
    const parsed = parseSandboxInferenceRouteProbeResult({
      status: probe.status,
      output: String(probe.stdout ?? ""),
      stderr: String(probe.stderr ?? ""),
    });
    httpStatus = parsed.httpStatus;
    if (parsed.healthy) return { ok: true, attempts: attempt, httpStatus };
    if (attempt < maxAttempts) sleep(retryDelayMs);
  }

  return { ok: false, attempts: maxAttempts, httpStatus };
}
