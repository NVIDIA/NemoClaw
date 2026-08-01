// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export interface PodmanSocketStat {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly mode: bigint | number;
  readonly uid: bigint | number;
  isDirectory(): boolean;
  isSocket(): boolean;
}

export interface PodmanSocketDirectoryAuthority {
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly ownerUid: string;
  readonly path: string;
}

export interface PodmanSocketAuthority {
  readonly directoryChain: readonly PodmanSocketDirectoryAuthority[];
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly ownerUid: string;
  readonly socketPath: string;
}

export interface PodmanSocketAuthorityDeps {
  readonly lstat?: (filePath: string) => PodmanSocketStat;
  readonly uid?: number;
}

// A rootless Podman service and its client intentionally share one Unix UID,
// which is the trust principal for this boundary. The captured authority
// excludes path control by other principals and detects endpoint rotation; it
// does not claim isolation from another process already running as that UID.

function integerIdentity(value: bigint | number, label: string): string {
  if (typeof value === "bigint") {
    if (value >= 0n) return value.toString(10);
  } else if (Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new Error(`Podman socket ${label} identity is invalid.`);
}

function integerValue(value: bigint | number, label: string): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n) return value;
  } else if (Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`Podman socket ${label} identity is invalid.`);
}

function currentUid(configured: number | undefined): number {
  const uid = configured ?? (typeof process.getuid === "function" ? process.getuid() : Number.NaN);
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("Podman socket authority requires the current Unix user ID.");
  }
  return uid;
}

function normalizedSocketPath(socketPath: string): string {
  const normalized = socketPath.trim();
  if (
    normalized === "" ||
    !path.isAbsolute(normalized) ||
    path.normalize(normalized) !== normalized ||
    /[\0\r\n]/u.test(normalized)
  ) {
    throw new Error("Podman socket authority requires a safe normalized absolute path.");
  }
  return normalized;
}

function captureDirectoryChain(
  socketPath: string,
  uid: number,
  lstat: (filePath: string) => PodmanSocketStat,
): readonly PodmanSocketDirectoryAuthority[] {
  const directories: string[] = [];
  for (let directory = path.dirname(socketPath); ; directory = path.dirname(directory)) {
    directories.push(directory);
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }

  return Object.freeze(
    directories.map((directory, index) => {
      const stat = lstat(directory);
      if (!stat.isDirectory()) {
        throw new Error(`Podman socket path component '${directory}' is not a real directory.`);
      }
      const ownerUid = integerIdentity(stat.uid, "directory owner");
      if (index === 0 && ownerUid !== String(uid)) {
        throw new Error(
          `Podman socket directory is owned by uid ${ownerUid}; expected current uid ${String(uid)}.`,
        );
      }
      const mode = integerValue(stat.mode, "directory mode");
      if ((mode & 0o022n) !== 0n) {
        throw new Error(
          `Podman socket path component '${directory}' is writable by another user or group.`,
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

export function capturePodmanSocketAuthority(
  socketPath: string,
  deps: PodmanSocketAuthorityDeps = {},
): PodmanSocketAuthority {
  const normalized = normalizedSocketPath(socketPath);
  const lstat =
    deps.lstat ??
    ((filePath: string): PodmanSocketStat => fs.lstatSync(filePath, { bigint: true }));
  const stat = lstat(normalized);
  if (!stat.isSocket()) {
    throw new Error("Podman socket authority path is not a Unix socket.");
  }
  const uid = currentUid(deps.uid);
  const ownerUid = integerIdentity(stat.uid, "owner");
  if (ownerUid !== String(uid)) {
    throw new Error(
      `Podman socket authority is owned by uid ${ownerUid}; expected current uid ${String(uid)}.`,
    );
  }
  const mode = integerValue(stat.mode, "mode");
  if ((mode & 0o022n) !== 0n) {
    throw new Error("Podman socket authority is writable by another user or group.");
  }
  return Object.freeze({
    directoryChain: captureDirectoryChain(normalized, uid, lstat),
    device: integerIdentity(stat.dev, "device"),
    inode: integerIdentity(stat.ino, "inode"),
    mode: mode.toString(10),
    ownerUid,
    socketPath: normalized,
  });
}

export function assertPodmanSocketAuthority(
  expected: PodmanSocketAuthority,
  deps: PodmanSocketAuthorityDeps = {},
): void {
  const actual = capturePodmanSocketAuthority(expected.socketPath, deps);
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.mode !== expected.mode ||
    actual.ownerUid !== expected.ownerUid ||
    actual.directoryChain.length !== expected.directoryChain.length ||
    actual.directoryChain.some((component, index) => {
      const pinned = expected.directoryChain[index];
      return (
        !pinned ||
        component.device !== pinned.device ||
        component.inode !== pinned.inode ||
        component.mode !== pinned.mode ||
        component.ownerUid !== pinned.ownerUid ||
        component.path !== pinned.path
      );
    })
  ) {
    throw new Error("Podman socket authority changed after it was qualified.");
  }
}
