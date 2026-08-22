// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import {
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";
import {
  normalizePersistedEngineAuthority,
  type PersistedEngineAuthority,
} from "./persisted-engine-authority";

export const HOST_LOCAL_CREATE_JOURNAL_SCHEMA_VERSION = 1 as const;
export const HOST_LOCAL_CREATE_JOURNAL_DIRECTORY = "host-local-create-journal";

export type HostLocalCreateJournalPhase =
  | "network-creating"
  | "prepared"
  | "creating"
  | "created"
  | "started"
  | "receipt-prepared"
  | "finalized";

export interface HostLocalCreateJournalRecord {
  readonly schemaVersion: typeof HOST_LOCAL_CREATE_JOURNAL_SCHEMA_VERSION;
  readonly transactionId: string;
  readonly phase: HostLocalCreateJournalPhase;
  readonly providerId: string;
  readonly service: string;
  readonly containerName: string;
  readonly runtimeId: string | null;
  /** Durable wall-clock boundary for the phase's issued resource-create mutation. */
  readonly createIntentUnixMs: number | null;
  readonly specSha256: string;
  readonly networkId: string | null;
  /** Path- and value-free identity of the API-key file captured before create. */
  readonly apiKeyIdentitySha256: string;
  /** Path-free identity of the private directory chain that owns the API-key pathname. */
  readonly apiKeyRootIdentitySha256: string;
  readonly engineAuthority: PersistedEngineAuthority;
  /** Path- and value-free identity of the operation-scoped external state target. */
  readonly receiptTargetSha256: string;
  /** Canonical secret-free receipt retained for exact crash replay. */
  readonly serializedReceipt: string | null;
  readonly receiptSha256: string | null;
}

export interface HostLocalCreateJournalExecutionLease {
  readonly schemaVersion: typeof HOST_LOCAL_CREATE_JOURNAL_SCHEMA_VERSION;
  readonly transactionId: string;
  readonly ownerId: string;
  readonly ownerPid: number;
}

export interface HostLocalCreateJournalStore {
  readonly load: (transactionId: string) => HostLocalCreateJournalRecord | null;
  readonly list: () => readonly HostLocalCreateJournalRecord[];
  readonly create: (record: HostLocalCreateJournalRecord) => HostLocalCreateJournalRecord;
  readonly recordNetworkCreated: (
    transactionId: string,
    networkId: string,
  ) => HostLocalCreateJournalRecord;
  readonly recordCreating: (
    transactionId: string,
    createIntentUnixMs: number,
  ) => HostLocalCreateJournalRecord;
  readonly recordCreated: (
    transactionId: string,
    runtimeId: string,
  ) => HostLocalCreateJournalRecord;
  readonly recordStarted: (transactionId: string) => HostLocalCreateJournalRecord;
  readonly prepareReceipt: (
    transactionId: string,
    serializedReceipt: string,
  ) => HostLocalCreateJournalRecord;
  readonly finalize: (transactionId: string) => HostLocalCreateJournalRecord;
  readonly retire: (transactionId: string) => void;
  readonly acquireExecution: (transactionId: string) => HostLocalCreateJournalExecutionLease;
  readonly assertExecution: (lease: HostLocalCreateJournalExecutionLease) => void;
  readonly releaseExecution: (lease: HostLocalCreateJournalExecutionLease) => void;
}

export interface HostLocalCreateJournalStoreDependencies {
  readonly createOwnerId?: () => string;
  readonly ownerPid?: number;
  readonly processIsAlive?: (pid: number) => boolean;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const PROVIDER = /^[a-z][a-z0-9-]{0,62}$/u;
const SERVICE = /^[a-z][a-z0-9.-]{0,62}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:/=+-]{0,511}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const EXECUTION_LEASE_FILE = ".execution-lease.json";
const EXECUTION_RECOVERY_FILE = ".execution-recovery.json";
const PHASES = new Set<HostLocalCreateJournalPhase>([
  "network-creating",
  "prepared",
  "creating",
  "created",
  "started",
  "receipt-prepared",
  "finalized",
]);

function fail(message: string): never {
  throw new Error(`Host-local create journal is invalid: ${message}`);
}

function exactText(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is malformed`);
  return value;
}

function exactPid(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 0x7fffffff) {
    fail("execution owner process ID is malformed");
  }
  return Number(value);
}

function exactUnixMs(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("create intent timestamp is malformed");
  }
  return Number(value);
}

function parsePreparedReceipt(serialized: string) {
  try {
    return parseHostLocalInferenceReceipt(serialized);
  } catch (error) {
    fail(`prepared receipt is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeExecutionLease(value: unknown): HostLocalCreateJournalExecutionLease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("execution lease must be an object");
  }
  const lease = value as Record<string, unknown>;
  if (
    Object.keys(lease).sort().join(",") !== "ownerId,ownerPid,schemaVersion,transactionId" ||
    lease.schemaVersion !== HOST_LOCAL_CREATE_JOURNAL_SCHEMA_VERSION
  ) {
    fail("execution lease schema is unsupported");
  }
  return Object.freeze({
    schemaVersion: HOST_LOCAL_CREATE_JOURNAL_SCHEMA_VERSION,
    transactionId: exactText(lease.transactionId, SHA256, "execution transaction identity"),
    ownerId: exactText(lease.ownerId, UUID, "execution owner identity"),
    ownerPid: exactPid(lease.ownerPid),
  });
}

function serializeExecutionLease(value: HostLocalCreateJournalExecutionLease): string {
  return `${JSON.stringify(normalizeExecutionLease(value))}\n`;
}

export function normalizeHostLocalCreateJournalRecord(
  value: unknown,
): HostLocalCreateJournalRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("record must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "apiKeyIdentitySha256",
    "apiKeyRootIdentitySha256",
    "containerName",
    "createIntentUnixMs",
    "engineAuthority",
    "networkId",
    "phase",
    "providerId",
    "receiptSha256",
    "receiptTargetSha256",
    "runtimeId",
    "schemaVersion",
    "serializedReceipt",
    "service",
    "specSha256",
    "transactionId",
  ];
  if (
    Object.keys(record).sort().join(",") !== keys.sort().join(",") ||
    record.schemaVersion !== HOST_LOCAL_CREATE_JOURNAL_SCHEMA_VERSION ||
    typeof record.phase !== "string" ||
    !PHASES.has(record.phase as HostLocalCreateJournalPhase)
  ) {
    fail("record schema is unsupported");
  }
  const phase = record.phase as HostLocalCreateJournalPhase;
  const transactionId = exactText(record.transactionId, SHA256, "transaction identity");
  const providerId = exactText(record.providerId, PROVIDER, "provider identity");
  const service = exactText(record.service, SERVICE, "service identity");
  const runtimeId =
    record.runtimeId === null ? null : exactText(record.runtimeId, RUNTIME_ID, "runtime identity");
  const createIntentUnixMs =
    record.createIntentUnixMs === null ? null : exactUnixMs(record.createIntentUnixMs);
  const receiptSha256 =
    record.receiptSha256 === null
      ? null
      : exactText(record.receiptSha256, SHA256, "receipt digest");
  const serializedReceipt =
    record.serializedReceipt === null
      ? null
      : typeof record.serializedReceipt === "string"
        ? record.serializedReceipt
        : fail("serialized receipt must be canonical text or null");
  if (
    (phase === "network-creating" || phase === "prepared" || phase === "creating") !==
    (runtimeId === null)
  ) {
    fail("phase and runtime identity disagree");
  }
  if ((phase === "prepared") !== (createIntentUnixMs === null)) {
    fail("phase and create intent timestamp disagree");
  }
  const networkId =
    record.networkId === null ? null : exactText(record.networkId, RUNTIME_ID, "network identity");
  if ((phase === "network-creating") !== (networkId === null)) {
    fail("phase and network identity disagree");
  }
  const hasPreparedReceipt = phase === "receipt-prepared" || phase === "finalized";
  if (
    hasPreparedReceipt !== (receiptSha256 !== null) ||
    hasPreparedReceipt !== (serializedReceipt !== null)
  ) {
    fail("phase and receipt fields disagree");
  }
  const authority = normalizePersistedEngineAuthority(record.engineAuthority);
  if (authority.operation !== "host-local-inference") {
    fail("engine authority has the wrong operation");
  }
  if (serializedReceipt !== null && receiptSha256 !== null) {
    const receipt = parsePreparedReceipt(serializedReceipt);
    if (
      serializeHostLocalInferenceReceipt(receipt) !== serializedReceipt ||
      receipt.providerId !== providerId ||
      receipt.service !== service ||
      receipt.runtime.kind !== "container" ||
      receipt.runtime.runtimeId !== runtimeId ||
      receipt.runtime.specSha256 !== record.specSha256 ||
      receipt.runtime.model?.generation !== transactionId ||
      JSON.stringify(receipt.engineAuthority) !== JSON.stringify(authority)
    ) {
      fail("prepared receipt differs from create authority");
    }
    const expectedReceiptSha256 = createHash("sha256").update(serializedReceipt).digest("hex");
    if (receiptSha256 !== expectedReceiptSha256) {
      fail("prepared receipt digest changed");
    }
  }
  return Object.freeze({
    schemaVersion: HOST_LOCAL_CREATE_JOURNAL_SCHEMA_VERSION,
    transactionId,
    phase,
    providerId,
    service,
    containerName: exactText(record.containerName, NAME, "container name"),
    runtimeId,
    createIntentUnixMs,
    specSha256: exactText(record.specSha256, SHA256, "specification digest"),
    networkId,
    apiKeyIdentitySha256: exactText(
      record.apiKeyIdentitySha256,
      SHA256,
      "API-key file identity digest",
    ),
    apiKeyRootIdentitySha256: exactText(
      record.apiKeyRootIdentitySha256,
      SHA256,
      "API-key directory authority digest",
    ),
    engineAuthority: authority,
    receiptTargetSha256: exactText(record.receiptTargetSha256, SHA256, "receipt target identity"),
    serializedReceipt,
    receiptSha256,
  });
}

export function serializeHostLocalCreateJournalRecord(value: HostLocalCreateJournalRecord): string {
  const serialized = `${JSON.stringify(normalizeHostLocalCreateJournalRecord(value))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) fail("record exceeds its size limit");
  return serialized;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") fail("current-user identity is unavailable");
  return process.getuid();
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function requireDirectory(root: string, createIfMissing = true): boolean {
  const existed = fs.existsSync(root);
  if (!existed && !createIfMissing) return false;
  if (createIfMissing) fs.mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE });
  let status: fs.Stats;
  try {
    status = fs.lstatSync(root);
  } catch (error) {
    if (!createIfMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== currentUid() ||
    (status.mode & 0o077) !== 0 ||
    fs.realpathSync(root) !== root
  ) {
    fail("journal directory must be a private current-user-owned directory");
  }
  if (!existed) fsyncDirectory(path.dirname(root));
  return true;
}

function recordPath(root: string, transactionId: string): string {
  return path.join(root, `${exactText(transactionId, SHA256, "transaction identity")}.json`);
}

function sameStableMetadata(left: BigIntStats, right: BigIntStats): boolean {
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

function reconcileExclusivePublishOrphan(
  target: string,
  descriptor: number,
  initial: BigIntStats,
): BigIntStats {
  if (initial.nlink === 1n) return initial;
  if (initial.nlink !== 2n) fail("journal file link authority is invalid");
  const root = path.dirname(target);
  const prefix = `.${path.basename(target)}.`;
  const candidates = fs.readdirSync(root).filter((entry) => {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) return false;
    const ownerId = entry.slice(prefix.length, -".tmp".length);
    if (!UUID.test(ownerId)) return false;
    let status: BigIntStats;
    try {
      status = fs.lstatSync(path.join(root, entry), { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    return (
      status.isFile() &&
      !status.isSymbolicLink() &&
      status.dev === initial.dev &&
      status.ino === initial.ino
    );
  });
  const afterScan = fs.fstatSync(descriptor, { bigint: true });
  if (afterScan.dev !== initial.dev || afterScan.ino !== initial.ino) {
    fail("exclusive journal publication changed during recovery");
  }
  if (afterScan.nlink === 1n) {
    fsyncDirectory(root);
    return afterScan;
  }
  if (candidates.length !== 1) fail("exclusive journal publication is not recoverable");
  try {
    fs.unlinkSync(path.join(root, candidates[0]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fsyncDirectory(root);
  const reconciled = fs.fstatSync(descriptor, { bigint: true });
  if (reconciled.nlink !== 1n || reconciled.dev !== initial.dev || reconciled.ino !== initial.ino) {
    fail("exclusive journal publication changed during recovery");
  }
  return reconciled;
}

function readPrivateFile(target: string, recoverPublishOrphan = true): string | null {
  if (typeof fs.constants.O_NOFOLLOW !== "number") fail("O_NOFOLLOW is unavailable");
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | nonblock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const initial = fs.fstatSync(descriptor, { bigint: true });
    const before = recoverPublishOrphan
      ? reconcileExclusivePublishOrphan(target, descriptor, initial)
      : initial;
    if (
      !before.isFile() ||
      before.uid !== BigInt(currentUid()) ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(MAX_BYTES)
    ) {
      fail("journal file authority is invalid");
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
      fail("journal file changed during its stable read");
    }
    return contents.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRecord(
  target: string,
  recoverPublishOrphan = true,
): HostLocalCreateJournalRecord | null {
  const source = readPrivateFile(target, recoverPublishOrphan);
  if (source === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("journal record is not valid JSON");
  }
  const record = normalizeHostLocalCreateJournalRecord(parsed);
  if (serializeHostLocalCreateJournalRecord(record) !== source) {
    fail("journal record is not canonical");
  }
  return record;
}

function listRecords(
  root: string,
  options: { readonly createDirectory: boolean; readonly recoverPublishOrphans: boolean },
): readonly HostLocalCreateJournalRecord[] {
  if (!requireDirectory(root, options.createDirectory)) return Object.freeze([]);
  return Object.freeze(
    fs
      .readdirSync(root)
      .filter((entry) => SHA256.test(entry.replace(/\.json$/u, "")) && entry.endsWith(".json"))
      .sort()
      .flatMap((entry) => {
        const record = readRecord(path.join(root, entry), options.recoverPublishOrphans);
        return record === null ? [] : [record];
      }),
  );
}

function readExecutionLease(target: string): HostLocalCreateJournalExecutionLease | null {
  const source = readPrivateFile(target);
  if (source === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("execution lease is not valid JSON");
  }
  const lease = normalizeExecutionLease(parsed);
  if (serializeExecutionLease(lease) !== source) fail("execution lease is not canonical");
  return lease;
}

class HostLocalCreateJournalEntryExistsError extends Error {}

function publish(root: string, target: string, source: string, exclusive: boolean): void {
  if (typeof fs.constants.O_NOFOLLOW !== "number") fail("O_NOFOLLOW is unavailable");
  const temporary = path.join(root, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  let operationFailed = false;
  let operationFailure: unknown;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      FILE_MODE,
    );
    fs.writeFileSync(descriptor, source, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (exclusive) {
      try {
        fs.linkSync(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new HostLocalCreateJournalEntryExistsError(
            "Host-local create journal is invalid: transaction already exists",
          );
        }
        throw error;
      }
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      fs.renameSync(temporary, target);
    }
    fs.chmodSync(target, FILE_MODE);
    fsyncDirectory(root);
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }
  let cleanupFailure: unknown;
  try {
    if (descriptor !== null) fs.closeSync(descriptor);
  } catch (error) {
    cleanupFailure = error;
  }
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && cleanupFailure === undefined) {
      cleanupFailure = error;
    }
  }
  if (operationFailed) throw operationFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

function publishExclusive(root: string, target: string, source: string): boolean {
  try {
    publish(root, target, source, true);
    return true;
  } catch (error) {
    if (error instanceof HostLocalCreateJournalEntryExistsError) return false;
    throw error;
  }
}

function sameExecutionLease(
  left: HostLocalCreateJournalExecutionLease,
  right: HostLocalCreateJournalExecutionLease,
): boolean {
  return serializeExecutionLease(left) === serializeExecutionLease(right);
}

function removeExactExecutionLease(
  root: string,
  target: string,
  expected: HostLocalCreateJournalExecutionLease,
): void {
  const current = readExecutionLease(target);
  if (current === null || !sameExecutionLease(current, expected)) {
    fail("execution ownership changed");
  }
  fs.unlinkSync(target);
  fsyncDirectory(root);
}

function defaultProcessIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function createHostLocalCreateJournalStore(
  stateDirectory: string,
  dependencies: HostLocalCreateJournalStoreDependencies = {},
): HostLocalCreateJournalStore {
  const root = path.join(stateDirectory, HOST_LOCAL_CREATE_JOURNAL_DIRECTORY);
  const executionLeasePath = path.join(root, EXECUTION_LEASE_FILE);
  const executionRecoveryPath = path.join(root, EXECUTION_RECOVERY_FILE);
  const ownerPid = exactPid(dependencies.ownerPid ?? process.pid);
  const processIsAlive = dependencies.processIsAlive ?? defaultProcessIsAlive;
  const load = (transactionId: string) => {
    requireDirectory(root);
    return readRecord(recordPath(root, transactionId));
  };
  const replace = (
    transactionId: string,
    update: (current: HostLocalCreateJournalRecord) => HostLocalCreateJournalRecord,
  ) => {
    const current = load(transactionId);
    if (!current) fail("transaction is missing");
    const next = normalizeHostLocalCreateJournalRecord(update(current));
    publish(
      root,
      recordPath(root, transactionId),
      serializeHostLocalCreateJournalRecord(next),
      false,
    );
    return next;
  };
  const store: HostLocalCreateJournalStore = {
    load,
    list() {
      return listRecords(root, { createDirectory: true, recoverPublishOrphans: true });
    },
    create(record) {
      requireDirectory(root);
      const normalized = normalizeHostLocalCreateJournalRecord(record);
      if (normalized.phase !== "prepared" && normalized.phase !== "network-creating") {
        fail("new transaction must record a prepared resource mutation");
      }
      publish(
        root,
        recordPath(root, normalized.transactionId),
        serializeHostLocalCreateJournalRecord(normalized),
        true,
      );
      return normalized;
    },
    recordNetworkCreated(transactionId, networkId) {
      return replace(transactionId, (current) => {
        if (current.phase !== "network-creating") {
          fail("only a network-creating transaction can record network creation");
        }
        return {
          ...current,
          phase: "prepared",
          networkId: exactText(networkId, RUNTIME_ID, "network identity"),
          createIntentUnixMs: null,
        };
      });
    },
    recordCreating(transactionId, createIntentUnixMs) {
      return replace(transactionId, (current) => {
        if (current.phase !== "prepared") fail("only a prepared transaction can record intent");
        return { ...current, phase: "creating", createIntentUnixMs };
      });
    },
    recordCreated(transactionId, runtimeId) {
      return replace(transactionId, (current) => {
        if (current.phase !== "creating") fail("only a creating transaction can record creation");
        return { ...current, phase: "created", runtimeId };
      });
    },
    recordStarted(transactionId) {
      return replace(transactionId, (current) => {
        if (current.phase !== "created") fail("only a created transaction can record start");
        return { ...current, phase: "started" };
      });
    },
    prepareReceipt(transactionId, serializedReceipt) {
      return replace(transactionId, (current) => {
        if (current.phase !== "started") {
          fail("only a started transaction can prepare receipt publication");
        }
        const receipt = parsePreparedReceipt(serializedReceipt);
        if (serializeHostLocalInferenceReceipt(receipt) !== serializedReceipt) {
          fail("prepared receipt bytes are not canonical");
        }
        return {
          ...current,
          phase: "receipt-prepared",
          serializedReceipt,
          receiptSha256: createHash("sha256").update(serializedReceipt).digest("hex"),
        };
      });
    },
    finalize(transactionId) {
      return replace(transactionId, (current) => {
        if (current.phase === "finalized") return current;
        if (current.phase !== "receipt-prepared") {
          fail("only a receipt-prepared transaction can finalize");
        }
        return { ...current, phase: "finalized" };
      });
    },
    retire(transactionId) {
      requireDirectory(root);
      try {
        fs.unlinkSync(recordPath(root, transactionId));
        fsyncDirectory(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    acquireExecution(transactionId) {
      requireDirectory(root);
      const lease = normalizeExecutionLease({
        schemaVersion: HOST_LOCAL_CREATE_JOURNAL_SCHEMA_VERSION,
        transactionId,
        ownerId: (dependencies.createOwnerId ?? randomUUID)(),
        ownerPid,
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const recovery = readExecutionLease(executionRecoveryPath);
        if (recovery !== null) {
          if (processIsAlive(recovery.ownerPid)) {
            fail("execution recovery is already owned by a live process");
          }
          removeExactExecutionLease(root, executionRecoveryPath, recovery);
          continue;
        }
        if (publishExclusive(root, executionLeasePath, serializeExecutionLease(lease))) {
          if (readExecutionLease(executionRecoveryPath) === null) return lease;
          removeExactExecutionLease(root, executionLeasePath, lease);
          continue;
        }
        const existing = readExecutionLease(executionLeasePath);
        if (existing === null) continue;
        if (processIsAlive(existing.ownerPid)) {
          fail("execution is already owned by a live process");
        }
        if (!publishExclusive(root, executionRecoveryPath, serializeExecutionLease(lease))) {
          fail("execution recovery is already in progress");
        }
        try {
          const abandoned = readExecutionLease(executionLeasePath);
          if (abandoned !== null && processIsAlive(abandoned.ownerPid)) {
            fail("execution owner became live during recovery");
          }
          if (abandoned !== null) {
            removeExactExecutionLease(root, executionLeasePath, abandoned);
          }
        } finally {
          const marker = readExecutionLease(executionRecoveryPath);
          if (marker !== null && sameExecutionLease(marker, lease)) {
            removeExactExecutionLease(root, executionRecoveryPath, lease);
          }
        }
      }
      fail("execution ownership could not be acquired");
    },
    assertExecution(lease) {
      requireDirectory(root);
      const expected = normalizeExecutionLease(lease);
      const current = readExecutionLease(executionLeasePath);
      if (current === null || !sameExecutionLease(current, expected)) {
        fail("execution ownership changed");
      }
    },
    releaseExecution(lease) {
      requireDirectory(root);
      removeExactExecutionLease(root, executionLeasePath, normalizeExecutionLease(lease));
    },
  };
  return Object.freeze(store);
}

/** Reconcile an interrupted exclusive publish and read records without creating a directory. */
export function reconcileAndReadHostLocalCreateJournalRecords(
  stateDirectory: string,
): readonly HostLocalCreateJournalRecord[] {
  const root = path.join(stateDirectory, HOST_LOCAL_CREATE_JOURNAL_DIRECTORY);
  return listRecords(root, { createDirectory: false, recoverPublishOrphans: true });
}
