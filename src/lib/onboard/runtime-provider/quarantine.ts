// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { SandboxRecreateObserver } from "../sandbox-recreate-probe";
import {
  RUNTIME_PROVIDER_QUARANTINE_CONTRACT_VERSION,
  type RuntimeProviderCommandCapture,
  type RuntimeProviderQuarantineAuthority,
  type RuntimeProviderQuarantineInput,
  type RuntimeProviderQuarantineObservation,
  type RuntimeProviderQuarantineStepResult,
  type RuntimeProviderQuarantineSurface,
} from "./contract";
import {
  observeDockerRuntimeSnapshot,
  type DockerRuntimeSnapshotDependencies,
  type RuntimeProviderSnapshotObservation,
} from "./snapshot";

const DOCKER_OPERATION_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DOCKER_CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;

type DockerStop = (
  containerId: string,
  options?: { readonly ignoreError?: boolean; readonly timeout?: number },
) => { readonly status?: number | null };

export interface DockerRuntimeQuarantineDependencies {
  readonly captureHostCommand: (
    command: string,
    args: string[],
    timeout?: number,
  ) => RuntimeProviderCommandCapture;
  readonly queryRuntimeSnapshot: DockerRuntimeSnapshotDependencies["queryRuntimeSnapshot"];
  readonly stopContainer: DockerStop;
  readonly observeSandbox?: SandboxRecreateObserver;
}

function defaultSandboxObserver(): SandboxRecreateObserver {
  return (
    require("../sandbox-recreate-probe") as {
      observeSandboxOnGateway: SandboxRecreateObserver;
    }
  ).observeSandboxOnGateway;
}

function providerHandle(
  providerId: string,
  observation: RuntimeProviderSnapshotObservation,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        providerId,
        lifecycleState: observation.lifecycleState,
        lifecycleGeneration: observation.lifecycleGeneration,
        runtime: observation.runtime,
      }),
      "utf8",
    )
    .digest("hex");
}

function assertInputAuthority(input: RuntimeProviderQuarantineInput): void {
  if (
    input.sandbox.name !== input.sandboxName ||
    input.sandbox.lifecycleGeneration !== input.lifecycleGeneration ||
    input.sandbox.lifecycleLiveIdentityFingerprint !== input.liveIdentityFingerprint ||
    input.sandbox.gatewayName !== input.gatewayName ||
    input.sandbox.gatewayPort !== input.gatewayPort
  ) {
    throw new Error("Quarantine registry and gateway authority changed before provider prepare");
  }
}

function sameAuthority(
  input: RuntimeProviderQuarantineInput,
  value: RuntimeProviderQuarantineAuthority,
  providerId: string,
): boolean {
  return (
    value.schemaVersion === 1 &&
    value.providerId === providerId &&
    value.sandboxName === input.sandboxName &&
    value.gatewayName === input.gatewayName &&
    value.gatewayPort === input.gatewayPort &&
    value.lifecycleGeneration === input.lifecycleGeneration &&
    value.liveIdentityFingerprint === input.liveIdentityFingerprint &&
    SHA256_PATTERN.test(value.providerHandle) &&
    value.providerLifecycleGeneration.length > 0 &&
    value.runtime.kind === "docker-container" &&
    DOCKER_CONTAINER_ID_PATTERN.test(value.runtime.handle)
  );
}

function observeRuntime(
  input: RuntimeProviderQuarantineInput,
  providerId: string,
  deps: DockerRuntimeQuarantineDependencies,
): RuntimeProviderSnapshotObservation {
  return observeDockerRuntimeSnapshot(input.sandbox, providerId, {
    captureHostCommand: deps.captureHostCommand,
    queryRuntimeSnapshot: deps.queryRuntimeSnapshot,
  });
}

function assertPreparedRuntimeUnchanged(
  observed: RuntimeProviderSnapshotObservation,
  authority: RuntimeProviderQuarantineAuthority,
  providerId: string,
): void {
  if (
    observed.runtime.runtime.kind !== authority.runtime.kind ||
    observed.runtime.runtime.handle !== authority.runtime.handle ||
    observed.lifecycleGeneration !== authority.providerLifecycleGeneration ||
    providerHandle(providerId, observed) !== authority.providerHandle
  ) {
    throw new Error("Quarantine runtime authority changed before stop");
  }
}

function sameExactRuntime(
  observed: RuntimeProviderSnapshotObservation,
  authority: RuntimeProviderQuarantineAuthority,
): boolean {
  return (
    observed.runtime.runtime.kind === authority.runtime.kind &&
    observed.runtime.runtime.handle === authority.runtime.handle
  );
}

function assertPreparedGatewayUnchanged(
  authority: RuntimeProviderQuarantineAuthority,
  deps: DockerRuntimeQuarantineDependencies,
): void {
  const observed = (deps.observeSandbox ?? defaultSandboxObserver())({
    sandboxName: authority.sandboxName,
    gatewayName: authority.gatewayName,
    gatewayPort: authority.gatewayPort,
  });
  if (
    observed.state === "missing" ||
    observed.liveIdentityFingerprint !== authority.liveIdentityFingerprint
  ) {
    throw new Error("Quarantine OpenShell authority changed before stop");
  }
}

function prepareDockerQuarantine(
  input: RuntimeProviderQuarantineInput,
  providerId: string,
  deps: DockerRuntimeQuarantineDependencies,
): RuntimeProviderQuarantineAuthority {
  assertInputAuthority(input);
  const access = (deps.observeSandbox ?? defaultSandboxObserver())({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
  });
  if (
    access.state === "missing" ||
    access.liveIdentityFingerprint !== input.liveIdentityFingerprint
  ) {
    throw new Error("Quarantine OpenShell authority is missing, stale, or replaced");
  }
  const observed = observeRuntime(input, providerId, deps);
  return {
    schemaVersion: 1,
    providerId,
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    lifecycleGeneration: input.lifecycleGeneration,
    liveIdentityFingerprint: input.liveIdentityFingerprint,
    providerHandle: providerHandle(providerId, observed),
    providerLifecycleGeneration: observed.lifecycleGeneration,
    runtime: { ...observed.runtime.runtime },
  };
}

function stopExactDockerQuarantineRuntime(
  input: RuntimeProviderQuarantineInput,
  authority: RuntimeProviderQuarantineAuthority,
  providerId: string,
  deps: DockerRuntimeQuarantineDependencies,
): RuntimeProviderQuarantineStepResult {
  try {
    assertInputAuthority(input);
    if (!sameAuthority(input, authority, providerId)) {
      throw new Error("Quarantine stop received invalid runtime authority");
    }
    assertPreparedGatewayUnchanged(authority, deps);
    const observed = observeRuntime(input, providerId, deps);
    if (!sameExactRuntime(observed, authority)) {
      throw new Error("Quarantine runtime identity changed before stop");
    }
    // A retry after our first stop observes the same immutable container in a
    // stopped state with a different state generation. That is a successful
    // no-op. Any still-running target must match the complete pre-stop
    // authority before we mutate it.
    if (observed.lifecycleState === "stopped") return { outcome: "succeeded" };
    assertPreparedRuntimeUnchanged(observed, authority, providerId);
    const result = deps.stopContainer(authority.runtime.handle, {
      ignoreError: true,
      timeout: DOCKER_OPERATION_TIMEOUT_MS,
    });
    return result.status === 0
      ? { outcome: "succeeded" }
      : {
          outcome: "failed",
          detail: "The exact Docker stop did not complete successfully; no retry was attempted.",
        };
  } catch {
    return {
      outcome: "failed",
      detail: "The exact Docker runtime was missing, ambiguous, replaced, or changed before stop.",
    };
  }
}

function observeDockerQuarantine(
  input: RuntimeProviderQuarantineInput,
  authority: RuntimeProviderQuarantineAuthority,
  providerId: string,
  deps: DockerRuntimeQuarantineDependencies,
): RuntimeProviderQuarantineObservation {
  let execution: RuntimeProviderQuarantineStepResult;
  try {
    if (!sameAuthority(input, authority, providerId)) {
      throw new Error("invalid authority");
    }
    const observed = observeRuntime(input, providerId, deps);
    const sameRuntime =
      observed.runtime.runtime.kind === authority.runtime.kind &&
      observed.runtime.runtime.handle === authority.runtime.handle;
    execution =
      sameRuntime && observed.lifecycleState === "stopped"
        ? { outcome: "succeeded" }
        : {
            outcome: "failed",
            detail: sameRuntime
              ? "The exact runtime is not stopped."
              : "The runtime identity changed after the stop attempt.",
          };
  } catch {
    execution = {
      outcome: "inconclusive",
      detail: "The exact runtime state could not be independently observed.",
    };
  }

  let sandboxAccess: RuntimeProviderQuarantineStepResult;
  try {
    const observed = (deps.observeSandbox ?? defaultSandboxObserver())({
      sandboxName: authority.sandboxName,
      gatewayName: authority.gatewayName,
      gatewayPort: authority.gatewayPort,
    });
    const exact = observed.liveIdentityFingerprint === authority.liveIdentityFingerprint;
    sandboxAccess =
      exact && observed.state === "not_ready"
        ? { outcome: "succeeded" }
        : observed.state === "missing"
          ? {
              outcome: "inconclusive",
              detail: "The owner gateway no longer reports the exact sandbox identity.",
            }
          : {
              outcome: "failed",
              detail: exact
                ? "The owner gateway still reports sandbox access as ready."
                : "The owner gateway reports a replaced sandbox identity.",
            };
  } catch {
    sandboxAccess = {
      outcome: "inconclusive",
      detail: "Sandbox access could not be independently observed.",
    };
  }
  return { execution, sandboxAccess };
}

/** Docker/OpenShell quarantine owns exact prepare, one-shot stop, and independent observation. */
export function createDockerRuntimeProviderQuarantineSurface(
  providerId: string,
  deps: DockerRuntimeQuarantineDependencies,
): RuntimeProviderQuarantineSurface {
  return {
    providerId,
    supported: true,
    contractVersion: RUNTIME_PROVIDER_QUARANTINE_CONTRACT_VERSION,
    prepare: (input) => prepareDockerQuarantine(input, providerId, deps),
    stop: (input, authority) =>
      stopExactDockerQuarantineRuntime(input, authority, providerId, deps),
    observe: (input, authority) => observeDockerQuarantine(input, authority, providerId, deps),
  };
}
