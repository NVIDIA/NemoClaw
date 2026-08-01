// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import {
  normalizePersistedEngineAuthority,
  type PersistedEngineAuthority,
  type PersistedEngineAuthorityStore,
  requirePersistedEngineAuthority,
  serializePersistedEngineAuthority,
} from "./persisted-engine-authority";

export const PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const PERSISTED_ENGINE_LIFECYCLE_DIRECTORY = "runtime-provider-lifecycle";

export type PersistedEngineLifecycleAction =
  | "snapshot-create"
  | "snapshot-clone"
  | "rebuild"
  | "backup"
  | "restore"
  | "recovery";

export type PersistedEngineLifecyclePhase = "prepared" | "mutation-authorized" | "completed";

export type PersistedEngineLifecycleResourceRole = "source" | "target";

export interface PersistedEngineLifecycleResource {
  readonly role: PersistedEngineLifecycleResourceRole;
  /** Provider-owned immutable runtime handle. Mutable names are not authority. */
  readonly runtimeId: string;
}

export interface PersistedEngineLifecycleRecord {
  readonly schemaVersion: typeof PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION;
  readonly transactionId: string;
  readonly action: PersistedEngineLifecycleAction;
  readonly phase: PersistedEngineLifecyclePhase;
  readonly sandboxName: string;
  readonly resources: readonly PersistedEngineLifecycleResource[];
  /** Digest of the provider's opaque runtime and acceleration state. */
  readonly runtimeStateSha256: string;
  readonly engineAuthority: PersistedEngineAuthority;
  readonly resultSha256: string | null;
}

export interface PersistedEngineLifecycleStore {
  readonly load: (transactionId: string) => PersistedEngineLifecycleRecord | null;
  readonly listUnfinished: () => readonly PersistedEngineLifecycleRecord[];
  readonly create: (record: PersistedEngineLifecycleRecord) => PersistedEngineLifecycleRecord;
  readonly authorizeMutation: (transactionId: string) => PersistedEngineLifecycleRecord;
  readonly complete: (
    transactionId: string,
    resultSha256: string,
  ) => PersistedEngineLifecycleRecord;
  /** Retire only the exact completed receipt; a durable tombstone prevents ID reuse. */
  readonly retire: (transactionId: string, resultSha256: string) => void;
}

export interface PreparePersistedEngineLifecycleInput {
  readonly transactionId: string;
  readonly action: PersistedEngineLifecycleAction;
  readonly sandboxName: string;
  readonly resources: readonly PersistedEngineLifecycleResource[];
  readonly runtimeStateSha256: string;
  readonly providerId: string;
  readonly bindingSha256: string;
  readonly engine: ContainerEngine;
  readonly engineAuthorityStore: PersistedEngineAuthorityStore;
  readonly lifecycleStore: PersistedEngineLifecycleStore;
}

export type PersistedEngineLifecycleExecutionInput = PreparePersistedEngineLifecycleInput;

export interface AuthorizedPersistedEngineLifecycle {
  readonly record: PersistedEngineLifecycleRecord;
  /**
   * Execute against one exact persisted runtime handle. The builder must place
   * that handle exactly once in the argument vector.
   */
  readonly captureExact: (
    role: PersistedEngineLifecycleResourceRole,
    buildArgs: (runtimeId: string) => readonly string[],
    timeoutMs?: number,
  ) => ContainerEngineCommandResult;
  readonly captureHostExact: (
    role: PersistedEngineLifecycleResourceRole,
    buildArgs: (runtimeId: string) => readonly string[],
    timeoutMs?: number,
  ) => ContainerEngineCommandResult;
}

export interface PersistedEngineLifecycleMutationResult<T> {
  readonly resultSha256: string;
  readonly value: T;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_ARGUMENTS = 512;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:/=+-]{0,511}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const ACTIONS = new Set<PersistedEngineLifecycleAction>([
  "snapshot-create",
  "snapshot-clone",
  "rebuild",
  "backup",
  "restore",
  "recovery",
]);
const PHASES = new Set<PersistedEngineLifecyclePhase>([
  "prepared",
  "mutation-authorized",
  "completed",
]);
const PHASE_FILES = ["prepared", "mutation-authorized", "completed"] as const;
const REQUIRED_ROLES: Readonly<
  Record<PersistedEngineLifecycleAction, readonly PersistedEngineLifecycleResourceRole[]>
> = Object.freeze({
  "snapshot-create": Object.freeze(["source"]),
  "snapshot-clone": Object.freeze(["source", "target"]),
  rebuild: Object.freeze(["source", "target"]),
  backup: Object.freeze(["source"]),
  restore: Object.freeze(["source", "target"]),
  recovery: Object.freeze(["target"]),
});

function fail(message: string): never {
  throw new Error(`Persisted engine lifecycle is invalid: ${message}`);
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} is malformed`);
  return value;
}

function exactName(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) fail(`${label} is malformed`);
  return value;
}

function exactAction(value: unknown): PersistedEngineLifecycleAction {
  if (typeof value !== "string" || !ACTIONS.has(value as PersistedEngineLifecycleAction)) {
    fail("action is unsupported");
  }
  return value as PersistedEngineLifecycleAction;
}

function exactPhase(value: unknown): PersistedEngineLifecyclePhase {
  if (typeof value !== "string" || !PHASES.has(value as PersistedEngineLifecyclePhase)) {
    fail("phase is unsupported");
  }
  return value as PersistedEngineLifecyclePhase;
}

function normalizeResources(
  action: PersistedEngineLifecycleAction,
  value: unknown,
): readonly PersistedEngineLifecycleResource[] {
  if (!Array.isArray(value)) fail("resources must be an array");
  const resources = value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !== "role,runtimeId"
    ) {
      fail("resource schema is unsupported");
    }
    const resource = candidate as Record<string, unknown>;
    if (resource.role !== "source" && resource.role !== "target") {
      fail("resource role is unsupported");
    }
    if (typeof resource.runtimeId !== "string" || !RUNTIME_ID.test(resource.runtimeId)) {
      fail("resource runtime identity is malformed");
    }
    return Object.freeze({ role: resource.role, runtimeId: resource.runtimeId });
  });
  resources.sort((left, right) => left.role.localeCompare(right.role));
  const expectedRoles = [...REQUIRED_ROLES[action]].sort();
  if (
    resources.map((resource) => resource.role).join(",") !== expectedRoles.join(",") ||
    new Set(resources.map((resource) => resource.runtimeId)).size !== resources.length
  ) {
    fail(
      `${action} resources must contain exact distinct ${expectedRoles.join(" and ")} authority`,
    );
  }
  return Object.freeze(resources);
}

export function normalizePersistedEngineLifecycleRecord(
  value: unknown,
): PersistedEngineLifecycleRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("record must be an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "action",
    "engineAuthority",
    "phase",
    "resources",
    "resultSha256",
    "runtimeStateSha256",
    "sandboxName",
    "schemaVersion",
    "transactionId",
  ];
  if (
    Object.keys(record).sort().join(",") !== expectedKeys.join(",") ||
    record.schemaVersion !== PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION
  ) {
    fail("record schema is unsupported");
  }
  const action = exactAction(record.action);
  const phase = exactPhase(record.phase);
  const resultSha256 =
    record.resultSha256 === null
      ? null
      : exactSha256(record.resultSha256, "completion result digest");
  if ((phase === "completed") !== (resultSha256 !== null)) {
    fail("completion result digest does not match the phase");
  }
  const engineAuthority = normalizePersistedEngineAuthority(record.engineAuthority);
  if (engineAuthority.operation !== "sandbox-lifecycle") {
    fail("lifecycle authority must use the sandbox-lifecycle engine scope");
  }
  return Object.freeze({
    schemaVersion: PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION,
    transactionId: exactSha256(record.transactionId, "transaction identity"),
    action,
    phase,
    sandboxName: exactName(record.sandboxName, "sandbox name"),
    resources: normalizeResources(action, record.resources),
    runtimeStateSha256: exactSha256(record.runtimeStateSha256, "runtime state digest"),
    engineAuthority,
    resultSha256,
  });
}

export function serializePersistedEngineLifecycleRecord(
  record: PersistedEngineLifecycleRecord,
): string {
  const serialized = `${JSON.stringify(normalizePersistedEngineLifecycleRecord(record))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    fail("serialized record exceeds its bounded transport");
  }
  return serialized;
}

export function parsePersistedEngineLifecycleRecord(
  serialized: string,
): PersistedEngineLifecycleRecord {
  if (
    serialized.length === 0 ||
    serialized.includes("\0") ||
    Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES
  ) {
    fail("serialized record is empty or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("serialized record is not valid JSON");
  }
  const record = normalizePersistedEngineLifecycleRecord(parsed);
  if (serializePersistedEngineLifecycleRecord(record) !== serialized) {
    fail("serialized record is not canonical");
  }
  return record;
}

function currentUid(fallback: number | bigint): bigint {
  return BigInt(typeof process.getuid === "function" ? process.getuid() : fallback);
}

function verifyPrivateDirectory(directory: string): void {
  const metadata = fs.lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    BigInt(metadata.uid) !== currentUid(metadata.uid) ||
    (metadata.mode & 0o077) !== 0
  ) {
    fail("ledger directory must be a private real directory owned by the current user");
  }
}

function requirePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  verifyPrivateDirectory(directory);
}

function sameStableMetadata(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readPrivateFile(target: string): string | null {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") fail("O_NOFOLLOW is unavailable for lifecycle reads");
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow | nonblock);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") fail("ledger file must not be a symbolic link");
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== currentUid(before.uid) ||
      (before.mode & 0o077n) !== 0n ||
      before.size <= 0n ||
      before.size > BigInt(MAX_RECORD_BYTES)
    ) {
      fail("ledger file failed ownership, mode, link, or size checks");
    }
    const contents = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < contents.length) {
      const count = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const overflow = Buffer.alloc(1);
    const overflowCount = fs.readSync(descriptor, overflow, 0, 1, offset);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== contents.length || overflowCount !== 0 || !sameStableMetadata(before, after)) {
      fail("ledger file changed during its stable read");
    }
    return contents.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishExclusive(directory: string, target: string, serialized: string): boolean {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") fail("O_NOFOLLOW is unavailable for lifecycle writes");
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
      FILE_MODE,
    );
    fs.writeFileSync(descriptor, serialized, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    fs.unlinkSync(temporary);
    fsyncDirectory(directory);
    return true;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function transactionDirectory(root: string, transactionId: string): string {
  return path.join(root, exactSha256(transactionId, "transaction identity"));
}

function phasePath(directory: string, phase: PersistedEngineLifecyclePhase): string {
  return path.join(directory, `${phase}.json`);
}

function tombstonePath(root: string, transactionId: string): string {
  return path.join(root, `${exactSha256(transactionId, "transaction identity")}.retired`);
}

function immutableRecord(record: PersistedEngineLifecycleRecord) {
  return {
    ...record,
    phase: "prepared" as const,
    resultSha256: null,
  };
}

function requireSameLifecycle(
  expected: PersistedEngineLifecycleRecord,
  candidate: PersistedEngineLifecycleRecord,
): void {
  if (
    serializePersistedEngineLifecycleRecord(immutableRecord(expected)) !==
    serializePersistedEngineLifecycleRecord(immutableRecord(candidate))
  ) {
    fail("phase records do not describe the same lifecycle authority");
  }
}

function loadPhase(
  directory: string,
  phase: PersistedEngineLifecyclePhase,
): PersistedEngineLifecycleRecord | null {
  const serialized = readPrivateFile(phasePath(directory, phase));
  if (serialized === null) return null;
  const record = parsePersistedEngineLifecycleRecord(serialized);
  if (record.phase !== phase) fail(`${phase} file contains another phase`);
  return record;
}

function loadTransaction(
  root: string,
  transactionId: string,
): PersistedEngineLifecycleRecord | null {
  const directory = transactionDirectory(root, transactionId);
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("transaction path must be a private real directory");
  }
  verifyPrivateDirectory(directory);
  const entries = fs.readdirSync(directory).sort();
  if (entries.some((entry) => !PHASE_FILES.some((phase) => entry === `${phase}.json`))) {
    fail("transaction directory contains an unsupported entry");
  }
  const prepared = loadPhase(directory, "prepared");
  if (!prepared || prepared.transactionId !== transactionId) {
    fail("transaction is missing its exact prepared authority");
  }
  const authorized = loadPhase(directory, "mutation-authorized");
  const completed = loadPhase(directory, "completed");
  if (completed && !authorized) fail("completed transaction is missing mutation authority");
  if (authorized) requireSameLifecycle(prepared, authorized);
  if (completed) requireSameLifecycle(prepared, completed);
  return completed ?? authorized ?? prepared;
}

function publishPhase(
  root: string,
  record: PersistedEngineLifecycleRecord,
): PersistedEngineLifecycleRecord {
  const directory = transactionDirectory(root, record.transactionId);
  requirePrivateDirectory(directory);
  const target = phasePath(directory, record.phase);
  const serialized = serializePersistedEngineLifecycleRecord(record);
  if (publishExclusive(directory, target, serialized)) return record;
  const existing = loadPhase(directory, record.phase);
  if (existing && serializePersistedEngineLifecycleRecord(existing) === serialized) return existing;
  fail(`${record.phase} authority already exists with different content`);
}

export function createFilePersistedEngineLifecycleStore(
  stateDir: string,
): PersistedEngineLifecycleStore {
  const root = path.join(stateDir, PERSISTED_ENGINE_LIFECYCLE_DIRECTORY);
  requirePrivateDirectory(root);
  return Object.freeze({
    load(transactionId: string) {
      requirePrivateDirectory(root);
      return loadTransaction(root, transactionId);
    },
    listUnfinished() {
      requirePrivateDirectory(root);
      const records: PersistedEngineLifecycleRecord[] = [];
      for (const entry of fs.readdirSync(root).sort()) {
        if (entry.endsWith(".retired")) {
          const transactionId = exactSha256(
            entry.slice(0, -".retired".length),
            "retired transaction identity",
          );
          const receipt = readPrivateFile(tombstonePath(root, transactionId));
          if (
            receipt === null ||
            !SHA256.test(receipt.trim()) ||
            receipt !== `${receipt.trim()}\n`
          ) {
            fail("retirement receipt is malformed");
          }
          continue;
        }
        exactSha256(entry, "transaction directory identity");
        const record = loadTransaction(root, entry);
        if (record && record.phase !== "completed") records.push(record);
      }
      return Object.freeze(records);
    },
    create(value: PersistedEngineLifecycleRecord) {
      const record = normalizePersistedEngineLifecycleRecord(value);
      if (record.phase !== "prepared" || record.resultSha256 !== null) {
        fail("new lifecycle must begin in prepared phase");
      }
      requirePrivateDirectory(root);
      if (readPrivateFile(tombstonePath(root, record.transactionId)) !== null) {
        fail("retired transaction identity cannot be reused");
      }
      const existing = loadTransaction(root, record.transactionId);
      if (existing) {
        requireSameLifecycle(record, existing);
        return existing;
      }
      return publishPhase(root, record);
    },
    authorizeMutation(transactionId: string) {
      const current = loadTransaction(root, transactionId);
      if (!current) fail("mutation authorization requires prepared authority");
      if (current.phase === "mutation-authorized") return current;
      if (current.phase !== "prepared") fail(`mutation is not allowed from ${current.phase}`);
      return publishPhase(
        root,
        normalizePersistedEngineLifecycleRecord({
          ...current,
          phase: "mutation-authorized",
        }),
      );
    },
    complete(transactionId: string, resultSha256: string) {
      const result = exactSha256(resultSha256, "completion result digest");
      const current = loadTransaction(root, transactionId);
      if (!current) fail("completion requires durable mutation authority");
      if (current.phase === "completed") {
        if (current.resultSha256 === result) return current;
        fail("completion result digest changed");
      }
      if (current.phase !== "mutation-authorized") {
        fail(`completion is not allowed from ${current.phase}`);
      }
      return publishPhase(
        root,
        normalizePersistedEngineLifecycleRecord({
          ...current,
          phase: "completed",
          resultSha256: result,
        }),
      );
    },
    retire(transactionId: string, resultSha256: string) {
      const result = exactSha256(resultSha256, "completion result digest");
      requirePrivateDirectory(root);
      const tombstone = tombstonePath(root, transactionId);
      const existingTombstone = readPrivateFile(tombstone);
      if (existingTombstone !== null) {
        if (existingTombstone !== `${result}\n`) fail("retirement receipt digest changed");
        const remaining = loadTransaction(root, transactionId);
        if (remaining !== null) {
          if (remaining.phase !== "completed" || remaining.resultSha256 !== result) {
            fail("retirement tombstone does not match the remaining transaction");
          }
          fs.rmSync(transactionDirectory(root, transactionId), { force: true, recursive: true });
          fsyncDirectory(root);
        }
        return;
      }
      const current = loadTransaction(root, transactionId);
      if (!current || current.phase !== "completed" || current.resultSha256 !== result) {
        fail("retirement requires the exact completed receipt");
      }
      if (!publishExclusive(root, tombstone, `${result}\n`)) {
        const raced = readPrivateFile(tombstone);
        if (raced !== `${result}\n`) fail("retirement receipt digest changed");
      }
      fs.rmSync(transactionDirectory(root, transactionId), { force: true, recursive: true });
      fsyncDirectory(root);
    },
  });
}

function requireCurrentEngineAuthority(
  engineAuthorityStore: PersistedEngineAuthorityStore,
  expected: PersistedEngineAuthority,
  providerId: string,
  engine: ContainerEngine,
  bindingSha256: string,
): PersistedEngineAuthority {
  if (engine.operation !== "sandbox-lifecycle") {
    throw new Error("Persisted lifecycle requires a sandbox-lifecycle container engine.");
  }
  const current = engineAuthorityStore.load("sandbox-lifecycle");
  if (!current) {
    throw new Error("Persisted sandbox-lifecycle engine authority is missing.");
  }
  requirePersistedEngineAuthority(current, providerId, engine, bindingSha256);
  if (
    serializePersistedEngineAuthority(normalizePersistedEngineAuthority(current)) !==
    serializePersistedEngineAuthority(normalizePersistedEngineAuthority(expected))
  ) {
    throw new Error("Persisted lifecycle engine authority changed after preparation.");
  }
  return current;
}

function expectedRecord(
  input: PreparePersistedEngineLifecycleInput,
): PersistedEngineLifecycleRecord {
  const authority = input.engineAuthorityStore.load("sandbox-lifecycle");
  if (!authority) throw new Error("Persisted sandbox-lifecycle engine authority is missing.");
  requirePersistedEngineAuthority(authority, input.providerId, input.engine, input.bindingSha256);
  return normalizePersistedEngineLifecycleRecord({
    schemaVersion: PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION,
    transactionId: input.transactionId,
    action: input.action,
    phase: "prepared",
    sandboxName: input.sandboxName,
    resources: input.resources,
    runtimeStateSha256: input.runtimeStateSha256,
    engineAuthority: authority,
    resultSha256: null,
  });
}

export function preparePersistedEngineLifecycle(
  input: PreparePersistedEngineLifecycleInput,
): PersistedEngineLifecycleRecord {
  return input.lifecycleStore.create(expectedRecord(input));
}

function requireExpectedLifecycle(
  input: PersistedEngineLifecycleExecutionInput,
): PersistedEngineLifecycleRecord {
  const expected = expectedRecord(input);
  const current = input.lifecycleStore.load(input.transactionId);
  if (!current) throw new Error("Persisted lifecycle transaction is missing.");
  requireSameLifecycle(expected, current);
  requireCurrentEngineAuthority(
    input.engineAuthorityStore,
    current.engineAuthority,
    input.providerId,
    input.engine,
    input.bindingSha256,
  );
  return current;
}

function exactArguments(args: readonly string[], runtimeId: string): readonly string[] {
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_ARGUMENTS) {
    throw new Error("Exact runtime command has an invalid argument count.");
  }
  let exactRuntimeReferences = 0;
  const normalized = args.map((value, index) => {
    if (
      typeof value !== "string" ||
      CONTROL_CHARACTERS.test(value) ||
      Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES
    ) {
      throw new Error(`Exact runtime command argument ${String(index)} is invalid.`);
    }
    if (value === runtimeId) exactRuntimeReferences += 1;
    return value;
  });
  if (exactRuntimeReferences !== 1) {
    throw new Error("Exact runtime command must contain its persisted runtime ID exactly once.");
  }
  return Object.freeze(normalized);
}

function authorizedScope(
  input: PersistedEngineLifecycleExecutionInput,
  record: PersistedEngineLifecycleRecord,
): AuthorizedPersistedEngineLifecycle {
  const capture = (
    host: boolean,
    role: PersistedEngineLifecycleResourceRole,
    buildArgs: (runtimeId: string) => readonly string[],
    timeoutMs?: number,
  ): ContainerEngineCommandResult => {
    const resource = record.resources.find((candidate) => candidate.role === role);
    if (!resource) throw new Error(`Persisted lifecycle has no exact ${role} runtime authority.`);
    const args = exactArguments(buildArgs(resource.runtimeId), resource.runtimeId);
    const guard = () => {
      const current = requireExpectedLifecycle(input);
      if (current.phase !== "mutation-authorized") {
        throw new Error("Persisted lifecycle mutation authority is no longer active.");
      }
    };
    guard();
    let result: ContainerEngineCommandResult | undefined;
    let failure: unknown;
    try {
      result = host
        ? input.engine.captureHost(args, timeoutMs)
        : input.engine.capture(args, timeoutMs);
    } catch (error) {
      failure = error;
    }
    try {
      guard();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    if (failure !== undefined) throw failure;
    return result as ContainerEngineCommandResult;
  };
  return Object.freeze({
    record,
    captureExact: (role, buildArgs, timeoutMs) => capture(false, role, buildArgs, timeoutMs),
    captureHostExact: (role, buildArgs, timeoutMs) => capture(true, role, buildArgs, timeoutMs),
  });
}

/**
 * Resume either durable pre-mutation phase with the same exact authority.
 * A thrown callback leaves mutation-authorized state intact for the next
 * process; success durably publishes the caller's result receipt.
 */
export async function executePersistedEngineLifecycle<T>(
  input: PersistedEngineLifecycleExecutionInput,
  mutate: (
    scope: AuthorizedPersistedEngineLifecycle,
  ) =>
    | Promise<PersistedEngineLifecycleMutationResult<T>>
    | PersistedEngineLifecycleMutationResult<T>,
): Promise<{
  readonly record: PersistedEngineLifecycleRecord;
  readonly value: T;
}> {
  const current = requireExpectedLifecycle(input);
  if (current.phase === "completed") {
    throw new Error("Persisted lifecycle transaction is already completed.");
  }
  const authorized = input.lifecycleStore.authorizeMutation(input.transactionId);
  const result = await mutate(authorizedScope(input, authorized));
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    Object.keys(result).sort().join(",") !== "resultSha256,value"
  ) {
    throw new Error("Persisted lifecycle mutation returned an invalid completion result.");
  }
  const resultSha256 = exactSha256(result.resultSha256, "completion result digest");
  const value = result.value;
  const after = requireExpectedLifecycle(input);
  if (after.phase !== "mutation-authorized") {
    throw new Error("Persisted lifecycle mutation authority changed before completion.");
  }
  const completed = input.lifecycleStore.complete(input.transactionId, resultSha256);
  return Object.freeze({ record: completed, value });
}
