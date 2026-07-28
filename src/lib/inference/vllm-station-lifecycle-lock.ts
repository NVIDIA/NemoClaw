// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type McpLifecycleLockOptions, withMcpLifecycleLock } from "../state/mcp-lifecycle-lock";
import { STATE_DIR_NAME } from "../state/state-root";

const DUAL_STATION_VLLM_LIFECYCLE_LOCK = "dual-station-vllm:host-global";
const DUAL_STATION_CONTROLLER_CONFIG_DIR = "/etc/nemoclaw";
export const DUAL_STATION_CONTROLLER_UID_FILE = path.join(
  DUAL_STATION_CONTROLLER_CONFIG_DIR,
  "dual-station-controller-uid",
);
const DUAL_STATION_CONTROLLER_UID_FILE_MODE = 0o644;
const MAX_POSIX_UID = 0xffff_ffff;

/** @internal Filesystem seam for security-focused unit tests. */
export interface DualStationControllerUidFileStat {
  uid: number;
  gid: number;
  mode: number;
  size: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** @internal Filesystem seam for security-focused unit tests. */
export interface DualStationControllerUidReaderDeps {
  lstat(pathname: string): DualStationControllerUidFileStat;
  open(pathname: string, flags: number): number;
  fstat(fd: number): DualStationControllerUidFileStat;
  read(fd: number): string;
  close(fd: number): void;
}

/** @internal Identity seam for tests that cannot use the prepared host account. */
export interface DualStationControllerIdentityDeps {
  readControllerUid(): number;
  effectiveControllerUid(): number | null;
}

const DEFAULT_CONTROLLER_UID_READER_DEPS: DualStationControllerUidReaderDeps = {
  lstat: (pathname) => fs.lstatSync(pathname),
  open: (pathname, flags) => fs.openSync(pathname, flags),
  fstat: (fd) => fs.fstatSync(fd),
  read: (fd) => fs.readFileSync(fd, "utf8"),
  close: (fd) => fs.closeSync(fd),
};

function isNonRootUid(value: number | null): value is number {
  return Number.isSafeInteger(value) && value !== null && value > 0 && value <= MAX_POSIX_UID;
}

/**
 * Read the host-preparation controller binding without following the file's
 * final path component. Metadata and contents are consumed from the same open
 * descriptor so a replacement cannot change what is authorized.
 */
export function readDualStationControllerUid(
  deps: DualStationControllerUidReaderDeps = DEFAULT_CONTROLLER_UID_READER_DEPS,
): number {
  const directory = deps.lstat(DUAL_STATION_CONTROLLER_CONFIG_DIR);
  if (
    !directory.isDirectory() ||
    directory.uid !== 0 ||
    directory.gid !== 0 ||
    (directory.mode & 0o7777) !== 0o755
  ) {
    throw new Error(
      `Dual-Station controller directory must be root-owned with mode 0755: ${DUAL_STATION_CONTROLLER_CONFIG_DIR}`,
    );
  }

  const fd = deps.open(
    DUAL_STATION_CONTROLLER_UID_FILE,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const binding = deps.fstat(fd);
    if (
      !binding.isFile() ||
      binding.uid !== 0 ||
      binding.gid !== 0 ||
      (binding.mode & 0o7777) !== DUAL_STATION_CONTROLLER_UID_FILE_MODE ||
      binding.size < 2 ||
      binding.size > 11
    ) {
      throw new Error(
        `Dual-Station controller UID binding must be a root-owned regular file with mode 0644: ${DUAL_STATION_CONTROLLER_UID_FILE}`,
      );
    }
    const match = /^([1-9][0-9]*)\n$/.exec(deps.read(fd));
    const controllerUid = match ? Number(match[1]) : Number.NaN;
    if (!isNonRootUid(controllerUid)) {
      throw new Error(
        `Dual-Station controller UID binding must contain exactly one non-root UID: ${DUAL_STATION_CONTROLLER_UID_FILE}`,
      );
    }
    return controllerUid;
  } finally {
    deps.close(fd);
  }
}

export function assertDualStationControllerAccount(
  readControllerUid: () => number = readDualStationControllerUid,
  effectiveControllerUid: () => number | null = () => process.getuid?.() ?? null,
): number {
  const controllerUid = readControllerUid();
  if (!isNonRootUid(controllerUid)) {
    throw new Error("Dual-Station host preparation returned an invalid controller UID");
  }
  const effectiveUid = effectiveControllerUid();
  if (!isNonRootUid(effectiveUid)) {
    throw new Error("Dual-Station lifecycle requires a non-root effective controller UID");
  }
  if (effectiveUid !== controllerUid) {
    throw new Error(
      `Dual-Station lifecycle effective UID ${String(effectiveUid)} does not match prepared controller UID ${String(controllerUid)}`,
    );
  }
  return controllerUid;
}

/**
 * Serialize the host-managed dual-Station service across gateway instances.
 *
 * Dual-Station lifecycle supports one effective controller account per host.
 * This anchors every supported caller at that account's passwd home instead of
 * mutable HOME or a gateway-specific root. Host preparation binds that account
 * in root-owned state before the lease can be acquired.
 */
export function withDualStationVllmLifecycleLock<T>(
  operation: () => Promise<T> | T,
  options: McpLifecycleLockOptions = {},
  /** @internal Explicit identity injection keeps test storage overrides authorized. */
  identityDeps: DualStationControllerIdentityDeps = {
    readControllerUid: readDualStationControllerUid,
    effectiveControllerUid: () => process.getuid?.() ?? null,
  },
): Promise<T> {
  assertDualStationControllerAccount(
    identityDeps.readControllerUid,
    identityDeps.effectiveControllerUid,
  );
  const stateDir = options.stateDir ?? path.join(os.userInfo().homedir, STATE_DIR_NAME, "state");
  return withMcpLifecycleLock(DUAL_STATION_VLLM_LIFECYCLE_LOCK, operation, {
    ...options,
    stateDir,
  });
}
