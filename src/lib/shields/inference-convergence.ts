// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildSandboxInferenceRouteProbeArgs,
  parseSandboxInferenceRouteProbeResult,
} from "../actions/sandbox/connect-inference-route-probe";
import { captureOpenshell } from "../adapters/openshell/runtime";
import { OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { sleepMs } from "../core/wait";

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 500;

type CaptureInferenceRoute = typeof captureOpenshell;

export interface InferenceRouteConvergenceResult {
  ok: boolean;
  attempts: number;
  httpStatus: number;
}

export interface InferenceRouteConvergenceOptions {
  capture?: CaptureInferenceRoute;
  maxAttempts?: number;
  retryDelayMs?: number;
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
  options: InferenceRouteConvergenceOptions = {},
): InferenceRouteConvergenceResult {
  const capture = options.capture ?? captureOpenshell;
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  const sleep = options.sleep ?? sleepMs;
  let httpStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const probe = capture(buildSandboxInferenceRouteProbeArgs(sandboxName, { name: "hermes" }), {
      ignoreError: true,
      includeStreams: true,
      timeout: OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS,
    });
    const parsed = parseSandboxInferenceRouteProbeResult(probe);
    httpStatus = parsed.httpStatus;
    if (parsed.healthy) return { ok: true, attempts: attempt, httpStatus };
    if (attempt < maxAttempts) sleep(retryDelayMs);
  }

  return { ok: false, attempts: maxAttempts, httpStatus };
}
