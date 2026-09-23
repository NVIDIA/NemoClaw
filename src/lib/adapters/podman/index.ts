// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type ContainerEngine,
  type ContainerEngineCommandCapture,
  createContainerEngineCommand,
} from "../container-engine";
import {
  assertPodmanExecutableAuthority,
  assertPodmanExecutableMetadataAuthority,
  capturePodmanExecutableAuthority,
  type PodmanExecutableAuthority,
  type PodmanExecutableAuthorityDeps,
} from "./executable-authority";
import {
  assertPodmanSocketAuthority,
  type PodmanSocketAuthority,
  type PodmanSocketAuthorityDeps,
} from "./socket-authority";

// Immutable metadata is checked before and after every dispatch. Rehash the
// full executable before every 64th command within this operation.
const EXECUTABLE_CONTENT_REVALIDATION_COMMAND_INTERVAL = 64;

export interface PodmanContainerEngineOptions {
  readonly operation:
    | "host-doctor"
    | "gateway-inspection"
    | "host-local-inference"
    | "sandbox-lifecycle"
    | "workload-cleanup";
  readonly socketAuthority: PodmanSocketAuthority;
  readonly executable?: string;
  readonly executableAuthority?: PodmanExecutableAuthority;
  readonly executableProof?: PodmanExecutableOperationProof;
  readonly executableSearchEnv?: NodeJS.ProcessEnv;
  readonly capture?: ContainerEngineCommandCapture;
  readonly commandEnvironment?: Readonly<Record<string, string>>;
  readonly authorityDeps?: PodmanSocketAuthorityDeps;
  readonly executableAuthorityDeps?: PodmanExecutableAuthorityDeps;
  readonly assertAuthority?: (
    expected: PodmanSocketAuthority,
    deps?: PodmanSocketAuthorityDeps,
  ) => void;
}

export interface PodmanExecutablePathTiming {
  readonly measure: <T>(stage: "podmanPathResolution", operation: () => T) => T;
}

const podmanExecutableOperationProofs = new WeakSet<object>();

export interface PodmanExecutableOperationProof {
  readonly authority: PodmanExecutableAuthority;
  readonly executablePath: string;
  readonly assertMetadataAuthority: () => void;
  readonly assertContentAuthority: () => void;
  readonly guardCommand: (phase: "before" | "after") => void;
}

export function createPodmanExecutableOperationProof(
  authority: PodmanExecutableAuthority,
  deps?: PodmanExecutableAuthorityDeps,
): PodmanExecutableOperationProof {
  let commandCount = 0;
  let failure: unknown;
  const assertWithLatch = (validate: () => void): void => {
    if (failure === undefined) {
      try {
        validate();
      } catch (error) {
        failure = error ?? new Error("Podman executable authority check failed without evidence.");
      }
    }
    if (failure !== undefined) throw failure;
  };
  const assertMetadataAuthority = () =>
    assertWithLatch(() => assertPodmanExecutableMetadataAuthority(authority, deps));
  const assertContentAuthority = () =>
    assertWithLatch(() => assertPodmanExecutableAuthority(authority, deps));
  const proof = Object.freeze({
    authority,
    executablePath: authority.executablePath,
    assertMetadataAuthority,
    assertContentAuthority,
    guardCommand: (phase: "before" | "after") => {
      try {
        const shouldRehash =
          phase === "before" &&
          commandCount + 1 === EXECUTABLE_CONTENT_REVALIDATION_COMMAND_INTERVAL;
        if (shouldRehash) assertContentAuthority();
        else assertMetadataAuthority();
      } finally {
        if (phase === "after") {
          commandCount = (commandCount + 1) % EXECUTABLE_CONTENT_REVALIDATION_COMMAND_INTERVAL;
        }
      }
    },
  });
  podmanExecutableOperationProofs.add(proof);
  return proof;
}

export interface PodmanContainerEngine extends ContainerEngine {
  readonly endpointAuthorityId: string;
}

/** Podman engine whose exact socket and executable authority can be revalidated on demand. */
export interface PodmanBoundContainerEngine extends PodmanContainerEngine {
  readonly assertAuthority: () => void;
}

export function resolvePodmanExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
  timing?: PodmanExecutablePathTiming,
): string {
  const resolve = () => {
    const searchPath = env.PATH;
    if (!searchPath) {
      throw new Error("Podman executable authority could not resolve podman from PATH.");
    }
    for (const directory of searchPath.split(path.delimiter)) {
      if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) continue;
      const candidate = path.join(directory, "podman");
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        const resolved = fs.realpathSync(candidate);
        if (path.isAbsolute(resolved) && path.normalize(resolved) === resolved) return resolved;
      } catch {
        // Continue to the next absolute PATH entry.
      }
    }
    throw new Error("Podman executable authority could not resolve podman from PATH.");
  };
  return timing?.measure("podmanPathResolution", resolve) ?? resolve();
}

export function localPodmanEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const local = { ...env };
  delete local.CONTAINER_CONNECTION;
  delete local.CONTAINER_HOST;
  delete local.CONTAINER_SSHKEY;
  delete local.DOCKER_TLS;
  delete local.DOCKER_TLS_VERIFY;
  delete local.DOCKER_CERT_PATH;
  return local;
}

function podmanAuthorityId(
  authority: PodmanSocketAuthority,
  executableAuthority?: PodmanExecutableAuthority,
): string {
  const canonical = JSON.stringify({
    socketPath: authority.socketPath,
    device: authority.device,
    inode: authority.inode,
    mode: authority.mode,
    ownerUid: authority.ownerUid,
    directoryChain: authority.directoryChain.map(({ device, inode, mode, ownerUid, path }) => ({
      device,
      inode,
      mode,
      ownerUid,
      path,
    })),
    ...(executableAuthority
      ? {
          executable: {
            changedTimeNanoseconds: executableAuthority.changedTimeNanoseconds,
            device: executableAuthority.device,
            directoryChain: executableAuthority.directoryChain,
            executablePath: executableAuthority.executablePath,
            inode: executableAuthority.inode,
            mode: executableAuthority.mode,
            modifiedTimeNanoseconds: executableAuthority.modifiedTimeNanoseconds,
            ownerUid: executableAuthority.ownerUid,
            sha256: executableAuthority.sha256,
            size: executableAuthority.size,
          },
        }
      : {}),
  });
  return `podman-sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Bind one Podman API socket to one provider operation. Callers inject the
 * returned value directly. The adapter never changes process-wide engine
 * selection or how Docker-named helpers behave elsewhere in the process.
 */
export function createPodmanContainerEngine(
  options: PodmanContainerEngineOptions,
): PodmanBoundContainerEngine {
  const assertAuthority = options.assertAuthority ?? assertPodmanSocketAuthority;
  const requiresExecutableAuthority =
    options.operation === "host-local-inference" ||
    options.operation === "workload-cleanup" ||
    options.executableAuthority !== undefined ||
    options.executableProof !== undefined;
  if (options.executableProof && !podmanExecutableOperationProofs.has(options.executableProof)) {
    throw new Error("Podman executable proof was not created by this adapter.");
  }
  if (
    options.executableProof &&
    options.executableAuthority &&
    options.executableProof.authority !== options.executableAuthority
  ) {
    throw new Error("Podman executable proof disagrees with its recorded authority.");
  }
  const executableAuthority =
    options.executableProof?.authority ??
    options.executableAuthority ??
    (requiresExecutableAuthority
      ? capturePodmanExecutableAuthority(
          options.executable ?? resolvePodmanExecutablePath(options.executableSearchEnv),
          options.executableAuthorityDeps,
        )
      : undefined);
  const executableProof =
    options.executableProof ??
    (executableAuthority
      ? createPodmanExecutableOperationProof(executableAuthority, options.executableAuthorityDeps)
      : undefined);
  const executable =
    options.executable ??
    executableProof?.executablePath ??
    (requiresExecutableAuthority
      ? resolvePodmanExecutablePath(options.executableSearchEnv)
      : "podman");
  if (executableProof && executable !== executableProof.executablePath) {
    throw new Error("Podman executable path disagrees with its recorded authority.");
  }
  // Preserve the prior constructor behavior: a supplied authority is fully
  // revalidated, while an authority captured by this constructor was already
  // hashed during capture. Sharing a proof changes ownership, not sequencing.
  if (options.executableProof || options.executableAuthority) {
    executableProof?.assertContentAuthority();
  }
  const endpointAuthorityId = podmanAuthorityId(options.socketAuthority);
  const assertBoundAuthority = (rehashExecutable: boolean): void => {
    assertAuthority(options.socketAuthority, options.authorityDeps);
    if (!executableProof) return;
    if (rehashExecutable) {
      executableProof.assertContentAuthority();
    } else {
      executableProof.assertMetadataAuthority();
    }
  };
  let allowedEnvironmentNames: string[] = [];
  if (options.operation === "host-local-inference") {
    allowedEnvironmentNames = ["NGC_API_KEY", "NIM_NGC_API_KEY", "OLLAMA_CONTEXT_LENGTH"];
  }
  const engine = createContainerEngineCommand({
    operation: options.operation,
    engineId: "podman",
    displayName: "Podman",
    authorityId: podmanAuthorityId(options.socketAuthority, executableAuthority),
    endpointAuthorityId,
    executable,
    endpointArgs: ["--url", `unix://${options.socketAuthority.socketPath}`],
    allowedEnvironmentNames,
    commandEnvironment: options.commandEnvironment,
    capture: options.capture,
    guard: (phase) => {
      let failure: unknown;
      try {
        assertAuthority(options.socketAuthority, options.authorityDeps);
      } catch (error) {
        failure = error;
      }
      if (executableProof) {
        try {
          executableProof.guardCommand(phase);
        } catch (error) {
          if (failure === undefined) failure = error;
        }
      }
      if (failure !== undefined) throw failure;
    },
  });
  const boundEngine = {
    ...engine,
    endpointAuthorityId,
    assertAuthority: () => assertBoundAuthority(true),
  };
  if (!requiresExecutableAuthority) return Object.freeze(boundEngine);
  return Object.freeze({
    ...boundEngine,
    captureHost: () => {
      throw new Error(`Podman ${options.operation} forbids ambient host command capture.`);
    },
  });
}

export type {
  PodmanExecutableAuthority,
  PodmanExecutableAuthorityDeps,
  PodmanExecutableAuthorityTiming,
  PodmanExecutableAuthorityTimingStage,
  PodmanExecutableDirectoryAuthority,
  PodmanExecutableStat,
} from "./executable-authority";
export {
  assertPodmanExecutableAuthority,
  assertPodmanExecutableMetadataAuthority,
  capturePodmanExecutableAuthority,
} from "./executable-authority";
export type { PodmanSocketAuthority, PodmanSocketAuthorityDeps } from "./socket-authority";
export {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  hardenPodmanSocketDirectory,
} from "./socket-authority";
