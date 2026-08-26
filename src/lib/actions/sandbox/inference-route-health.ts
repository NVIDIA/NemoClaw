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
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";

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
    gatewayName?: string;
    getSessionAgentImpl?: typeof agentRuntime.getSessionAgent;
  } = {},
): Promise<SandboxInferenceRouteHealth | null> {
  const endpoint = "https://inference.local/v1/models";
  const capture = options.captureOpenshellImpl ?? captureOpenshellForStatus;
  const getSessionAgent = options.getSessionAgentImpl ?? agentRuntime.getSessionAgent;
  let result: Awaited<ReturnType<typeof captureOpenshellForStatus>>;
  try {
    result = await capture(
      buildSandboxInferenceRouteProbeArgs(
        sandboxName,
        getSessionAgent(sandboxName),
        options.gatewayName,
      ),
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

export type SandboxInferenceRouteHealthContext = {
  agentName: string | null;
  provider: string | null;
};

/**
 * The one agent and provider combination whose models route intentionally
 * answers HTTP 404: Deep Agents Code on OpenRouter (#9834). This is the
 * authoritative rule for that exception; launch readiness and status both
 * call it so the two cannot drift apart again (#10080).
 *
 * Matching this predicate is necessary but not sufficient. Both callers must
 * additionally require a successful bounded inference request before they
 * accept the 404, because the route status alone proves nothing about whether
 * the sandbox can invoke its selected model.
 */
export function isDcodeOpenRouterModelsRoute404(
  context: SandboxInferenceRouteHealthContext,
  httpStatus: number,
): boolean {
  return (
    context.agentName === DCODE_AGENT_NAME &&
    context.provider?.trim() === "openrouter-api" &&
    httpStatus === 404
  );
}

// A models route that answers but is credential-gated (401/403) stays
// authoritative through one successful inference request, because the request
// is the evidence that matters and the route itself did answer (#6192).
//
// HTTP 404 is the one status that request cannot vouch for: it means the model
// catalog is absent, so nothing validated the selected model against the
// provider. Only Deep Agents Code on OpenRouter is expected to answer 404
// (#9834), and even there the invocation must succeed. Every other agent and
// provider fails closed on 404, so `status` cannot report Ready for a route
// that genuine model-list validation would reject (#10080).
function routeStatusAccepted(
  gateway: SandboxInferenceRouteHealth,
  invocation: SandboxInferenceInvocationResult | null,
  context: SandboxInferenceRouteHealthContext,
): boolean {
  if (gateway.httpStatus >= 200 && gateway.httpStatus < 300) return true;
  if (gateway.httpStatus === 404) {
    return isDcodeOpenRouterModelsRoute404(context, gateway.httpStatus) && invocation?.ok === true;
  }
  return (gateway.httpStatus === 401 || gateway.httpStatus === 403) && invocation?.ok === true;
}

export function buildSandboxInferenceRouteHealth(
  gateway: SandboxInferenceRouteHealth | null,
  providerHealth: ProviderHealthStatus | null,
  invocation: SandboxInferenceInvocationResult | null,
  context: SandboxInferenceRouteHealthContext,
): ProviderHealthStatus {
  const endpoint = gateway?.endpoint ?? "https://inference.local/v1/models";
  const diagnostics = providerHealthDiagnostics(providerHealth, Boolean(invocation?.ok));
  const accepted =
    gateway !== null && gateway.ok && routeStatusAccepted(gateway, invocation, context);
  let routeHealth: ProviderHealthStatus;
  if (gateway?.ok && invocation) {
    const invoked = buildInvokedRouteHealth(gateway, endpoint, invocation);
    routeHealth =
      invoked.ok && !accepted
        ? {
            ...invoked,
            ok: false,
            detail:
              `Inference gateway served a request, but ${endpoint} returned HTTP ` +
              `${gateway.httpStatus}, so the selected model was never validated against a model ` +
              `catalog. Only Deep Agents Code with OpenRouter is expected to answer that; ` +
              `treating this route as not ready.`,
            failureLabel: "unreachable" as const,
          }
        : invoked;
  } else if (gateway) {
    const ok = accepted;
    // The probe reads any HTTP 200-499 as reachable, so its own detail says the
    // chain is reachable. Name the reason a non-2xx status was declined instead,
    // so that wording cannot read as a healthy result next to `ok: false`.
    const declined = gateway.ok && !ok;
    routeHealth = {
      ok,
      probed: true,
      providerLabel: "Inference route",
      endpoint,
      detail: declined
        ? `Inference gateway returned HTTP ${gateway.httpStatus} on ${endpoint} and no inference ` +
          `request confirmed the selected model; treating this route as not ready.`
        : gateway.detail,
      ...(ok
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
