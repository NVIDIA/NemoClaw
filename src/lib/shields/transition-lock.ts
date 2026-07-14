// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NAME_ALLOWED_FORMAT, NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../name-validation";
import { resolveNemoclawStateDir } from "../state/paths";
import { isProcessAlive, readProcessStartIdentity } from "./timer-control";

const LOCK_VERSION = 1;
const MAX_OWNER_BYTES = 16 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_MALFORMED_STALE_MS = 30_000;
const TAKEOVER_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

export interface ShieldsTransitionLockOwner {
  version: 1;
  sandboxName: string;
  pid: number;
  processStartIdentity: string;
  command: string;
  acquiredAtMs: number;
  takeoverToken?: string;
}

export interface ShieldsTransitionLockOptions {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  malformedStaleMs?: number;
  takeoverToken?: string;
}

export interface ShieldsTransitionLockDependencies {
  stateDir?: string;
  pid?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => void;
  sleepAsync?: (milliseconds: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartIdentity?: (pid: number) => string | null;
}

interface InodeIdentity {
  dev: bigint;
  ino: bigint;
}

class DeferredTransitionProcessExit extends Error {
  readonly exitCode: string | number | null | undefined;

  constructor(exitCode: string | number | null | undefined) {
    super(
      `process.exit(${String(exitCode ?? 0)}) requested while a shields transition lock is held`,
    );
    this.name = "DeferredTransitionProcessExit";
    this.exitCode = exitCode;
  }
}

interface ExistingLockSnapshot {
  fd: number;
  identity: InodeIdentity;
  mtimeMs: number;
  owner: ShieldsTransitionLockOwner | null;
}

interface HeldLock {
  fd: number;
  identity: InodeIdentity;
  lockPath: string;
  depth: number;
  ownerToken: symbol;
  owner: ShieldsTransitionLockOwner;
}

interface AcquisitionState {
  lockPath: string;
  owner: ShieldsTransitionLockOwner;
  startedAtMs: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  malformedStaleMs: number;
}

type WaitReason =
  | { kind: "live"; owner: ShieldsTransitionLockOwner }
  | { kind: "same-process"; owner: ShieldsTransitionLockOwner }
  | { kind: "identity-unavailable"; owner: ShieldsTransitionLockOwner }
  | { kind: "recent-malformed"; ageMs: number }
  | { kind: "stale-malformed"; ageMs: number }
  | { kind: "dead"; owner: ShieldsTransitionLockOwner }
  | {
      kind: "pid-reused";
      owner: ShieldsTransitionLockOwner;
      currentProcessStartIdentity: string;
    };

export interface InspectedShieldsTransitionOwner {
  pid: number;
  processStartIdentity: string;
  command: string;
}

export type ShieldsTransitionTakeoverReason =
  | "removed-dead-owner"
  | "removed-reused-pid"
  | "missing"
  | "owner-mismatch"
  | "owner-live"
  | "owner-identity-unavailable"
  | "path-changed"
  | "replacement-preserved";

export interface ShieldsTransitionTakeoverResult {
  removed: boolean;
  reason: ShieldsTransitionTakeoverReason;
  quarantinePath?: string;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function inodeIdentity(stat: fs.BigIntStats): InodeIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameInode(left: InodeIdentity, right: InodeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireNonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function requireTakeoverToken(token: string, label = "takeoverToken"): string {
  if (!TAKEOVER_TOKEN_PATTERN.test(token)) {
    throw new Error(`${label} must be exactly 32 lowercase hexadecimal characters`);
  }
  return token;
}

function optionalTakeoverToken(token: string | undefined): string | undefined {
  return token === undefined ? undefined : requireTakeoverToken(token);
}

function validateSandboxName(name: string): string {
  if (!name || typeof name !== "string") {
    throw new Error(`sandbox name is required. Allowed format: ${NAME_ALLOWED_FORMAT}.`);
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new Error(
      `sandbox name too long (max ${String(NAME_MAX_LENGTH)} chars). Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }
  if (!NAME_VALID_PATTERN.test(name)) {
    throw new Error(`Invalid sandbox name: '${name}'. Allowed format: ${NAME_ALLOWED_FORMAT}.`);
  }
  return name;
}

function parseOwner(raw: string, sandboxName: string): ShieldsTransitionLockOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const owner = value as Record<string, unknown>;
  if (
    owner.version !== LOCK_VERSION ||
    owner.sandboxName !== sandboxName ||
    typeof owner.pid !== "number" ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.processStartIdentity !== "string" ||
    owner.processStartIdentity.length === 0 ||
    typeof owner.command !== "string" ||
    owner.command.length === 0 ||
    typeof owner.acquiredAtMs !== "number" ||
    !Number.isFinite(owner.acquiredAtMs) ||
    (owner.takeoverToken !== undefined &&
      (typeof owner.takeoverToken !== "string" ||
        !TAKEOVER_TOKEN_PATTERN.test(owner.takeoverToken)))
  ) {
    return null;
  }
  return owner as unknown as ShieldsTransitionLockOwner;
}

function unsafeLockPathError(lockPath: string, reason: string): Error {
  return new Error(`Unsafe shields transition lock '${lockPath}': ${reason}`);
}

function readExistingLock(lockPath: string, sandboxName: string): ExistingLockSnapshot | null {
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(lockPath, { bigint: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (pathStat.isSymbolicLink()) {
    throw unsafeLockPathError(lockPath, "symbolic links are not allowed");
  }
  if (!pathStat.isFile()) {
    throw unsafeLockPathError(lockPath, "path is not a regular file");
  }

  let fd: number;
  try {
    fd = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    if (isErrnoException(error) && error.code === "ELOOP") {
      throw unsafeLockPathError(lockPath, "symbolic links are not allowed");
    }
    throw error;
  }

  try {
    const fdStat = fs.fstatSync(fd, { bigint: true });
    if (!fdStat.isFile()) {
      throw unsafeLockPathError(lockPath, "path is not a regular file");
    }
    if (!sameInode(inodeIdentity(pathStat), inodeIdentity(fdStat))) {
      fs.closeSync(fd);
      return null;
    }

    const buffer = Buffer.alloc(MAX_OWNER_BYTES + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const owner =
      bytesRead > MAX_OWNER_BYTES
        ? null
        : parseOwner(buffer.subarray(0, bytesRead).toString("utf8"), sandboxName);
    return {
      fd,
      identity: inodeIdentity(fdStat),
      mtimeMs: Number(fdStat.mtimeMs),
      owner,
    };
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Preserve the inspection error.
    }
    throw error;
  }
}

function closeSnapshot(snapshot: ExistingLockSnapshot): void {
  try {
    fs.closeSync(snapshot.fd);
  } catch {
    // The snapshot is advisory after inspection; there is nothing safe to clean up here.
  }
}

function defaultSleep(milliseconds: number): void {
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function defaultSleepAsync(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function staleRecovery(lockPath: string): string {
  return `NemoClaw will not remove a stale lock pathname automatically because another process could replace it after inspection. Verify that no shields transition is active, remove '${lockPath}' manually, and retry.`;
}

function formatWaitReason(reason: WaitReason | null, lockPath: string): string {
  if (!reason) return "the lock changed during inspection; retry the command";
  if (reason.kind === "recent-malformed") {
    return `the owner record is incomplete and only ${Math.max(0, Math.floor(reason.ageMs))}ms old. Retry after the writer finishes`;
  }
  if (reason.kind === "stale-malformed") {
    return `the owner record is incomplete and ${Math.max(0, Math.floor(reason.ageMs))}ms old. ${staleRecovery(lockPath)}`;
  }
  const owner = reason.owner;
  if (reason.kind === "dead") {
    return `recorded owner PID ${String(owner.pid)} is not running (${owner.command}). ${staleRecovery(lockPath)}`;
  }
  if (reason.kind === "pid-reused") {
    return `recorded owner PID ${String(owner.pid)} now has process-start identity '${reason.currentProcessStartIdentity}' instead of '${owner.processStartIdentity}' (${owner.command}). ${staleRecovery(lockPath)}`;
  }
  if (reason.kind === "identity-unavailable") {
    return `PID ${String(owner.pid)} is alive but its process-start identity cannot be verified (${owner.command}). Verify the active process and retry`;
  }
  if (reason.kind === "same-process") {
    return `another async chain in this process still owns the lock (${owner.command}). Wait for that operation to finish and retry`;
  }
  return `PID ${String(owner.pid)} is still running (${owner.command}). Wait for that operation to finish and retry`;
}

export function shieldsTransitionLockPath(
  sandboxName: string,
  stateDir: string = resolveNemoclawStateDir(),
): string {
  const validName = validateSandboxName(sandboxName);
  return path.join(stateDir, `shields-transition-lock-${validName}.json`);
}

export class ShieldsTransitionLockManager {
  private readonly stateDir: string;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => void;
  private readonly sleepAsync: (milliseconds: number) => Promise<void>;
  private readonly processIsAlive: (pid: number) => boolean;
  private readonly processStartIdentity: (pid: number) => string | null;
  private readonly held = new Map<string, HeldLock>();
  private readonly ownership = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();

  constructor(deps: ShieldsTransitionLockDependencies = {}) {
    this.stateDir = deps.stateDir ?? resolveNemoclawStateDir();
    this.pid = deps.pid ?? process.pid;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.sleepAsync = deps.sleepAsync ?? defaultSleepAsync;
    this.processIsAlive = deps.isProcessAlive ?? isProcessAlive;
    this.processStartIdentity = deps.readProcessStartIdentity ?? readProcessStartIdentity;
  }

  withShieldsTransitionLock<T>(
    sandboxName: string,
    command: string,
    fn: () => T,
    options: ShieldsTransitionLockOptions = {},
  ): T {
    const validName = validateSandboxName(sandboxName);
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error("shields transition command is required");
    }
    const requestedTakeoverToken = optionalTakeoverToken(options.takeoverToken);
    const existing = this.reentrantLock(validName);
    if (existing) {
      if (
        requestedTakeoverToken !== undefined &&
        requestedTakeoverToken !== existing.owner.takeoverToken
      ) {
        throw new Error("reentrant shields transition takeoverToken does not match the owner");
      }
      this.assertHeldPath(existing);
      existing.depth += 1;
      try {
        return fn();
      } finally {
        this.release(validName, existing);
      }
    }

    const held = this.acquire(validName, command, options);
    this.held.set(validName, held);
    const originalExit = process.exit;
    let deferredExit: DeferredTransitionProcessExit | null = null;
    try {
      // Legacy runner/policy helpers may call process.exit on command failure.
      // A real exit skips finally blocks, so translate it into an exception
      // while this synchronous callback owns the lock. Reentrant callbacks
      // inherit the same guard and propagate the sentinel to this outer owner.
      process.exit = ((code?: string | number | null): never => {
        throw new DeferredTransitionProcessExit(code);
      }) as typeof process.exit;
      try {
        return this.ownership.run(this.ownershipContext(validName, held.ownerToken), fn);
      } catch (error) {
        if (!(error instanceof DeferredTransitionProcessExit)) throw error;
        deferredExit = error;
      }
    } finally {
      process.exit = originalExit;
      this.release(validName, held);
    }
    if (deferredExit) {
      originalExit(deferredExit.exitCode);
    }
    throw new Error("unreachable: deferred process exit did not terminate");
  }

  async withShieldsTransitionLockAsync<T>(
    sandboxName: string,
    command: string,
    fn: () => Promise<T>,
    options: ShieldsTransitionLockOptions = {},
  ): Promise<T> {
    const validName = validateSandboxName(sandboxName);
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error("shields transition command is required");
    }
    const requestedTakeoverToken = optionalTakeoverToken(options.takeoverToken);
    const existing = this.reentrantLock(validName);
    if (existing) {
      if (
        requestedTakeoverToken !== undefined &&
        requestedTakeoverToken !== existing.owner.takeoverToken
      ) {
        throw new Error("reentrant shields transition takeoverToken does not match the owner");
      }
      this.assertHeldPath(existing);
      existing.depth += 1;
      try {
        return await fn();
      } finally {
        this.release(validName, existing);
      }
    }

    const held = await this.acquireAsync(validName, command, options);
    this.held.set(validName, held);
    try {
      return await this.ownership.run(this.ownershipContext(validName, held.ownerToken), fn);
    } finally {
      this.release(validName, held);
    }
  }

  inspectShieldsTransitionLockOwner(
    sandboxName: string,
    takeoverToken: string,
  ): InspectedShieldsTransitionOwner | null {
    const validName = validateSandboxName(sandboxName);
    const validToken = requireTakeoverToken(takeoverToken);
    const lockPath = shieldsTransitionLockPath(validName, this.stateDir);
    const snapshot = readExistingLock(lockPath, validName);
    if (!snapshot) return null;
    try {
      const owner = snapshot.owner;
      if (!owner || owner.takeoverToken !== validToken) return null;
      return {
        pid: owner.pid,
        processStartIdentity: owner.processStartIdentity,
        command: owner.command,
      };
    } finally {
      closeSnapshot(snapshot);
    }
  }

  takeoverShieldsTransitionLock(
    sandboxName: string,
    expectedOwnerPid: number,
    expectedOwnerStartIdentity: string,
    takeoverToken: string,
  ): ShieldsTransitionTakeoverResult {
    const validName = validateSandboxName(sandboxName);
    if (!Number.isInteger(expectedOwnerPid) || expectedOwnerPid <= 0) {
      throw new Error("expectedOwnerPid must be a positive integer");
    }
    if (typeof expectedOwnerStartIdentity !== "string" || expectedOwnerStartIdentity.length === 0) {
      throw new Error("expectedOwnerStartIdentity is required");
    }
    const validToken = requireTakeoverToken(takeoverToken);
    const lockPath = shieldsTransitionLockPath(validName, this.stateDir);
    const snapshot = readExistingLock(lockPath, validName);
    if (!snapshot) return { removed: false, reason: "missing" };

    try {
      const owner = snapshot.owner;
      if (
        !owner ||
        owner.pid !== expectedOwnerPid ||
        owner.processStartIdentity !== expectedOwnerStartIdentity ||
        owner.takeoverToken !== validToken
      ) {
        return { removed: false, reason: "owner-mismatch" };
      }

      let removalReason: Extract<
        ShieldsTransitionTakeoverReason,
        "removed-dead-owner" | "removed-reused-pid"
      >;
      if (!this.processIsAlive(owner.pid)) {
        removalReason = "removed-dead-owner";
      } else {
        const currentIdentity = this.processStartIdentity(owner.pid);
        if (!currentIdentity) {
          return { removed: false, reason: "owner-identity-unavailable" };
        }
        if (currentIdentity === owner.processStartIdentity) {
          return { removed: false, reason: "owner-live" };
        }
        removalReason = "removed-reused-pid";
      }

      const current = this.currentRegularLockIdentity(lockPath);
      if (!current || !sameInode(current, snapshot.identity)) {
        return { removed: false, reason: "path-changed" };
      }

      const quarantineDir = fs.mkdtempSync(`${lockPath}.takeover-${validToken}-`);
      fs.chmodSync(quarantineDir, 0o700);
      const quarantinePath = path.join(quarantineDir, "owner.json");
      try {
        fs.renameSync(lockPath, quarantinePath);
      } catch (error) {
        this.removeEmptyQuarantine(quarantineDir);
        if (isErrnoException(error) && error.code === "ENOENT") {
          return { removed: false, reason: "path-changed" };
        }
        throw error;
      }

      const moved = readExistingLock(quarantinePath, validName);
      if (!moved) {
        return { removed: false, reason: "replacement-preserved", quarantinePath };
      }
      try {
        const movedOwner = moved.owner;
        const movedMatches =
          sameInode(moved.identity, snapshot.identity) &&
          movedOwner?.pid === expectedOwnerPid &&
          movedOwner.processStartIdentity === expectedOwnerStartIdentity &&
          movedOwner.takeoverToken === validToken;
        if (!movedMatches) {
          this.restoreQuarantinedReplacement(lockPath, quarantinePath);
          return { removed: false, reason: "replacement-preserved", quarantinePath };
        }

        const currentQuarantine = this.currentRegularLockIdentity(quarantinePath);
        if (!currentQuarantine || !sameInode(currentQuarantine, moved.identity)) {
          this.restoreQuarantinedReplacement(lockPath, quarantinePath);
          return { removed: false, reason: "replacement-preserved", quarantinePath };
        }
        fs.unlinkSync(quarantinePath);
      } finally {
        closeSnapshot(moved);
      }
      this.removeEmptyQuarantine(quarantineDir);
      return { removed: true, reason: removalReason };
    } finally {
      closeSnapshot(snapshot);
    }
  }

  private currentRegularLockIdentity(lockPath: string): InodeIdentity | null {
    try {
      const stat = fs.lstatSync(lockPath, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw unsafeLockPathError(lockPath, "symbolic links are not allowed");
      }
      if (!stat.isFile()) {
        throw unsafeLockPathError(lockPath, "path is not a regular file");
      }
      return inodeIdentity(stat);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private restoreQuarantinedReplacement(lockPath: string, quarantinePath: string): void {
    let quarantineStat: fs.BigIntStats;
    try {
      quarantineStat = fs.lstatSync(quarantinePath, { bigint: true });
    } catch {
      return;
    }
    if (!quarantineStat.isFile()) return;
    try {
      fs.linkSync(quarantinePath, lockPath);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      // A newer owner already occupies the canonical path. Preserve both it
      // and the quarantined replacement for explicit recovery.
    }
  }

  private removeEmptyQuarantine(quarantineDir: string): void {
    try {
      fs.rmdirSync(quarantineDir);
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTEMPTY")) {
        throw error;
      }
    }
  }

  private reentrantLock(sandboxName: string): HeldLock | null {
    const existing = this.held.get(sandboxName);
    if (!existing) return null;
    return this.ownership.getStore()?.get(sandboxName) === existing.ownerToken ? existing : null;
  }

  private ownershipContext(sandboxName: string, ownerToken: symbol): ReadonlyMap<string, symbol> {
    const context = new Map(this.ownership.getStore() ?? []);
    context.set(sandboxName, ownerToken);
    return context;
  }

  private acquire(
    sandboxName: string,
    command: string,
    options: ShieldsTransitionLockOptions,
  ): HeldLock {
    const state = this.acquisitionState(sandboxName, command, options);
    let lastWaitReason: WaitReason | null = null;

    while (true) {
      const inProcess = this.held.get(sandboxName);
      if (inProcess) {
        lastWaitReason = { kind: "same-process", owner: inProcess.owner };
      } else {
        const created = this.tryCreate(state.lockPath, state.owner);
        if (created) return created;
        const observed = this.observeWaitReason(
          state.lockPath,
          sandboxName,
          state.malformedStaleMs,
        );
        if (!observed) continue;
        lastWaitReason = observed;
      }
      this.sleep(this.waitDuration(state, lastWaitReason));
    }
  }

  private async acquireAsync(
    sandboxName: string,
    command: string,
    options: ShieldsTransitionLockOptions,
  ): Promise<HeldLock> {
    const state = this.acquisitionState(sandboxName, command, options);
    let lastWaitReason: WaitReason | null = null;

    while (true) {
      const inProcess = this.held.get(sandboxName);
      if (inProcess) {
        lastWaitReason = { kind: "same-process", owner: inProcess.owner };
      } else {
        const created = this.tryCreate(state.lockPath, state.owner);
        if (created) return created;
        const observed = this.observeWaitReason(
          state.lockPath,
          sandboxName,
          state.malformedStaleMs,
        );
        if (!observed) continue;
        lastWaitReason = observed;
      }
      await this.sleepAsync(this.waitDuration(state, lastWaitReason));
    }
  }

  private acquisitionState(
    sandboxName: string,
    command: string,
    options: ShieldsTransitionLockOptions,
  ): AcquisitionState {
    const waitTimeoutMs = requireNonNegativeFinite(
      options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
      "waitTimeoutMs",
    );
    const pollIntervalMs = requireNonNegativeFinite(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    const malformedStaleMs = requireNonNegativeFinite(
      options.malformedStaleMs ?? DEFAULT_MALFORMED_STALE_MS,
      "malformedStaleMs",
    );
    const ownerStartIdentity = this.processStartIdentity(this.pid);
    if (!ownerStartIdentity) {
      throw new Error(
        `Cannot acquire shields transition lock: process-start identity for PID ${String(this.pid)} is unavailable`,
      );
    }

    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const lockPath = shieldsTransitionLockPath(sandboxName, this.stateDir);
    const acquiredAtMs = this.now();
    const takeoverToken = optionalTakeoverToken(options.takeoverToken);
    return {
      lockPath,
      owner: {
        version: LOCK_VERSION,
        sandboxName,
        pid: this.pid,
        processStartIdentity: ownerStartIdentity,
        command,
        acquiredAtMs,
        ...(takeoverToken ? { takeoverToken } : {}),
      },
      startedAtMs: acquiredAtMs,
      waitTimeoutMs,
      pollIntervalMs,
      malformedStaleMs,
    };
  }

  private observeWaitReason(
    lockPath: string,
    sandboxName: string,
    malformedStaleMs: number,
  ): WaitReason | null {
    const snapshot = readExistingLock(lockPath, sandboxName);
    if (!snapshot) return null;
    try {
      const owner = snapshot.owner;
      if (!owner) {
        const ageMs = Math.max(0, this.now() - snapshot.mtimeMs);
        return ageMs >= malformedStaleMs
          ? { kind: "stale-malformed", ageMs }
          : { kind: "recent-malformed", ageMs };
      }
      if (!this.processIsAlive(owner.pid)) return { kind: "dead", owner };
      const currentIdentity = this.processStartIdentity(owner.pid);
      if (!currentIdentity) return { kind: "identity-unavailable", owner };
      if (currentIdentity !== owner.processStartIdentity) {
        return { kind: "pid-reused", owner, currentProcessStartIdentity: currentIdentity };
      }
      return { kind: "live", owner };
    } finally {
      closeSnapshot(snapshot);
    }
  }

  private waitDuration(state: AcquisitionState, reason: WaitReason | null): number {
    const elapsedMs = Math.max(0, this.now() - state.startedAtMs);
    if (elapsedMs >= state.waitTimeoutMs) {
      throw new Error(
        `Timed out after ${String(state.waitTimeoutMs)}ms waiting for shields transition lock '${state.lockPath}': ${formatWaitReason(reason, state.lockPath)}`,
      );
    }
    return Math.min(state.pollIntervalMs, state.waitTimeoutMs - elapsedMs);
  }

  private tryCreate(lockPath: string, owner: ShieldsTransitionLockOwner): HeldLock | null {
    // Avoid temp-inode/fsync churn for the common waiter path. This check is
    // advisory only: link(2) below remains the no-overwrite race authority.
    try {
      fs.lstatSync(lockPath);
      return null;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    }
    const tempPath = `${lockPath}.acquire-${String(this.pid)}-${randomBytes(16).toString("hex")}.tmp`;
    let fd: number;
    try {
      fd = fs.openSync(
        tempPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (isErrnoException(error) && error.code === "ELOOP") {
        throw unsafeLockPathError(tempPath, "symbolic links are not allowed");
      }
      throw error;
    }

    try {
      const fdStat = fs.fstatSync(fd, { bigint: true });
      if (!fdStat.isFile()) {
        throw unsafeLockPathError(tempPath, "new lock is not a regular file");
      }
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      fs.fsyncSync(fd);
      try {
        // Publish only a complete, durable owner record. link(2) is atomic and
        // refuses to overwrite an existing canonical lock, so a crash before
        // this point leaves at most an unreferenced temp inode and a crash
        // after it leaves a parseable token/identity record.
        fs.linkSync(tempPath, lockPath);
      } catch (error) {
        if (isErrnoException(error) && error.code === "EEXIST") {
          fs.closeSync(fd);
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // The unpublished temp file is inert and can be cleaned manually.
          }
          return null;
        }
        throw error;
      }
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // The canonical hard link is already complete and authoritative. A
        // leftover root-only temp link is inert and must not fail acquisition.
      }
      return {
        fd,
        identity: inodeIdentity(fdStat),
        lockPath,
        depth: 1,
        ownerToken: Symbol("shields-transition-lock-owner"),
        owner,
      };
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the creation error.
      }
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Preserve the creation error. The temp path is never authoritative.
      }
      throw error;
    }
  }

  private assertHeldPath(held: HeldLock): void {
    const fdStat = fs.fstatSync(held.fd, { bigint: true });
    let pathStat: fs.BigIntStats;
    try {
      pathStat = fs.lstatSync(held.lockPath, { bigint: true });
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        throw new Error(`Shields transition lock '${held.lockPath}' disappeared while held`);
      }
      throw error;
    }
    if (!pathStat.isFile() || !sameInode(inodeIdentity(pathStat), inodeIdentity(fdStat))) {
      throw new Error(`Shields transition lock '${held.lockPath}' was replaced while held`);
    }
  }

  private release(sandboxName: string, held: HeldLock): void {
    if (this.held.get(sandboxName) !== held) return;
    held.depth -= 1;
    if (held.depth > 0) return;
    this.held.delete(sandboxName);

    try {
      const heldIdentity = inodeIdentity(fs.fstatSync(held.fd, { bigint: true }));
      const quarantineDir = fs.mkdtempSync(`${held.lockPath}.release-`);
      fs.chmodSync(quarantineDir, 0o700);
      const quarantinePath = path.join(quarantineDir, "owner.json");
      try {
        fs.renameSync(held.lockPath, quarantinePath);
      } catch (error) {
        this.removeEmptyQuarantine(quarantineDir);
        if (isErrnoException(error) && error.code === "ENOENT") return;
        throw error;
      }

      const moved = readExistingLock(quarantinePath, sandboxName);
      if (!moved || !sameInode(moved.identity, heldIdentity)) {
        if (moved) closeSnapshot(moved);
        this.restoreQuarantinedReplacement(held.lockPath, quarantinePath);
        // Never delete a replacement that appeared while the owner was
        // releasing. Keep it canonical (and quarantined as a forensic hard
        // link) so the next command fails closed on that owner's record.
        return;
      }
      closeSnapshot(moved);
      fs.unlinkSync(quarantinePath);
      this.removeEmptyQuarantine(quarantineDir);
    } finally {
      fs.closeSync(held.fd);
    }
  }
}

const defaultManager = new ShieldsTransitionLockManager();

export function withShieldsTransitionLock<T>(
  sandboxName: string,
  command: string,
  fn: () => T,
  options: ShieldsTransitionLockOptions = {},
): T {
  return defaultManager.withShieldsTransitionLock(sandboxName, command, fn, options);
}

export function withShieldsTransitionLockAsync<T>(
  sandboxName: string,
  command: string,
  fn: () => Promise<T>,
  options: ShieldsTransitionLockOptions = {},
): Promise<T> {
  return defaultManager.withShieldsTransitionLockAsync(sandboxName, command, fn, options);
}

export function inspectShieldsTransitionLockOwner(
  sandboxName: string,
  takeoverToken: string,
): InspectedShieldsTransitionOwner | null {
  return defaultManager.inspectShieldsTransitionLockOwner(sandboxName, takeoverToken);
}

export function takeoverShieldsTransitionLock(
  sandboxName: string,
  expectedOwnerPid: number,
  expectedOwnerStartIdentity: string,
  takeoverToken: string,
): ShieldsTransitionTakeoverResult {
  return defaultManager.takeoverShieldsTransitionLock(
    sandboxName,
    expectedOwnerPid,
    expectedOwnerStartIdentity,
    takeoverToken,
  );
}
