// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenShellGatewayTarget = { kind: "named"; gatewayName: string } | { kind: "selected" };

export type OpenShellSandboxReadiness = "ready" | "not_ready" | "terminal";

export type OpenShellSandboxObservation = Readonly<{
  name: string;
  phase: string | null;
  readiness: OpenShellSandboxReadiness;
}>;

export type OpenShellSandboxInventory = Readonly<{
  sandboxes: readonly OpenShellSandboxObservation[];
}>;

export type OpenShellSandboxLookup =
  | Readonly<{ state: "present"; sandbox: OpenShellSandboxObservation }>
  | Readonly<{ state: "missing" }>;

export type OpenShellSandboxErrorKind =
  | "authentication"
  | "command"
  | "schema"
  | "timeout"
  | "transport";

export type OpenShellSandboxTransportReason = "identity_mismatch" | "unreachable";

export type OpenShellSandboxError =
  | Readonly<{
      kind: Exclude<OpenShellSandboxErrorKind, "command" | "transport">;
      message: string;
    }>
  | Readonly<{
      kind: "transport";
      reason: OpenShellSandboxTransportReason;
      message: string;
    }>
  | Readonly<{
      kind: "command";
      reason: "failed" | "invalid_request";
      message: string;
    }>;

export type OpenShellSandboxResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: OpenShellSandboxError }>;

export type ListOpenShellSandboxesRequest = Readonly<{
  target: OpenShellGatewayTarget;
  timeoutMs?: number;
}>;

export type LookupOpenShellSandboxRequest = ListOpenShellSandboxesRequest &
  Readonly<{
    sandboxName: string;
  }>;

export type OpenShellSandboxReadinessProbe = (
  request: LookupOpenShellSandboxRequest,
) => Promise<OpenShellSandboxResult<OpenShellSandboxReadiness>>;

/** Transport-neutral sandbox observation capabilities used by NemoClaw. */
export interface OpenShellSandboxObserver {
  listSandboxes(
    request: ListOpenShellSandboxesRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxInventory>>;
}

export function namedOpenShellGateway(gatewayName: string): OpenShellGatewayTarget {
  return { kind: "named", gatewayName };
}

export function selectedOpenShellGateway(): OpenShellGatewayTarget {
  return { kind: "selected" };
}

// sourceOfTruth: nemoclaw/src/shared/openshell-observation-boundary.cts
// generatedBoundary: build:cli emits this typed capability before compiling
// the root adapter surface.
export {
  EXTERNAL_OPENSHELL_RELEASE,
  observeExternalOpenShellGatewayHealth,
} from "../../../../nemoclaw/dist/shared/openshell-observation-boundary.cjs";

export {
  createOpenShellSdkGatewayHealthObserver,
  sdkOpenShellGatewayHealthObserver,
} from "../../../../nemoclaw/dist/shared/openshell-gateway-health-sdk.js";

export type {
  ExternalOpenShellGatewayResult,
  ExternalOpenShellGatewayStatus,
  ObserveOpenShellGatewayHealthRequest,
  OpenShellGatewayHealthError,
  OpenShellGatewayHealthObservation,
  OpenShellGatewayHealthObserver,
  OpenShellGatewayHealthResult,
  OpenShellGatewayHealthStatus,
} from "../../../../nemoclaw/dist/shared/openshell-observation-boundary.cjs";
