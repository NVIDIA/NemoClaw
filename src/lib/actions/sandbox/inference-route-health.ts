// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshellForStatus, isCommandTimeout } from "../../adapters/openshell/runtime";
import { OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import type { ProviderHealthStatus } from "../../inference/health";
import {
  buildSandboxInferenceRouteProbeArgs,
  classifyInferenceRouteFailureLabel,
  isDcodeManagedExecMissingDetail,
  parseSandboxInferenceRouteProbeResult,
} from "./connect-inference-route-probe";
import {
  probeSandboxInferenceInvocation,
  READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  type SandboxInferenceInvocationInput,
  type SandboxInferenceInvocationResult,
} from "./inference-invocation-probe";

export type { SandboxInferenceInvocationResult } from "./inference-invocation-probe";
export type ProbeSandboxInferenceInvocation = typeof probeSandboxInferenceInvocation;


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
          `DNS may have failed or the agent gateway / auth proxy is not running.`
        : `Inference gateway returned an invalid HTTP status (${status}) on ${endpoint}; ` +
          `check the in-sandbox proxy and gateway.`,
  };
}

/**
 * The upstream probe authenticates with the host credential this command
 * resolves. The gateway stores the provider credential the sandbox route uses
 * and does not return its value, so the two can hold different secrets. Once
 * the route has served an inference request, a provider rejection of the host
 * credential reports nothing about the sandbox route. Local backend and auth
 * proxy hops carry their own probeLabel and keep their own remediation.
 */
function unattributedUpstreamProbe(probe: ProviderHealthStatus): ProviderHealthStatus {
  const { failureLabel: _failureLabel, ...rest } = probe;
  return {
    ...rest,
    ok: true,
    probed: false,
    detail:
      `${probe.detail} The sandbox ` +
      "route served an inference request with the provider credential stored in the gateway, so " +
      "NemoClaw does not attribute this result to the sandbox route.",
  };
}

function providerHealthDiagnostics(
  providerHealth: ProviderHealthStatus | null,
  routeServedRequest: boolean,
): ProviderHealthStatus[] {
  if (!providerHealth) return [];
  const { subprobes = [], ...primary } = providerHealth;
  const labeledPrimary = primary.probeLabel ? primary : { ...primary, probeLabel: "upstream" };
  return [labeledPrimary, ...subprobes].map((probe) =>
    routeServedRequest &&
    probe.probeLabel === "upstream" &&
    probe.probed &&
    !probe.ok &&
    probe.failureLabel === "unauthorized"
      ? unattributedUpstreamProbe(probe)
      : probe,
  );
}

function classifyInferenceInvocationFailureLabel(
  httpStatus: number | null,
): NonNullable<ProviderHealthStatus["failureLabel"]> {
  if (httpStatus === null) return "unreachable";
  if (httpStatus === 401 || httpStatus === 403) return "unauthorized";
  return "unhealthy";
}

/**
 * Report the reachable route as its own hop so an operator can tell a broken
 * route from a reachable route that will not serve an inference request.
 */
function reachableRouteSubprobe(
  gateway: SandboxInferenceRouteHealth,
  endpoint: string,
): ProviderHealthStatus {
  return {
    ok: true,
    probed: true,
    providerLabel: "Inference route",
    probeLabel: "route reachability",
    endpoint,
    detail: gateway.detail,
    okLabel: "reachable",
  };
}

/**
 * The route probe reads any final HTTP 200-499 as reachable, so a route with
 * an invalidated provider credential answers 401 and still passes it. Health
 * therefore reports the result of one inference request, and keeps the route
 * probe as a subprobe so a failure shows that the route itself answered.
 */
function buildInvokedRouteHealth(
  gateway: SandboxInferenceRouteHealth,
  endpoint: string,
  invocation: SandboxInferenceInvocationResult,
): ProviderHealthStatus {
  if (invocation.ok) {
    return {
      ok: true,
      probed: true,
      providerLabel: "Inference route",
      endpoint,
      detail: "Inference gateway served an inference request on https://inference.local.",
      subprobes: [reachableRouteSubprobe(gateway, endpoint)],
    };
  }
  return {
    ok: false,
    probed: true,
    providerLabel: "Inference route",
    endpoint,
    detail: `Inference gateway did not serve an inference request: ${invocation.detail}.`,
    failureLabel: classifyInferenceInvocationFailureLabel(invocation.httpStatus),
    subprobes: [reachableRouteSubprobe(gateway, endpoint)],
  };
}

export function buildSandboxInferenceRouteHealth(
  gateway: SandboxInferenceRouteHealth | null,
  providerHealth: ProviderHealthStatus | null,
  invocation: SandboxInferenceInvocationResult | null,
): ProviderHealthStatus {
  const endpoint = gateway?.endpoint ?? "https://inference.local/v1/models";
  const diagnostics = providerHealthDiagnostics(providerHealth, Boolean(invocation?.ok));
  let routeHealth: ProviderHealthStatus;
  if (gateway?.ok && invocation) {
    routeHealth = buildInvokedRouteHealth(gateway, endpoint, invocation);
  } else if (gateway) {
    routeHealth = {
      ok: gateway.ok,
      probed: true,
      providerLabel: "Inference route",
      endpoint,
      detail: gateway.detail,
      ...(gateway.ok
        ? { okLabel: "reachable" }
        : {
            failureLabel: classifyInferenceRouteFailureLabel(gateway.httpStatus),
          }),
    };
  } else {
    routeHealth = {
      ok: false,
      probed: false,
      providerLabel: "Inference route",
      endpoint,
      detail: `Could not probe ${endpoint} from inside the sandbox.`,
    };
  }
  const subprobes = [...(routeHealth.subprobes ?? []), ...diagnostics];
  return subprobes.length > 0 ? { ...routeHealth, subprobes } : routeHealth;
}

export function runSandboxInferenceInvocationProbe(
  input: SandboxInferenceInvocationInput,
  probe: ProbeSandboxInferenceInvocation = probeSandboxInferenceInvocation,
  onProbeError: (error: unknown) => void = () => {},
): SandboxInferenceInvocationResult {
  try {
    return probe(input, {}, READINESS_INFERENCE_INVOCATION_TIMEOUT_MS);
  } catch (error) {
    onProbeError(error);
    return {
      ok: false,
      detail: "sandbox inference invocation probe could not run",
      httpStatus: null,
    };
  }
}
