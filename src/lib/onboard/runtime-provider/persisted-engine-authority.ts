// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ContainerEngine,
  ContainerEngineOperationScope,
} from "../../adapters/container-engine";

export const PERSISTED_ENGINE_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const PERSISTED_ENGINE_AUTHORITY_DIRECTORY = "runtime-provider-authority";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 16 * 1024;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const ENGINE_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const AUTHORITY_ID = /^[a-z][a-z0-9-]{0,62}:[A-Za-z0-9._:-]{1,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATIONS = new Set<ContainerEngineOperationScope>([
  "host-doctor",
  "host-local-inference",
  "gateway-inspection",
  "managed-bootstrap",
  "sandbox-lifecycle",
  "state-mutation",
  "workload-cleanup",
]);

/**
 * Immutable, provider-neutral identity for one qualified container-engine
 * operation. The record carries no executable, endpoint, environment, or
 * credential material; those remain owned by the provider that reconstructs
 * and qualifies the injected ContainerEngine.
 */
export interface PersistedEngineAuthority {
  readonly schemaVersion: typeof PERSISTED_ENGINE_AUTHORITY_SCHEMA_VERSION;
  readonly providerId: string;
  readonly operation: ContainerEngineOperationScope;
  readonly engineId: string;
  readonly authorityId: string;
  readonly bindingSha256: string;
}

export interface PersistedEngineAuthorityStore {
  readonly load: (operation: ContainerEngineOperationScope) => PersistedEngineAuthority | null;
  /** Write once, or prove an existing record is byte-for-byte identical. */
  readonly record: (authority: PersistedEngineAuthority) => PersistedEngineAuthority;
}

function fail(message: string): never {
  throw new Error(`Persisted engine authority is invalid: ${message}`);
}

function exactIdentity(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is malformed`);
  }
  return value;
}

function exactOperation(value: unknown): ContainerEngineOperationScope {
  if (typeof value !== "string" || !OPERATIONS.has(value as ContainerEngineOperationScope)) {
    fail("operation is unsupported");
  }
  return value as ContainerEngineOperationScope;
}

export function normalizePersistedEngineAuthority(value: unknown): PersistedEngineAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("record must be an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "authorityId",
    "bindingSha256",
    "engineId",
    "operation",
    "providerId",
    "schemaVersion",
  ];
  if (
    Object.keys(record).sort().join(",") !== expectedKeys.join(",") ||
    record.schemaVersion !== PERSISTED_ENGINE_AUTHORITY_SCHEMA_VERSION
  ) {
    fail("record schema is unsupported");
  }
  return Object.freeze({
    schemaVersion: PERSISTED_ENGINE_AUTHORITY_SCHEMA_VERSION,
    providerId: exactIdentity(record.providerId, PROVIDER_ID, "provider identity"),
    operation: exactOperation(record.operation),
    engineId: exactIdentity(record.engineId, ENGINE_ID, "engine identity"),
    authorityId: exactIdentity(record.authorityId, AUTHORITY_ID, "endpoint authority identity"),
    bindingSha256: exactIdentity(record.bindingSha256, SHA256, "binding digest"),
  });
}

export function serializePersistedEngineAuthority(authority: PersistedEngineAuthority): string {
  const serialized = `${JSON.stringify(normalizePersistedEngineAuthority(authority))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    fail("serialized record exceeds its bounded transport");
  }
  return serialized;
}

export function parsePersistedEngineAuthority(serialized: string): PersistedEngineAuthority {
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
  const authority = normalizePersistedEngineAuthority(parsed);
  if (serializePersistedEngineAuthority(authority) !== serialized) {
    fail("serialized record is not canonical");
  }
  return authority;
}

export function createPersistedEngineAuthority(
  providerId: string,
  engine: ContainerEngine,
  bindingSha256: string,
): PersistedEngineAuthority {
  return normalizePersistedEngineAuthority({
    schemaVersion: PERSISTED_ENGINE_AUTHORITY_SCHEMA_VERSION,
    providerId,
    operation: engine.operation,
    engineId: engine.engineId,
    authorityId: engine.authorityId,
    bindingSha256,
  });
}

/**
 * Reject a freshly provider-qualified engine unless it matches the recorded
 * identity. Callers must perform this check before lifecycle or destructive
 * mutation.
 */
export function requirePersistedEngineAuthority(
  persisted: PersistedEngineAuthority,
  providerId: string,
  engine: ContainerEngine,
  bindingSha256: string,
): PersistedEngineAuthority {
  const authority = normalizePersistedEngineAuthority(persisted);
  const qualified = createPersistedEngineAuthority(providerId, engine, bindingSha256);
  if (authority.providerId !== qualified.providerId) {
    throw new Error("Qualified runtime provider does not match persisted engine authority.");
  }
  if (authority.operation !== qualified.operation) {
    throw new Error("Qualified container-engine operation does not match persisted authority.");
  }
  if (authority.engineId !== qualified.engineId) {
    throw new Error("Qualified container-engine identity does not match persisted authority.");
  }
  if (authority.authorityId !== qualified.authorityId) {
    throw new Error("Qualified container endpoint does not match persisted authority.");
  }
  if (authority.bindingSha256 !== qualified.bindingSha256) {
    throw new Error("Qualified runtime binding does not match persisted engine authority.");
  }
  return authority;
}

function operationFileName(operation: ContainerEngineOperationScope): string {
  return `${exactOperation(operation)}.json`;
}

export function persistedEngineAuthorityPath(
  stateDir: string,
  operation: ContainerEngineOperationScope,
): string {
  return path.join(stateDir, PERSISTED_ENGINE_AUTHORITY_DIRECTORY, operationFileName(operation));
}

function currentUid(fallback: number | bigint): bigint {
  return BigInt(typeof process.getuid === "function" ? process.getuid() : fallback);
}

function requirePrivateDirectory(directory: string, createIfMissing: boolean): void {
  if (createIfMissing) fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail("authority directory is missing");
    }
    throw error;
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    BigInt(metadata.uid) !== currentUid(metadata.uid) ||
    (metadata.mode & 0o077) !== 0
  ) {
    fail("authority directory must be a private real directory owned by the current user");
  }
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

function readPrivateRecord(target: string): string | null {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    fail("O_NOFOLLOW is unavailable for persisted authority reads");
  }
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow | nonblock);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") fail("authority file must not be a symbolic link");
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
      fail("authority file failed ownership, mode, link, or size checks");
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
      fail("authority file changed during its stable read");
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

function writeExclusiveRecord(directory: string, target: string, serialized: string): boolean {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    fail("O_NOFOLLOW is unavailable for persisted authority writes");
  }
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

function filePersistedEngineAuthorityStore(
  stateDir: string,
  createIfMissing: boolean,
): PersistedEngineAuthorityStore {
  const directory = path.join(stateDir, PERSISTED_ENGINE_AUTHORITY_DIRECTORY);
  requirePrivateDirectory(directory, createIfMissing);
  const load = (operation: ContainerEngineOperationScope): PersistedEngineAuthority | null => {
    requirePrivateDirectory(directory, createIfMissing);
    const serialized = readPrivateRecord(path.join(directory, operationFileName(operation)));
    return serialized === null ? null : parsePersistedEngineAuthority(serialized);
  };
  return Object.freeze({
    load,
    record(authority: PersistedEngineAuthority) {
      if (!createIfMissing) fail("read-only authority store cannot record authority");
      const normalized = normalizePersistedEngineAuthority(authority);
      const serialized = serializePersistedEngineAuthority(normalized);
      const target = path.join(directory, operationFileName(normalized.operation));
      const existing = load(normalized.operation);
      if (existing !== null) {
        if (serializePersistedEngineAuthority(existing) === serialized) return existing;
        throw new Error(`Persisted engine authority already exists for '${normalized.operation}'.`);
      }
      if (writeExclusiveRecord(directory, target, serialized)) return normalized;
      const raced = load(normalized.operation);
      if (raced !== null && serializePersistedEngineAuthority(raced) === serialized) return raced;
      throw new Error(`Persisted engine authority already exists for '${normalized.operation}'.`);
    },
  });
}

export function createFilePersistedEngineAuthorityStore(
  stateDir: string,
): PersistedEngineAuthorityStore {
  return filePersistedEngineAuthorityStore(stateDir, true);
}

/** Open an existing authority store without creating or repairing filesystem state. */
export function openFilePersistedEngineAuthorityStore(
  stateDir: string,
): PersistedEngineAuthorityStore {
  return filePersistedEngineAuthorityStore(stateDir, false);
}
