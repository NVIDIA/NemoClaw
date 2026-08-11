// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ContainerEngine,
  type ContainerEngineCommandCapture,
} from "../../adapters/container-engine";
import {
  createDockerLlamaCppManagedLifecycle,
  type DockerLlamaCppManagedLifecycle,
} from "./docker-llama-cpp-managed-lifecycle";
import {
  createDockerOperationAuthority,
  dockerOperationBindingSha256,
  dockerOperationCommandArguments,
} from "./docker-operation-authority";
import type {
  HostLocalInferenceCommandSpawner,
  HostLocalInferenceOperation,
} from "./host-local-inference";

export interface DockerLlamaCppOperationAuthority {
  readonly assertAuthority: () => void;
  readonly engine: ContainerEngine;
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
): DockerLlamaCppOperationAuthority {
  const authority = withManagedLlamaCppError(() =>
    createDockerOperationAuthority("host-local-inference", env, capture),
  );
  const assertAuthority = () => withManagedLlamaCppError(authority.assertAuthority);
  return Object.freeze({
    assertAuthority,
    engine: managedLlamaCppEngine(authority.engine),
    spawn: (args: readonly string[], options?: Parameters<HostLocalInferenceCommandSpawner>[1]) => {
      assertAuthority();
      return spawnCommand
        ? spawnCommand([...dockerOperationCommandArguments(authority, args)], options)
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
  createLifecycle: (
    input: Parameters<typeof createDockerLlamaCppManagedLifecycle>[0],
  ) => DockerLlamaCppManagedLifecycle = createDockerLlamaCppManagedLifecycle,
): HostLocalInferenceOperation {
  const authority = createDockerLlamaCppOperationAuthority(env, capture, spawnCommand);
  return Object.freeze({
    providerId: "docker",
    engine: authority.engine,
    bindingSha256: dockerLlamaCppBindingSha256(authority.engine),
    assertAuthority: authority.assertAuthority,
    spawn: authority.spawn,
    createLlamaCppLifecycle: createLifecycle,
  });
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
    createLlamaCppLifecycle: createDockerLlamaCppManagedLifecycle,
  });
}
