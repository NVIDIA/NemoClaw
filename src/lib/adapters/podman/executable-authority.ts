// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_EXECUTABLE_BYTES = 512n * 1024n * 1024n;

// Root and the current Unix UID are the trusted pathname-control principals.
// The before/after guards reject observable replacement but do not claim
// isolation from another process already running as either trusted principal.

export interface PodmanExecutableStat {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly mode: bigint | number;
  readonly uid: bigint | number;
  readonly size: bigint | number;
  readonly mtimeNs: bigint | number;
  readonly ctimeNs: bigint | number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface PodmanExecutableDirectoryAuthority {
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly ownerUid: string;
  readonly path: string;
}

export interface PodmanExecutableAuthority {
  readonly changedTimeNanoseconds: string;
  readonly device: string;
  readonly directoryChain: readonly PodmanExecutableDirectoryAuthority[];
  readonly executablePath: string;
  readonly inode: string;
  readonly mode: string;
  readonly modifiedTimeNanoseconds: string;
  readonly ownerUid: string;
  readonly sha256: string;
  readonly size: string;
}

type PodmanExecutableMetadataAuthority = Omit<PodmanExecutableAuthority, "sha256">;

export type PodmanExecutableAuthorityTimingStage =
  | "podmanCanonicalRealpath"
  | "podmanDirectoryChain"
  | "podmanExecutableMetadata"
  | "podmanContentRead"
  | "podmanContentHash"
  | "podmanAuthorityCompare";

export interface PodmanExecutableAuthorityTiming {
  readonly measure: <T>(stage: PodmanExecutableAuthorityTimingStage, operation: () => T) => T;
}

export interface PodmanExecutableAuthorityDeps {
  readonly lstat?: (filePath: string) => PodmanExecutableStat;
  readonly readFile?: (filePath: string) => Uint8Array;
  readonly realpath?: (filePath: string) => string;
  readonly timing?: PodmanExecutableAuthorityTiming;
  readonly uid?: number;
}

function measure<T>(
  deps: PodmanExecutableAuthorityDeps,
  stage: PodmanExecutableAuthorityTimingStage,
  operation: () => T,
): T {
  return deps.timing?.measure(stage, operation) ?? operation();
}

function integerIdentity(value: bigint | number, label: string): string {
  if (typeof value === "bigint") {
    if (value >= 0n) return value.toString(10);
  } else if (Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new Error(`Podman executable ${label} identity is invalid.`);
}

function integerValue(value: bigint | number, label: string): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n) return value;
  } else if (Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`Podman executable ${label} identity is invalid.`);
}

function currentUid(configured: number | undefined): number {
  const uid = configured ?? (typeof process.getuid === "function" ? process.getuid() : Number.NaN);
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("Podman executable authority requires the current Unix user ID.");
  }
  return uid;
}

function canonicalExecutablePath(
  executablePath: string,
  realpath: (filePath: string) => string,
): string {
  if (
    typeof executablePath !== "string" ||
    executablePath === "" ||
    executablePath.trim() !== executablePath ||
    !path.isAbsolute(executablePath) ||
    path.normalize(executablePath) !== executablePath ||
    /[\0\r\n]/u.test(executablePath)
  ) {
    throw new Error("Podman executable authority requires a canonical absolute path.");
  }
  let resolved: string;
  try {
    resolved = realpath(executablePath);
  } catch {
    throw new Error("Podman executable authority could not resolve the executable path.");
  }
  if (resolved !== executablePath) {
    throw new Error("Podman executable authority rejects symlinked or non-canonical paths.");
  }
  return executablePath;
}

function immutableMetadata(
  stat: PodmanExecutableStat,
  uid: number,
): Omit<PodmanExecutableAuthority, "directoryChain" | "executablePath" | "sha256"> {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Podman executable authority path is a symlink or is not a regular file.");
  }
  const ownerUid = integerIdentity(stat.uid, "owner");
  if (ownerUid !== "0" && ownerUid !== String(uid)) {
    throw new Error(
      `Podman executable authority is owned by uid ${ownerUid}; expected root or current uid ${String(uid)}.`,
    );
  }
  const mode = integerValue(stat.mode, "mode");
  if ((mode & 0o022n) !== 0n) {
    throw new Error("Podman executable authority is writable by another user or group.");
  }
  if ((mode & 0o111n) === 0n) {
    throw new Error("Podman executable authority path is not executable.");
  }
  const size = integerValue(stat.size, "size");
  if (size === 0n || size > MAX_EXECUTABLE_BYTES) {
    throw new Error("Podman executable authority size is invalid or exceeds its byte bound.");
  }
  return Object.freeze({
    changedTimeNanoseconds: integerIdentity(stat.ctimeNs, "changed time"),
    device: integerIdentity(stat.dev, "device"),
    inode: integerIdentity(stat.ino, "inode"),
    mode: mode.toString(10),
    modifiedTimeNanoseconds: integerIdentity(stat.mtimeNs, "modified time"),
    ownerUid,
    size: size.toString(10),
  });
}

function sameMetadata(
  left: Omit<PodmanExecutableAuthority, "directoryChain" | "executablePath" | "sha256">,
  right: Omit<PodmanExecutableAuthority, "directoryChain" | "executablePath" | "sha256">,
): boolean {
  return (
    left.changedTimeNanoseconds === right.changedTimeNanoseconds &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.modifiedTimeNanoseconds === right.modifiedTimeNanoseconds &&
    left.ownerUid === right.ownerUid &&
    left.size === right.size
  );
}

function captureDirectoryChain(
  executablePath: string,
  uid: number,
  lstat: (filePath: string) => PodmanExecutableStat,
): readonly PodmanExecutableDirectoryAuthority[] {
  const directories: string[] = [];
  for (let directory = path.dirname(executablePath); ; directory = path.dirname(directory)) {
    directories.push(directory);
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  return Object.freeze(
    directories.map((directory) => {
      const stat = lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          `Podman executable path component '${directory}' is a symlink or is not a real directory.`,
        );
      }
      const ownerUid = integerIdentity(stat.uid, "directory owner");
      if (ownerUid !== "0" && ownerUid !== String(uid)) {
        throw new Error(
          `Podman executable path component '${directory}' is owned by uid ${ownerUid}; expected root or current uid ${String(uid)}.`,
        );
      }
      const mode = integerValue(stat.mode, "directory mode");
      if ((mode & 0o022n) !== 0n) {
        throw new Error(
          `Podman executable path component '${directory}' is writable by another user or group.`,
        );
      }
      return Object.freeze({
        device: integerIdentity(stat.dev, "directory device"),
        inode: integerIdentity(stat.ino, "directory inode"),
        mode: mode.toString(10),
        ownerUid,
        path: directory,
      });
    }),
  );
}

function sameDirectoryChain(
  left: readonly PodmanExecutableDirectoryAuthority[],
  right: readonly PodmanExecutableDirectoryAuthority[],
): boolean {
  return (
    left.length === right.length &&
    left.every((component, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        component.device === candidate.device &&
        component.inode === candidate.inode &&
        component.mode === candidate.mode &&
        component.ownerUid === candidate.ownerUid &&
        component.path === candidate.path
      );
    })
  );
}

function capturePodmanExecutableMetadataAuthority(
  executablePath: string,
  deps: PodmanExecutableAuthorityDeps = {},
): PodmanExecutableMetadataAuthority {
  const lstat =
    deps.lstat ??
    ((filePath: string): PodmanExecutableStat => fs.lstatSync(filePath, { bigint: true }));
  const realpath = deps.realpath ?? ((filePath: string): string => fs.realpathSync(filePath));
  const uid = currentUid(deps.uid);
  const canonicalPath = measure(deps, "podmanCanonicalRealpath", () =>
    canonicalExecutablePath(executablePath, realpath),
  );
  const directoryChainBefore = measure(deps, "podmanDirectoryChain", () =>
    captureDirectoryChain(canonicalPath, uid, lstat),
  );
  const before = measure(deps, "podmanExecutableMetadata", () =>
    immutableMetadata(lstat(canonicalPath), uid),
  );
  const after = measure(deps, "podmanExecutableMetadata", () =>
    immutableMetadata(lstat(canonicalPath), uid),
  );
  const directoryChainAfter = measure(deps, "podmanDirectoryChain", () =>
    captureDirectoryChain(canonicalPath, uid, lstat),
  );
  measure(deps, "podmanCanonicalRealpath", () => canonicalExecutablePath(canonicalPath, realpath));
  measure(deps, "podmanAuthorityCompare", () => {
    if (
      !sameMetadata(before, after) ||
      !sameDirectoryChain(directoryChainBefore, directoryChainAfter)
    ) {
      throw new Error("Podman executable authority changed while it was checked.");
    }
  });
  return Object.freeze({
    ...after,
    directoryChain: directoryChainAfter,
    executablePath: canonicalPath,
  });
}

function sameExecutableMetadataAuthority(
  actual: PodmanExecutableMetadataAuthority,
  expected: PodmanExecutableAuthority,
): boolean {
  return (
    actual.changedTimeNanoseconds === expected.changedTimeNanoseconds &&
    actual.device === expected.device &&
    sameDirectoryChain(actual.directoryChain, expected.directoryChain) &&
    actual.executablePath === expected.executablePath &&
    actual.inode === expected.inode &&
    actual.mode === expected.mode &&
    actual.modifiedTimeNanoseconds === expected.modifiedTimeNanoseconds &&
    actual.ownerUid === expected.ownerUid &&
    actual.size === expected.size
  );
}

export function capturePodmanExecutableAuthority(
  executablePath: string,
  deps: PodmanExecutableAuthorityDeps = {},
): PodmanExecutableAuthority {
  const lstat =
    deps.lstat ??
    ((filePath: string): PodmanExecutableStat => fs.lstatSync(filePath, { bigint: true }));
  const readFile = deps.readFile ?? ((filePath: string): Uint8Array => fs.readFileSync(filePath));
  const realpath = deps.realpath ?? ((filePath: string): string => fs.realpathSync(filePath));
  const uid = currentUid(deps.uid);
  const canonicalPath = measure(deps, "podmanCanonicalRealpath", () =>
    canonicalExecutablePath(executablePath, realpath),
  );
  const directoryChainBefore = measure(deps, "podmanDirectoryChain", () =>
    captureDirectoryChain(canonicalPath, uid, lstat),
  );
  const before = measure(deps, "podmanExecutableMetadata", () =>
    immutableMetadata(lstat(canonicalPath), uid),
  );
  const contents = measure(deps, "podmanContentRead", () => {
    try {
      return readFile(canonicalPath);
    } catch {
      throw new Error("Podman executable authority could not read the executable.");
    }
  });
  if (!(contents instanceof Uint8Array) || contents.byteLength !== Number(before.size)) {
    throw new Error("Podman executable authority read returned inconsistent executable bytes.");
  }
  const after = measure(deps, "podmanExecutableMetadata", () =>
    immutableMetadata(lstat(canonicalPath), uid),
  );
  const directoryChainAfter = measure(deps, "podmanDirectoryChain", () =>
    captureDirectoryChain(canonicalPath, uid, lstat),
  );
  measure(deps, "podmanCanonicalRealpath", () => canonicalExecutablePath(canonicalPath, realpath));
  measure(deps, "podmanAuthorityCompare", () => {
    if (
      !sameMetadata(before, after) ||
      !sameDirectoryChain(directoryChainBefore, directoryChainAfter)
    ) {
      throw new Error("Podman executable authority changed while it was captured.");
    }
  });
  const sha256 = measure(deps, "podmanContentHash", () =>
    createHash("sha256").update(contents).digest("hex"),
  );
  return Object.freeze({
    ...after,
    directoryChain: directoryChainAfter,
    executablePath: canonicalPath,
    sha256,
  });
}

export function assertPodmanExecutableAuthority(
  expected: PodmanExecutableAuthority,
  deps: PodmanExecutableAuthorityDeps = {},
): void {
  const actual = capturePodmanExecutableAuthority(expected.executablePath, deps);
  measure(deps, "podmanAuthorityCompare", () => {
    if (!sameExecutableMetadataAuthority(actual, expected) || actual.sha256 !== expected.sha256) {
      throw new Error("Podman executable authority changed after it was qualified.");
    }
  });
}

export function assertPodmanExecutableMetadataAuthority(
  expected: PodmanExecutableAuthority,
  deps: PodmanExecutableAuthorityDeps = {},
): void {
  const actual = capturePodmanExecutableMetadataAuthority(expected.executablePath, deps);
  measure(deps, "podmanAuthorityCompare", () => {
    if (!sameExecutableMetadataAuthority(actual, expected)) {
      throw new Error("Podman executable authority changed after it was qualified.");
    }
  });
}
