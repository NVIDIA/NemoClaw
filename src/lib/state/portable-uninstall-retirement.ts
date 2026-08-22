// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isErrnoException } from "../core/errno";
import {
  acquireProcessBoundLockAt,
  releaseProcessBoundLock,
  type ProcessBoundLockHandle,
} from "./registry/lock";

const NAMES = {
  R: "portable-uninstall-retirement.json",
  T: ".portable-uninstall-retirement.tmp",
  TC: ".portable-uninstall-retirement.tmp.cleanup",
  S: ".portable-uninstall-retirement.superseded",
  RC: ".portable-uninstall-retirement.canonical.cleanup",
  SC: ".portable-uninstall-retirement.superseded.cleanup",
} as const;
const KIND = "portable-uninstall-retirement";
const MAX_RECORD = 64 * 1024;
const MAX_AUTHORITY = 16 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 1024;
const HEX = /^[a-f0-9]{64}$/u;
const RECEIPT = /^[a-f0-9]{64}\.json$/u;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/u;
const MAX_UINT64 = (1n << 64n) - 1n;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const PORTABLE_RETIREMENT_STATE_ENTRIES = Object.values(NAMES);

export function isPortableUninstallMissingPathError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "ENOENT";
}

type Role = "config" | "receipt" | "registry";
type Target = readonly [
  Role,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
interface RecordState {
  readonly kind: typeof KIND;
  readonly schemaVersion: 1;
  readonly targets: readonly Target[];
  readonly transactionId: string;
}
interface ExactFile {
  readonly bytes: Buffer;
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly uid: bigint;
}
export interface PreparedPortableRetirement {
  readonly homeDir: string;
  readonly record: RecordState;
  readonly recordBytes: Buffer;
}
export interface PortableRetirementRecovery {
  readonly artifacts: readonly {
    readonly basename: string;
    readonly root: Role;
  }[];
  readonly fixedState: string;
  readonly registryBytes: Buffer | null;
}
export interface PortableOnboardAuthorityAdmission {
  readonly files: readonly string[];
  readonly verify: (snapshots: ReadonlyMap<string, Buffer>) => void;
}
export interface PortableAuthorityDirectorySnapshot {
  readonly entries: readonly string[];
  readonly identity: fs.BigIntStats | null;
}
interface FenceOwner {
  active: boolean;
  readonly handle: ProcessBoundLockHandle;
  readonly path: string;
  references: number;
  released: boolean;
  readonly drained: Promise<void>;
  readonly resolveDrained: () => void;
}
const owners = new AsyncLocalStorage<FenceOwner>();
const tails = new Map<string, Promise<void>>();

export const portableHostFencePath = (homeDir: string): string =>
  path.join(homeDir, ".nemoclaw-portable-host.lock");

/** Resolve the portable state root while admitting only the isolated Vitest override. */
export function defaultPortableStateDir(env: NodeJS.ProcessEnv): string {
  if (
    env.VITEST === "true" &&
    (env.HOME ?? "") === env.NEMOCLAW_TEST_BASE_HOME &&
    env.NEMOCLAW_TEST_STATE_DIR &&
    path.isAbsolute(env.NEMOCLAW_TEST_STATE_DIR)
  ) {
    return env.NEMOCLAW_TEST_STATE_DIR;
  }
  return path.join(env.HOME || os.homedir(), ".nemoclaw");
}

/** Count bounded schema-5 authority leaves while the caller holds the host fence. */
export function getHermesPortableHostAuthorityEntryCount(stateDir: string): number {
  return readPortableAuthorityDirectory(path.join(stateDir, "hermes-portable-lifecycle"), false)
    .entries.length;
}

/** Reject host-wide legacy work while schema-5 receipt authority exists. */
export function assertNoHermesPortableHostAuthority(stateDir: string, commandId: string): void {
  if (getHermesPortableHostAuthorityEntryCount(stateDir) > 0) {
    throw new Error(
      `Command '${commandId}' is not supported while an experimental Hermes portable lifecycle receipt exists. No legacy Docker or OpenShell action was attempted.`,
    );
  }
}

function releaseFenceReference(owner: FenceOwner): void {
  owner.references -= 1;
  if (owner.references === 0) owner.resolveDrained();
}

export async function withPortableHostFence<T>(
  homeDir: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const lockPath = portableHostFencePath(homeDir);
  const inherited = owners.getStore();
  if (inherited?.path === lockPath) {
    if (!inherited.active) throw new Error("Portable host fence owner is inactive");
    inherited.references += 1;
    try {
      return await operation();
    } finally {
      releaseFenceReference(inherited);
    }
  }
  const previous = tails.get(lockPath) ?? Promise.resolve();
  let finish!: () => void;
  const turn = new Promise<void>((resolve) => (finish = resolve));
  const tail = previous.then(() => turn);
  tails.set(lockPath, tail);
  await previous;
  let owner: FenceOwner | null = null;
  let onExit: (() => void) | null = null;
  try {
    let resolveDrained!: () => void;
    const drained = new Promise<void>((resolve) => (resolveDrained = resolve));
    owner = {
      active: true,
      handle: acquireProcessBoundLockAt(lockPath),
      path: lockPath,
      references: 1,
      released: false,
      drained,
      resolveDrained,
    };
    onExit = () => {
      if (!owner?.active) return;
      owner.active = false;
      owner.released = true;
      try {
        releaseProcessBoundLock(owner.handle);
      } catch {
        // Exit cannot recover; generation-safe release preserves ambiguity.
      }
    };
    process.once("exit", onExit);
    return await owners.run(owner, operation);
  } finally {
    try {
      if (owner?.active) {
        owner.active = false;
      }
      if (owner) {
        releaseFenceReference(owner);
        await owner.drained;
      }
      if (onExit) process.removeListener("exit", onExit);
      if (owner && !owner.released) {
        owner.released = true;
        releaseProcessBoundLock(owner.handle);
      }
    } finally {
      finish();
      if (tails.get(lockPath) === tail) tails.delete(lockPath);
    }
  }
}

/** Hold the portable host fence for the current process home without a second state owner. */
export function withCurrentPortableHostFence<T>(operation: () => Promise<T> | T): Promise<T> {
  return withPortableHostFence(process.env.HOME || os.homedir(), operation);
}

const root = (homeDir: string): string => path.join(homeDir, ".nemoclaw");
const paths = (homeDir: string) =>
  Object.fromEntries(
    Object.entries(NAMES).map(([key, name]) => [key, path.join(root(homeDir), name)]),
  ) as {
    [Key in keyof typeof NAMES]: string;
  };
function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
function privateRoot(homeDir: string): string {
  const stateRoot = root(homeDir);
  fs.mkdirSync(stateRoot, { mode: 0o700, recursive: true });
  const stat = fs.lstatSync(stateRoot, { bigint: true });
  const uid = process.getuid?.();
  if (uid === undefined || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid))
    throw new Error("Portable uninstall requires a current-user state directory");
  if ((stat.mode & 0o777n) !== 0o700n) fs.chmodSync(stateRoot, 0o700);
  return stateRoot;
}
function sameStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return ["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"].every(
    (key) => left[key as keyof fs.BigIntStats] === right[key as keyof fs.BigIntStats],
  );
}
/**
 * Read one portable authority directory.
 *
 * `permitAnyMode` is for the uninstall leftover check alone, which reads a
 * directory an abandoned run left behind rather than one NemoClaw created, so
 * the owner-private requirement cannot apply to it. The owner, symlink, link
 * count, identity and entry-count checks still bound what it can read.
 */
export function readPortableAuthorityDirectory(
  directory: string,
  required: boolean,
  permitAnyMode = false,
): PortableAuthorityDirectorySnapshot {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(directory, { bigint: true });
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !before.isDirectory() ||
      named.isSymbolicLink() ||
      !sameStat(before, named) ||
      before.uid !== BigInt(uid) ||
      (!permitAnyMode && (before.mode & 0o777n) !== 0o700n) ||
      before.nlink < 1n
    )
      throw new Error(`Unsafe portable authority directory: ${directory}`);
    const entries = fs.readdirSync(directory).sort();
    if (entries.length > MAX_DIRECTORY_ENTRIES)
      throw new Error(`Portable authority directory has too many entries: ${directory}`);
    if (
      !sameStat(before, fs.fstatSync(descriptor, { bigint: true })) ||
      !sameStat(before, fs.lstatSync(directory, { bigint: true }))
    )
      throw new Error(`Portable authority directory changed while reading: ${directory}`);
    return { entries, identity: before };
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT" && !required)
      return { entries: [], identity: null };
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}
export function samePortableAuthorityDirectory(
  left: PortableAuthorityDirectorySnapshot,
  right: PortableAuthorityDirectorySnapshot,
): boolean {
  return (
    (left.identity === null) === (right.identity === null) &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => entry === right.entries[index]) &&
    (left.identity === null || (right.identity !== null && sameStat(left.identity, right.identity)))
  );
}
function readFile(target: string, limit: number, expectedLinks = 1n): ExactFile | null {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Current-user ownership is unavailable");
    const before = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(target, { bigint: true });
    if (
      !before.isFile() ||
      named.isSymbolicLink() ||
      !sameStat(before, named) ||
      before.nlink !== expectedLinks ||
      before.uid !== BigInt(uid) ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size < 1n ||
      before.size > BigInt(limit)
    )
      throw new Error(`Unsafe portable uninstall file: ${target}`);
    const bytes = Buffer.alloc(Number(before.size));
    if (
      fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length ||
      !sameStat(before, fs.fstatSync(descriptor, { bigint: true })) ||
      !sameStat(before, fs.lstatSync(target, { bigint: true }))
    )
      throw new Error(`Portable uninstall file changed while reading: ${target}`);
    return {
      bytes,
      ctimeNs: before.ctimeNs,
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
      mtimeNs: before.mtimeNs,
      nlink: before.nlink,
      size: before.size,
      uid: before.uid,
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}
function roleLimit(role: Role): number {
  return role === "receipt" ? 4_096 : role === "config" ? 64 * 1_024 : 1_024 * 1_024;
}
function decimal(value: string): bigint {
  if (!DECIMAL.test(value)) throw new Error("Portable uninstall decimal value is invalid");
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) throw new Error("Portable uninstall decimal value is too large");
  return parsed;
}
function frame(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}
export function portableRetirementFingerprint(
  transactionId: string,
  role: Role,
  basename: string,
  bytes: Buffer,
): string {
  const expectedBasename =
    typeof basename === "string" && role === "config"
      ? basename === "containers.conf"
      : role === "registry"
        ? basename === "sandboxes.json"
        : role === "receipt"
          ? RECEIPT.test(basename)
          : false;
  if (
    typeof transactionId !== "string" ||
    typeof role !== "string" ||
    !HEX.test(transactionId) ||
    expectedBasename !== true ||
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    bytes.length > roleLimit(role)
  )
    throw new Error("Portable uninstall fingerprint input is invalid");
  return createHash("sha256")
    .update(
      Buffer.concat([
        frame("NEMOCLAW-PORTABLE-UNINSTALL-TARGET-V1"),
        frame(transactionId),
        frame(role),
        frame(basename),
        frame(bytes),
      ]),
    )
    .digest("hex");
}
function canonical(homeDir: string, target: Target): string {
  if (target[0] === "config")
    return path.join(homeDir, ".config/nemoclaw/portable/containers.conf");
  if (target[0] === "registry") return path.join(root(homeDir), "sandboxes.json");
  return path.join(root(homeDir), "portable-demo-lifecycle", target[1]);
}
const cleanup = (homeDir: string, record: RecordState, target: Target): string => {
  const source = canonical(homeDir, target);
  return path.join(
    path.dirname(source),
    `.${target[1]}.portable-uninstall-${record.transactionId}.cleanup`,
  );
};
function matches(record: RecordState, target: Target, file: ExactFile, staged = false): boolean {
  return (
    file.dev === decimal(target[2]) &&
    file.ino === decimal(target[3]) &&
    file.size === decimal(target[4]) &&
    file.uid === decimal(target[5]) &&
    file.mode === decimal(target[6]) &&
    file.nlink === decimal(target[7]) &&
    file.mtimeNs === decimal(target[8]) &&
    (file.ctimeNs === decimal(target[9]) || (staged && file.ctimeNs >= decimal(target[9]))) &&
    portableRetirementFingerprint(record.transactionId, target[0], target[1], file.bytes) ===
      target[10]
  );
}

function parseRecord(bytes: Buffer): RecordState {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new Error("Portable uninstall retirement record is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Portable uninstall retirement record is invalid");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join() !== "kind,schemaVersion,targets,transactionId" ||
    record.kind !== KIND ||
    record.schemaVersion !== 1 ||
    typeof record.transactionId !== "string" ||
    !HEX.test(record.transactionId) ||
    !Array.isArray(record.targets) ||
    record.targets.length < 2 ||
    record.targets.length > 258
  )
    throw new Error("Portable uninstall retirement record values are invalid");
  const targets = record.targets.map((item): Target => {
    if (
      !Array.isArray(item) ||
      item.length !== 11 ||
      !["config", "receipt", "registry"].includes(item[0]) ||
      item.slice(1).some((part) => typeof part !== "string")
    )
      throw new Error("Portable uninstall retirement target is invalid");
    const target = item as unknown as Target;
    if (
      (target[0] === "config" && target[1] !== "containers.conf") ||
      (target[0] === "registry" && target[1] !== "sandboxes.json") ||
      (target[0] === "receipt" && !RECEIPT.test(target[1])) ||
      target.slice(2, 10).some((part) => !DECIMAL.test(part) || decimal(part) > MAX_UINT64) ||
      decimal(target[4]) < 1n ||
      decimal(target[4]) > BigInt(roleLimit(target[0])) ||
      (decimal(target[6]) & 0o777n) !== 0o600n ||
      decimal(target[7]) !== 1n ||
      !HEX.test(target[10])
    )
      throw new Error("Portable uninstall retirement target values are invalid");
    return target;
  });
  const receipts = targets.filter((target) => target[0] === "receipt");
  if (
    targets.at(-1)?.[0] !== "registry" ||
    targets.filter((target) => target[0] === "registry").length !== 1 ||
    targets.filter((target) => target[0] === "config").length !== 1 ||
    targets.some((target, index) => target[0] === "config" && index !== 0) ||
    receipts.length < 1 ||
    receipts.some((target, index) => index > 0 && receipts[index - 1]![1] >= target[1])
  )
    throw new Error("Portable uninstall retirement target order is invalid");
  return { kind: KIND, schemaVersion: 1, targets, transactionId: record.transactionId };
}
function readRecord(target: string, links = 1n): { file: ExactFile; record: RecordState } | null {
  const file = readFile(target, MAX_RECORD, links);
  return file ? { file, record: parseRecord(file.bytes) } : null;
}
function snapshot(homeDir: string, id: string, role: Role, basename: string): Target | null {
  const shell = [role, basename] as unknown as Target;
  const file = readFile(canonical(homeDir, shell), roleLimit(role));
  if (file && role !== "config") JSON.parse(UTF8.decode(file.bytes));
  return file
    ? [
        role,
        basename,
        String(file.dev),
        String(file.ino),
        String(file.size),
        String(file.uid),
        String(file.mode),
        String(file.nlink),
        String(file.mtimeNs),
        String(file.ctimeNs),
        portableRetirementFingerprint(id, role, basename, file.bytes),
      ]
    : null;
}

export function preparePortableRetirement(
  homeDir: string,
  receiptBasenames: readonly string[],
): PreparedPortableRetirement {
  privateRoot(homeDir);
  if (
    receiptBasenames.length < 1 ||
    receiptBasenames.length > 256 ||
    new Set(receiptBasenames).size !== receiptBasenames.length ||
    receiptBasenames.some((name) => !RECEIPT.test(name))
  )
    throw new Error("Portable uninstall receipt identities are invalid");
  const transactionId = randomBytes(32).toString("hex");
  const targets = [
    snapshot(homeDir, transactionId, "config", "containers.conf"),
    ...[...receiptBasenames]
      .sort()
      .map((name) => snapshot(homeDir, transactionId, "receipt", name)),
    snapshot(homeDir, transactionId, "registry", "sandboxes.json"),
  ].filter((target): target is Target => target !== null);
  if (
    targets.filter((target) => target[0] === "config").length !== 1 ||
    targets.filter((target) => target[0] === "receipt").length !== receiptBasenames.length ||
    targets.at(-1)?.[0] !== "registry"
  )
    throw new Error("Portable uninstall authority is incomplete");
  const record: RecordState = { kind: KIND, schemaVersion: 1, targets, transactionId };
  const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (recordBytes.length > MAX_RECORD) throw new Error("Portable uninstall record is too large");
  return { homeDir, record, recordBytes };
}

function targetState(
  homeDir: string,
  record: RecordState,
  target: Target,
  allowCanonicalReplacement = false,
): "canonical" | "cleanup" | "retired" {
  const limit = roleLimit(target[0]);
  const source = readFile(canonical(homeDir, target), limit);
  const staged = readFile(cleanup(homeDir, record, target), limit);
  if (source && staged) {
    if (
      allowCanonicalReplacement &&
      !matches(record, target, source) &&
      matches(record, target, staged, true)
    )
      return "cleanup";
    throw new Error("Portable uninstall target has two generations");
  }
  if (source && !matches(record, target, source)) {
    if (allowCanonicalReplacement && !staged) return "retired";
    throw new Error("Portable uninstall target changed");
  }
  if (staged && !matches(record, target, staged, true))
    throw new Error("Portable uninstall target changed");
  return source ? "canonical" : staged ? "cleanup" : "retired";
}
function targetStates(homeDir: string, record: RecordState, allowCanonicalReplacement = false) {
  const states = record.targets.map((target) =>
    targetState(homeDir, record, target, allowCanonicalReplacement),
  );
  const firstPending = states.findIndex((state) => state !== "retired");
  if (firstPending >= 0 && states.slice(firstPending).includes("retired"))
    throw new Error("Portable uninstall targets retired out of order");
  return states;
}
function allTargetsExact(homeDir: string, record: RecordState): boolean {
  return record.targets.every((target) => targetState(homeDir, record, target) === "canonical");
}
function sameExact(left: ExactFile | null, right: ExactFile): boolean {
  return Boolean(
    left &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.bytes.equals(right.bytes),
  );
}
function sameTarget(left: ExactFile | null, right: ExactFile, renamed = false): boolean {
  return Boolean(
    left &&
    left.bytes.equals(right.bytes) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    (left.ctimeNs === right.ctimeNs || (renamed && left.ctimeNs >= right.ctimeNs)),
  );
}
function entryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
function detachDelete(
  source: string | null,
  staged: string,
  expected: ExactFile,
  limit: number,
  survivor?: { readonly expected: ExactFile; readonly path: string },
  targetMetadata = false,
): void {
  const sourceFile = source ? readFile(source, limit, expected.nlink) : null;
  let stagedFile = readFile(staged, limit, expected.nlink);
  if (sourceFile && stagedFile) throw new Error("Portable uninstall cleanup has two generations");
  if (sourceFile) {
    if (!(targetMetadata ? sameTarget(sourceFile, expected) : sameExact(sourceFile, expected)))
      throw new Error(`Portable uninstall source changed: ${source}`);
    fs.renameSync(source!, staged);
    fsyncDirectory(path.dirname(source!));
    stagedFile = readFile(staged, limit, expected.nlink);
    if (targetMetadata && !sameTarget(stagedFile, expected, true))
      throw new Error(`Portable uninstall cleanup changed: ${staged}`);
  }
  if (
    !(targetMetadata
      ? sameTarget(stagedFile, sourceFile ? stagedFile! : expected)
      : sameExact(stagedFile, expected))
  )
    throw new Error(`Portable uninstall cleanup changed: ${staged}`);
  fs.unlinkSync(staged);
  fsyncDirectory(path.dirname(staged));
  if (survivor) {
    const remaining = readFile(survivor.path, limit, 1n);
    if (!sameExact(remaining, { ...survivor.expected, nlink: 1n }))
      throw new Error(`Portable uninstall survivor changed: ${survivor.path}`);
  }
}
interface OwnedDirectoryHandle {
  readonly descriptor: number;
  readonly identity: fs.BigIntStats;
  readonly path: string;
}
function sameDirectoryIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}
function assertOwnedDirectory(handle: OwnedDirectoryHandle): void {
  const descriptorStat = fs.fstatSync(handle.descriptor, { bigint: true });
  const namedStat = fs.lstatSync(handle.path, { bigint: true });
  if (
    namedStat.isSymbolicLink() ||
    !sameDirectoryIdentity(handle.identity, descriptorStat) ||
    !sameDirectoryIdentity(handle.identity, namedStat)
  )
    throw new Error(`Portable uninstall directory changed: ${handle.path}`);
}
function openOwnedDirectory(
  directory: string,
  required: boolean,
  requirePrivateMode = false,
): OwnedDirectoryHandle | null {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
    );
    const identity = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(directory, { bigint: true });
    const uid = process.getuid?.();
    const permissions = identity.mode & 0o777n;
    if (
      uid === undefined ||
      named.isSymbolicLink() ||
      !sameStat(identity, named) ||
      identity.uid !== BigInt(uid) ||
      identity.nlink < 1n ||
      (requirePrivateMode ? permissions !== 0o700n : (permissions & 0o022n) !== 0n)
    )
      throw new Error(`Unsafe portable uninstall directory: ${directory}`);
    return { descriptor, identity, path: directory };
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (isErrnoException(error) && error.code === "ENOENT" && !required) return null;
    throw error;
  }
}
function ownedDirectoryIsEmpty(handle: OwnedDirectoryHandle): boolean {
  assertOwnedDirectory(handle);
  const isEmpty = fs.readdirSync(handle.path).length === 0;
  assertOwnedDirectory(handle);
  return isEmpty;
}
function removeOwnedEmptyDirectory(
  handle: OwnedDirectoryHandle,
  parent: OwnedDirectoryHandle,
): boolean {
  if (!ownedDirectoryIsEmpty(handle)) return false;
  assertOwnedDirectory(parent);
  assertOwnedDirectory(handle);
  try {
    fs.rmdirSync(handle.path);
  } catch (error) {
    if (isErrnoException(error) && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) {
      assertOwnedDirectory(parent);
      assertOwnedDirectory(handle);
      return false;
    }
    if (!(isErrnoException(error) && error.code === "ENOENT")) throw error;
  }
  fs.fsyncSync(parent.descriptor);
  assertOwnedDirectory(parent);
  if (entryExists(handle.path))
    throw new Error(`Portable uninstall directory was replaced: ${handle.path}`);
  return true;
}
function removeRetiredPortableConfigDirectories(homeDir: string): void {
  const home = openOwnedDirectory(homeDir, true)!;
  const configHomePath = path.join(homeDir, ".config");
  const configDir = path.join(homeDir, ".config", "nemoclaw");
  let configHome: OwnedDirectoryHandle | null = null;
  let nemoclawConfig: OwnedDirectoryHandle | null = null;
  let portableConfig: OwnedDirectoryHandle | null = null;
  try {
    configHome = openOwnedDirectory(configHomePath, true)!;
    assertOwnedDirectory(home);
    nemoclawConfig = openOwnedDirectory(configDir, false);
    assertOwnedDirectory(configHome);
    assertOwnedDirectory(home);
    if (!nemoclawConfig) {
      fs.fsyncSync(configHome.descriptor);
      assertOwnedDirectory(configHome);
      return;
    }
    portableConfig = openOwnedDirectory(path.join(configDir, "portable"), false, true);
    assertOwnedDirectory(nemoclawConfig);
    assertOwnedDirectory(configHome);
    if (portableConfig && !removeOwnedEmptyDirectory(portableConfig, nemoclawConfig)) return;
    assertOwnedDirectory(nemoclawConfig);
    if (!ownedDirectoryIsEmpty(nemoclawConfig)) return;
    removeOwnedEmptyDirectory(nemoclawConfig, configHome);
    assertOwnedDirectory(configHome);
    assertOwnedDirectory(home);
  } finally {
    if (portableConfig) fs.closeSync(portableConfig.descriptor);
    if (nemoclawConfig) fs.closeSync(nemoclawConfig.descriptor);
    if (configHome) fs.closeSync(configHome.descriptor);
    fs.closeSync(home.descriptor);
  }
}
function recoverTemp(homeDir: string): ExactFile | null {
  const state = paths(homeDir);
  const pendingPaths = [state.T, state.TC].filter(entryExists);
  if (pendingPaths.length > 1) throw new Error("Portable uninstall temporary state is ambiguous");
  const recordPresent = entryExists(state.R);
  if (!pendingPaths.length) return null;
  const expectedLinks = recordPresent ? 2n : 1n;
  const pending = readRecord(pendingPaths[0]!, expectedLinks)!;
  const published = recordPresent ? readRecord(state.R, 2n)! : null;
  if (
    published ? !sameExact(pending.file, published.file) : !allTargetsExact(homeDir, pending.record)
  )
    throw new Error("Portable uninstall temporary record has no exact authority");
  detachDelete(
    state.T,
    state.TC,
    pending.file,
    MAX_RECORD,
    published ? { expected: published.file, path: state.R } : undefined,
  );
  return published ? readRecord(state.R, 1n)!.file : null;
}
function publish(prepared: PreparedPortableRetirement): void {
  const state = paths(prepared.homeDir);
  if ([state.R, state.RC, state.S, state.SC].some(entryExists))
    throw new Error("Portable uninstall retirement already exists or is incomplete");
  recoverTemp(prepared.homeDir);
  fs.writeFileSync(state.T, prepared.recordBytes, { flag: "wx", mode: 0o600 });
  const descriptor = fs.openSync(state.T, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const temp = readRecord(state.T);
  if (!temp || !temp.file.bytes.equals(prepared.recordBytes))
    throw new Error("Portable uninstall temporary record verification failed");
  fs.linkSync(state.T, state.R);
  fsyncDirectory(path.dirname(state.R));
  const linkedTemp = readRecord(state.T, 2n);
  const record = readRecord(state.R, 2n);
  if (
    !linkedTemp ||
    !record ||
    !sameExact(record.file, linkedTemp.file) ||
    !record.file.bytes.equals(prepared.recordBytes)
  )
    throw new Error("Portable uninstall record publication failed");
  recoverTemp(prepared.homeDir);
}
function retireTargets(
  homeDir: string,
  record: RecordState,
  allowCanonicalReplacement = false,
): void {
  const states = targetStates(homeDir, record, allowCanonicalReplacement);
  const firstPending = states.findIndex((state) => state !== "retired");
  for (let index = Math.max(firstPending, 0); index < record.targets.length; index++) {
    const target = record.targets[index]!;
    const state = states[index]!;
    if (state === "retired") {
      const parent = path.dirname(canonical(homeDir, target));
      if (target[0] === "config" && !entryExists(parent))
        fsyncDirectory(path.join(homeDir, ".config"));
      else fsyncDirectory(parent);
      continue;
    }
    const source = canonical(homeDir, target);
    const staged = cleanup(homeDir, record, target);
    const exact = readFile(state === "canonical" ? source : staged, roleLimit(target[0]))!;
    if (!matches(record, target, exact, state === "cleanup"))
      throw new Error("Portable uninstall target changed");
    const replacement =
      allowCanonicalReplacement &&
      state === "cleanup" &&
      readFile(source, roleLimit(target[0])) !== null;
    detachDelete(replacement ? null : source, staged, exact, roleLimit(target[0]), undefined, true);
  }
}
function finishPortableEvidenceRetirement(homeDir: string, record: RecordState): void {
  retireTargets(homeDir, record);
  removeRetiredPortableConfigDirectories(homeDir);
}
export function publishAndRetirePortableEvidence(prepared: PreparedPortableRetirement): void {
  if (!allTargetsExact(prepared.homeDir, prepared.record))
    throw new Error("Portable uninstall authority changed before publication");
  publish(prepared);
  finishPortableEvidenceRetirement(prepared.homeDir, prepared.record);
}

function load(homeDir: string): { file: ExactFile; record: RecordState } | null {
  const state = paths(homeDir);
  if ([state.RC, state.S, state.SC].some(entryExists))
    throw new Error("Portable uninstall supersession is incomplete");
  recoverTemp(homeDir);
  const record = readRecord(state.R, 1n);
  if (record) fsyncDirectory(path.dirname(state.R));
  return record;
}
export const hasPortableRetirementRecord = (homeDir: string): boolean => admitSupersession(homeDir);
function inspectRetirementRecovery(
  homeDir: string,
  allowCanonicalReplacement = false,
): PortableRetirementRecovery | null {
  const fixed = allowCanonicalReplacement ? fixedSupersessionState(homeDir) : null;
  const recorded = allowCanonicalReplacement ? (fixed?.files[0] ?? null) : load(homeDir);
  if (!recorded) return null;
  const states = targetStates(homeDir, recorded.record, allowCanonicalReplacement);
  const artifacts = recorded.record.targets.flatMap((target, index) =>
    states[index] === "cleanup"
      ? [{ basename: path.basename(cleanup(homeDir, recorded.record, target)), root: target[0] }]
      : [],
  );
  const registry = recorded.record.targets.at(-1)!;
  const state = states.at(-1)!;
  const registryBytes =
    state === "retired"
      ? null
      : readFile(
          state === "canonical"
            ? canonical(homeDir, registry)
            : cleanup(homeDir, recorded.record, registry),
          roleLimit("registry"),
        )!.bytes;
  return { artifacts, fixedState: fixed?.code ?? "1000", registryBytes };
}
export const inspectPortableRetirementRecovery = (
  homeDir: string,
): PortableRetirementRecovery | null => inspectRetirementRecovery(homeDir);
export const inspectPortableOnboardSupersession = (
  homeDir: string,
): PortableRetirementRecovery | null => inspectRetirementRecovery(homeDir, true);
export function resumePortableOnboardReplacementEvidence(homeDir: string): void {
  const fixed = fixedSupersessionState(homeDir);
  if (!fixed || fixed.code !== "1000")
    throw new Error("Portable onboarding replacement recovery requires the canonical record");
  retireTargets(homeDir, fixed.files[0]!.record, true);
}
export function resumePortableEvidenceRetirement(homeDir: string): void {
  const recorded = load(homeDir);
  if (!recorded) throw new Error("Portable uninstall retirement record is missing");
  finishPortableEvidenceRetirement(homeDir, recorded.record);
}

function durableFile(target: string): ExactFile {
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(target));
  const file = readFile(target, MAX_AUTHORITY);
  if (!file) throw new Error(`Completed onboarding authority is missing: ${target}`);
  return file;
}
export function readPortableAuthoritySnapshot(
  target: string,
  limit = MAX_AUTHORITY,
): Buffer | null {
  return readFile(target, limit)?.bytes ?? null;
}
export function provePortableOnboardAuthority(admission: PortableOnboardAuthorityAdmission): void {
  if (
    admission.files.length < 2 ||
    admission.files.length > 3 ||
    new Set(admission.files).size !== admission.files.length
  )
    throw new Error("Completed onboarding authority paths are invalid");
  const snapshots = new Map(admission.files.map((target) => [target, durableFile(target)]));
  admission.verify(
    new Map([...snapshots].map(([target, file]) => [target, Buffer.from(file.bytes)])),
  );
  for (const [target, expected] of snapshots) {
    const current = readFile(target, MAX_AUTHORITY);
    if (
      !current ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      !current.bytes.equals(expected.bytes)
    )
      throw new Error("Completed onboarding authority changed during verification");
  }
}
function fixedSupersessionState(homeDir: string): {
  readonly code: string;
  readonly files: readonly { file: ExactFile; record: RecordState }[];
} | null {
  const state = paths(homeDir);
  recoverTemp(homeDir);
  const statePaths = [state.R, state.RC, state.S, state.SC];
  const code = statePaths.map((target) => (entryExists(target) ? "1" : "0")).join("");
  if (code === "0000") return null;
  const expectedLinks = new Map<string, bigint>([
    ["1000", 1n],
    ["1010", 2n],
    ["0110", 2n],
    ["0010", 1n],
    ["0001", 1n],
  ]).get(code);
  if (expectedLinks === undefined) throw new Error("Portable uninstall supersession is ambiguous");
  const records = statePaths.map((target) =>
    entryExists(target) ? readRecord(target, expectedLinks) : null,
  );
  const present = records.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (!present.length) return null;
  const admitted = present[0]!.file;
  if (
    present.some(
      (entry) =>
        entry.file.dev !== admitted.dev ||
        entry.file.ino !== admitted.ino ||
        entry.file.nlink !== admitted.nlink ||
        !entry.file.bytes.equals(admitted.bytes),
    )
  )
    throw new Error("Portable uninstall supersession is ambiguous");
  return { code, files: present };
}
function admitSupersession(homeDir: string): boolean {
  return fixedSupersessionState(homeDir) !== null;
}
function supersede(homeDir: string): void {
  const state = paths(homeDir);
  const fixed = fixedSupersessionState(homeDir);
  if (!fixed) return;
  const admitted = fixed.files[0]!.file;
  if (fixed.code === "1000") {
    fs.linkSync(state.R, state.S);
    fsyncDirectory(path.dirname(state.R));
    const linkedR = readRecord(state.R, 2n);
    const linkedS = readRecord(state.S, 2n);
    if (!linkedR || !linkedS || !sameExact(linkedR.file, linkedS.file))
      throw new Error("Portable uninstall supersession link publication failed");
    return supersede(homeDir);
  } else if (fixed.code === "1010" || fixed.code === "0110") {
    const survivor = readRecord(state.S, 2n)!;
    fsyncDirectory(path.dirname(state.R));
    detachDelete(state.R, state.RC, admitted, MAX_RECORD, {
      expected: survivor.file,
      path: state.S,
    });
    return supersede(homeDir);
  } else if (fixed.code === "0010" || fixed.code === "0001") {
    detachDelete(state.S, state.SC, admitted, MAX_RECORD);
    return supersede(homeDir);
  }
  throw new Error("Portable uninstall supersession is ambiguous");
}
export function supersedePortableRetirementAfterOnboard(
  homeDir: string,
  admission: PortableOnboardAuthorityAdmission,
): void {
  const recorded = fixedSupersessionState(homeDir)?.files[0] ?? null;
  if (!recorded) return;
  provePortableOnboardAuthority(admission);
  retireTargets(homeDir, recorded.record, true);
  provePortableOnboardAuthority(admission);
  inspectRetirementRecovery(homeDir, true);
  supersede(homeDir);
}
