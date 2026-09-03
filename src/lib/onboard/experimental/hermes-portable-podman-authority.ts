// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  assertPodmanExecutableMetadataAuthority,
  capturePodmanExecutableAuthority,
  createPodmanContainerEngine,
  createPodmanExecutableOperationProof,
  resolvePodmanExecutablePath,
  type PodmanBoundContainerEngine,
  type PodmanExecutableAuthority,
  type PodmanExecutableAuthorityDeps,
  type PodmanExecutableOperationProof,
  type PodmanSocketAuthority,
  type PodmanSocketAuthorityDeps,
} from "../../adapters/podman";
import type { ContainerEngineCommandCapture } from "../../adapters/container-engine";
import type { ContainerEngineOperationScope } from "../../adapters/container-engine";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { parsePortableRuntimeAuthority } from "../../state/onboard/portable-runtime-authority";
import { qualifyPodmanEndpointHost } from "../runtime-provider/podman-preflight";
import { buildHermesPortablePodmanEnvironment } from "./hermes-portable-container";

export const HERMES_PORTABLE_PODMAN_VERSION = "5.7.0" as const;
const HERMES_PORTABLE_PODMAN_NETWORK_BACKEND = "netavark";

export interface HermesPortablePodmanExecutableAuthority {
  readonly version: typeof HERMES_PORTABLE_PODMAN_VERSION;
  readonly executable: PodmanExecutableAuthority;
}

export interface HermesPortablePodmanAuthorityDeps {
  readonly capture?: ContainerEngineCommandCapture;
  readonly socketAuthorityDeps?: PodmanSocketAuthorityDeps;
  readonly executableAuthorityDeps?: PodmanExecutableAuthorityDeps;
  readonly assertSocketAuthority?: (
    expected: PodmanSocketAuthority,
    deps?: PodmanSocketAuthorityDeps,
  ) => void;
  readonly resolveExecutablePath?: (env: NodeJS.ProcessEnv) => string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly uid?: number;
}

export interface HermesPortablePodmanCommandAuthority {
  readonly engine: PodmanBoundContainerEngine;
  readonly assertTransactionCurrent: () => void;
  readonly assertCurrent: () => void;
}

export interface HermesPortablePodmanOperationEngines {
  readonly hostDoctor: PodmanBoundContainerEngine;
  readonly hostLocalInference: PodmanBoundContainerEngine;
  readonly sandboxLifecycle: PodmanBoundContainerEngine;
  readonly assertTransactionCurrent: () => void;
  readonly assertCurrent: () => void;
}

function fail(message: string): never {
  throw new Error(`Hermes portable Podman authority ${message}`);
}

function currentUid(configured: number | undefined): number {
  const uid = configured ?? (typeof process.getuid === "function" ? process.getuid() : Number.NaN);
  if (!Number.isSafeInteger(uid) || uid < 0) fail("requires the current Unix user ID");
  return uid;
}

function requireRuntimeAuthority(
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
  socketAuthority: PodmanSocketAuthority,
  deps: HermesPortablePodmanAuthorityDeps,
): void {
  const parsed = parsePortableRuntimeAuthority(runtimeAuthority);
  if (
    !parsed ||
    !isDeepStrictEqual(parsed, runtimeAuthority) ||
    parsed.uid !== currentUid(deps.uid) ||
    parsed.socketPath !== socketAuthority.socketPath
  ) {
    fail("runtime or socket identity disagrees with current-user receipt authority");
  }
}

function requireExpectedAuthority(authority: HermesPortablePodmanExecutableAuthority): void {
  if (
    authority.version !== HERMES_PORTABLE_PODMAN_VERSION ||
    !authority.executable ||
    typeof authority.executable !== "object"
  ) {
    fail(`requires exact Podman ${HERMES_PORTABLE_PODMAN_VERSION} authority`);
  }
}

function requireResolvedExecutable(
  authority: HermesPortablePodmanExecutableAuthority,
  sourceEnv: NodeJS.ProcessEnv,
  deps: HermesPortablePodmanAuthorityDeps,
): void {
  const resolved = (deps.resolveExecutablePath ?? resolvePodmanExecutablePath)(sourceEnv);
  if (resolved !== authority.executable.executablePath) {
    fail("PATH resolves another Podman executable");
  }
}

function qualifyExactMatrix(
  engine: PodmanBoundContainerEngine,
  deps: HermesPortablePodmanAuthorityDeps,
): void {
  const receipt = qualifyPodmanEndpointHost(engine, {
    expectedVersion: HERMES_PORTABLE_PODMAN_VERSION,
    expectedNetworkBackend: HERMES_PORTABLE_PODMAN_NETWORK_BACKEND,
    platform: deps.platform ?? process.platform,
    architecture: deps.architecture ?? process.arch,
  });
  if (
    receipt.clientVersion !== HERMES_PORTABLE_PODMAN_VERSION ||
    receipt.serverVersion !== HERMES_PORTABLE_PODMAN_VERSION ||
    receipt.rootless !== true ||
    receipt.cgroupVersion !== "v2" ||
    receipt.os !== "linux" ||
    receipt.architecture !== "amd64" ||
    receipt.networkBackend !== HERMES_PORTABLE_PODMAN_NETWORK_BACKEND
  ) {
    fail("exact client, server, rootless, cgroup, platform, or network matrix disagrees");
  }
}

function createHermesPortablePodmanOperationCommandAuthority(
  authority: HermesPortablePodmanExecutableAuthority,
  socketAuthority: PodmanSocketAuthority,
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
  operation: Extract<
    ContainerEngineOperationScope,
    "host-doctor" | "host-local-inference" | "sandbox-lifecycle"
  >,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: HermesPortablePodmanAuthorityDeps = {},
  executableProof: PodmanExecutableOperationProof = createPodmanExecutableOperationProof(
    authority.executable,
    deps.executableAuthorityDeps,
  ),
): HermesPortablePodmanCommandAuthority {
  requireExpectedAuthority(authority);
  requireRuntimeAuthority(runtimeAuthority, socketAuthority, deps);
  const commandEnvironment = buildHermesPortablePodmanEnvironment(runtimeAuthority, sourceEnv);
  requireResolvedExecutable(authority, sourceEnv, deps);
  const engine = createPodmanContainerEngine({
    operation,
    socketAuthority,
    executable: authority.executable.executablePath,
    executableAuthority: authority.executable,
    executableProof,
    commandEnvironment,
    ...(deps.capture ? { capture: deps.capture } : {}),
    ...(deps.socketAuthorityDeps ? { authorityDeps: deps.socketAuthorityDeps } : {}),
    ...(deps.executableAuthorityDeps
      ? { executableAuthorityDeps: deps.executableAuthorityDeps }
      : {}),
    ...(deps.assertSocketAuthority ? { assertAuthority: deps.assertSocketAuthority } : {}),
  });
  const assertTransactionCurrent = (): void => {
    requireRuntimeAuthority(runtimeAuthority, socketAuthority, deps);
    buildHermesPortablePodmanEnvironment(runtimeAuthority, sourceEnv);
    requireResolvedExecutable(authority, sourceEnv, deps);
    engine.assertAuthority();
  };
  const assertCurrent = (): void => {
    assertTransactionCurrent();
    if (operation === "sandbox-lifecycle") qualifyExactMatrix(engine, deps);
    assertTransactionCurrent();
  };
  return Object.freeze({ engine, assertTransactionCurrent, assertCurrent });
}

export function createHermesPortablePodmanCommandAuthority(
  authority: HermesPortablePodmanExecutableAuthority,
  socketAuthority: PodmanSocketAuthority,
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: HermesPortablePodmanAuthorityDeps = {},
): HermesPortablePodmanCommandAuthority {
  return createHermesPortablePodmanOperationCommandAuthority(
    authority,
    socketAuthority,
    runtimeAuthority,
    "sandbox-lifecycle",
    sourceEnv,
    deps,
  );
}

/** Bind one receipt-owned inference inspection without running the Podman behavior matrix. */
export function createHermesPortablePodmanInferenceInspectionAuthority(
  authority: HermesPortablePodmanExecutableAuthority,
  socketAuthority: PodmanSocketAuthority,
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: HermesPortablePodmanAuthorityDeps = {},
): HermesPortablePodmanCommandAuthority {
  return createHermesPortablePodmanOperationCommandAuthority(
    authority,
    socketAuthority,
    runtimeAuthority,
    "host-local-inference",
    sourceEnv,
    deps,
  );
}

export function createHermesPortablePodmanOperationEngines(
  authority: HermesPortablePodmanExecutableAuthority,
  socketAuthority: PodmanSocketAuthority,
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: HermesPortablePodmanAuthorityDeps = {},
): HermesPortablePodmanOperationEngines {
  const executableProof = createPodmanExecutableOperationProof(
    authority.executable,
    deps.executableAuthorityDeps,
  );
  const create = (operation: "host-doctor" | "host-local-inference" | "sandbox-lifecycle") =>
    createHermesPortablePodmanOperationCommandAuthority(
      authority,
      socketAuthority,
      runtimeAuthority,
      operation,
      sourceEnv,
      deps,
      executableProof,
    );
  const hostDoctor = create("host-doctor");
  const hostLocalInference = create("host-local-inference");
  const sandboxLifecycle = create("sandbox-lifecycle");

  return Object.freeze({
    hostDoctor: hostDoctor.engine,
    hostLocalInference: hostLocalInference.engine,
    sandboxLifecycle: sandboxLifecycle.engine,
    assertTransactionCurrent: () => {
      hostDoctor.assertTransactionCurrent();
      hostLocalInference.assertTransactionCurrent();
      sandboxLifecycle.assertTransactionCurrent();
    },
    assertCurrent: () => {
      hostDoctor.assertCurrent();
      hostLocalInference.assertCurrent();
      sandboxLifecycle.assertCurrent();
    },
  });
}

export function captureHermesPortablePodmanExecutableAuthority(
  socketAuthority: PodmanSocketAuthority,
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: HermesPortablePodmanAuthorityDeps = {},
): HermesPortablePodmanExecutableAuthority {
  requireRuntimeAuthority(runtimeAuthority, socketAuthority, deps);
  buildHermesPortablePodmanEnvironment(runtimeAuthority, sourceEnv);
  const executablePath = (deps.resolveExecutablePath ?? resolvePodmanExecutablePath)(sourceEnv);
  const authority = Object.freeze({
    version: HERMES_PORTABLE_PODMAN_VERSION,
    executable: capturePodmanExecutableAuthority(executablePath, deps.executableAuthorityDeps),
  });
  createHermesPortablePodmanCommandAuthority(
    authority,
    socketAuthority,
    runtimeAuthority,
    sourceEnv,
    deps,
  ).assertCurrent();
  return authority;
}

/**
 * Capture the exact Podman executable generation without querying the engine.
 * Read-only OpenShell operations use this proof after launch readiness has
 * already established live sandbox, route, and policy health. Any Podman
 * operation still uses the full matrix-qualified command authority above.
 */
export function captureHermesPortablePodmanExecutableFileAuthority(
  socketAuthority: PodmanSocketAuthority,
  receipt: { readonly runtimeAuthority: CheckpointPortableRuntimeAuthority } & {
    readonly podmanExecutableAuthority: HermesPortablePodmanExecutableAuthority;
  },
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: HermesPortablePodmanAuthorityDeps = {},
): HermesPortablePodmanExecutableAuthority {
  requireExpectedAuthority(receipt.podmanExecutableAuthority);
  requireRuntimeAuthority(receipt.runtimeAuthority, socketAuthority, deps);
  buildHermesPortablePodmanEnvironment(receipt.runtimeAuthority, sourceEnv);
  requireResolvedExecutable(receipt.podmanExecutableAuthority, sourceEnv, deps);
  assertPodmanExecutableMetadataAuthority(
    receipt.podmanExecutableAuthority.executable,
    deps.executableAuthorityDeps,
  );
  return receipt.podmanExecutableAuthority;
}
