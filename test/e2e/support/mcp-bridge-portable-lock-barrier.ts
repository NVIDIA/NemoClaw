// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { waitUntilAsync } from "../../../src/lib/core/wait";

const OWNER_WAIT_MS = 30_000;
const STOP_CONFIRM_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const BOOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface AuthenticatedOwner {
  readonly command: readonly string[];
  readonly directory: FileIdentity;
  readonly ownerFile: FileIdentity;
  readonly pid: number;
  readonly processFile: FileIdentity;
  readonly processIdentity: string;
  readonly state: string;
}

export interface PortableHostLockBarrierOptions {
  readonly commandArgs: readonly string[];
  readonly commandPath: string;
  readonly homeDir: string;
}

export interface PortableHostLockBarrierDeps {
  readonly bootIdPath?: string;
  readonly now?: () => number;
  readonly procRoot?: string;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep?: (durationMs: number) => Promise<void>;
}

export interface PortableHostLockBarrier {
  readonly pid: number;
  resume(): Promise<void>;
}

function identity(stat: fs.BigIntStats): FileIdentity {
  return { device: stat.dev, inode: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameOwner(left: AuthenticatedOwner, right: AuthenticatedOwner): boolean {
  return (
    left.pid === right.pid &&
    left.processIdentity === right.processIdentity &&
    sameIdentity(left.directory, right.directory) &&
    sameIdentity(left.ownerFile, right.ownerFile) &&
    sameIdentity(left.processFile, right.processFile) &&
    left.command.length === right.command.length &&
    left.command.every((argument, index) => argument === right.command[index])
  );
}

function readSmallRegularFile(
  target: string,
  expectedMode: number,
  maxBytes: number,
): { readonly identity: FileIdentity; readonly text: string } | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      Number(before.mode & 0o777n) !== expectedMode ||
      before.size <= 0n ||
      before.size > BigInt(maxBytes)
    ) {
      throw new Error("Portable host lock metadata is unsafe");
    }
    const buffer = Buffer.alloc(Number(before.size));
    if (fs.readSync(descriptor, buffer, 0, buffer.length, 0) !== buffer.length) {
      throw new Error("Portable host lock metadata changed while reading");
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathname = fs.lstatSync(target, { bigint: true });
    if (
      !sameIdentity(identity(before), identity(after)) ||
      !sameIdentity(identity(after), identity(pathname))
    ) {
      throw new Error("Portable host lock metadata changed while reading");
    }
    return { identity: identity(after), text: buffer.toString("utf8") };
  } finally {
    fs.closeSync(descriptor);
  }
}

function processSnapshot(
  pid: number,
  expectedCommandPath: string,
  expectedArgs: readonly string[],
  procRoot: string,
  bootIdPath: string,
): Pick<AuthenticatedOwner, "command" | "processIdentity" | "state"> | null {
  let stat: string;
  let cmdline: Buffer;
  let bootId: string;
  try {
    stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    cmdline = fs.readFileSync(path.join(procRoot, String(pid), "cmdline"));
    bootId = fs.readFileSync(bootIdPath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const close = stat.lastIndexOf(")");
  const fields =
    close < 0
      ? []
      : stat
          .slice(close + 2)
          .trim()
          .split(/\s+/u);
  const state = fields[0];
  const startTick = fields[19];
  if (!state || !startTick || !POSITIVE_INTEGER.test(startTick) || !BOOT_ID.test(bootId)) {
    throw new Error("Portable host lock owner process identity is malformed");
  }
  const command = cmdline
    .toString("utf8")
    .split("\0")
    .filter((argument) => argument.length > 0);
  const suffix = command.slice(-expectedArgs.length);
  const commandPrefix = command.slice(0, command.length - expectedArgs.length);
  if (
    suffix.length !== expectedArgs.length ||
    !suffix.every((argument, index) => argument === expectedArgs[index]) ||
    !commandPrefix.includes(expectedCommandPath)
  ) {
    throw new Error("Portable host lock owner does not match the exact first MCP add");
  }
  return { command, processIdentity: `${bootId} ${startTick}`, state };
}

function inspectOwner(
  options: PortableHostLockBarrierOptions,
  deps: PortableHostLockBarrierDeps,
): AuthenticatedOwner | null {
  const directoryPath = path.join(options.homeDir, ".nemoclaw-portable-host.lock");
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(directoryPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== BigInt(process.getuid?.() ?? -1) ||
    Number(before.mode & 0o777n) !== 0o700
  ) {
    throw new Error("Portable host lock generation is unsafe");
  }
  const owner = readSmallRegularFile(path.join(directoryPath, "owner"), 0o600, 32);
  const processRecord = readSmallRegularFile(path.join(directoryPath, "process-start"), 0o600, 256);
  if (!owner || !processRecord) return null;
  const ownerText = owner.text.trim();
  if (!POSITIVE_INTEGER.test(ownerText)) {
    throw new Error("Portable host lock owner is malformed");
  }
  const pid = Number(ownerText);
  const record = processRecord.text.trim().split(/\s+/u);
  if (record.length !== 3 || record[0] !== ownerText) {
    throw new Error("Portable host lock process identity is malformed");
  }
  const snapshot = processSnapshot(
    pid,
    options.commandPath,
    options.commandArgs,
    deps.procRoot ?? "/proc",
    deps.bootIdPath ?? "/proc/sys/kernel/random/boot_id",
  );
  if (!snapshot || snapshot.processIdentity !== `${record[1]} ${record[2]}`) {
    throw new Error("Portable host lock process identity does not match its live owner");
  }
  const after = fs.lstatSync(directoryPath, { bigint: true });
  if (!sameIdentity(identity(before), identity(after))) {
    throw new Error("Portable host lock generation changed during inspection");
  }
  return {
    ...snapshot,
    directory: identity(after),
    ownerFile: owner.identity,
    pid,
    processFile: processRecord.identity,
  };
}

function authenticatedProcessStillExists(
  owner: AuthenticatedOwner,
  options: PortableHostLockBarrierOptions,
  deps: PortableHostLockBarrierDeps,
): boolean {
  const snapshot = processSnapshot(
    owner.pid,
    options.commandPath,
    options.commandArgs,
    deps.procRoot ?? "/proc",
    deps.bootIdPath ?? "/proc/sys/kernel/random/boot_id",
  );
  return (
    snapshot !== null &&
    snapshot.processIdentity === owner.processIdentity &&
    snapshot.command.length === owner.command.length &&
    snapshot.command.every((argument, index) => argument === owner.command[index])
  );
}

/** Pause the exact first add while it owns the Portable host fence. */
export async function pausePortableHostLockOwner(
  options: PortableHostLockBarrierOptions,
  deps: PortableHostLockBarrierDeps = {},
): Promise<PortableHostLockBarrier> {
  const now = deps.now ?? performance.now.bind(performance);
  const signal = deps.signal ?? ((pid, requested) => process.kill(pid, requested));
  const waitOptions = {
    backoffFactor: 1,
    initialIntervalMs: POLL_INTERVAL_MS,
    maxIntervalMs: POLL_INTERVAL_MS,
    now,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
  const captured: { owner?: AuthenticatedOwner } = {};
  const found = await waitUntilAsync(
    () => {
      const owner = inspectOwner(options, deps);
      if (owner) captured.owner = owner;
      return owner !== null;
    },
    { ...waitOptions, deadlineMs: now() + OWNER_WAIT_MS },
  );
  if (!found || !captured.owner) {
    throw new Error("The first MCP add did not publish an authenticated Portable host lock owner");
  }
  const authenticatedOwner = captured.owner;

  let resumed = false;
  let stopped = false;
  const resume = async (): Promise<void> => {
    if (resumed) return;
    if (!stopped || !authenticatedProcessStillExists(authenticatedOwner, options, deps)) {
      resumed = true;
      return;
    }
    try {
      signal(authenticatedOwner.pid, "SIGCONT");
      resumed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      resumed = true;
    }
  };

  try {
    signal(authenticatedOwner.pid, "SIGSTOP");
    stopped = true;
    const stoppedOwner = await waitUntilAsync(
      () => {
        const current = inspectOwner(options, deps);
        if (!current || !sameOwner(authenticatedOwner, current)) {
          throw new Error("Portable host lock owner changed after SIGSTOP");
        }
        return current.state === "T" || current.state === "t";
      },
      { ...waitOptions, deadlineMs: now() + STOP_CONFIRM_MS },
    );
    if (!stoppedOwner) {
      throw new Error("Portable host lock owner did not stop before the overlap deadline");
    }
    return { pid: authenticatedOwner.pid, resume };
  } catch (error) {
    await resume();
    throw error;
  }
}
