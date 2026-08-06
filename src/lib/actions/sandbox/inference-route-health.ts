// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshellForStatus, isCommandTimeout } from "../../adapters/openshell/runtime";
import { OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import {
  buildSandboxInferenceRouteProbeArgs,
  classifyInferenceRouteFailureLabel,
  isDcodeManagedExecMissingDetail,
  parseSandboxInferenceRouteProbeResult,
} from "./connect-inference-route-probe";

export type SandboxInferenceRouteHealth = {
  ok: boolean;
  endpoint: string;
  httpStatus: number;
  detail: string;
};

function describeInferenceTransportFailure(
  curlExitCode: number | null,
  tlsVerifyResult: number | null,
  canonicalCurlExitCode: number | null,
  canonicalTlsVerifyResult: number | null,
): string {
  switch (curlExitCode) {
    case 5:
      return "The configured proxy hostname could not be resolved.";
    case 6:
      return "DNS resolution for inference.local failed inside the sandbox.";
    case 7:
      return "The inference route connection failed inside the sandbox.";
    case 28:
      return "The inference route probe timed out inside the sandbox.";
    case 60:
      if (canonicalCurlExitCode === 0 && canonicalTlsVerifyResult === 0) {
        return "The inherited CA bundle did not verify the inference route; OpenShell's canonical runtime CA did.";
      }
      if (canonicalCurlExitCode === 60 && canonicalTlsVerifyResult !== null) {
        return `TLS certificate validation also failed with OpenShell's canonical runtime CA (verification result ${String(canonicalTlsVerifyResult)}).`;
      }
      return tlsVerifyResult === null
        ? "TLS certificate validation failed for the inference route."
        : `TLS certificate validation failed for the inference route (verification result ${String(tlsVerifyResult)}).`;
    case null:
      return "DNS, connection, timeout, or TLS setup failed.";
    default:
      return `The inference route probe failed with curl exit code ${String(curlExitCode)}.`;
  }
}

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
        includeStreams: true,
        timeout: OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS,
      },
    );
  } catch {
    return null;
  }
  if (isCommandTimeout(result) || result.error) return null;
  const parsed = parseSandboxInferenceRouteProbeResult(result);
  if (!parsed.healthy && !parsed.broken) {
    return isDcodeManagedExecMissingDetail(parsed.detail)
      ? {
          ok: false,
          endpoint,
          httpStatus: 0,
          detail: parsed.detail,
        }
      : null;
  }
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
          describeInferenceTransportFailure(
            parsed.curlExitCode,
            parsed.tlsVerifyResult,
            parsed.canonicalCurlExitCode,
            parsed.canonicalTlsVerifyResult,
          )
        : `Inference gateway returned an invalid HTTP status (${status}) on ${endpoint}; ` +
          `check the in-sandbox proxy and gateway.`,
  };
}
