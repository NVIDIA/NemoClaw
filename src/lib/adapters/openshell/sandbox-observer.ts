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

export type OpenShellSandboxError =
  | Readonly<{
      kind: Exclude<OpenShellSandboxErrorKind, "command">;
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

export type WaitForOpenShellSandboxReadyRequest = LookupOpenShellSandboxRequest &
  Readonly<{
    timeoutMs: number;
    pollIntervalMs?: number;
    stableReadyObservations?: number;
    errorPhaseDebounceObservations?: number;
  }>;

export type OpenShellSandboxReadinessWait =
  | Readonly<{
      state: "ready";
      sandbox: OpenShellSandboxObservation;
      observations: number;
    }>
  | Readonly<{
      state: "terminal";
      sandbox: OpenShellSandboxObservation;
      observations: number;
    }>
  | Readonly<{
      state: "timeout";
      lastObservation: OpenShellSandboxObservation | null;
      observations: number;
    }>;

/** Transport-neutral sandbox observation capabilities used by NemoClaw. */
export interface OpenShellSandboxObserver {
  listSandboxes(
    request: ListOpenShellSandboxesRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxInventory>>;

  lookupSandbox(
    request: LookupOpenShellSandboxRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxLookup>>;

  waitForSandboxReady(
    request: WaitForOpenShellSandboxReadyRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxReadinessWait>>;
}

export function namedOpenShellGateway(gatewayName: string): OpenShellGatewayTarget {
  return { kind: "named", gatewayName };
}

export function selectedOpenShellGateway(): OpenShellGatewayTarget {
  return { kind: "selected" };
}
