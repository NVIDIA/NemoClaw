// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ContainerEngine,
  type ContainerEngineCommandCapture,
} from "../../adapters/container-engine";
import { prependInstalledUserLocalOpenshellPath } from "../openshell-pin";
import { getFutureShellPathHint } from "../remediation";
import { detectWslDockerDesktopStatus } from "../wsl-docker-desktop-gpu";
import { createDockerLlamaCppManagedLifecycle } from "./docker-llama-cpp-managed-lifecycle";
import {
  createDockerOperationAuthority,
  dockerOperationBindingSha256,
  dockerOperationCommandArguments,
  dockerOperationBridgeEnvironment,
} from "./docker-operation-authority";
import { createDockerLlamaCppPrivateBridgeController } from "./docker-llama-cpp-private-bridge";
import type {
  HostLocalInferenceCommandSpawner,
  HostLocalInferenceOperation,
} from "./host-local-inference";
import {
  deadlineBoundHostLocalInferenceEngine,
  deadlineBoundHostLocalInferenceSpawner,
} from "./host-local-inference";

export interface DockerLlamaCppOperationAuthority {
  readonly assertAuthority: () => void;
  readonly engine: ContainerEngine;
  readonly bridgeEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly spawn: HostLocalInferenceCommandSpawner;
}

function withManagedLlamaCppError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Docker operation ")) {
      throw new Error(error.message.replace(/^Docker operation /u, "Managed llama.cpp "));
    }
    if (error instanceof Error && error.message.startsWith("Docker context endpoint changed ")) {
      throw new Error(`Managed llama.cpp ${error.message}`);
    }
    throw error;
  }
}

function managedLlamaCppEngine(engine: ContainerEngine): ContainerEngine {
  return Object.freeze({
    operation: engine.operation,
    engineId: engine.engineId,
    displayName: engine.displayName,
    authorityId: engine.authorityId,
    capture: (args: readonly string[], timeoutMs?: number, input?: Buffer) =>
      withManagedLlamaCppError(() => engine.capture(args, timeoutMs, input)),
    captureHost: (args: readonly string[], timeoutMs?: number) =>
      withManagedLlamaCppError(() => engine.captureHost(args, timeoutMs)),
  });
}

/** Bind synchronous lifecycle commands and streamed acquisition to one qualified daemon. */
export function createDockerLlamaCppOperationAuthority(
  env: NodeJS.ProcessEnv = process.env,
  capture?: ContainerEngineCommandCapture,
  spawnCommand?: HostLocalInferenceCommandSpawner,
  deadlineMs?: number,
): DockerLlamaCppOperationAuthority {
  const operationEnv = { ...env };
  prependInstalledUserLocalOpenshellPath({
    env: operationEnv,
    getFutureShellPathHint,
  });
  const authority = withManagedLlamaCppError(() =>
    createDockerOperationAuthority("host-local-inference", operationEnv, capture, deadlineMs),
  );
  const assertAuthority = () => withManagedLlamaCppError(authority.assertAuthority);
  const boundedSpawnCommand =
    spawnCommand === undefined
      ? undefined
      : deadlineBoundHostLocalInferenceSpawner(spawnCommand, deadlineMs);
  return Object.freeze({
    assertAuthority,
    engine: managedLlamaCppEngine(authority.engine),
    bridgeEnvironment: dockerOperationBridgeEnvironment(authority),
    spawn: (args: readonly string[], options?: Parameters<HostLocalInferenceCommandSpawner>[1]) => {
      assertAuthority();
      return boundedSpawnCommand
        ? boundedSpawnCommand([...dockerOperationCommandArguments(authority, args)], options)
        : authority.spawn(args, options);
    },
  });
}

export function dockerLlamaCppBindingSha256(engine: ContainerEngine): string {
  return dockerOperationBindingSha256(engine);
}

export function createDockerLlamaCppHostLocalOperation(
  env: NodeJS.ProcessEnv = process.env,
  capture?: ContainerEngineCommandCapture,
  spawnCommand?: HostLocalInferenceCommandSpawner,
  createLifecycle: typeof createDockerLlamaCppManagedLifecycle = createDockerLlamaCppManagedLifecycle,
  deadlineMs?: number,
): HostLocalInferenceOperation {
  const authority = createDockerLlamaCppOperationAuthority(env, capture, spawnCommand, deadlineMs);
  const engine = deadlineBoundHostLocalInferenceEngine(authority.engine, deadlineMs);
  const spawn = deadlineBoundHostLocalInferenceSpawner(authority.spawn, deadlineMs);
  return Object.freeze({
    providerId: "docker",
    engine,
    bindingSha256: dockerLlamaCppBindingSha256(engine),
    assertAuthority: authority.assertAuthority,
    spawn,
    // Docker Desktop WSL isolates the VM loopback from the distro loopback, so
    // the bridge loopback proof runs from this CLI process instead of a
    // host-network probe container.
    createLlamaCppLifecycle: (
      input: Parameters<typeof createDockerLlamaCppManagedLifecycle>[0],
    ) => {
      const options = {
        ...dockerLlamaCppLifecycleOptions(input, engine, env),
        ...(deadlineMs === undefined ? {} : { engine }),
      };
      return options.bindings?.stdioForward
        ? createLifecycle(options, {
            privateBridge: createDockerLlamaCppPrivateBridgeController({
              dockerEnvironment: authority.bridgeEnvironment,
            }),
          })
        : createLifecycle(options);
    },
  });
}

function dockerLlamaCppLifecycleOptions(
  input: Parameters<typeof createDockerLlamaCppManagedLifecycle>[0],
  engine: ContainerEngine,
  env: NodeJS.ProcessEnv,
): Parameters<typeof createDockerLlamaCppManagedLifecycle>[0] {
  const desktop =
    detectWslDockerDesktopStatus({
      env,
      dockerInfoFormat: (format) => engine.capture(["info", "--format", format]).stdout,
    }) === "docker-desktop";
  return {
    ...input,
    ...(desktop ? { bindings: { ...input.bindings, stdioForward: true } } : {}),
    loopbackProbe: input.loopbackProbe ?? (desktop ? "host-process" : undefined),
  };
}

export function createManagedLlamaCppEngine(
  env: NodeJS.ProcessEnv = process.env,
  capture?: ContainerEngineCommandCapture,
): ContainerEngine {
  return createDockerLlamaCppHostLocalOperation(env, capture).engine;
}

/** Rebind an already injected Docker engine for read-only status inspection. */
export function createDockerLlamaCppInspectionOperation(
  engine: ContainerEngine,
  env: NodeJS.ProcessEnv = process.env,
  createLifecycle: typeof createDockerLlamaCppManagedLifecycle = createDockerLlamaCppManagedLifecycle,
): HostLocalInferenceOperation {
  if (engine.operation !== "host-local-inference" || engine.engineId !== "docker") {
    throw new Error("Managed llama.cpp inspection requires a Docker host-local-inference engine.");
  }
  return Object.freeze({
    providerId: "docker",
    engine,
    bindingSha256: dockerLlamaCppBindingSha256(engine),
    assertAuthority: () => undefined,
    spawn: () => {
      throw new Error("Managed llama.cpp inspection cannot spawn container-engine commands.");
    },
    createLlamaCppLifecycle: (input: Parameters<typeof createDockerLlamaCppManagedLifecycle>[0]) =>
      createLifecycle(dockerLlamaCppLifecycleOptions(input, engine, env)),
  });
}
