// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  type ContainerEngine,
  type ContainerEngineCommandCapture,
  createContainerEngineCommand,
} from "../../adapters/container-engine";
import { dockerSpawn } from "../../adapters/docker/exec";
import {
  createDockerLlamaCppManagedLifecycle,
  type DockerLlamaCppManagedLifecycle,
} from "./docker-llama-cpp-managed-lifecycle";
import type {
  HostLocalInferenceCommandSpawner,
  HostLocalInferenceOperation,
} from "./host-local-inference";

interface DockerClientBinding {
  readonly endpointArgs: readonly string[];
  readonly identity: string;
  readonly guard?: () => void;
}

export interface DockerLlamaCppOperationAuthority {
  readonly assertAuthority: () => void;
  readonly engine: ContainerEngine;
  readonly spawn: HostLocalInferenceCommandSpawner;
}

const DOCKER_CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const DOCKER_HOST_PATTERN = /^(?:npipe|ssh|tcp|unix):\/\/[^\s\u0000-\u001f\u007f]+$/u;
const DOCKER_ARGUMENT_MAX_BYTES = 16 * 1024;
const DOCKER_CONTEXT_INSPECT_FORMAT = "{{json .}}";

function exactDockerValue(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > DOCKER_ARGUMENT_MAX_BYTES ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`Managed llama.cpp ${label} is invalid.`);
  }
  return value;
}

function absoluteDockerPath(value: string, label: string): string {
  const candidate = exactDockerValue(value, label);
  if (!candidate) throw new Error(`Managed llama.cpp ${label} is invalid.`);
  return path.resolve(candidate);
}

function dockerConfigPath(env: NodeJS.ProcessEnv): string {
  const configured = exactDockerValue(env.DOCKER_CONFIG, "DOCKER_CONFIG");
  if (configured) return path.resolve(configured);
  const home = exactDockerValue(env.HOME, "HOME") ?? os.homedir();
  return path.join(path.resolve(home), ".docker");
}

function dockerTlsArgs(env: NodeJS.ProcessEnv): {
  readonly args: readonly string[];
  readonly verify: boolean;
} {
  const tls = exactDockerValue(env.DOCKER_TLS, "DOCKER_TLS") !== undefined;
  const tlsVerify = exactDockerValue(env.DOCKER_TLS_VERIFY, "DOCKER_TLS_VERIFY") !== undefined;
  const certPath = exactDockerValue(env.DOCKER_CERT_PATH, "DOCKER_CERT_PATH");
  const args: string[] = [];
  if (tlsVerify) args.push("--tlsverify");
  else if (tls) args.push("--tls");
  if (certPath) {
    const directory = absoluteDockerPath(certPath, "DOCKER_CERT_PATH");
    args.push(
      "--tlscacert",
      path.join(directory, "ca.pem"),
      "--tlscert",
      path.join(directory, "cert.pem"),
      "--tlskey",
      path.join(directory, "key.pem"),
    );
  }
  return Object.freeze({ args: Object.freeze(args), verify: tlsVerify });
}

function dockerContextName(value: string, label: string): string {
  const context = exactDockerValue(value, label);
  if (!context || !DOCKER_CONTEXT_PATTERN.test(context)) {
    throw new Error(`Managed llama.cpp ${label} is invalid.`);
  }
  return context;
}

function dockerHost(value: string): string {
  const host = exactDockerValue(value, "DOCKER_HOST");
  if (!host || !DOCKER_HOST_PATTERN.test(host)) {
    throw new Error("Managed llama.cpp DOCKER_HOST is invalid.");
  }
  return host;
}

function requireSecureDockerEndpoint(host: string, tlsVerificationEnabled: boolean): void {
  if (host.startsWith("tcp://") && !tlsVerificationEnabled) {
    throw new Error("Managed llama.cpp requires verified TLS for remote Docker TCP endpoints.");
  }
}

function dockerBindingProbe(
  endpointArgs: readonly string[],
  capture?: ContainerEngineCommandCapture,
): ContainerEngine {
  return createContainerEngineCommand({
    operation: "host-local-inference",
    engineId: "docker",
    displayName: "Docker",
    authorityId: "docker:qualification",
    executable: "docker",
    endpointArgs,
    ...(capture ? { capture } : {}),
  });
}

function requireDockerProbeOutput(
  result: ReturnType<ContainerEngine["capture"]>,
  label: string,
): string {
  if (result.error || result.status !== 0) {
    throw new Error(`Managed llama.cpp could not ${label}.`);
  }
  const output = result.stdout.trim();
  if (!output) throw new Error(`Managed llama.cpp could not ${label}.`);
  return output;
}

function resolvedDockerContextEndpoint(probe: ContainerEngine, context: string): string {
  const output = requireDockerProbeOutput(
    probe.capture(["context", "inspect", context, "--format", DOCKER_CONTEXT_INSPECT_FORMAT]),
    "qualify the Docker context endpoint",
  );
  let endpoint: unknown;
  try {
    endpoint = JSON.parse(output);
  } catch {
    throw new Error("Managed llama.cpp Docker context endpoint is unreadable.");
  }
  if (typeof endpoint !== "object" || endpoint === null) {
    throw new Error("Managed llama.cpp Docker context endpoint is invalid.");
  }
  const inspection = endpoint as {
    Endpoints?: { docker?: { Host?: unknown; SkipTLSVerify?: unknown } };
    TLSMaterial?: { docker?: unknown };
  };
  const dockerEndpoint = inspection.Endpoints?.docker;
  if (
    typeof dockerEndpoint?.Host !== "string" ||
    typeof dockerEndpoint.SkipTLSVerify !== "boolean"
  ) {
    throw new Error("Managed llama.cpp Docker context endpoint is invalid.");
  }
  const host = dockerHost(dockerEndpoint.Host);
  const tlsMaterial = inspection.TLSMaterial?.docker ?? [];
  if (
    !Array.isArray(tlsMaterial) ||
    tlsMaterial.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9._-]+$/u.test(entry))
  ) {
    throw new Error("Managed llama.cpp Docker context TLS material is invalid.");
  }
  const tlsFiles = [...tlsMaterial].sort();
  requireSecureDockerEndpoint(host, !dockerEndpoint.SkipTLSVerify && tlsFiles.includes("ca.pem"));
  return JSON.stringify({
    host,
    skipTlsVerify: dockerEndpoint.SkipTLSVerify,
    tlsMaterial: tlsFiles,
  });
}

function dockerClientBinding(
  env: NodeJS.ProcessEnv,
  capture?: ContainerEngineCommandCapture,
): DockerClientBinding {
  const configArgs = ["--config", dockerConfigPath(env)] as const;
  const tls = dockerTlsArgs(env);
  const explicitContext = exactDockerValue(env.DOCKER_CONTEXT, "DOCKER_CONTEXT");
  const explicitHost = exactDockerValue(env.DOCKER_HOST, "DOCKER_HOST");
  if (!explicitContext && explicitHost) {
    const host = dockerHost(explicitHost);
    requireSecureDockerEndpoint(host, tls.verify);
    const endpointArgs = Object.freeze([...configArgs, "--host", host, ...tls.args]);
    return {
      endpointArgs,
      identity: createHash("sha256").update(JSON.stringify(endpointArgs)).digest("hex"),
    };
  }

  let context: string;
  if (explicitContext) {
    context = dockerContextName(explicitContext, "DOCKER_CONTEXT");
  } else {
    const selectorProbe = dockerBindingProbe([...configArgs, ...tls.args], capture);
    context = dockerContextName(
      requireDockerProbeOutput(
        selectorProbe.capture(["context", "show"]),
        "resolve the Docker context",
      ),
      "current Docker context",
    );
  }
  const endpointArgs = Object.freeze([...configArgs, "--context", context, ...tls.args]);
  const endpointProbe = dockerBindingProbe(endpointArgs, capture);
  const qualifiedEndpoint = resolvedDockerContextEndpoint(endpointProbe, context);
  const identity = createHash("sha256")
    .update(JSON.stringify({ endpointArgs, qualifiedEndpoint }))
    .digest("hex");
  return {
    endpointArgs,
    identity,
    guard: () => {
      if (resolvedDockerContextEndpoint(endpointProbe, context) !== qualifiedEndpoint) {
        throw new Error(
          "Managed llama.cpp Docker context endpoint changed after qualification; retry the operation.",
        );
      }
    },
  };
}

/** Bind synchronous lifecycle commands and streamed acquisition to one qualified daemon. */
export function createDockerLlamaCppOperationAuthority(
  env: NodeJS.ProcessEnv = process.env,
  capture?: ContainerEngineCommandCapture,
  spawnCommand: HostLocalInferenceCommandSpawner = dockerSpawn,
): DockerLlamaCppOperationAuthority {
  const binding = dockerClientBinding(env, capture);
  const assertAuthority = () => binding.guard?.();
  const engine = createContainerEngineCommand({
    operation: "host-local-inference",
    engineId: "docker",
    displayName: "Docker",
    authorityId: `docker:${binding.identity}`,
    executable: "docker",
    endpointArgs: binding.endpointArgs,
    ...(capture ? { capture } : {}),
    ...(binding.guard ? { guard: binding.guard } : {}),
  });
  return Object.freeze({
    assertAuthority,
    engine,
    spawn: (args: readonly string[], options?: Parameters<HostLocalInferenceCommandSpawner>[1]) => {
      assertAuthority();
      return spawnCommand([...binding.endpointArgs, ...args], options);
    },
  });
}

export function dockerLlamaCppBindingSha256(engine: ContainerEngine): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: engine.operation,
        engineId: engine.engineId,
        authorityId: engine.authorityId,
        executable: "docker",
      }),
    )
    .digest("hex");
}

export function createDockerLlamaCppHostLocalOperation(
  env: NodeJS.ProcessEnv = process.env,
  capture?: ContainerEngineCommandCapture,
  spawnCommand: HostLocalInferenceCommandSpawner = dockerSpawn,
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
