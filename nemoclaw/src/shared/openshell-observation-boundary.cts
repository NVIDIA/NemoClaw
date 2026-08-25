// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: Transport-neutral OpenShell observation contracts shared by
// the root CLI adapters and the Blueprint Runner. Transport implementations
// must return sanitized errors and must not expose authentication material.
// consumers: src/lib/adapters/openshell/sandbox-observer.ts re-exports this
// contract for CLI callers. The Blueprint Runner consumes the generated .cjs
// boundary for external-target observation without importing root CLI source.
// sourceBoundary: Explicit external endpoint and workspace identity may cross
// this boundary. CA and authentication file paths or contents must not.
// regressionTest: openshell-observation-boundary.test.ts and the root CLI
// sandbox-observer tests.
// removalCondition: remove only when no NemoClaw consumer observes OpenShell
// gateway, workspace, or sandbox state through a transport-neutral contract.

export type OpenShellExternalGatewayTarget = Readonly<{
  kind: "external";
  endpoint: string;
  workspace: string;
  expectedRelease: string;
  allWorkspaces: false;
}>;

export type OpenShellGatewayTarget =
  | Readonly<{ kind: "named"; gatewayName: string }>
  | Readonly<{ kind: "selected" }>
  | OpenShellExternalGatewayTarget;

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

export type OpenShellExternalTargetError =
  | OpenShellSandboxError
  | Readonly<{
      kind: "compatibility";
      message: string;
    }>;

export type OpenShellExternalTargetResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: OpenShellExternalTargetError }>;

export type ListOpenShellSandboxesRequest = Readonly<{
  target: OpenShellGatewayTarget;
  timeoutMs?: number;
}>;

export type LookupOpenShellSandboxRequest = ListOpenShellSandboxesRequest &
  Readonly<{
    sandboxName: string;
  }>;

/** Transport-neutral sandbox observation capabilities used by NemoClaw. */
export interface OpenShellSandboxObserver {
  listSandboxes(
    request: ListOpenShellSandboxesRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxInventory>>;
}

export type OpenShellGatewayHealthStatus = "unspecified" | "healthy" | "degraded" | "unhealthy";

export type OpenShellGatewayHealthObservation = Readonly<{
  status: OpenShellGatewayHealthStatus;
  release: string;
}>;

export type OpenShellWorkspacePhase = "unspecified" | "active" | "terminating";

export type OpenShellWorkspaceObservation = Readonly<{
  name: string;
  phase: OpenShellWorkspacePhase;
}>;

export type OpenShellCurrentUserObservation = Readonly<{
  subjectFingerprint: string;
}>;

export type ObserveExternalOpenShellTargetRequest = Readonly<{
  target: OpenShellExternalGatewayTarget;
  timeoutMs?: number;
}>;

export type ExternalOpenShellTargetObservation = Readonly<{
  target: OpenShellExternalGatewayTarget;
  health: OpenShellGatewayHealthObservation;
  identity: OpenShellCurrentUserObservation;
  workspace: OpenShellWorkspaceObservation;
  inventory: OpenShellSandboxInventory;
}>;

/**
 * Authenticated read-only observations required after release compatibility
 * passes. For an external target, `listSandboxes` must send the target's exact
 * workspace and `allWorkspaces: false` to the OpenShell raw request.
 */
export interface AuthenticatedOpenShellExternalTargetObserver extends OpenShellSandboxObserver {
  getCurrentUser(
    request: ObserveExternalOpenShellTargetRequest,
  ): Promise<OpenShellSandboxResult<OpenShellCurrentUserObservation>>;
  getWorkspace(
    request: ObserveExternalOpenShellTargetRequest,
  ): Promise<OpenShellSandboxResult<OpenShellWorkspaceObservation>>;
}

/**
 * Public probe and delayed file-backed credential boundary for one external
 * target. The transport owns the future validated file reference; this
 * boundary exposes only when the opaque handoff may occur.
 */
export interface OpenShellExternalTargetObserver {
  getGatewayHealth(
    request: ObserveExternalOpenShellTargetRequest,
  ): Promise<OpenShellSandboxResult<OpenShellGatewayHealthObservation>>;
  connectWithCredentialFile(
    request: ObserveExternalOpenShellTargetRequest,
  ): Promise<OpenShellSandboxResult<AuthenticatedOpenShellExternalTargetObserver>>;
}

export function namedOpenShellGateway(gatewayName: string): OpenShellGatewayTarget {
  return { kind: "named", gatewayName };
}

export function selectedOpenShellGateway(): OpenShellGatewayTarget {
  return { kind: "selected" };
}

export function externalOpenShellGateway(
  endpoint: string,
  workspace: string,
  expectedRelease: string,
): OpenShellExternalGatewayTarget {
  return { kind: "external", endpoint, workspace, expectedRelease, allWorkspaces: false };
}

function failure<T>(error: OpenShellSandboxError): OpenShellSandboxResult<T> {
  return { ok: false, error };
}

function externalFailure<T>(error: OpenShellExternalTargetError): OpenShellExternalTargetResult<T> {
  return { ok: false, error };
}

function sanitizedExternalObservationError(error: OpenShellSandboxError): OpenShellSandboxError {
  switch (error.kind) {
    case "authentication":
      return {
        kind: "authentication",
        message: "OpenShell could not authenticate the external target observation.",
      };
    case "timeout":
      return { kind: "timeout", message: "The external OpenShell target observation timed out." };
    case "schema":
      return { kind: "schema", message: "OpenShell returned an invalid observation response." };
    case "transport":
      return {
        kind: "transport",
        reason: error.reason,
        message:
          error.reason === "identity_mismatch"
            ? "The external OpenShell target identity does not match the configured identity."
            : "NemoClaw could not reach the external OpenShell target.",
      };
    case "command":
      return {
        kind: "command",
        reason: error.reason,
        message: "The external OpenShell target observation failed.",
      };
  }
}

/**
 * Collect the read-only external-target receipt through one shared observer.
 * Public health and release validation complete before the opaque credential
 * handoff. Authenticated identity, workspace, and inventory
 * calls then run in that order with the same bounded operation timeout. The
 * transport remains responsible for enforcing each timeout.
 */
export async function observeExternalOpenShellTarget(
  observer: OpenShellExternalTargetObserver,
  request: ObserveExternalOpenShellTargetRequest,
): Promise<OpenShellExternalTargetResult<ExternalOpenShellTargetObservation>> {
  const health = await observer.getGatewayHealth(request);
  if (!health.ok) return failure(sanitizedExternalObservationError(health.error));
  if (health.value.release !== request.target.expectedRelease) {
    return externalFailure({
      kind: "compatibility",
      message: "The external OpenShell target release does not match the configured release.",
    });
  }

  const authenticated = await observer.connectWithCredentialFile(request);
  if (!authenticated.ok) {
    return failure(sanitizedExternalObservationError(authenticated.error));
  }
  const identity = await authenticated.value.getCurrentUser(request);
  if (!identity.ok) return failure(sanitizedExternalObservationError(identity.error));
  const workspace = await authenticated.value.getWorkspace(request);
  if (!workspace.ok) return failure(sanitizedExternalObservationError(workspace.error));
  if (workspace.value.name !== request.target.workspace) {
    return failure({
      kind: "schema",
      message: "OpenShell returned a workspace other than the explicitly configured workspace.",
    });
  }
  const inventory = await authenticated.value.listSandboxes(request);
  if (!inventory.ok) return failure(sanitizedExternalObservationError(inventory.error));

  return {
    ok: true,
    value: {
      target: request.target,
      health: health.value,
      identity: identity.value,
      workspace: workspace.value,
      inventory: inventory.value,
    },
  };
}
