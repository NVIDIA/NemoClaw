// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildSandboxInferenceRouteProbeArgs,
  parseSandboxInferenceRouteProbeResult,
} from "../actions/sandbox/connect-inference-route-probe";
import { buildOpenshellCommand } from "../adapters/openshell/command-argv";

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
  buildOpenshellCommand?: (args: readonly string[]) => string[];
  run: RunInferenceRoute;
  sleep?: (milliseconds: number) => void;
}

/**
 * Require the Hermes inference route to be usable after a live policy
 * replacement. OpenShell's `policy set --wait` confirms the policy version is
 * active, but the inference proxy can briefly continue returning HTTP 503
 * after that acknowledgement. Shields down must not report completion during
 * that gap because callers immediately resume agent work.
 * OpenShell owns both the activation acknowledgement and proxy convergence;
 * NemoClaw can only verify the postcondition here. Remove this wait once every
 * supported OpenShell release makes `policy set --wait` guarantee that the
 * sandbox inference route is usable before it returns.
 */
export function waitForHermesInferenceRouteConvergence(
  sandboxName: string,
  options: InferenceRouteConvergenceOptions,
): InferenceRouteConvergenceResult {
  const configuredMaxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const configuredRetryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = Number.isFinite(configuredMaxAttempts)
    ? Math.max(1, Math.trunc(configuredMaxAttempts))
    : DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = Number.isFinite(configuredRetryDelayMs)
    ? Math.max(0, Math.trunc(configuredRetryDelayMs))
    : DEFAULT_RETRY_DELAY_MS;
  const buildCommand = options.buildOpenshellCommand ?? buildOpenshellCommand;
  const sleep = options.sleep ?? sleepMs;
  let httpStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const probe = options.run(
      buildCommand(buildSandboxInferenceRouteProbeArgs(sandboxName, { name: "hermes" })),
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
    const usable = parsed.healthy && httpStatus >= 200 && httpStatus < 300;
    if (usable) return { ok: true, attempts: attempt, httpStatus };
    if (attempt < maxAttempts) sleep(retryDelayMs);
  }

  return { ok: false, attempts: maxAttempts, httpStatus };
}
