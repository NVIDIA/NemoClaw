// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { type ProviderHealthStatus, probeProviderHealth } from "../../inference/health";
import { inspectManagedLlamaCppStatus } from "../../inference/llama-cpp/managed-status";
import {
  type EffectiveReasoningEffort,
  getEffectiveReasoningEffort,
} from "../../inference/selection";
import { classifyInferenceRouteFailureLabel } from "./connect-inference-route-probe";
import type { DoctorCheck } from "./doctor-report";
import { probeSandboxInferenceGatewayHealth } from "./inference-route-health";

export type DoctorInferenceRoute = {
  model: string;
  provider: string;
  effectiveReasoningEffort?: EffectiveReasoningEffort | null;
};

type ManagedLlamaCppDoctorDeps = {
  inspectManagedLlamaCppStatusImpl?: typeof inspectManagedLlamaCppStatus;
};

export function collectManagedLlamaCppDoctorChecks(
  sandboxName: string,
  gatewayPort?: number | null,
  deps: ManagedLlamaCppDoctorDeps = {},
): DoctorCheck[] {
  const managed = (deps.inspectManagedLlamaCppStatusImpl ?? inspectManagedLlamaCppStatus)(
    sandboxName,
    {
      ...(typeof gatewayPort === "number" ? { gatewayPort } : {}),
    },
  );
  if (!managed) return [];
  const runtimeStatus =
    managed.state === "running"
      ? "ok"
      : managed.state === "stopped" || managed.state === "preparing"
        ? "warn"
        : "fail";
  return [
    {
      group: "Local services",
      label: "Managed llama.cpp identity",
      status: "info",
      detail: `recipe ${managed.recipeId}; model ${managed.modelDigest ?? "not published"}; image ${managed.imageReference ?? "not published"}`,
    },
    {
      group: "Local services",
      label: "Managed llama.cpp runtime",
      status: runtimeStatus,
      detail: `${managed.state}: ${managed.detail}; endpoint ${managed.endpoint}`,
      ...(runtimeStatus === "ok"
        ? {}
        : {
            hint: `re-run \`${CLI_NAME} onboard\` for '${sandboxName}' to recover the exact runtime`,
          }),
    },
  ];
}

type DoctorInferenceDeps = {
  gatewayName?: string | null;
  probeProviderHealthImpl?: typeof probeProviderHealth;
  probeSandboxInferenceGatewayHealthImpl?: typeof probeSandboxInferenceGatewayHealth;
  /** False for terminal agents that do not have a long-running gateway serving process. */
  includeServingProcessCheck?: boolean;
};

export function resolveDoctorReasoningEffort(
  input: Parameters<typeof getEffectiveReasoningEffort>[0],
): EffectiveReasoningEffort | null {
  return getEffectiveReasoningEffort(input);
}

function pushInferenceHealthCheck(
  checks: DoctorCheck[],
  probe: ProviderHealthStatus,
  options: { authoritative?: boolean; label?: string } = {},
): void {
  const authoritative = options.authoritative !== false;
  const label =
    options.label ??
    (probe.probeLabel ? `Provider health (${probe.probeLabel})` : "Provider health");
  const passed = probe.probed && probe.ok;
  const failed = authoritative && !probe.ok && (probe.probed || Boolean(probe.failureLabel));
  checks.push({
    group: "Inference",
    label,
    status: passed ? "ok" : failed ? "fail" : "info",
    detail: passed ? `${probe.endpoint} reachable` : probe.detail,
    hint: failed ? "check sandbox reachability and the inference route" : undefined,
  });
}

function inferenceRouteCheck(sandboxName: string, route: DoctorInferenceRoute): DoctorCheck {
  const known = route.provider !== "unknown" && route.model !== "unknown";
  return {
    group: "Inference",
    label: "Route",
    status: known ? "ok" : "warn",
    detail: `${route.provider} / ${route.model}`,
    hint: known
      ? undefined
      : `run \`${CLI_NAME} ${sandboxName} status\` after the gateway is healthy`,
  };
}

function reasoningEffortCheck(route: DoctorInferenceRoute): DoctorCheck | null {
  const effort = route.effectiveReasoningEffort;
  if (!effort) return null;
  return {
    group: "Inference",
    label: "Reasoning effort",
    status: "info",
    detail: effort,
  };
}

function skippedInferenceGatewayProbe(): ProviderHealthStatus {
  return {
    ok: false,
    probed: false,
    providerLabel: "Inference gateway chain",
    endpoint: "https://inference.local/v1/models",
    detail: "skipped because the sandbox is not reachable through its named gateway",
    probeLabel: "gateway",
  };
}

function unavailableInferenceGatewayProbe(): ProviderHealthStatus {
  const endpoint = "https://inference.local/v1/models";
  return {
    ok: false,
    probed: false,
    providerLabel: "Inference gateway chain",
    endpoint,
    detail: `Could not probe ${endpoint} from inside the reachable sandbox.`,
    probeLabel: "gateway",
    failureLabel: "unreachable",
  };
}

async function collectInferenceRouteProbe(
  sandboxName: string,
  sandboxReachable: boolean,
  probe: typeof probeSandboxInferenceGatewayHealth,
  gatewayName?: string | null,
): Promise<ProviderHealthStatus> {
  if (!sandboxReachable) return skippedInferenceGatewayProbe();
  let gateway: Awaited<ReturnType<typeof probeSandboxInferenceGatewayHealth>> = null;
  try {
    gateway = gatewayName ? await probe(sandboxName, { gatewayName }) : await probe(sandboxName);
  } catch {
    gateway = null;
  }
  if (!gateway) return unavailableInferenceGatewayProbe();
  return {
    ok: gateway.ok,
    probed: true,
    providerLabel: "Inference gateway chain",
    endpoint: gateway.endpoint,
    detail: gateway.detail,
    probeLabel: "gateway",
    ...(gateway.ok
      ? {}
      : {
          failureLabel: classifyInferenceRouteFailureLabel(gateway.httpStatus),
        }),
  };
}

function unavailableProviderHealthDiagnostic(detail: string): ProviderHealthStatus {
  return {
    ok: false,
    probed: false,
    providerLabel: "Upstream provider",
    endpoint: "",
    detail,
    probeLabel: "upstream",
  };
}

function collectProviderHealthDiagnostics(
  provider: string,
  model: string,
  probe: typeof probeProviderHealth,
): ProviderHealthStatus[] {
  if (provider === "unknown") {
    return [unavailableProviderHealthDiagnostic("provider route is unknown")];
  }
  try {
    const health = probe(provider, { model });
    if (!health) {
      return [
        unavailableProviderHealthDiagnostic(`no direct health probe registered for ${provider}`),
      ];
    }
    const { subprobes = [], ...primary } = health;
    return [{ ...primary, probeLabel: primary.probeLabel ?? "upstream" }, ...subprobes];
  } catch {
    return [unavailableProviderHealthDiagnostic("direct provider health probe could not run")];
  }
}

/** Collect authoritative route health plus non-authoritative upstream diagnostics. */
export async function collectInferenceChecks(
  sandboxName: string,
  route: DoctorInferenceRoute,
  sandboxReachable: boolean,
  deps: DoctorInferenceDeps = {},
): Promise<DoctorCheck[]> {
  const checks = [inferenceRouteCheck(sandboxName, route)];
  const effortCheck = reasoningEffortCheck(route);
  if (effortCheck) checks.push(effortCheck);
  const gatewayProbe = await collectInferenceRouteProbe(
    sandboxName,
    sandboxReachable,
    deps.probeSandboxInferenceGatewayHealthImpl ?? probeSandboxInferenceGatewayHealth,
    deps.gatewayName,
  );
  pushInferenceHealthCheck(checks, gatewayProbe, { label: "Inference route (gateway)" });
  for (const diagnostic of collectProviderHealthDiagnostics(
    route.provider,
    route.model,
    deps.probeProviderHealthImpl ?? probeProviderHealth,
  )) {
    pushInferenceHealthCheck(checks, diagnostic, { authoritative: false });
  }
  // Serving-process leg: the above probes run in a fresh exec with OpenShell's
  // injected env, so they cannot attest what the long-running gateway process
  // can reach. Until NemoClaw defines and implements a process-owned probe
  // contract, keep this honest result explicit (#7003).
  if (deps.includeServingProcessCheck !== false) {
    checks.push({
      group: "Inference",
      label: "Serving process",
      status: "info",
      detail: "not checked — serving-process probing is not implemented",
    });
  }
  return checks;
}
