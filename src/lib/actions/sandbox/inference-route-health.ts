// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshellForStatus, isCommandTimeout } from "../../adapters/openshell/runtime";
import { OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import {
  buildSandboxInferenceRouteProbeArgs,
  classifyInferenceRouteFailureLabel,
  parseSandboxInferenceRouteProbeResult,
} from "./connect-inference-route-probe";

export type SandboxInferenceRouteHealth = {
  ok: boolean;
  endpoint: string;
  httpStatus: number;
  detail: string;
};

/**
 * Probe the authoritative `https://inference.local/v1/models` route from
 * inside the sandbox using the same agent-aware argv and parser as connect.
 *
 * Returns null when OpenShell exec, DNS, TLS, proxy setup, or the response
 * framing cannot produce a trusted route result. Callers must treat null as
 * probe unavailable, never as a healthy or definitively broken route.
 */
export async function probeSandboxInferenceGatewayHealth(
  sandboxName: string,
  options: {
    captureOpenshellImpl?: typeof captureOpenshellForStatus;
    getSessionAgentImpl?: typeof agentRuntime.getSessionAgent;
  } = {},
): Promise<SandboxInferenceRouteHealth | null> {
  const endpoint = "https://inference.local/v1/models";
  const capture = options.captureOpenshellImpl ?? captureOpenshellForStatus;
  const getSessionAgent = options.getSessionAgentImpl ?? agentRuntime.getSessionAgent;
  let result: Awaited<ReturnType<typeof captureOpenshellForStatus>>;
  try {
    result = await capture(
      buildSandboxInferenceRouteProbeArgs(sandboxName, getSessionAgent(sandboxName)),
      {
        ignoreError: true,
        timeout: OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS,
      },
    );
  } catch {
    return null;
  }
  if (isCommandTimeout(result) || result.error) return null;
  const parsed = parseSandboxInferenceRouteProbeResult(result);
  if (!parsed.healthy && !parsed.broken) return null;
  const status = parsed.httpStatus;
  if (parsed.healthy) {
    return {
      ok: true,
      endpoint,
      httpStatus: status,
      detail: `Inference gateway responded HTTP ${status} on ${endpoint} (full chain reachable).`,
    };
  }
  if (classifyInferenceRouteFailureLabel(status) === "unhealthy") {
    return {
      ok: false,
      endpoint,
      httpStatus: status,
      detail: `Inference gateway returned HTTP ${status} on ${endpoint}; the route is reachable but unhealthy.`,
    };
  }
  return {
    ok: false,
    endpoint,
    httpStatus: status,
    detail:
      status === 0
        ? `Inference gateway unreachable on ${endpoint} from inside the sandbox. ` +
          `DNS may have failed or the agent gateway / auth proxy is not running.`
        : `Inference gateway returned an invalid HTTP status (${status}) on ${endpoint}; ` +
          `check the in-sandbox proxy and gateway.`,
  };
}
