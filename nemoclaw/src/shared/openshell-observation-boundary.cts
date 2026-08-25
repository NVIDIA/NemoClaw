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

import {
  isValidatedSanitizedExternalOpenShellTargetPlan,
  type SanitizedExternalOpenShellTargetPlan,
} from "./openshell-external-target-boundary.cjs";

export type OpenShellExternalGatewayTarget = Readonly<{
  kind: "external";
  plan: SanitizedExternalOpenShellTargetPlan;
  allWorkspaces: false;
}>;

const validatedExternalOpenShellGatewayTargets = new WeakSet<object>();

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
  plan: SanitizedExternalOpenShellTargetPlan,
): OpenShellExternalGatewayTarget {
  if (!isValidatedSanitizedExternalOpenShellTargetPlan(plan)) {
    throw new Error("external OpenShell observation requires a validated target plan");
  }
  const target: OpenShellExternalGatewayTarget = Object.freeze({
    kind: "external",
    plan,
    allWorkspaces: false,
  });
  validatedExternalOpenShellGatewayTargets.add(target);
  return target;
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

function unexpectedExternalObservationError(): OpenShellSandboxError {
  return {
    kind: "transport",
    reason: "unreachable",
    message: "NemoClaw could not reach the external OpenShell target.",
  };
}

async function invokeExternalObserver<T>(
  operation: () => Promise<OpenShellSandboxResult<T>>,
): Promise<OpenShellSandboxResult<T>> {
  try {
    return await operation();
  } catch {
    return failure(unexpectedExternalObservationError());
  }
}

function snapshotGatewayHealth(
  value: OpenShellGatewayHealthObservation,
): OpenShellGatewayHealthObservation {
  return Object.freeze({ status: value.status, release: value.release });
}

function snapshotCurrentUser(
  value: OpenShellCurrentUserObservation,
): OpenShellCurrentUserObservation {
  return Object.freeze({ subjectFingerprint: value.subjectFingerprint });
}

function snapshotWorkspace(value: OpenShellWorkspaceObservation): OpenShellWorkspaceObservation {
  return Object.freeze({ name: value.name, phase: value.phase });
}

function snapshotInventory(value: OpenShellSandboxInventory): OpenShellSandboxInventory {
  return Object.freeze({
    sandboxes: Object.freeze(
      value.sandboxes.map((sandbox) =>
        Object.freeze({
          name: sandbox.name,
          phase: sandbox.phase,
          readiness: sandbox.readiness,
        }),
      ),
    ),
  });
}

function snapshotExternalObservationRequest(
  request: ObserveExternalOpenShellTargetRequest,
): ObserveExternalOpenShellTargetRequest | null {
  const { target: sourceTarget, timeoutMs } = request;
  if (!validatedExternalOpenShellGatewayTargets.has(sourceTarget)) return null;
  const target: OpenShellExternalGatewayTarget = Object.freeze({
    kind: "external",
    plan: sourceTarget.plan,
    allWorkspaces: false,
  });
  validatedExternalOpenShellGatewayTargets.add(target);
  return Object.freeze({ target, timeoutMs });
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
  const validatedRequest = snapshotExternalObservationRequest(request);
  if (validatedRequest === null) {
    return externalFailure({
      kind: "command",
      reason: "invalid_request",
      message: "The external OpenShell observation target is not a validated target plan.",
    });
  }

  const healthResult = await invokeExternalObserver(() =>
    observer.getGatewayHealth(validatedRequest),
  );
  if (!healthResult.ok) {
    return failure(sanitizedExternalObservationError(healthResult.error));
  }
  const health = snapshotGatewayHealth(healthResult.value);
  if (health.release !== validatedRequest.target.plan.expected_release) {
    return externalFailure({
      kind: "compatibility",
      message: "The external OpenShell target release does not match the configured release.",
    });
  }

  const authenticated = await invokeExternalObserver(() =>
    observer.connectWithCredentialFile(validatedRequest),
  );
  if (!authenticated.ok) {
    return failure(sanitizedExternalObservationError(authenticated.error));
  }
  const identityResult = await invokeExternalObserver(() =>
    authenticated.value.getCurrentUser(validatedRequest),
  );
  if (!identityResult.ok) {
    return failure(sanitizedExternalObservationError(identityResult.error));
  }
  const identity = snapshotCurrentUser(identityResult.value);
  const workspaceResult = await invokeExternalObserver(() =>
    authenticated.value.getWorkspace(validatedRequest),
  );
  if (!workspaceResult.ok) {
    return failure(sanitizedExternalObservationError(workspaceResult.error));
  }
  const workspace = snapshotWorkspace(workspaceResult.value);
  if (workspace.name !== validatedRequest.target.plan.workspace) {
    return failure({
      kind: "schema",
      message: "OpenShell returned a workspace other than the explicitly configured workspace.",
    });
  }
  const inventoryResult = await invokeExternalObserver(() =>
    authenticated.value.listSandboxes(validatedRequest),
  );
  if (!inventoryResult.ok) {
    return failure(sanitizedExternalObservationError(inventoryResult.error));
  }
  const inventory = snapshotInventory(inventoryResult.value);

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      target: validatedRequest.target,
      health,
      identity,
      workspace,
      inventory,
    }),
  });
}
