// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  type ContainerEngine,
  type ContainerEngineCommandCapture,
  createContainerEngineCommand,
} from "../container-engine";
import {
  assertPodmanExecutableAuthority,
  capturePodmanExecutableAuthority,
  type PodmanExecutableAuthority,
  type PodmanExecutableAuthorityDeps,
} from "./executable-authority";
import {
  assertPodmanSocketAuthority,
  type PodmanSocketAuthority,
  type PodmanSocketAuthorityDeps,
} from "./socket-authority";

export interface PodmanContainerEngineOptions {
  readonly operation: "host-doctor" | "host-local-inference" | "sandbox-lifecycle";
  readonly socketAuthority: PodmanSocketAuthority;
  readonly executable?: string;
  readonly capture?: ContainerEngineCommandCapture;
  readonly authorityDeps?: PodmanSocketAuthorityDeps;
  readonly executableAuthorityDeps?: PodmanExecutableAuthorityDeps;
  readonly assertAuthority?: (
    expected: PodmanSocketAuthority,
    deps?: PodmanSocketAuthorityDeps,
  ) => void;
}

export interface PodmanContainerEngine extends ContainerEngine {
  readonly endpointAuthorityId: string;
}

export function localPodmanEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const local = { ...env };
  delete local.CONTAINER_CONNECTION;
  delete local.CONTAINER_HOST;
  delete local.CONTAINER_SSHKEY;
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
): PodmanContainerEngine {
  const assertAuthority = options.assertAuthority ?? assertPodmanSocketAuthority;
  const executable = options.executable ?? "podman";
  const executableAuthority =
    options.operation === "host-local-inference"
      ? capturePodmanExecutableAuthority(executable, options.executableAuthorityDeps)
      : undefined;
  const endpointAuthorityId = podmanAuthorityId(options.socketAuthority);
  const engine = createContainerEngineCommand({
    operation: options.operation,
    engineId: "podman",
    displayName: "Podman",
    authorityId: podmanAuthorityId(options.socketAuthority, executableAuthority),
    endpointAuthorityId,
    executable,
    endpointArgs: ["--url", `unix://${options.socketAuthority.socketPath}`],
    allowedEnvironmentNames:
      options.operation === "host-local-inference" ? ["NGC_API_KEY", "NIM_NGC_API_KEY"] : [],
    capture: options.capture,
    guard: () => {
      let failure: unknown;
      try {
        assertAuthority(options.socketAuthority, options.authorityDeps);
      } catch (error) {
        failure = error;
      }
      if (executableAuthority) {
        try {
          assertPodmanExecutableAuthority(executableAuthority, options.executableAuthorityDeps);
        } catch (error) {
          if (failure === undefined) failure = error;
        }
      }
      if (failure !== undefined) throw failure;
    },
  }) as PodmanContainerEngine;
  if (options.operation !== "host-local-inference") return engine;
  return Object.freeze({
    ...engine,
    captureHost: () => {
      throw new Error("Podman host-local inference forbids ambient host command capture.");
    },
  });
}

export type {
  PodmanExecutableAuthority,
  PodmanExecutableAuthorityDeps,
  PodmanExecutableDirectoryAuthority,
  PodmanExecutableStat,
} from "./executable-authority";
export {
  assertPodmanExecutableAuthority,
  capturePodmanExecutableAuthority,
} from "./executable-authority";
export type { PodmanSocketAuthority, PodmanSocketAuthorityDeps } from "./socket-authority";
export {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  hardenPodmanSocketDirectory,
} from "./socket-authority";
