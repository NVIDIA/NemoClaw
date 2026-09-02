// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PodmanContainerEngine } from "../../adapters/podman";
import type {
  RuntimeProviderPrivilegedSandboxCommandInput,
  RuntimeProviderPrivilegedSandboxCommandResult,
  RuntimeProviderPrivilegedSandboxControl,
  RuntimeProviderPrivilegedSandboxTarget,
} from "./contract";
import { observePodmanManagedContainer } from "./podman-lifecycle";
import {
  DirectSandboxFallbackUnavailableError,
  PinnedSandboxResourceIdentityChangedError,
} from "./privileged-sandbox-control-errors";
import {
  clearStoppedSandboxStateWithEngine,
  sandboxStateResourceFromMounts,
  type StoppedSandboxStateObservation,
} from "./stopped-sandbox-state-cleanup";

const SANITIZED_PRIVILEGED_ENV = [
  "BASH_ENV=",
  "ENV=",
  "GCONV_PATH=",
  "GLIBC_TUNABLES=",
  "LD_AUDIT=",
  "LD_LIBRARY_PATH=",
  "LD_PRELOAD=",
  "LOCPATH=",
  "NODE_OPTIONS=",
  "PERL5OPT=",
  "PYTHONHOME=",
  "PYTHONINSPECT=",
  "PYTHONNOUSERSITE=1",
  "PYTHONPATH=",
  "PYTHONSTARTUP=",
  "PYTHONUSERBASE=",
  "RUBYOPT=",
] as const;

function resolveTarget(
  engine: PodmanContainerEngine,
  input: Pick<
    RuntimeProviderPrivilegedSandboxCommandInput,
    "registeredSandboxNames" | "sandbox" | "sandboxName"
  >,
): RuntimeProviderPrivilegedSandboxTarget {
  if (input.sandbox.name !== input.sandboxName) {
    throw new Error("Podman privileged control requires the registered sandbox identity.");
  }
  const container = observePodmanManagedContainer(engine, input.sandboxName);
  if (!container || !container.running || container.paused) {
    throw new DirectSandboxFallbackUnavailableError(
      `No running Podman runtime resource found for sandbox '${input.sandboxName}'.`,
    );
  }
  return Object.freeze({ providerId: "podman", resourceHandle: container.containerId });
}

function execute(
  engine: PodmanContainerEngine,
  input: RuntimeProviderPrivilegedSandboxCommandInput,
): RuntimeProviderPrivilegedSandboxCommandResult {
  const target = resolveTarget(engine, input);
  if (
    input.expectedResourceHandle !== undefined &&
    input.expectedResourceHandle !== target.resourceHandle
  ) {
    throw new PinnedSandboxResourceIdentityChangedError(input.sandboxName);
  }
  const environment = input.sanitizeEnvironment
    ? SANITIZED_PRIVILEGED_ENV.flatMap((value) => ["--env", value])
    : [];
  const result = engine.capture(
    [
      "container",
      "exec",
      ...(input.input ? ["--interactive"] : []),
      ...environment,
      "--user",
      "root",
      target.resourceHandle,
      ...input.command,
    ],
    input.timeoutMs,
    input.input,
  );
  return Object.freeze({
    status: result.status,
    signal: null,
    stdout: Buffer.from(result.stdout, "utf8"),
    stderr: Buffer.from(result.stderr, "utf8"),
    ...(result.error ? { error: result.error } : {}),
  });
}

function observeStoppedTarget(
  engine: PodmanContainerEngine,
  input: Parameters<
    NonNullable<RuntimeProviderPrivilegedSandboxControl["clearStoppedStateRoots"]>
  >[0],
): StoppedSandboxStateObservation {
  let container: ReturnType<typeof observePodmanManagedContainer>;
  try {
    container = observePodmanManagedContainer(engine, input.sandboxName);
  } catch {
    return { failure: "runtime-discovery-failed" };
  }
  if (!container) return { failure: "no-eligible-stopped-runtime" };
  const stateResource = sandboxStateResourceFromMounts(container.inspect.Mounts, input.paths);
  return stateResource
    ? {
        target: {
          resourceHandle: container.containerId,
          running: container.running,
          stateResource,
        },
      }
    : { failure: "state-resource-unavailable" };
}

export function createPodmanPrivilegedSandboxControl(
  engine: PodmanContainerEngine,
  cleanupEngine?: PodmanContainerEngine,
): RuntimeProviderPrivilegedSandboxControl {
  if (engine.operation !== "sandbox-lifecycle" || engine.engineId !== "podman") {
    throw new Error("Podman privileged control requires its sandbox-lifecycle engine.");
  }
  if (
    cleanupEngine &&
    (cleanupEngine.operation !== "workload-cleanup" || cleanupEngine.engineId !== "podman")
  ) {
    throw new Error("Podman stopped-state cleanup requires its workload-cleanup engine.");
  }
  return Object.freeze({
    resolveTarget: (
      input: Pick<
        RuntimeProviderPrivilegedSandboxCommandInput,
        "registeredSandboxNames" | "sandbox" | "sandboxName"
      >,
    ) => resolveTarget(engine, input),
    execute: (input: RuntimeProviderPrivilegedSandboxCommandInput) => execute(engine, input),
    ...(cleanupEngine
      ? {
          clearStoppedStateRoots: (
            input: Parameters<
              NonNullable<RuntimeProviderPrivilegedSandboxControl["clearStoppedStateRoots"]>
            >[0],
          ) =>
            clearStoppedSandboxStateWithEngine(input.sandboxName, input.paths, {
              capture: (args, timeoutMs = 30_000) => cleanupEngine.capture(args, timeoutMs),
              observe: () => observeStoppedTarget(engine, input),
            }),
        }
      : {}),
  });
}
