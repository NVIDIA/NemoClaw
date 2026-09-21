// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenShellForwardLocalHost = "127.0.0.1" | "0.0.0.0";

/** The sandbox target is always 127.0.0.1 on the same port. */
export type OpenShellForwardIdentity = Readonly<{
  gatewayEndpoint: string;
  gatewayName: string;
  workspace: string;
  sandboxName: string;
  localHost: OpenShellForwardLocalHost;
  port: number;
}>;

/** Messages are fixed and contain no command output or process details. */
export type OpenShellForwardValidationError = Readonly<{
  kind: "validation";
  message: "The OpenShell forward request is invalid.";
}>;

export type OpenShellForwardRuntimeError =
  | Readonly<{
      kind: "authority";
      message: "NemoClaw could not prove current OpenShell forward authority.";
    }>
  | Readonly<{
      kind: "authentication";
      message: "OpenShell authentication failed.";
    }>
  | Readonly<{
      kind: "schema";
      message: "OpenShell returned an invalid forward response.";
    }>
  | Readonly<{
      kind: "timeout";
      message: "The OpenShell forward operation timed out.";
    }>
  | Readonly<{
      kind: "transport";
      message: "The OpenShell forward transport failed.";
    }>
  | Readonly<{
      kind: "command";
      message: "The OpenShell forward command failed.";
    }>
  | Readonly<{
      kind: "ownership";
      message: "NemoClaw could not prove OpenShell forward ownership.";
    }>
  | Readonly<{
      kind: "cleanup";
      message: "NemoClaw could not prove OpenShell forward cleanup.";
    }>;

export type OpenShellForwardError = OpenShellForwardValidationError | OpenShellForwardRuntimeError;

/** Fixed, non-sensitive classification for a direct-forward startup failure. */
export type OpenShellForwardStartFailure =
  | Readonly<{
      stage: "spawn";
      reason:
        | "invocation_failed"
        | "executable_not_found"
        | "permission_denied"
        | "child_error"
        | "listener_registration_failed"
        | "invalid_child_identity";
    }>
  | Readonly<{
      stage: "startup";
      reason: "child_exited";
      exitStatus?: number;
    }>
  | Readonly<{
      stage: "startup";
      reason: "child_signaled";
      signal?: "SIGABRT" | "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGPIPE" | "SIGTERM";
    }>
  | Readonly<{
      stage: "reachability";
      reason: "probe_failed";
    }>;

/** Format a fixed, non-sensitive direct-forward startup classification. */
export function formatOpenShellForwardStartFailure(failure: OpenShellForwardStartFailure): string {
  let failureValue = "";
  if (failure.reason === "child_exited" && failure.exitStatus !== undefined) {
    failureValue = ` status=${String(failure.exitStatus)}`;
  }
  if (failure.reason === "child_signaled" && failure.signal) {
    failureValue = ` signal=${failure.signal}`;
  }
  return `forward-start ${failure.stage}/${failure.reason}${failureValue}`;
}

type OpenShellOwnedForward = Readonly<{
  state: "owned";
  forward: OpenShellForwardIdentity;
}>;

type OpenShellAbsentForward = Readonly<{
  state: "absent";
  forward: OpenShellForwardIdentity;
}>;

type OpenShellStaleForward = Readonly<{
  state: "stale";
  forward: OpenShellForwardIdentity;
}>;

type OpenShellForeignForward = Readonly<{
  state: "foreign";
  forward: OpenShellForwardIdentity;
}>;

type OpenShellIndeterminateForward = Readonly<{
  state: "indeterminate";
  forward: OpenShellForwardIdentity;
  error: OpenShellForwardRuntimeError;
}>;

type OpenShellInvalidForwardRequest = Readonly<{
  state: "indeterminate";
  error: OpenShellForwardValidationError;
}>;

export type OpenShellForwardObservation =
  | OpenShellOwnedForward
  | OpenShellAbsentForward
  | OpenShellStaleForward
  | OpenShellForeignForward
  | OpenShellIndeterminateForward
  | OpenShellInvalidForwardRequest;

export type OpenShellForwardStartResult =
  | Readonly<{
      state: "started";
      forward: OpenShellForwardIdentity;
      cleanup(request?: {
        timeoutMs?: number;
        assertCurrent?: () => Promise<void>;
      }): Promise<OpenShellForwardReleaseResult>;
    }>
  | Readonly<{ state: "reused"; forward: OpenShellForwardIdentity }>
  | Readonly<{
      state: "refused";
      observation: OpenShellStaleForward | OpenShellForeignForward | OpenShellIndeterminateForward;
    }>
  | Readonly<{
      state: "failed";
      forward: OpenShellForwardIdentity;
      effect: "none";
      error: OpenShellForwardRuntimeError;
      failure?: OpenShellForwardStartFailure;
    }>
  | Readonly<{
      state: "failed";
      effect: "none";
      error: OpenShellForwardValidationError;
    }>
  | Readonly<{
      state: "cleanup_uncertain";
      forward: OpenShellForwardIdentity;
      effect: "possible";
      error: OpenShellForwardRuntimeError;
      failure?: OpenShellForwardStartFailure;
    }>;

export type OpenShellLegacyForwardRetirementResult =
  | Readonly<{ state: "retired"; forward: OpenShellForwardIdentity }>
  | Readonly<{
      state: "not_needed";
      observation: OpenShellOwnedForward | OpenShellAbsentForward;
    }>
  | Readonly<{
      state: "refused";
      observation: OpenShellForeignForward | OpenShellIndeterminateForward;
    }>
  | Readonly<{
      state: "failed";
      forward: OpenShellForwardIdentity;
      effect: "none";
      error: OpenShellForwardRuntimeError;
    }>
  | Readonly<{
      state: "failed";
      effect: "none";
      error: OpenShellForwardValidationError;
    }>
  | Readonly<{
      state: "mutation_uncertain";
      forward: OpenShellForwardIdentity;
      effect: "possible";
      error: OpenShellForwardRuntimeError;
    }>
  | Readonly<{
      state: "release_unproved";
      forward: OpenShellForwardIdentity;
      effect: "possible";
      error: OpenShellForwardRuntimeError;
    }>;

export type OpenShellForwardReleaseResult =
  | Readonly<{ state: "released" }>
  | Readonly<{ state: "bound"; forwards: readonly OpenShellForwardIdentity[] }>
  | Readonly<{
      state: "indeterminate";
      forwards: readonly OpenShellForwardIdentity[];
      error: OpenShellForwardRuntimeError;
    }>
  | Readonly<{
      state: "indeterminate";
      error: OpenShellForwardValidationError;
    }>;

export type ObserveOpenShellForwardsRequest = Readonly<{
  forwards: readonly OpenShellForwardIdentity[];
  /** Require the listener on each keyed port to have this exact process identity. */
  expectedListenerPidsByPort?: ReadonlyMap<number, number>;
  timeoutMs?: number;
  assertCurrent?: () => Promise<void>;
}>;

export type StartOpenShellForwardRequest = Readonly<{
  forward: OpenShellForwardIdentity;
  timeoutMs?: number;
  assertCurrent?: () => Promise<void>;
}>;

export type RetireLegacyOpenShellForwardRequest = Readonly<{
  forward: OpenShellForwardIdentity;
  timeoutMs?: number;
  assertCurrent?: () => Promise<void>;
  authorize: (forward: OpenShellForwardIdentity) => Promise<void>;
}>;

export type VerifyOpenShellForwardReleaseRequest = Readonly<{
  forwards: readonly OpenShellForwardIdentity[];
  timeoutMs?: number;
  assertCurrent?: () => Promise<void>;
}>;

/** Transport-neutral forwarding operations used by NemoClaw consumers. */
export interface OpenShellForwardAdapter {
  observeForwards(
    request: ObserveOpenShellForwardsRequest,
  ): Promise<readonly OpenShellForwardObservation[]>;

  startForward(request: StartOpenShellForwardRequest): Promise<OpenShellForwardStartResult>;

  retireLegacyForward(
    request: RetireLegacyOpenShellForwardRequest,
  ): Promise<OpenShellLegacyForwardRetirementResult>;

  verifyForwardRelease(
    request: VerifyOpenShellForwardReleaseRequest,
  ): Promise<OpenShellForwardReleaseResult>;
}
