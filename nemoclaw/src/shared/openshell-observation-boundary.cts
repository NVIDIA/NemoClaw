// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: Transport-neutral external OpenShell observation contract
// shared by the root CLI adapter surface and the Blueprint Runner.

import {
  EXTERNAL_OPENSHELL_RELEASE,
  type SanitizedExternalOpenShellTargetPlan,
} from "./openshell-external-target-boundary.cjs";

export { EXTERNAL_OPENSHELL_RELEASE };

export type OpenShellGatewayHealthStatus = "unspecified" | "healthy" | "degraded" | "unhealthy";

export type OpenShellGatewayHealthObservation = Readonly<{
  status: OpenShellGatewayHealthStatus;
  release: string;
}>;

export type OpenShellGatewayHealthError = Readonly<{
  kind: "dependency" | "schema" | "timeout" | "transport";
  message: string;
}>;

export type OpenShellGatewayHealthResult =
  | Readonly<{ ok: true; value: OpenShellGatewayHealthObservation }>
  | Readonly<{ ok: false; error: OpenShellGatewayHealthError }>;

export type ObserveOpenShellGatewayHealthRequest = Readonly<{
  target: SanitizedExternalOpenShellTargetPlan;
  caBundle: Uint8Array;
  timeoutMs: number;
}>;

/** Transport-neutral public gateway health capability used by NemoClaw. */
export interface OpenShellGatewayHealthObserver {
  observeHealth(
    request: ObserveOpenShellGatewayHealthRequest,
  ): Promise<OpenShellGatewayHealthResult>;
}

export type ExternalOpenShellGatewayStatus = Readonly<{
  openshell_target: SanitizedExternalOpenShellTargetPlan;
  gateway: Readonly<{
    status: "healthy";
    release: typeof EXTERNAL_OPENSHELL_RELEASE;
  }>;
  compatibility: "compatible";
}>;

export type ExternalOpenShellGatewayResult =
  | Readonly<{ ok: true; value: ExternalOpenShellGatewayStatus }>
  | Readonly<{ ok: false; error: Readonly<{ message: string }> }>;

const HEALTH_STATUSES = new Set<OpenShellGatewayHealthStatus>([
  "unspecified",
  "healthy",
  "degraded",
  "unhealthy",
]);

function failure(message: string): ExternalOpenShellGatewayResult {
  return Object.freeze({ ok: false, error: Object.freeze({ message }) });
}

function fixedObserverFailure(kind: OpenShellGatewayHealthError["kind"]): string {
  switch (kind) {
    case "dependency":
      return `The approved OpenShell SDK ${EXTERNAL_OPENSHELL_RELEASE} is unavailable.`;
    case "schema":
      return "The external OpenShell gateway returned an invalid public health response.";
    case "timeout":
    case "transport":
      return "NemoClaw could not reach the external OpenShell target.";
  }
}

/** Validate and sanitize one observation before it becomes Runner output. */
export async function observeExternalOpenShellGatewayHealth(
  observer: OpenShellGatewayHealthObserver,
  request: ObserveOpenShellGatewayHealthRequest,
): Promise<ExternalOpenShellGatewayResult> {
  if (
    request.target.expected_release !== EXTERNAL_OPENSHELL_RELEASE ||
    !(request.caBundle instanceof Uint8Array) ||
    request.caBundle.byteLength === 0 ||
    request.caBundle.byteLength > 1024 * 1024 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 60_000
  ) {
    return failure("The external OpenShell gateway health request is not valid.");
  }

  let observed: OpenShellGatewayHealthResult;
  try {
    observed = await observer.observeHealth(
      Object.freeze({
        target: request.target,
        caBundle: Uint8Array.from(request.caBundle),
        timeoutMs: request.timeoutMs,
      }),
    );
  } catch {
    return failure("The external OpenShell gateway health check failed.");
  }
  if (!observed.ok) return failure(fixedObserverFailure(observed.error.kind));

  const { release, status } = observed.value;
  if (typeof release !== "string" || !HEALTH_STATUSES.has(status)) {
    return failure("The external OpenShell gateway returned an invalid public health response.");
  }
  if (release !== EXTERNAL_OPENSHELL_RELEASE) {
    return failure(
      `The external OpenShell gateway release does not match ${EXTERNAL_OPENSHELL_RELEASE}.`,
    );
  }
  if (status !== "healthy") {
    return failure("The external OpenShell gateway is not healthy.");
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      openshell_target: request.target,
      gateway: Object.freeze({ status, release }),
      compatibility: "compatible",
    }),
  });
}
