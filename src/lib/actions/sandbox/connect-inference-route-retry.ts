// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { captureOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { retryUntil } from "../../core/retry";
import {
  buildSandboxInferenceRouteProbeArgs,
  type InferenceRouteProbeAgent,
  parseSandboxInferenceRouteProbeResult,
} from "./connect-inference-route-probe";

export type { InferenceRouteProbeAgent } from "./connect-inference-route-probe";

export type SandboxInferenceRouteProbe = {
  healthy: boolean;
  broken: boolean;
  httpStatus?: number;
  detail: string;
};

export type InferenceRouteProbeOptions = {
  attempts?: number;
  delayMs?: number;
};

type CaptureInferenceRoute = typeof captureOpenshell;

export interface InferenceRouteRetryDeps {
  capture?: CaptureInferenceRoute;
  sleep?: (milliseconds: number) => void;
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  if (process.env.VITEST === "true" || process.env.NEMOCLAW_TEST_NO_SLEEP === "1") return;
  spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${milliseconds})`], {
    stdio: "ignore",
    timeout: milliseconds + 1_000,
  });
}

export function probeSandboxInferenceRoute(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
  { attempts = 1, delayMs = 0 }: InferenceRouteProbeOptions = {},
  deps: InferenceRouteRetryDeps = {},
): SandboxInferenceRouteProbe {
  const attemptCount = Math.max(1, Math.floor(attempts));
  const capture = deps.capture ?? captureOpenshell;
  return retryUntil(
    () => {
      // Keep the shell string inside the sandbox: curl write-out, body capture,
      // and status classification must run as one bounded probe. sandboxName
      // remains an argv value, so no user input is interpolated into the script.
      const probe = capture(buildSandboxInferenceRouteProbeArgs(sandboxName, agent), {
        ignoreError: true,
        includeStreams: true,
        timeout: OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS,
      });
      const parsed = parseSandboxInferenceRouteProbeResult(probe);
      return {
        healthy: parsed.healthy,
        broken: parsed.broken,
        httpStatus: parsed.httpStatus,
        detail: parsed.detail,
      };
    },
    {
      accept: (result) => result.healthy,
      retryDelaysMs: Array.from({ length: attemptCount - 1 }, () => delayMs),
      sleep: deps.sleep ?? sleepSync,
    },
  );
}
