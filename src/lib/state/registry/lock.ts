// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isErrnoException } from "../../core/errno";
import { ensureConfigDir } from "../config-io";
import { REGISTRY_FILE } from "./persistence";

export const LOCK_DIR = `${REGISTRY_FILE}.lock`;
export const LOCK_OWNER = path.join(LOCK_DIR, "owner");
export const LOCK_PROCESS_START = path.join(LOCK_DIR, "process-start");
export const LOCK_STALE_MS = 10_000;
export const LOCK_RETRY_MS = 100;
export const LOCK_MAX_RETRIES = 120;
const BOOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

type Paths = { readonly directory: string; readonly owner: string; readonly processStart: string };
type Identity = { readonly device: bigint; readonly inode: bigint };
type Generation = Identity & { readonly paths: Paths };
type Acquired = Generation & { readonly ownerFile: Identity; readonly processFile: Identity | null; readonly processRecord: string | null };

export interface RegistryLockDeps { readonly isProcessAlive?: (pid: number) => boolean; readonly maxRetries?: number; readonly now?: () => number; readonly readProcessIdentity?: (pid: number) => string | null; readonly wait?: () => void }
export type RegistryOwnerStatus = "ordinary" | "original" | "recycled" | "unverifiable";
export type RegistryLockDecision = "break" | "wait";
export type ProcessBoundLockHandle = object;

export class ProcessBoundLockContentionError extends Error {
  constructor(directory: string, retries: number) {
    super(`Failed to acquire lock on ${directory} after ${String(retries)} retries`);
    this.name = "ProcessBoundLockContentionError";
  }
}

const handles = new WeakMap<ProcessBoundLockHandle, Acquired>();
const at = (directory: string): Paths => ({ directory, owner: path.join(directory, "owner"), processStart: path.join(directory, "process-start") });
const identity = (target: string): Identity | null => {
  try {
    const stat = fs.lstatSync(target, { bigint: true });
    return { device: stat.dev, inode: stat.ino };
  } catch {
    return null;
  }
};
const sameIdentity = (left: Identity | null, right: Identity | null): boolean => left?.device === right?.device && left?.inode === right?.inode;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function processIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const tick = close < 0 ? undefined : stat.slice(close + 2).trim().split(/\s+/u)[19];
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return tick && /^[1-9][0-9]*$/u.test(tick) && BOOT_ID.test(boot) ? `${boot} ${tick}` : null;
  } catch {
    return null;
  }
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"] as const).every((key) => left[key] === right[key]);
}

function readOwnedFile(target: string, limit: number, requireUid: boolean): string | null {
  let descriptor: number | null = null;
  try {
    const uid = process.getuid?.();
    if (requireUid && uid === undefined) return null;
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW));
    const before = fs.fstatSync(descriptor, { bigint: true });
    const pathBefore = fs.lstatSync(target, { bigint: true });
    if (!before.isFile() || !pathBefore.isFile() || pathBefore.isSymbolicLink() || !sameFile(before, pathBefore) || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit) || (uid !== undefined && (before.uid !== BigInt(uid) || (before.mode & 0o777n) !== 0o600n)))
      return null;
    const bytes = Buffer.alloc(Number(before.size));
    const read = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(target, { bigint: true });
    return read === bytes.length && sameFile(before, after) && sameFile(before, pathAfter) ? bytes.toString("utf8") : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function ownerPid(target: string): number | null {
  const value = readOwnedFile(target, 32, false);
  if (value === null || !/^[1-9][0-9]{0,15}\n?$/u.test(value)) return null;
  const pid = Number(value.trim());
  return Number.isSafeInteger(pid) ? pid : null;
}

function readProcessRecord(target: string, pid: number): string | null {
  const value = readOwnedFile(target, 128, true);
  const match = value && /^([1-9][0-9]{0,15}) ([0-9a-f-]{36}) ([1-9][0-9]*)\n?$/u.exec(value);
  return match && match[1] === String(pid) && BOOT_ID.test(match[2]!)
    ? `${match[1]} ${match[2]} ${match[3]}`
    : null;
}

export function classifyExistingLock(options: { ownerAlive: boolean; ownerPid: number | null; ownerStatus: RegistryOwnerStatus; lockMtimeMs: number; nowMs: number; staleMs: number }): RegistryLockDecision {
  if (options.ownerPid === null)
    return options.nowMs - options.lockMtimeMs > options.staleMs ? "break" : "wait";
  if (!options.ownerAlive || options.ownerStatus === "recycled") return "break";
  if (options.ownerStatus !== "ordinary") return "wait";
  return options.nowMs - options.lockMtimeMs > options.staleMs ? "break" : "wait";
}

function status(pid: number, alive: boolean, record: string | null, read: (pid: number) => string | null): RegistryOwnerStatus {
  if (record === null) return alive && read(pid) === null ? "unverifiable" : "ordinary";
  if (!alive) return "recycled";
  const current = read(pid);
  return current === null ? "unverifiable" : record === `${String(pid)} ${current}` ? "original" : "recycled";
}

function sameGeneration(generation: Generation): boolean {
  const current = identity(generation.paths.directory);
  return sameIdentity(current, generation);
}

/** Atomically detach one generation; never restore or sweep an ambiguous generation. */
function removeGeneration(generation: Generation, files: readonly (readonly [string, Identity])[], validate: (paths: Paths) => boolean): void {
  const quarantine = `${generation.paths.directory}.quarantine.${String(process.pid)}.${crypto.randomUUID()}`;
  fs.renameSync(generation.paths.directory, quarantine);
  const detached = { ...identity(quarantine)!, paths: at(quarantine) };
  const mapped = files.map(([target, expected]) => [path.join(quarantine, path.basename(target)), expected] as const);
  const names = mapped.map(([target]) => path.basename(target)).sort();
  const exactNames = JSON.stringify(fs.readdirSync(quarantine).sort()) === JSON.stringify(names);
  if (!sameIdentity(detached, generation) || !sameGeneration(detached) || !exactNames || mapped.some(([target, expected]) => !sameIdentity(identity(target), expected)) || !validate(detached.paths))
    throw new Error("Registry lock changed ownership");
  fs.rmSync(quarantine, { recursive: true });
}

function tryRemove(generation: Generation, pid: number | null, owner: Identity | null, record: string | null, processFile: Identity | null, mtimeNs: bigint): boolean {
  const files: [string, Identity][] = [];
  if (owner) files.push([generation.paths.owner, owner]);
  if (processFile) files.push([generation.paths.processStart, processFile]);
  try {
    removeGeneration(generation, files, (paths) => fs.lstatSync(paths.directory, { bigint: true }).mtimeNs === mtimeNs && ownerPid(paths.owner) === pid && (pid === null || readProcessRecord(paths.processStart, pid) === record));
    return true;
  } catch {
    return false;
  }
}

function acquire(directory: string, exact: boolean, deps: RegistryLockDeps): Acquired {
  const readIdentity = deps.readProcessIdentity ?? processIdentity;
  const initialIdentity = readIdentity(process.pid);
  if (exact && (initialIdentity === null || process.getuid?.() === undefined))
    throw new Error("Portable registry locking requires an exact Linux process-start identity");
  const paths = at(directory);
  const alive = deps.isProcessAlive ?? isProcessAlive;
  const retries = deps.maxRetries ?? LOCK_MAX_RETRIES;
  const now = deps.now ?? Date.now;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  const wait = deps.wait ?? (() => Atomics.wait(sleep, 0, 0, LOCK_RETRY_MS));
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      let lock: fs.BigIntStats;
      try {
        lock = fs.lstatSync(directory, { bigint: true });
      } catch (statError) {
        if (isErrnoException(statError) && statError.code === "ENOENT") continue;
        throw statError;
      }
      if (!lock.isDirectory() || lock.isSymbolicLink())
        throw new Error(`Registry lock '${directory}' is not a real directory`);
      const pid = ownerPid(paths.owner);
      const owner = identity(paths.owner);
      const live = pid !== null && alive(pid);
      const record = pid === null ? null : readProcessRecord(paths.processStart, pid);
      const processFile = identity(paths.processStart);
      const decision = classifyExistingLock({
        ownerAlive: live, ownerPid: pid,
        ownerStatus: pid === null ? "ordinary" : status(pid, live, record, readIdentity),
        lockMtimeMs: Number(lock.mtimeMs), nowMs: now(), staleMs: LOCK_STALE_MS,
      });
      if (decision === "break" && tryRemove({ device: lock.dev, inode: lock.ino, paths }, pid, owner, record, processFile, lock.mtimeNs))
        continue;
      wait();
      continue;
    }

    const lock = fs.lstatSync(directory, { bigint: true });
    const generation: Generation = { device: lock.dev, inode: lock.ino, paths };
    const temporary = `${paths.owner}.tmp.${String(process.pid)}.${crypto.randomUUID()}`;
    let temporaryFile: Identity | null = null;
    let ownerFile: Identity | null = null;
    let record: string | null = null;
    let processFile: Identity | null = null;
    try {
      fs.writeFileSync(temporary, String(process.pid), { flag: "wx", mode: 0o600 });
      temporaryFile = identity(temporary);
      fs.renameSync(temporary, paths.owner);
      ownerFile = temporaryFile;
      temporaryFile = null;
      if (initialIdentity !== null) {
        record = `${String(process.pid)} ${initialIdentity}`;
        fs.writeFileSync(paths.processStart, `${record}\n`, { flag: "wx", mode: 0o600 });
        processFile = identity(paths.processStart);
      }
      const invalidProcessFile = record !== null &&
        (processFile === null || !sameIdentity(identity(paths.processStart), processFile) || readProcessRecord(paths.processStart, process.pid) !== record);
      if (ownerFile === null || !sameGeneration(generation) || !sameIdentity(identity(paths.owner), ownerFile) || ownerPid(paths.owner) !== process.pid || invalidProcessFile || (exact && readIdentity(process.pid) !== initialIdentity))
        throw new Error("Registry lock identity changed during acquisition");
    } catch (error) {
      const files: [string, Identity][] = [];
      if (temporaryFile) files.push([temporary, temporaryFile]);
      if (ownerFile) files.push([paths.owner, ownerFile]);
      if (processFile) files.push([paths.processStart, processFile]);
      try {
        removeGeneration(generation, files, () => true);
      } catch {
        // An ambiguous detached generation is intentionally preserved.
      }
      throw error;
    }
    return { ...generation, ownerFile, processFile, processRecord: record };
  }
  throw new ProcessBoundLockContentionError(directory, retries);
}

function release(acquired: Acquired): void {
  const files: [string, Identity][] = [[acquired.paths.owner, acquired.ownerFile]];
  if (acquired.processFile) files.push([acquired.paths.processStart, acquired.processFile]);
  try {
    removeGeneration(acquired, files, (paths) => ownerPid(paths.owner) === process.pid && readProcessRecord(paths.processStart, process.pid) === acquired.processRecord);
  } catch {
    throw new Error(`Registry lock '${acquired.paths.directory}' changed ownership`);
  }
}

let compatibility: Acquired | null = null;

export function acquireLock(): void {
  ensureConfigDir(path.dirname(REGISTRY_FILE));
  if (compatibility) throw new Error(`Registry lock '${LOCK_DIR}' is already acquired`);
  compatibility = acquire(LOCK_DIR, false, {});
}
export function releaseLock(): void {
  if (!compatibility) throw new Error(`Registry lock '${LOCK_DIR}' is not acquired`);
  const lock = compatibility;
  compatibility = null;
  release(lock);
}
export function withLock<T>(operation: () => T): T {
  acquireLock();
  try {
    return operation();
  } finally {
    releaseLock();
  }
}
function withAcquired<T>(directory: string, exact: boolean, operation: () => T, deps: RegistryLockDeps): T {
  const lock = acquire(directory, exact, deps);
  try {
    return operation();
  } finally {
    release(lock);
  }
}
export function withRegistryLockAt<T>(registryFile: string, operation: () => T, deps: RegistryLockDeps = {}): T {
  return withAcquired(`${registryFile}.lock`, false, operation, deps);
}
export function withProcessBoundRegistryLockAt<T>(registryFile: string, operation: () => T, deps: RegistryLockDeps = {}): T {
  return withAcquired(`${registryFile}.lock`, true, operation, deps);
}
export function acquireProcessBoundLockAt(lockDirectory: string, deps: RegistryLockDeps = {}): ProcessBoundLockHandle {
  const handle = {};
  handles.set(handle, acquire(lockDirectory, process.platform === "linux", deps));
  return handle;
}
export function releaseProcessBoundLock(handle: ProcessBoundLockHandle): void {
  const lock = handles.get(handle);
  if (!lock) throw new Error("Process-bound registry lock handle is inactive");
  handles.delete(handle);
  release(lock);
}
