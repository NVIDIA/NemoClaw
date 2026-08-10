// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  type ContainerEngine,
  type ContainerEngineCommandCapture,
  createContainerEngineCommand,
} from "../container-engine";
import {
  assertPodmanSocketAuthority,
  type PodmanSocketAuthority,
  type PodmanSocketAuthorityDeps,
} from "./socket-authority";

export interface PodmanContainerEngineOptions {
  readonly operation: "host-doctor" | "sandbox-lifecycle";
  readonly socketAuthority: PodmanSocketAuthority;
  readonly executable?: string;
  readonly capture?: ContainerEngineCommandCapture;
  readonly authorityDeps?: PodmanSocketAuthorityDeps;
  readonly assertAuthority?: (
    expected: PodmanSocketAuthority,
    deps?: PodmanSocketAuthorityDeps,
  ) => void;
}

export function localPodmanEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const local = { ...env };
  delete local.CONTAINER_CONNECTION;
  delete local.CONTAINER_HOST;
  delete local.CONTAINER_SSHKEY;
  return local;
}

function podmanAuthorityId(authority: PodmanSocketAuthority): string {
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
): ContainerEngine {
  const assertAuthority = options.assertAuthority ?? assertPodmanSocketAuthority;
  return createContainerEngineCommand({
    operation: options.operation,
    engineId: "podman",
    displayName: "Podman",
    authorityId: podmanAuthorityId(options.socketAuthority),
    executable: options.executable ?? "podman",
    endpointArgs: ["--url", `unix://${options.socketAuthority.socketPath}`],
    capture: options.capture,
    guard: () => assertAuthority(options.socketAuthority, options.authorityDeps),
  });
}

export type { PodmanSocketAuthority, PodmanSocketAuthorityDeps } from "./socket-authority";
export {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  hardenPodmanSocketDirectory,
} from "./socket-authority";
