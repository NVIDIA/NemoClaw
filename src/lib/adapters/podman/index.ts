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
    | "managed-bootstrap"
    | "sandbox-lifecycle"
    | "state-mutation"
    | "workload-cleanup";
  readonly socketAuthority: PodmanSocketAuthority;
  readonly executable?: string;
  readonly executableAuthority?: PodmanExecutableAuthority;
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

export interface PodmanContainerEngine extends ContainerEngine {
  readonly endpointAuthorityId: string;
}

export interface PodmanManagedWorkspaceRootReceipt {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: 0;
  readonly gid: number;
  readonly mode: 0o1775;
}

/** Podman engine whose exact socket and executable authority can be revalidated on demand. */
export interface PodmanBoundContainerEngine extends PodmanContainerEngine {
  readonly assertAuthority: () => void;
  /** Exact local user-namespace mutation available only to managed bootstrap. */
  readonly prepareManagedWorkspaceRoot?: (input: {
    readonly path: string;
    readonly gid: number;
  }) => PodmanManagedWorkspaceRootReceipt;
}

export function resolvePodmanExecutablePath(env: NodeJS.ProcessEnv = process.env): string {
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
  const protectsRuntimeMutation =
    options.operation === "host-local-inference" ||
    options.operation === "managed-bootstrap" ||
    options.operation === "state-mutation" ||
    options.operation === "workload-cleanup";
  const executable =
    options.executable ??
    options.executableAuthority?.executablePath ??
    (protectsRuntimeMutation ? resolvePodmanExecutablePath(options.executableSearchEnv) : "podman");
  if (options.executableAuthority && executable !== options.executableAuthority.executablePath) {
    throw new Error("Podman executable path disagrees with its recorded authority.");
  }
  if (options.executableAuthority) {
    assertPodmanExecutableAuthority(options.executableAuthority, options.executableAuthorityDeps);
  }
  const executableAuthority = protectsRuntimeMutation
    ? (options.executableAuthority ??
      capturePodmanExecutableAuthority(executable, options.executableAuthorityDeps))
    : undefined;
  let executableCommandCount = 0;
  let hasExecutableAuthorityFailure = false;
  let executableAuthorityFailure: unknown;
  const endpointAuthorityId = podmanAuthorityId(options.socketAuthority);
  const assertBoundAuthority = (rehashExecutable: boolean): void => {
    assertAuthority(options.socketAuthority, options.authorityDeps);
    if (!executableAuthority) return;
    if (rehashExecutable) {
      assertPodmanExecutableAuthority(executableAuthority, options.executableAuthorityDeps);
    } else {
      assertPodmanExecutableMetadataAuthority(executableAuthority, options.executableAuthorityDeps);
    }
  };
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
    commandEnvironment: options.commandEnvironment,
    capture: options.capture,
    guard: (phase) => {
      let failure: unknown;
      try {
        assertAuthority(options.socketAuthority, options.authorityDeps);
      } catch (error) {
        failure = error;
      }
      if (executableAuthority) {
        if (!hasExecutableAuthorityFailure) {
          try {
            const shouldRehash =
              phase === "before" &&
              executableCommandCount + 1 === EXECUTABLE_CONTENT_REVALIDATION_COMMAND_INTERVAL;
            if (shouldRehash) {
              assertPodmanExecutableAuthority(executableAuthority, options.executableAuthorityDeps);
            } else {
              assertPodmanExecutableMetadataAuthority(
                executableAuthority,
                options.executableAuthorityDeps,
              );
            }
          } catch (error) {
            hasExecutableAuthorityFailure = true;
            executableAuthorityFailure =
              error ?? new Error("Podman executable authority check failed without evidence.");
          }
        }
        if (failure === undefined && hasExecutableAuthorityFailure) {
          failure = executableAuthorityFailure;
        }
      }
      if (phase === "after") {
        executableCommandCount =
          (executableCommandCount + 1) % EXECUTABLE_CONTENT_REVALIDATION_COMMAND_INTERVAL;
      }
      if (failure !== undefined) throw failure;
    },
  });
  const boundEngine = {
    ...engine,
    endpointAuthorityId,
    assertAuthority: () => assertBoundAuthority(true),
  };
  if (!protectsRuntimeMutation) return Object.freeze(boundEngine);
  const prepareManagedWorkspaceRoot = (input: {
    readonly path: string;
    readonly gid: number;
  }): PodmanManagedWorkspaceRootReceipt => {
    if (options.operation !== "managed-bootstrap") {
      throw new Error("Podman workspace-root preparation requires managed-bootstrap authority.");
    }
    if (
      !path.isAbsolute(input.path) ||
      path.normalize(input.path) !== input.path ||
      input.path === path.parse(input.path).root ||
      fs.realpathSync(input.path) !== input.path
    ) {
      throw new Error("Podman managed workspace mountpoint is invalid.");
    }
    if (!Number.isSafeInteger(input.gid) || input.gid < 1 || input.gid > 2_147_483_647) {
      throw new Error("Podman managed workspace group identity is invalid.");
    }
    const before = fs.lstatSync(input.path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || before.nlink < 1n) {
      throw new Error("Podman managed workspace mountpoint is not one stable directory.");
    }
    const runLocal = (args: readonly string[], action: string) => {
      const result = boundEngine.captureHost(args, 15_000);
      if (result.status !== 0 || result.error) {
        const detail = (
          result.stderr ||
          result.stdout ||
          result.error?.message ||
          "unknown failure"
        )
          .replace(/\s+/gu, " ")
          .trim()
          .slice(-600);
        throw new Error(
          `Podman managed workspace ${action} failed (exit ${String(result.status)}): ${detail}`,
        );
      }
      return result;
    };
    runLocal(
      ["unshare", "chown", "--no-dereference", `0:${String(input.gid)}`, "--", input.path],
      "ownership preparation",
    );
    runLocal(["unshare", "chmod", "1775", "--", input.path], "mode preparation");
    const observed = runLocal(
      ["unshare", "stat", "--format=%u:%g:%a:%F", "--", input.path],
      "authority observation",
    ).stdout.trim();
    if (observed !== `0:${String(input.gid)}:1775:directory`) {
      throw new Error(
        `Podman managed workspace authority is invalid after preparation (${observed || "empty observation"}).`,
      );
    }
    const after = fs.lstatSync(input.path, { bigint: true });
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error("Podman managed workspace mountpoint changed during preparation.");
    }
    return Object.freeze({
      path: input.path,
      device: after.dev.toString(),
      inode: after.ino.toString(),
      uid: 0 as const,
      gid: input.gid,
      mode: 0o1775 as const,
    });
  };
  return Object.freeze({
    ...boundEngine,
    ...(options.operation === "managed-bootstrap" ? { prepareManagedWorkspaceRoot } : {}),
    captureHost: () => {
      throw new Error(`Podman ${options.operation} forbids ambient host command capture.`);
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
