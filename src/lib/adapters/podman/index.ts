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
const MANAGED_ROOT_HELPER_EXECUTABLE = fs.realpathSync(process.execPath);
const MANAGED_ROOT_DESCRIPTOR_SCRIPT = `
const fs = require("node:fs");
const payload = JSON.parse(process.argv[1]);
const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const descriptor = fs.openSync(payload.path, flags);
try {
  const before = fs.fstatSync(descriptor, { bigint: true });
  if (!before.isDirectory() || before.nlink < 1n || before.dev.toString() !== payload.device || before.ino.toString() !== payload.inode) {
    throw new Error("managed root identity changed before descriptor-bound mutation");
  }
  fs.fchownSync(descriptor, payload.uid, payload.gid);
  fs.fchmodSync(descriptor, payload.mode);
  const after = fs.fstatSync(descriptor, { bigint: true });
  if (!after.isDirectory() || after.nlink < 1n || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error("managed root identity changed during descriptor-bound mutation");
  }
  process.stdout.write(JSON.stringify({ device: after.dev.toString(), inode: after.ino.toString(), uid: Number(after.uid), gid: Number(after.gid), mode: Number(after.mode & 0o7777n) }));
} finally {
  fs.closeSync(descriptor);
}
`;

export interface PodmanContainerEngineOptions {
  readonly operation:
    | "host-doctor"
    | "gateway-inspection"
    | "host-local-inference"
    | "managed-bootstrap"
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

export interface PodmanManagedWorkspaceRootReceipt {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: 0o755 | 0o1775;
}

export interface PodmanManagedVolumeRootReceipt {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

/** Podman engine whose exact socket and executable authority can be revalidated on demand. */
export interface PodmanBoundContainerEngine extends PodmanContainerEngine {
  readonly assertAuthority: () => void;
  /** Exact local user-namespace mutation available only to managed bootstrap. */
  readonly prepareManagedWorkspaceRoot?: (input: {
    readonly path: string;
    readonly uid: number;
    readonly gid: number;
    readonly mode: 0o755 | 0o1775;
  }) => PodmanManagedWorkspaceRootReceipt;
  /** Exact, non-recursive local user-namespace mutation for one managed volume root. */
  readonly prepareManagedVolumeRoot?: (input: {
    readonly path: string;
    readonly uid: number;
    readonly gid: number;
    readonly mode: number;
  }) => PodmanManagedVolumeRootReceipt;
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
  const requiresExecutableAuthority =
    options.operation === "host-local-inference" ||
    options.operation === "managed-bootstrap" ||
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
  const engine = createContainerEngineCommand({
    operation: options.operation,
    engineId: "podman",
    displayName: "Podman",
    authorityId: podmanAuthorityId(options.socketAuthority, executableAuthority),
    endpointAuthorityId,
    executable,
    endpointArgs: ["--url", `unix://${options.socketAuthority.socketPath}`],
    allowedEnvironmentNames:
      options.operation === "host-local-inference"
        ? ["NGC_API_KEY", "NIM_NGC_API_KEY", "OLLAMA_CONTEXT_LENGTH"]
        : options.operation === "managed-bootstrap"
          ? ["CONTAINERS_CONF", "CONTAINERS_STORAGE_CONF"]
          : [],
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
  const prepareManagedVolumeRoot = (input: {
    readonly path: string;
    readonly uid: number;
    readonly gid: number;
    readonly mode: number;
  }): PodmanManagedVolumeRootReceipt => {
    if (options.operation !== "managed-bootstrap") {
      throw new Error("Podman volume-root preparation requires managed-bootstrap authority.");
    }
    if (
      !path.isAbsolute(input.path) ||
      path.normalize(input.path) !== input.path ||
      input.path === path.parse(input.path).root ||
      fs.realpathSync(input.path) !== input.path
    ) {
      throw new Error("Podman managed volume mountpoint is invalid.");
    }
    if (
      !Number.isSafeInteger(input.uid) ||
      input.uid < 0 ||
      input.uid > 2_147_483_647 ||
      !Number.isSafeInteger(input.gid) ||
      input.gid < 1 ||
      input.gid > 2_147_483_647 ||
      !Number.isSafeInteger(input.mode) ||
      input.mode < 0 ||
      input.mode > 0o7777 ||
      (input.mode & 0o002) !== 0
    ) {
      throw new Error("Podman managed volume root metadata is invalid.");
    }
    const before = fs.lstatSync(input.path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || before.nlink < 1n) {
      throw new Error("Podman managed volume mountpoint is not one stable directory.");
    }
    const payload = JSON.stringify({
      path: input.path,
      device: before.dev.toString(),
      inode: before.ino.toString(),
      uid: input.uid,
      gid: input.gid,
      mode: input.mode,
    });
    const result = boundEngine.captureHost(
      ["unshare", MANAGED_ROOT_HELPER_EXECUTABLE, "-e", MANAGED_ROOT_DESCRIPTOR_SCRIPT, payload],
      15_000,
    );
    if (result.status !== 0 || result.error) {
      const detail = (result.stderr || result.stdout || result.error?.message || "unknown failure")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(-600);
      throw new Error(
        `Podman managed volume descriptor preparation failed (exit ${String(result.status)}): ${detail}`,
      );
    }
    let observed: unknown;
    try {
      observed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Podman managed volume descriptor preparation returned invalid JSON.");
    }
    if (
      !observed ||
      typeof observed !== "object" ||
      Array.isArray(observed) ||
      (observed as Record<string, unknown>).device !== before.dev.toString() ||
      (observed as Record<string, unknown>).inode !== before.ino.toString() ||
      (observed as Record<string, unknown>).uid !== input.uid ||
      (observed as Record<string, unknown>).gid !== input.gid ||
      (observed as Record<string, unknown>).mode !== input.mode
    ) {
      throw new Error("Podman managed volume authority is invalid after descriptor preparation.");
    }
    return Object.freeze({
      path: input.path,
      device: before.dev.toString(),
      inode: before.ino.toString(),
      uid: input.uid,
      gid: input.gid,
      mode: input.mode,
    });
  };
  const prepareManagedWorkspaceRoot = (input: {
    readonly path: string;
    readonly uid: number;
    readonly gid: number;
    readonly mode: 0o755 | 0o1775;
  }): PodmanManagedWorkspaceRootReceipt => {
    const receipt = prepareManagedVolumeRoot({
      path: input.path,
      uid: input.uid,
      gid: input.gid,
      mode: input.mode,
    });
    return Object.freeze({ ...receipt, mode: input.mode });
  };
  return Object.freeze({
    ...boundEngine,
    ...(options.operation === "managed-bootstrap"
      ? { prepareManagedVolumeRoot, prepareManagedWorkspaceRoot }
      : {}),
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
  assertPodmanExecutableMetadataAuthority,
  capturePodmanExecutableAuthority,
} from "./executable-authority";
export type { PodmanSocketAuthority, PodmanSocketAuthorityDeps } from "./socket-authority";
export {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  hardenPodmanSocketDirectory,
} from "./socket-authority";
