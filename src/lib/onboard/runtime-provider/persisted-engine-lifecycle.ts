// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import { readMcpLockProcessIdentity } from "../../state/mcp-lifecycle-lock-identity";
import {
  normalizePersistedEngineAuthority,
  type PersistedEngineAuthority,
  type PersistedEngineAuthorityStore,
  requirePersistedEngineAuthority,
  serializePersistedEngineAuthority,
} from "./persisted-engine-authority";

export const PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const PERSISTED_ENGINE_LIFECYCLE_DIRECTORY = "runtime-provider-lifecycle";
export const PERSISTED_ENGINE_STATE_MUTATION_INTENT_SCHEMA_VERSION = 1 as const;
export const PERSISTED_ENGINE_STATE_MUTATION_INTENT_FILE = "state-mutation-intent.json";
export const PERSISTED_ENGINE_STATE_MUTATION_RELEASE_FILE = "provider-release-finalized.json";

export type PersistedEngineLifecycleAction =
  | "snapshot-create"
  | "snapshot-clone"
  | "rebuild"
  | "backup"
  | "restore"
  | "recovery"
  | "state-mutation";

export type PersistedEngineLifecyclePhase =
  | "prepared"
  | "mutation-authorized"
  | "fence-established"
  | "completed";

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

export interface PersistedEngineStateMutationIntentInput {
  /** Canonical bounded provider plan that can reconstruct the exact acquire request. */
  readonly serializedPlan: string;
  readonly planSha256: string;
  readonly projectionSha256: string;
  readonly nonce: string;
}

export interface PersistedEngineStateMutationIntent extends PersistedEngineStateMutationIntentInput {
  readonly schemaVersion: typeof PERSISTED_ENGINE_STATE_MUTATION_INTENT_SCHEMA_VERSION;
  readonly transactionId: string;
}

interface PersistedEngineStateMutationReleaseReceipt {
  readonly schemaVersion: typeof PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION;
  readonly transactionId: string;
  readonly resultSha256: string;
  readonly completedRecordSha256: string;
}

export interface PersistedEngineLifecycleStore {
  readonly load: (transactionId: string) => PersistedEngineLifecycleRecord | null;
  /** Load a write-once intent, including an intent published before prepared authority. */
  readonly loadStateMutationIntent: (
    transactionId: string,
  ) => PersistedEngineStateMutationIntent | null;
  /** Publish the exact intent before any state-mutation prepared authority. */
  readonly recordStateMutationIntent: (
    intent: PersistedEngineStateMutationIntent,
  ) => PersistedEngineStateMutationIntent;
  readonly listUnfinished: () => readonly PersistedEngineLifecycleRecord[];
  readonly create: (record: PersistedEngineLifecycleRecord) => PersistedEngineLifecycleRecord;
  readonly authorizeMutation: (transactionId: string) => PersistedEngineLifecycleRecord;
  readonly assertStateMutationTargetClaim: (
    transactionId: string,
  ) => PersistedEngineLifecycleRecord;
  readonly establishStateMutationFence: (
    lease: PersistedEngineLifecycleExecutionLease,
  ) => PersistedEngineLifecycleRecord;
  /**
   * Acquire one process-owned execution lease before invoking a mutation.
   * State-mutation preparation may hold this lease before publishing mutation
   * authority so an external fence marker can be established without a crash
   * window. A dead or PID-recycled owner may be recovered, but the exact live
   * owner wins.
   */
  readonly acquireMutationExecution: (
    transactionId: string,
  ) => PersistedEngineLifecycleExecutionLease;
  readonly assertMutationExecution: (lease: PersistedEngineLifecycleExecutionLease) => void;
  readonly releaseMutationExecution: (lease: PersistedEngineLifecycleExecutionLease) => void;
  readonly complete: (
    lease: PersistedEngineLifecycleExecutionLease,
    resultSha256: string,
  ) => PersistedEngineLifecycleRecord;
  /**
   * Retire the exact-target claim only after the provider's external fence was
   * released from the already-durable state-mutation completion receipt.
   */
  readonly finalizeStateMutationRelease: (
    lease: PersistedEngineLifecycleExecutionLease,
    resultSha256: string,
  ) => PersistedEngineLifecycleRecord;
  /** True only after provider release returned and its exact receipt is durable. */
  readonly isStateMutationReleaseFinalized: (
    transactionId: string,
    resultSha256: string,
  ) => boolean;
  /** Retire only the exact completed receipt; a durable tombstone prevents ID reuse. */
  readonly retire: (transactionId: string, resultSha256: string) => void;
  /** Finish provider cleanup before retiring a released mutation's durable receipt. */
  readonly retireReleasedStateMutations: (
    sandboxName: string,
    beforeRetire: (record: PersistedEngineLifecycleRecord) => void,
  ) => void;
  /** Match only an exact durable retirement receipt. */
  readonly isRetired: (transactionId: string, resultSha256: string) => boolean;
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
  /** Required only for state-mutation preparation. */
  readonly stateMutationIntent?: PersistedEngineStateMutationIntentInput;
}

export type PersistedEngineLifecycleExecutionInput = PreparePersistedEngineLifecycleInput;

export interface PersistedEngineLifecycleExecutionLease {
  readonly schemaVersion: typeof PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION;
  readonly transactionId: string;
  readonly ownerId: string;
  readonly ownerPid: number;
  readonly ownerStartIdentity: string;
}

export interface PersistedEngineLifecycleExactCommand {
  readonly args: readonly string[];
  /** Index containing the command's one exact persisted runtime target. */
  readonly targetIndex: number;
  /** Fixed absolute container path when the command targets `runtimeId:path`. */
  readonly targetPath?: string;
}

export interface AuthorizedPersistedEngineLifecycle {
  readonly record: PersistedEngineLifecycleRecord;
  /**
   * Execute against one exact persisted runtime handle. The builder must place
   * that handle exactly once and declare its semantic target position.
   */
  readonly captureExact: (
    role: PersistedEngineLifecycleResourceRole,
    buildCommand: (runtimeId: string) => PersistedEngineLifecycleExactCommand,
    timeoutMs?: number,
    commandInput?: Buffer,
  ) => ContainerEngineCommandResult;
  readonly captureHostExact: (
    role: PersistedEngineLifecycleResourceRole,
    buildCommand: (runtimeId: string) => PersistedEngineLifecycleExactCommand,
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
const MAX_STATE_MUTATION_PLAN_BYTES = 64 * 1024;
const MAX_STATE_MUTATION_INTENT_BYTES = 128 * 1024;
const MAX_STATE_MUTATION_NONCE_BYTES = 512;
const MAX_ARGUMENTS = 512;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:/=+-]{0,511}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const ACTIONS = new Set<PersistedEngineLifecycleAction>([
  "snapshot-create",
  "snapshot-clone",
  "rebuild",
  "backup",
  "restore",
  "recovery",
  "state-mutation",
]);
const PHASES = new Set<PersistedEngineLifecyclePhase>([
  "prepared",
  "mutation-authorized",
  "fence-established",
  "completed",
]);
const PHASE_FILES = ["prepared", "mutation-authorized", "fence-established", "completed"] as const;
const EXECUTION_LEASE_FILE = "mutation-execution.json";
const EXECUTION_RECOVERY_FILE = ".mutation-execution-recovery";
const RUNTIME_TARGET_CLAIM_DIRECTORY = "runtime-target-claims";
let currentProcessStartIdentityValue: string | undefined;
const TRANSACTION_PUBLISH_TARGETS = [
  ...PHASE_FILES.map((phase) => `${phase}.json`),
  PERSISTED_ENGINE_STATE_MUTATION_INTENT_FILE,
  PERSISTED_ENGINE_STATE_MUTATION_RELEASE_FILE,
  EXECUTION_LEASE_FILE,
  EXECUTION_RECOVERY_FILE,
] as const;
const resourceRoles = (
  ...roles: PersistedEngineLifecycleResourceRole[]
): readonly PersistedEngineLifecycleResourceRole[] => Object.freeze(roles);
const REQUIRED_ROLES: Readonly<
  Record<PersistedEngineLifecycleAction, readonly PersistedEngineLifecycleResourceRole[]>
> = Object.freeze({
  "snapshot-create": resourceRoles("source"),
  "snapshot-clone": resourceRoles("source", "target"),
  rebuild: resourceRoles("source", "target"),
  backup: resourceRoles("source"),
  restore: resourceRoles("source", "target"),
  recovery: resourceRoles("target"),
  "state-mutation": resourceRoles("target"),
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
  if (phase === "fence-established" && action !== "state-mutation") {
    fail("only state-mutation may establish an external fence");
  }
  const resultSha256 =
    record.resultSha256 === null
      ? null
      : exactSha256(record.resultSha256, "completion result digest");
  if ((phase === "completed") !== (resultSha256 !== null)) {
    fail("completion result digest does not match the phase");
  }
  const engineAuthority = normalizePersistedEngineAuthority(record.engineAuthority);
  if (
    engineAuthority.operation !== "sandbox-lifecycle" &&
    !(action === "state-mutation" && engineAuthority.operation === "state-mutation")
  ) {
    fail("lifecycle authority does not match the lifecycle action");
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

function exactStateMutationPlan(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTERS.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_STATE_MUTATION_PLAN_BYTES ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    fail("state-mutation plan is empty, malformed, or too large");
  }
  return value;
}

function exactStateMutationNonce(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTERS.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_STATE_MUTATION_NONCE_BYTES ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    fail("state-mutation nonce is empty, malformed, or too large");
  }
  return value;
}

export function normalizePersistedEngineStateMutationIntent(
  value: unknown,
): PersistedEngineStateMutationIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("state-mutation intent must be an object");
  }
  const intent = value as Record<string, unknown>;
  const expectedKeys = [
    "nonce",
    "planSha256",
    "projectionSha256",
    "schemaVersion",
    "serializedPlan",
    "transactionId",
  ];
  if (
    Object.keys(intent).sort().join(",") !== expectedKeys.join(",") ||
    intent.schemaVersion !== PERSISTED_ENGINE_STATE_MUTATION_INTENT_SCHEMA_VERSION
  ) {
    fail("state-mutation intent schema is unsupported");
  }
  const serializedPlan = exactStateMutationPlan(intent.serializedPlan);
  const planSha256 = exactSha256(intent.planSha256, "state-mutation plan digest");
  if (createHash("sha256").update(serializedPlan, "utf8").digest("hex") !== planSha256) {
    fail("state-mutation plan digest does not match its serialized plan");
  }
  return Object.freeze({
    schemaVersion: PERSISTED_ENGINE_STATE_MUTATION_INTENT_SCHEMA_VERSION,
    transactionId: exactSha256(intent.transactionId, "state-mutation transaction identity"),
    serializedPlan,
    planSha256,
    projectionSha256: exactSha256(intent.projectionSha256, "state-mutation projection digest"),
    nonce: exactStateMutationNonce(intent.nonce),
  });
}

export function serializePersistedEngineStateMutationIntent(
  value: PersistedEngineStateMutationIntent,
): string {
  const intent = normalizePersistedEngineStateMutationIntent(value);
  const transport: Record<string, unknown> = Object.create(null);
  transport.schemaVersion = intent.schemaVersion;
  transport.transactionId = intent.transactionId;
  transport.serializedPlan = intent.serializedPlan;
  transport.planSha256 = intent.planSha256;
  transport.projectionSha256 = intent.projectionSha256;
  transport.nonce = intent.nonce;
  const serialized = `${JSON.stringify(transport)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_MUTATION_INTENT_BYTES) {
    fail("serialized state-mutation intent exceeds its bounded transport");
  }
  return serialized;
}

export function parsePersistedEngineStateMutationIntent(
  serialized: string,
): PersistedEngineStateMutationIntent {
  if (
    serialized.length === 0 ||
    serialized.includes("\0") ||
    Buffer.byteLength(serialized, "utf8") > MAX_STATE_MUTATION_INTENT_BYTES
  ) {
    fail("serialized state-mutation intent is empty or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("serialized state-mutation intent is not valid JSON");
  }
  const intent = normalizePersistedEngineStateMutationIntent(parsed);
  if (serializePersistedEngineStateMutationIntent(intent) !== serialized) {
    fail("serialized state-mutation intent is not canonical");
  }
  return intent;
}

function completedRecordSha256(record: PersistedEngineLifecycleRecord): string {
  if (record.action !== "state-mutation" || record.phase !== "completed") {
    fail("provider release receipt requires one completed state mutation");
  }
  return createHash("sha256")
    .update(serializePersistedEngineLifecycleRecord(record), "utf8")
    .digest("hex");
}

function normalizeStateMutationReleaseReceipt(
  value: unknown,
): PersistedEngineStateMutationReleaseReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("provider release receipt must be an object");
  }
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join(",") !==
      "completedRecordSha256,resultSha256,schemaVersion,transactionId" ||
    receipt.schemaVersion !== PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION
  ) {
    fail("provider release receipt schema is unsupported");
  }
  return Object.freeze({
    schemaVersion: PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION,
    transactionId: exactSha256(receipt.transactionId, "provider release transaction identity"),
    resultSha256: exactSha256(receipt.resultSha256, "provider release completion digest"),
    completedRecordSha256: exactSha256(
      receipt.completedRecordSha256,
      "provider release completed-record digest",
    ),
  });
}

function serializeStateMutationReleaseReceipt(
  value: PersistedEngineStateMutationReleaseReceipt,
): string {
  const receipt = normalizeStateMutationReleaseReceipt(value);
  const transport: Record<string, unknown> = Object.create(null);
  transport.schemaVersion = receipt.schemaVersion;
  transport.transactionId = receipt.transactionId;
  transport.resultSha256 = receipt.resultSha256;
  transport.completedRecordSha256 = receipt.completedRecordSha256;
  return `${JSON.stringify(transport)}\n`;
}

function parseStateMutationReleaseReceipt(
  serialized: string,
): PersistedEngineStateMutationReleaseReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("provider release receipt is not valid JSON");
  }
  const receipt = normalizeStateMutationReleaseReceipt(parsed);
  if (serializeStateMutationReleaseReceipt(receipt) !== serialized) {
    fail("provider release receipt is not canonical");
  }
  return receipt;
}

function stateMutationIntentForTransaction(
  transactionId: string,
  value: unknown,
): PersistedEngineStateMutationIntent {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "nonce,planSha256,projectionSha256,serializedPlan"
  ) {
    fail("state-mutation intent input schema is unsupported");
  }
  const intent = value as Record<string, unknown>;
  return normalizePersistedEngineStateMutationIntent({
    schemaVersion: PERSISTED_ENGINE_STATE_MUTATION_INTENT_SCHEMA_VERSION,
    transactionId,
    serializedPlan: intent.serializedPlan,
    planSha256: intent.planSha256,
    projectionSha256: intent.projectionSha256,
    nonce: intent.nonce,
  });
}

function normalizeExecutionLease(value: unknown): PersistedEngineLifecycleExecutionLease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("mutation execution lease must be an object");
  }
  const lease = value as Record<string, unknown>;
  if (
    Object.keys(lease).sort().join(",") !==
      "ownerId,ownerPid,ownerStartIdentity,schemaVersion,transactionId" ||
    lease.schemaVersion !== PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION ||
    typeof lease.ownerId !== "string" ||
    !UUID.test(lease.ownerId) ||
    !Number.isSafeInteger(lease.ownerPid) ||
    (lease.ownerPid as number) <= 0 ||
    (lease.ownerPid as number) > 0x7fffffff ||
    typeof lease.ownerStartIdentity !== "string" ||
    lease.ownerStartIdentity.length === 0 ||
    lease.ownerStartIdentity.length > 512 ||
    CONTROL_CHARACTERS.test(lease.ownerStartIdentity)
  ) {
    fail("mutation execution lease schema is unsupported");
  }
  return Object.freeze({
    schemaVersion: PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION,
    transactionId: exactSha256(lease.transactionId, "mutation transaction identity"),
    ownerId: lease.ownerId,
    ownerPid: lease.ownerPid as number,
    ownerStartIdentity: lease.ownerStartIdentity,
  });
}

function serializeExecutionLease(lease: PersistedEngineLifecycleExecutionLease): string {
  return `${JSON.stringify(normalizeExecutionLease(lease))}\n`;
}

function parseExecutionLease(serialized: string): PersistedEngineLifecycleExecutionLease {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("mutation execution lease is not valid JSON");
  }
  const lease = normalizeExecutionLease(parsed);
  if (serializeExecutionLease(lease) !== serialized) {
    fail("mutation execution lease is not canonical");
  }
  return lease;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function currentProcessStartIdentity(): string {
  return (currentProcessStartIdentityValue ??=
    readMcpLockProcessIdentity(process.pid, true) ??
    `unverified-self:${String(process.pid)}:${randomUUID()}`);
}

function exactExecutionOwnerIsAlive(lease: PersistedEngineLifecycleExecutionLease): boolean {
  if (!processIsAlive(lease.ownerPid)) return false;
  const currentIdentity = readMcpLockProcessIdentity(lease.ownerPid, true);
  if (currentIdentity !== null) return currentIdentity === lease.ownerStartIdentity;
  return (
    lease.ownerPid !== process.pid || lease.ownerStartIdentity === currentProcessStartIdentity()
  );
}

function currentUid(): bigint {
  if (typeof process.getuid !== "function") fail("current user identity is unavailable");
  return BigInt(process.getuid());
}

function verifyPrivateDirectory(directory: string): void {
  const metadata = fs.lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    BigInt(metadata.uid) !== currentUid() ||
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

function repairInterruptedExclusivePublication(target: string): void {
  const directory = path.dirname(target);
  const targetBasename = path.basename(target);
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!isPublishTemporaryEntry(entry, targetBasename)) continue;
    const temporary = path.join(directory, entry);
    let targetMetadata: fs.BigIntStats;
    let temporaryMetadata: fs.BigIntStats;
    try {
      targetMetadata = fs.lstatSync(target, { bigint: true });
      temporaryMetadata = fs.lstatSync(temporary, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      targetMetadata.dev !== temporaryMetadata.dev ||
      targetMetadata.ino !== temporaryMetadata.ino
    ) {
      continue;
    }
    if (
      !targetMetadata.isFile() ||
      targetMetadata.isSymbolicLink() ||
      !temporaryMetadata.isFile() ||
      temporaryMetadata.isSymbolicLink() ||
      targetMetadata.uid !== currentUid() ||
      (targetMetadata.mode & 0o077n) !== 0n ||
      targetMetadata.nlink !== 2n ||
      temporaryMetadata.nlink !== 2n
    ) {
      fail("interrupted ledger publication failed ownership, mode, or link checks");
    }
    try {
      fs.unlinkSync(temporary);
      fsyncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function readPrivateFile(target: string, maxBytes = MAX_RECORD_BYTES): string | null {
  repairInterruptedExclusivePublication(target);
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
      before.uid !== currentUid() ||
      (before.mode & 0o077n) !== 0n ||
      before.size <= 0n ||
      before.size > BigInt(maxBytes)
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
    // A concurrent reader may already have repaired the post-link crash window.
    fs.rmSync(temporary, { force: true });
    fsyncDirectory(directory);
    return true;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function isPublishTemporaryEntry(entry: string, targetBasename: string): boolean {
  const prefix = `.${targetBasename}.`;
  const suffix = ".tmp";
  return (
    entry.startsWith(prefix) &&
    entry.endsWith(suffix) &&
    UUID.test(entry.slice(prefix.length, -suffix.length))
  );
}

function isTransactionPublishTemporaryEntry(entry: string): boolean {
  return TRANSACTION_PUBLISH_TARGETS.some((target) => isPublishTemporaryEntry(entry, target));
}

function isRootPublishTemporaryEntry(entry: string): boolean {
  const transactionId = entry.slice(1, 65);
  return SHA256.test(transactionId) && isPublishTemporaryEntry(entry, `${transactionId}.retired`);
}

function transactionDirectory(root: string, transactionId: string): string {
  return path.join(root, exactSha256(transactionId, "transaction identity"));
}

function phasePath(directory: string, phase: PersistedEngineLifecyclePhase): string {
  return path.join(directory, `${phase}.json`);
}

function stateMutationIntentPath(directory: string): string {
  return path.join(directory, PERSISTED_ENGINE_STATE_MUTATION_INTENT_FILE);
}

function stateMutationReleasePath(directory: string): string {
  return path.join(directory, PERSISTED_ENGINE_STATE_MUTATION_RELEASE_FILE);
}

function tombstonePath(root: string, transactionId: string): string {
  return path.join(root, `${exactSha256(transactionId, "transaction identity")}.retired`);
}

function runtimeTargetClaimDirectory(root: string): string {
  return path.join(root, RUNTIME_TARGET_CLAIM_DIRECTORY);
}

function executionLeasePath(directory: string): string {
  return path.join(directory, EXECUTION_LEASE_FILE);
}

function executionRecoveryPath(directory: string): string {
  return path.join(directory, EXECUTION_RECOVERY_FILE);
}

function loadStateMutationIntentArtifact(
  directory: string,
  transactionId: string,
): PersistedEngineStateMutationIntent | null {
  const serialized = readPrivateFile(
    stateMutationIntentPath(directory),
    MAX_STATE_MUTATION_INTENT_BYTES,
  );
  if (serialized === null) return null;
  const intent = parsePersistedEngineStateMutationIntent(serialized);
  if (intent.transactionId !== transactionId) {
    fail("state-mutation intent names another transaction");
  }
  return intent;
}

function expectedStateMutationReleaseReceipt(
  record: PersistedEngineLifecycleRecord,
): PersistedEngineStateMutationReleaseReceipt {
  if (record.resultSha256 === null) {
    fail("provider release receipt requires the exact completion digest");
  }
  return Object.freeze({
    schemaVersion: PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION,
    transactionId: record.transactionId,
    resultSha256: record.resultSha256,
    completedRecordSha256: completedRecordSha256(record),
  });
}

function loadStateMutationReleaseReceipt(
  directory: string,
  record: PersistedEngineLifecycleRecord,
): PersistedEngineStateMutationReleaseReceipt | null {
  const serialized = readPrivateFile(stateMutationReleasePath(directory));
  if (serialized === null) return null;
  const receipt = parseStateMutationReleaseReceipt(serialized);
  const expected = expectedStateMutationReleaseReceipt(record);
  if (
    serializeStateMutationReleaseReceipt(receipt) !== serializeStateMutationReleaseReceipt(expected)
  ) {
    fail("provider release receipt does not match the exact completed transaction");
  }
  return receipt;
}

function loadExecutionLease(directory: string): PersistedEngineLifecycleExecutionLease | null {
  const serialized = readPrivateFile(executionLeasePath(directory));
  return serialized === null ? null : parseExecutionLease(serialized);
}

function loadExecutionRecovery(directory: string): PersistedEngineLifecycleExecutionLease | null {
  const serialized = readPrivateFile(executionRecoveryPath(directory));
  return serialized === null ? null : parseExecutionLease(serialized);
}

function requireExactExecutionLease(
  directory: string,
  expected: PersistedEngineLifecycleExecutionLease,
): PersistedEngineLifecycleExecutionLease {
  const current = loadExecutionLease(directory);
  if (!current || serializeExecutionLease(current) !== serializeExecutionLease(expected)) {
    fail("mutation execution ownership changed");
  }
  return current;
}

function removeExactExecutionLease(
  directory: string,
  expected: PersistedEngineLifecycleExecutionLease,
): void {
  requireExactExecutionLease(directory, expected);
  fs.unlinkSync(executionLeasePath(directory));
  fsyncDirectory(directory);
}

function removeExactExecutionRecovery(
  directory: string,
  expected: PersistedEngineLifecycleExecutionLease,
): void {
  const current = loadExecutionRecovery(directory);
  if (!current || serializeExecutionLease(current) !== serializeExecutionLease(expected)) {
    fail("mutation execution recovery ownership changed");
  }
  fs.unlinkSync(executionRecoveryPath(directory));
  fsyncDirectory(directory);
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

function loadStateMutationIntentFromRoot(
  root: string,
  transactionId: string,
): PersistedEngineStateMutationIntent | null {
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
  return loadStateMutationIntentArtifact(directory, transactionId);
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
  if (
    entries.some(
      (entry) =>
        entry !== EXECUTION_LEASE_FILE &&
        entry !== EXECUTION_RECOVERY_FILE &&
        entry !== PERSISTED_ENGINE_STATE_MUTATION_INTENT_FILE &&
        entry !== PERSISTED_ENGINE_STATE_MUTATION_RELEASE_FILE &&
        !isTransactionPublishTemporaryEntry(entry) &&
        !PHASE_FILES.some((phase) => entry === `${phase}.json`),
    )
  ) {
    fail("transaction directory contains an unsupported entry");
  }
  const intent = loadStateMutationIntentArtifact(directory, transactionId);
  const prepared = loadPhase(directory, "prepared");
  if (!prepared) {
    if (
      entries.some(
        (entry) =>
          entry === EXECUTION_LEASE_FILE ||
          entry === EXECUTION_RECOVERY_FILE ||
          entry === PERSISTED_ENGINE_STATE_MUTATION_RELEASE_FILE ||
          PHASE_FILES.some((phase) => entry === `${phase}.json`),
      )
    ) {
      fail("transaction is missing its exact prepared authority");
    }
    // Preparation can stop after it publishes the write-once intent or creates
    // its private directory. Neither state grants lifecycle or target authority.
    return null;
  }
  if (prepared.transactionId !== transactionId) {
    fail("transaction is missing its exact prepared authority");
  }
  if (prepared.action === "state-mutation" && intent === null) {
    fail("prepared state mutation is missing its exact intent");
  }
  if (prepared.action !== "state-mutation" && intent !== null) {
    fail("state-mutation intent cannot authorize another lifecycle action");
  }
  const authorized = loadPhase(directory, "mutation-authorized");
  const established = loadPhase(directory, "fence-established");
  const completed = loadPhase(directory, "completed");
  if (established && !authorized) {
    fail("established fence is missing mutation authority");
  }
  if (completed && (!authorized || (prepared.action === "state-mutation" && !established))) {
    fail("completed transaction is missing required mutation authority");
  }
  if (authorized) requireSameLifecycle(prepared, authorized);
  if (established) requireSameLifecycle(prepared, established);
  if (completed) requireSameLifecycle(prepared, completed);
  const current = completed ?? established ?? authorized ?? prepared;
  const releaseReceipt = readPrivateFile(stateMutationReleasePath(directory));
  if (releaseReceipt !== null) {
    if (current.action !== "state-mutation" || current.phase !== "completed") {
      fail("provider release receipt requires one completed state mutation");
    }
    if (loadStateMutationReleaseReceipt(directory, current) === null) {
      fail("provider release receipt disappeared during inspection");
    }
  }
  return current;
}

function runtimeTarget(record: PersistedEngineLifecycleRecord): string | null {
  return record.resources.find((resource) => resource.role === "target")?.runtimeId ?? null;
}

function runtimeTargetClaimIdentity(record: PersistedEngineLifecycleRecord): string | null {
  const target = runtimeTarget(record);
  if (target === null) return null;
  return createHash("sha256")
    .update(record.engineAuthority.providerId, "utf8")
    .update("\0", "utf8")
    .update(target, "utf8")
    .digest("hex");
}

function runtimeTargetClaimPath(
  root: string,
  record: PersistedEngineLifecycleRecord,
): string | null {
  const identity = runtimeTargetClaimIdentity(record);
  return identity === null ? null : path.join(runtimeTargetClaimDirectory(root), identity);
}

function loadRuntimeTargetClaim(
  root: string,
  identity: string,
): PersistedEngineLifecycleRecord | null {
  const serialized = readPrivateFile(
    path.join(runtimeTargetClaimDirectory(root), exactSha256(identity, "target claim identity")),
  );
  if (serialized === null) return null;
  const record = parsePersistedEngineLifecycleRecord(serialized);
  if (
    runtimeTarget(record) === null ||
    runtimeTargetClaimIdentity(record) !== identity ||
    record.phase !== "prepared"
  ) {
    fail("runtime target claim is malformed");
  }
  return record;
}

function removeExactRuntimeTargetClaim(
  root: string,
  expected: PersistedEngineLifecycleRecord,
): void {
  const identity = runtimeTargetClaimIdentity(expected);
  const target = runtimeTargetClaimPath(root, expected);
  if (identity === null || target === null) return;
  const claim = loadRuntimeTargetClaim(root, identity);
  if (!claim) return;
  requireSameLifecycle(expected, claim);
  fs.unlinkSync(target);
  fsyncDirectory(runtimeTargetClaimDirectory(root));
}

function hasExactRuntimeTargetClaim(
  root: string,
  expected: PersistedEngineLifecycleRecord,
): boolean {
  const identity = runtimeTargetClaimIdentity(expected);
  if (identity === null) return false;
  const claim = loadRuntimeTargetClaim(root, identity);
  if (!claim) return false;
  requireSameLifecycle(expected, claim);
  return true;
}

function hasMatchingRuntimeTargetClaim(
  root: string,
  expected: PersistedEngineLifecycleRecord,
): boolean {
  const identity = runtimeTargetClaimIdentity(expected);
  if (identity === null) return true;
  const claim = loadRuntimeTargetClaim(root, identity);
  if (!claim || claim.transactionId !== expected.transactionId) return false;
  requireSameLifecycle(expected, claim);
  return true;
}

function hasFinalizedStateMutationRelease(
  root: string,
  record: PersistedEngineLifecycleRecord,
): boolean {
  if (record.action !== "state-mutation" || record.phase !== "completed") return false;
  return (
    loadStateMutationReleaseReceipt(transactionDirectory(root, record.transactionId), record) !==
    null
  );
}

function acquireRuntimeTargetClaim(root: string, candidate: PersistedEngineLifecycleRecord): void {
  const identity = runtimeTargetClaimIdentity(candidate);
  const target = runtimeTargetClaimPath(root, candidate);
  if (identity === null || target === null) return;
  const claimDirectory = runtimeTargetClaimDirectory(root);
  requirePrivateDirectory(claimDirectory);
  const prepared = normalizePersistedEngineLifecycleRecord(immutableRecord(candidate));
  const serialized = serializePersistedEngineLifecycleRecord(prepared);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (publishExclusive(claimDirectory, target, serialized)) return;
    const existing = loadRuntimeTargetClaim(root, identity);
    if (!existing) continue;
    const existingTransaction = loadTransaction(root, existing.transactionId);
    if (!existingTransaction) {
      // Prepared authority is published before any claim in this protocol.
      // A claim without that authority is corruption; never make a stale
      // orphan decision that could unlink a concurrently recovered owner.
      fail("runtime target claim is missing its prepared authority");
    }
    requireSameLifecycle(existing, existingTransaction);
    if (existing.transactionId === prepared.transactionId) {
      requireSameLifecycle(prepared, existing);
      return;
    }
    // A completed owner may still be finishing its claim cleanup. Competing
    // creators never unlink another transaction's claim; the exact owner must
    // release it while holding its execution lease.
    fail("exact runtime target already has an unfinished transaction");
  }
  fail("exact runtime target claim could not be acquired");
}

function abandonNewUnclaimedPreparedTransaction(
  root: string,
  expected: PersistedEngineLifecycleRecord,
): void {
  const directory = transactionDirectory(root, expected.transactionId);
  const current = loadTransaction(root, expected.transactionId);
  if (!current) return;
  requireSameLifecycle(expected, current);
  if (
    current.phase !== "prepared" ||
    hasMatchingRuntimeTargetClaim(root, current) ||
    readPrivateFile(executionLeasePath(directory)) !== null ||
    readPrivateFile(executionRecoveryPath(directory)) !== null
  ) {
    return;
  }
  fs.rmSync(directory, { force: true, recursive: true });
  fsyncDirectory(root);
}

function listUnfinishedTransactions(root: string): readonly PersistedEngineLifecycleRecord[] {
  requirePrivateDirectory(root);
  const records = new Map<string, PersistedEngineLifecycleRecord>();
  for (const entry of fs.readdirSync(root).sort()) {
    if (isRootPublishTemporaryEntry(entry)) continue;
    if (entry === RUNTIME_TARGET_CLAIM_DIRECTORY) continue;
    if (entry.endsWith(".retired")) {
      const transactionId = exactSha256(
        entry.slice(0, -".retired".length),
        "retired transaction identity",
      );
      const receipt = readPrivateFile(tombstonePath(root, transactionId));
      if (receipt === null || !SHA256.test(receipt.trim()) || receipt !== `${receipt.trim()}\n`) {
        fail("retirement receipt is malformed");
      }
      continue;
    }
    exactSha256(entry, "transaction directory identity");
    const record = loadTransaction(root, entry);
    if (!record) continue;
    if (record.phase === "completed") {
      if (
        record.action === "state-mutation" &&
        (!hasFinalizedStateMutationRelease(root, record) ||
          hasMatchingRuntimeTargetClaim(root, record))
      ) {
        records.set(record.transactionId, record);
      }
      continue;
    }
    if (runtimeTarget(record) === null || hasMatchingRuntimeTargetClaim(root, record)) {
      records.set(record.transactionId, record);
    } else if (record.phase === "prepared" && record.action === "state-mutation") {
      // A prepared mutation without a claim is still authoritative. Recovery
      // must reacquire the exact target before any helper replay.
      records.set(record.transactionId, record);
    } else {
      fail("unfinished target transaction is missing its exact claim");
    }
  }
  const claimDirectory = runtimeTargetClaimDirectory(root);
  requirePrivateDirectory(claimDirectory);
  for (const entry of fs.readdirSync(claimDirectory).sort()) {
    if (isPublishTemporaryEntry(entry, entry.slice(1, 65))) continue;
    const claim = loadRuntimeTargetClaim(root, entry);
    if (!claim) fail("runtime target claim disappeared during inspection");
    const current = loadTransaction(root, claim.transactionId);
    if (current) requireSameLifecycle(claim, current);
    if (
      !current ||
      current.phase !== "completed" ||
      (current.action === "state-mutation" && hasExactRuntimeTargetClaim(root, current))
    ) {
      records.set(claim.transactionId, current ?? claim);
    }
  }
  return Object.freeze(
    [...records.values()].sort((left, right) =>
      left.transactionId < right.transactionId
        ? -1
        : left.transactionId > right.transactionId
          ? 1
          : 0,
    ),
  );
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

function exactRetirementExists(root: string, transactionId: string, resultSha256: string): boolean {
  const receipt = readPrivateFile(tombstonePath(root, transactionId));
  if (receipt === null) return false;
  if (receipt !== `${exactSha256(resultSha256, "completion result digest")}\n`) {
    fail("retirement receipt digest changed");
  }
  return true;
}

function recoverExecutionArtifactsForRetirement(directory: string, transactionId: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lease = loadExecutionLease(directory);
    const existingRecovery = loadExecutionRecovery(directory);
    if (!lease && !existingRecovery) return;
    if (existingRecovery) {
      if (existingRecovery.transactionId !== transactionId) {
        fail("mutation execution recovery names another transaction");
      }
      if (exactExecutionOwnerIsAlive(existingRecovery)) {
        fail("retirement cannot interrupt live mutation execution recovery");
      }
      removeExactExecutionRecovery(directory, existingRecovery);
      continue;
    }
    if (!lease) continue;
    if (lease.transactionId !== transactionId) {
      fail("mutation execution lease names another transaction");
    }
    if (exactExecutionOwnerIsAlive(lease)) {
      fail("retirement requires released mutation execution ownership");
    }
    const recovery = normalizeExecutionLease({
      schemaVersion: PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION,
      transactionId,
      ownerId: randomUUID(),
      ownerPid: process.pid,
      ownerStartIdentity: currentProcessStartIdentity(),
    });
    if (
      !publishExclusive(
        directory,
        executionRecoveryPath(directory),
        serializeExecutionLease(recovery),
      )
    ) {
      continue;
    }
    try {
      const abandoned = loadExecutionLease(directory);
      if (abandoned && exactExecutionOwnerIsAlive(abandoned)) {
        fail("mutation execution owner became live during retirement recovery");
      }
      if (abandoned) removeExactExecutionLease(directory, abandoned);
    } finally {
      const marker = loadExecutionRecovery(directory);
      if (marker && serializeExecutionLease(marker) === serializeExecutionLease(recovery)) {
        removeExactExecutionRecovery(directory, recovery);
      }
    }
  }
  fail("retirement could not recover abandoned mutation execution ownership");
}

function retireCompletedTransaction(
  root: string,
  transactionId: string,
  resultSha256: string,
): void {
  const result = exactSha256(resultSha256, "completion result digest");
  requirePrivateDirectory(root);
  const directory = transactionDirectory(root, transactionId);
  const existingTombstone = exactRetirementExists(root, transactionId, result);
  if (existingTombstone) {
    const remaining = loadTransaction(root, transactionId);
    if (remaining !== null) {
      if (remaining.phase !== "completed" || remaining.resultSha256 !== result) {
        fail("retirement tombstone does not match the remaining transaction");
      }
      if (
        remaining.action === "state-mutation" &&
        (!hasFinalizedStateMutationRelease(root, remaining) ||
          hasMatchingRuntimeTargetClaim(root, remaining))
      ) {
        fail("retirement tombstone precedes provider fence release");
      }
      recoverExecutionArtifactsForRetirement(directory, transactionId);
      fs.rmSync(directory, { force: true, recursive: true });
      fsyncDirectory(root);
    }
    return;
  }
  const current = loadTransaction(root, transactionId);
  if (!current || current.phase !== "completed" || current.resultSha256 !== result) {
    fail("retirement requires the exact completed receipt");
  }
  if (current.action === "state-mutation" && !hasFinalizedStateMutationRelease(root, current)) {
    fail("state-mutation retirement requires a finalized provider release receipt");
  }
  if (runtimeTarget(current) !== null && hasMatchingRuntimeTargetClaim(root, current)) {
    if (current.action === "state-mutation") {
      fail("state-mutation retirement requires released provider fence authority");
    }
    fail("retirement requires the owning mutation to release its exact runtime target claim");
  }
  recoverExecutionArtifactsForRetirement(directory, transactionId);
  const tombstone = tombstonePath(root, transactionId);
  if (!publishExclusive(root, tombstone, `${result}\n`)) {
    exactRetirementExists(root, transactionId, result);
  }
  fs.rmSync(directory, { force: true, recursive: true });
  fsyncDirectory(root);
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
    loadStateMutationIntent(transactionId: string) {
      requirePrivateDirectory(root);
      return loadStateMutationIntentFromRoot(root, transactionId);
    },
    recordStateMutationIntent(value: PersistedEngineStateMutationIntent) {
      const intent = normalizePersistedEngineStateMutationIntent(value);
      requirePrivateDirectory(root);
      if (readPrivateFile(tombstonePath(root, intent.transactionId)) !== null) {
        fail("retired transaction identity cannot be reused");
      }
      const current = loadTransaction(root, intent.transactionId);
      if (current && current.action !== "state-mutation") {
        fail("state-mutation intent cannot authorize another lifecycle action");
      }
      const directory = transactionDirectory(root, intent.transactionId);
      requirePrivateDirectory(directory);
      const serialized = serializePersistedEngineStateMutationIntent(intent);
      if (publishExclusive(directory, stateMutationIntentPath(directory), serialized)) {
        return intent;
      }
      const existing = loadStateMutationIntentArtifact(directory, intent.transactionId);
      if (existing && serializePersistedEngineStateMutationIntent(existing) === serialized) {
        return existing;
      }
      fail("state-mutation intent already exists with different content");
    },
    listUnfinished() {
      return listUnfinishedTransactions(root);
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
      const intent = loadStateMutationIntentFromRoot(root, record.transactionId);
      if (record.action === "state-mutation" && intent === null) {
        fail("state-mutation preparation requires its exact durable intent");
      }
      if (record.action !== "state-mutation" && intent !== null) {
        fail("state-mutation intent cannot authorize another lifecycle action");
      }
      const existing = loadTransaction(root, record.transactionId);
      if (existing) {
        requireSameLifecycle(record, existing);
        if (existing.phase !== "completed") acquireRuntimeTargetClaim(root, record);
        return existing;
      }
      const published = publishPhase(root, record);
      // Publish prepared authority first. Authorization remains impossible
      // until this exact transaction wins the target claim, and an interrupted
      // creator can never leave a claim that races its own later publication.
      try {
        acquireRuntimeTargetClaim(root, published);
      } catch (error) {
        // The caller still owns the per-sandbox transition lock. A candidate
        // that never won its target claim cannot authorize helper execution
        // and must not remain as a conservative orphan.
        abandonNewUnclaimedPreparedTransaction(root, published);
        throw error;
      }
      return published;
    },
    authorizeMutation(transactionId: string) {
      const current = loadTransaction(root, transactionId);
      if (!current) fail("mutation authorization requires prepared authority");
      if (!hasMatchingRuntimeTargetClaim(root, current)) {
        fail("mutation authorization requires the exact runtime target claim");
      }
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
    assertStateMutationTargetClaim(transactionId: string) {
      const current = loadTransaction(root, transactionId);
      if (
        !current ||
        current.action !== "state-mutation" ||
        !hasExactRuntimeTargetClaim(root, current)
      ) {
        fail("active state mutation requires the exact runtime target claim");
      }
      return current;
    },
    establishStateMutationFence(lease: PersistedEngineLifecycleExecutionLease) {
      const execution = normalizeExecutionLease(lease);
      const directory = transactionDirectory(root, execution.transactionId);
      requireExactExecutionLease(directory, execution);
      const current = loadTransaction(root, execution.transactionId);
      if (!current || current.action !== "state-mutation") {
        fail("external fence establishment requires state-mutation authority");
      }
      if (!hasExactRuntimeTargetClaim(root, current)) {
        fail("external fence establishment requires the exact runtime target claim");
      }
      if (current.phase === "fence-established") return current;
      if (current.phase !== "mutation-authorized") {
        fail(`external fence establishment is not allowed from ${current.phase}`);
      }
      return publishPhase(
        root,
        normalizePersistedEngineLifecycleRecord({
          ...current,
          phase: "fence-established",
        }),
      );
    },
    acquireMutationExecution(transactionId: string) {
      const current = loadTransaction(root, transactionId);
      const releaseFinalized = current ? hasFinalizedStateMutationRelease(root, current) : false;
      if (
        current?.action === "state-mutation" &&
        (current.phase === "prepared" || (current.phase === "completed" && !releaseFinalized)) &&
        !hasMatchingRuntimeTargetClaim(root, current)
      ) {
        acquireRuntimeTargetClaim(root, current);
      }
      if (
        current &&
        current.phase !== "completed" &&
        !hasMatchingRuntimeTargetClaim(root, current)
      ) {
        fail("mutation execution requires the exact runtime target claim");
      }
      const pendingStateMutationRelease =
        current?.action === "state-mutation" &&
        current.phase === "completed" &&
        hasMatchingRuntimeTargetClaim(root, current);
      const preparedStateMutation =
        current?.action === "state-mutation" && current.phase === "prepared";
      if (
        !current ||
        (current.phase === "completed" && releaseFinalized && !pendingStateMutationRelease) ||
        (!preparedStateMutation &&
          current.phase !== "mutation-authorized" &&
          current.phase !== "fence-established" &&
          !pendingStateMutationRelease)
      ) {
        fail("mutation execution requires durable mutation authority");
      }
      const directory = transactionDirectory(root, transactionId);
      requirePrivateDirectory(directory);
      const ownerStartIdentity = currentProcessStartIdentity();
      const lease = normalizeExecutionLease({
        schemaVersion: PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION,
        transactionId,
        ownerId: randomUUID(),
        ownerPid: process.pid,
        ownerStartIdentity,
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const existingRecovery = loadExecutionRecovery(directory);
        if (existingRecovery) {
          if (existingRecovery.transactionId !== transactionId) {
            fail("mutation execution recovery names another transaction");
          }
          if (exactExecutionOwnerIsAlive(existingRecovery)) {
            fail("mutation execution recovery is already in progress");
          }
          removeExactExecutionRecovery(directory, existingRecovery);
        }
        if (
          publishExclusive(directory, executionLeasePath(directory), serializeExecutionLease(lease))
        ) {
          if (readPrivateFile(executionRecoveryPath(directory)) === null) return lease;
          removeExactExecutionLease(directory, lease);
          continue;
        }

        const existing = loadExecutionLease(directory);
        if (!existing) continue;
        if (existing.transactionId !== transactionId) {
          fail("mutation execution lease names another transaction");
        }
        if (exactExecutionOwnerIsAlive(existing)) {
          fail("mutation execution is already owned by a live process");
        }

        const recovery = normalizeExecutionLease({
          schemaVersion: PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION,
          transactionId,
          ownerId: randomUUID(),
          ownerPid: process.pid,
          ownerStartIdentity,
        });
        if (
          !publishExclusive(
            directory,
            executionRecoveryPath(directory),
            serializeExecutionLease(recovery),
          )
        ) {
          continue;
        }
        try {
          const abandoned = loadExecutionLease(directory);
          if (abandoned && exactExecutionOwnerIsAlive(abandoned)) {
            fail("mutation execution owner became live during recovery");
          }
          if (abandoned) removeExactExecutionLease(directory, abandoned);
        } finally {
          const marker = loadExecutionRecovery(directory);
          if (marker && serializeExecutionLease(marker) === serializeExecutionLease(recovery)) {
            removeExactExecutionRecovery(directory, recovery);
          }
        }
      }
      fail("mutation execution ownership could not be acquired");
    },
    assertMutationExecution(lease: PersistedEngineLifecycleExecutionLease) {
      const expected = normalizeExecutionLease(lease);
      const current = loadTransaction(root, expected.transactionId);
      const releaseFinalized = current ? hasFinalizedStateMutationRelease(root, current) : false;
      if (
        current &&
        current.phase !== "completed" &&
        !hasMatchingRuntimeTargetClaim(root, current)
      ) {
        fail("mutation execution requires the exact runtime target claim");
      }
      const pendingStateMutationRelease =
        current?.action === "state-mutation" &&
        current.phase === "completed" &&
        hasMatchingRuntimeTargetClaim(root, current);
      const preparedStateMutation =
        current?.action === "state-mutation" && current.phase === "prepared";
      if (
        !current ||
        (current.phase === "completed" && releaseFinalized && !pendingStateMutationRelease) ||
        (!preparedStateMutation &&
          current.phase !== "mutation-authorized" &&
          current.phase !== "fence-established" &&
          !pendingStateMutationRelease)
      ) {
        fail("mutation execution authority is no longer active");
      }
      requireExactExecutionLease(transactionDirectory(root, expected.transactionId), expected);
    },
    releaseMutationExecution(lease: PersistedEngineLifecycleExecutionLease) {
      const expected = normalizeExecutionLease(lease);
      const current = loadTransaction(root, expected.transactionId);
      if (!current) fail("mutation execution transaction is missing");
      removeExactExecutionLease(transactionDirectory(root, expected.transactionId), expected);
    },
    complete(lease: PersistedEngineLifecycleExecutionLease, resultSha256: string) {
      const execution = normalizeExecutionLease(lease);
      const directory = transactionDirectory(root, execution.transactionId);
      requireExactExecutionLease(directory, execution);
      const result = exactSha256(resultSha256, "completion result digest");
      const current = loadTransaction(root, execution.transactionId);
      if (!current) fail("completion requires durable mutation authority");
      if (current.phase !== "completed" && !hasMatchingRuntimeTargetClaim(root, current)) {
        fail("completion requires the exact runtime target claim");
      }
      if (current.phase === "completed") {
        if (current.resultSha256 === result) return current;
        fail("completion result digest changed");
      }
      const requiredPhase =
        current.action === "state-mutation" ? "fence-established" : "mutation-authorized";
      if (current.phase !== requiredPhase) {
        fail(`completion is not allowed from ${current.phase}`);
      }
      const completed = publishPhase(
        root,
        normalizePersistedEngineLifecycleRecord({
          ...current,
          phase: "completed",
          resultSha256: result,
        }),
      );
      if (completed.action !== "state-mutation") {
        removeExactRuntimeTargetClaim(root, completed);
      }
      return completed;
    },
    finalizeStateMutationRelease(
      lease: PersistedEngineLifecycleExecutionLease,
      resultSha256: string,
    ) {
      const execution = normalizeExecutionLease(lease);
      const directory = transactionDirectory(root, execution.transactionId);
      requireExactExecutionLease(directory, execution);
      const result = exactSha256(resultSha256, "completion result digest");
      const current = loadTransaction(root, execution.transactionId);
      if (
        !current ||
        current.action !== "state-mutation" ||
        current.phase !== "completed" ||
        current.resultSha256 !== result
      ) {
        fail("state-mutation release requires the exact completed receipt");
      }
      const existingReceipt = loadStateMutationReleaseReceipt(directory, current);
      if (existingReceipt === null && !hasExactRuntimeTargetClaim(root, current)) {
        fail("state-mutation release target claim is missing");
      }
      const receipt = expectedStateMutationReleaseReceipt(current);
      const serialized = serializeStateMutationReleaseReceipt(receipt);
      if (
        existingReceipt === null &&
        !publishExclusive(directory, stateMutationReleasePath(directory), serialized)
      ) {
        const raced = loadStateMutationReleaseReceipt(directory, current);
        if (!raced || serializeStateMutationReleaseReceipt(raced) !== serialized) {
          fail("provider release receipt changed during publication");
        }
      }
      if (hasMatchingRuntimeTargetClaim(root, current)) {
        removeExactRuntimeTargetClaim(root, current);
      }
      return current;
    },
    isStateMutationReleaseFinalized(transactionId: string, resultSha256: string) {
      const result = exactSha256(resultSha256, "completion result digest");
      const current = loadTransaction(root, transactionId);
      if (
        !current ||
        current.action !== "state-mutation" ||
        current.phase !== "completed" ||
        current.resultSha256 !== result
      ) {
        fail("provider release status requires the exact completed receipt");
      }
      return hasFinalizedStateMutationRelease(root, current);
    },
    retire(transactionId: string, resultSha256: string) {
      retireCompletedTransaction(root, transactionId, resultSha256);
    },
    retireReleasedStateMutations(
      sandboxName: string,
      beforeRetire: (record: PersistedEngineLifecycleRecord) => void,
    ) {
      const exactSandboxName = exactName(sandboxName, "sandbox name");
      requirePrivateDirectory(root);
      for (const entry of fs.readdirSync(root).sort()) {
        if (
          entry === RUNTIME_TARGET_CLAIM_DIRECTORY ||
          entry.endsWith(".retired") ||
          isRootPublishTemporaryEntry(entry)
        ) {
          continue;
        }
        exactSha256(entry, "transaction directory identity");
        const current = loadTransaction(root, entry);
        if (
          current?.action === "state-mutation" &&
          current.phase === "completed" &&
          current.sandboxName === exactSandboxName &&
          hasFinalizedStateMutationRelease(root, current) &&
          !hasMatchingRuntimeTargetClaim(root, current)
        ) {
          beforeRetire(current);
          retireCompletedTransaction(root, current.transactionId, current.resultSha256 as string);
        }
      }
    },
    isRetired(transactionId: string, resultSha256: string) {
      requirePrivateDirectory(root);
      return exactRetirementExists(root, transactionId, resultSha256);
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
  if (engine.operation !== "sandbox-lifecycle" && engine.operation !== "state-mutation") {
    throw new Error(
      "Persisted lifecycle requires a sandbox-lifecycle or state-mutation container engine.",
    );
  }
  const current = engineAuthorityStore.load(engine.operation);
  if (!current) {
    throw new Error(`Persisted ${engine.operation} engine authority is missing.`);
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
  if (
    input.engine.operation !== "sandbox-lifecycle" &&
    !(input.action === "state-mutation" && input.engine.operation === "state-mutation")
  ) {
    throw new Error("Persisted lifecycle engine operation does not match its action.");
  }
  const authority = input.engineAuthorityStore.load(input.engine.operation);
  if (!authority) {
    throw new Error(`Persisted ${input.engine.operation} engine authority is missing.`);
  }
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
  const record = expectedRecord(input);
  if (record.action === "state-mutation") {
    if (input.stateMutationIntent === undefined) {
      fail("state-mutation preparation requires its exact intent");
    }
    input.lifecycleStore.recordStateMutationIntent(
      stateMutationIntentForTransaction(record.transactionId, input.stateMutationIntent),
    );
  } else if (input.stateMutationIntent !== undefined) {
    fail("state-mutation intent cannot authorize another lifecycle action");
  }
  return input.lifecycleStore.create(record);
}

/**
 * Read-only gate for direct container access while a provider owns an exact
 * state-mutation target. The file store returns a completed transaction only
 * while its provider fence still retains the exact-target claim.
 */
export function hasActivePersistedEngineStateMutationTarget(
  lifecycleStore: PersistedEngineLifecycleStore,
  sandboxName: string,
  runtimeId?: string,
): boolean {
  const exactSandboxName = exactName(sandboxName, "sandbox name");
  if (runtimeId !== undefined && !RUNTIME_ID.test(runtimeId)) {
    fail("runtime identity is malformed");
  }
  const exactRuntimeId = runtimeId;
  return lifecycleStore
    .listUnfinished()
    .some(
      (record) =>
        record.action === "state-mutation" &&
        record.sandboxName === exactSandboxName &&
        record.resources.some(
          (resource) =>
            resource.role === "target" &&
            (exactRuntimeId === undefined || resource.runtimeId === exactRuntimeId),
        ),
    );
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

/**
 * Load the exact replay intent only after the lifecycle and engine authority
 * still match the durable state-mutation transaction.
 */
export function loadPersistedEngineStateMutationIntent(
  input: PersistedEngineLifecycleExecutionInput,
): PersistedEngineStateMutationIntent {
  if (input.action !== "state-mutation") {
    throw new Error("Persisted state mutation requires the state-mutation lifecycle action.");
  }
  const current = requireExpectedLifecycle(input);
  const intent = input.lifecycleStore.loadStateMutationIntent(current.transactionId);
  if (!intent) {
    throw new Error("Persisted state mutation intent is missing.");
  }
  const normalized = normalizePersistedEngineStateMutationIntent(intent);
  if (normalized.transactionId !== current.transactionId) {
    throw new Error("Persisted state mutation intent names another transaction.");
  }
  return normalized;
}

function exactArguments(
  command: PersistedEngineLifecycleExactCommand,
  runtimeId: string,
): readonly string[] {
  if (typeof command !== "object" || command === null || Array.isArray(command)) {
    throw new Error("Exact runtime command has an invalid argument count.");
  }
  const commandKeys = Object.keys(command).sort().join(",");
  if (
    (commandKeys !== "args,targetIndex" && commandKeys !== "args,targetIndex,targetPath") ||
    !Array.isArray(command.args) ||
    command.args.length === 0 ||
    command.args.length > MAX_ARGUMENTS ||
    !Number.isSafeInteger(command.targetIndex) ||
    command.targetIndex < 0 ||
    command.targetIndex >= command.args.length
  ) {
    throw new Error("Exact runtime command has an invalid argument count.");
  }
  const targetPath = command.targetPath;
  if (
    targetPath !== undefined &&
    (typeof targetPath !== "string" ||
      !targetPath.startsWith("/") ||
      path.posix.normalize(targetPath) !== targetPath ||
      targetPath.includes(":") ||
      CONTROL_CHARACTERS.test(targetPath) ||
      Buffer.byteLength(targetPath, "utf8") > MAX_ARGUMENT_BYTES)
  ) {
    throw new Error("Exact runtime command container path is invalid.");
  }
  const exactTarget = targetPath === undefined ? runtimeId : `${runtimeId}:${targetPath}`;
  let exactRuntimeReferences = 0;
  const normalized = command.args.map((value, index) => {
    if (
      typeof value !== "string" ||
      CONTROL_CHARACTERS.test(value) ||
      Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES
    ) {
      throw new Error(`Exact runtime command argument ${String(index)} is invalid.`);
    }
    if (value === runtimeId || value.startsWith(`${runtimeId}:`)) {
      if (value !== exactTarget) {
        throw new Error("Exact runtime command contains another persisted runtime target.");
      }
      exactRuntimeReferences += 1;
    }
    return value;
  });
  if (exactRuntimeReferences !== 1) {
    throw new Error("Exact runtime command must contain its persisted runtime ID exactly once.");
  }
  if (normalized[command.targetIndex] !== exactTarget) {
    throw new Error("Exact runtime command target must be its persisted runtime ID.");
  }
  return Object.freeze(normalized);
}

function authorizedScope(
  input: PersistedEngineLifecycleExecutionInput,
  record: PersistedEngineLifecycleRecord,
  lease: PersistedEngineLifecycleExecutionLease,
): AuthorizedPersistedEngineLifecycle {
  const capture = (
    host: boolean,
    role: PersistedEngineLifecycleResourceRole,
    buildCommand: (runtimeId: string) => PersistedEngineLifecycleExactCommand,
    timeoutMs?: number,
    commandInput?: Buffer,
  ): ContainerEngineCommandResult => {
    const resource = record.resources.find((candidate) => candidate.role === role);
    if (!resource) throw new Error(`Persisted lifecycle has no exact ${role} runtime authority.`);
    const args = exactArguments(buildCommand(resource.runtimeId), resource.runtimeId);
    const guard = () => {
      const current = requireExpectedLifecycle(input);
      if (current.phase !== record.phase) {
        throw new Error("Persisted lifecycle mutation authority is no longer active.");
      }
      input.lifecycleStore.assertMutationExecution(lease);
    };
    guard();
    let result: ContainerEngineCommandResult | undefined;
    let failure: unknown;
    try {
      result = host
        ? input.engine.captureHost(args, timeoutMs)
        : input.engine.capture(args, timeoutMs, commandInput);
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
    captureExact: (
      role: PersistedEngineLifecycleResourceRole,
      buildCommand: (runtimeId: string) => PersistedEngineLifecycleExactCommand,
      timeoutMs?: number,
      commandInput?: Buffer,
    ) => capture(false, role, buildCommand, timeoutMs, commandInput),
    captureHostExact: (
      role: PersistedEngineLifecycleResourceRole,
      buildCommand: (runtimeId: string) => PersistedEngineLifecycleExactCommand,
      timeoutMs?: number,
    ) => capture(true, role, buildCommand, timeoutMs),
  });
}

/**
 * Resume either durable pre-mutation phase with the same exact authority.
 * A thrown callback leaves mutation-authorized state intact for the next
 * process; success durably publishes the caller's result receipt.
 */
async function executePersistedEngineLifecycleCompletion<T>(
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
  const lease = input.lifecycleStore.acquireMutationExecution(input.transactionId);
  try {
    const result = await mutate(authorizedScope(input, authorized, lease));
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
    input.lifecycleStore.assertMutationExecution(lease);
    const completed = input.lifecycleStore.complete(lease, resultSha256);
    return Object.freeze({ record: completed, value });
  } finally {
    try {
      input.lifecycleStore.releaseMutationExecution(lease);
    } catch {
      // Lease recovery may race cleanup. Preserve the mutation's primary error
      // or its already-durable completion result.
    }
  }
}

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
  if (input.action === "state-mutation") {
    throw new Error(
      "Persisted state mutation must remain active until explicit activation completion.",
    );
  }
  return executePersistedEngineLifecycleCompletion(input, mutate);
}

/**
 * Assert that one exact provider-owned state mutation remains durably active.
 * This check is read-only so a restarted controller can reconstruct the fence
 * without publishing another lifecycle phase or acquiring execution ownership.
 */
export function assertActivePersistedEngineStateMutation(
  input: PersistedEngineLifecycleExecutionInput,
): PersistedEngineLifecycleRecord {
  if (input.action !== "state-mutation") {
    throw new Error("Persisted state mutation requires the state-mutation lifecycle action.");
  }
  const current = requireExpectedLifecycle(input);
  if (current.phase !== "fence-established") {
    throw new Error("Persisted state mutation fence is not established.");
  }
  input.lifecycleStore.assertStateMutationTargetClaim(input.transactionId);
  return current;
}

type PersistedEngineStateMutationResult<T> = {
  readonly record: PersistedEngineLifecycleRecord;
  readonly value: T;
};

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function releaseExecutionLeaseIgnoringCleanupRace(
  input: PersistedEngineLifecycleExecutionInput,
  lease: PersistedEngineLifecycleExecutionLease,
): void {
  try {
    input.lifecycleStore.releaseMutationExecution(lease);
  } catch {
    // A recovered owner may race cleanup. The exact durable phase and target
    // claim remain authoritative independently of process-owned execution.
  }
}

function withStateMutationExecutionLease<T>(
  input: PersistedEngineLifecycleExecutionInput,
  lease: PersistedEngineLifecycleExecutionLease,
  run: () => T | Promise<T>,
): T | Promise<T> {
  try {
    const value = run();
    if (isPromiseLike<T>(value)) {
      return Promise.resolve(value).finally(() => {
        releaseExecutionLeaseIgnoringCleanupRace(input, lease);
      });
    }
    releaseExecutionLeaseIgnoringCleanupRace(input, lease);
    return value;
  } catch (error) {
    releaseExecutionLeaseIgnoringCleanupRace(input, lease);
    throw error;
  }
}

/**
 * Establish one provider-owned external fence while the durable transaction is
 * still prepared. Only after the callback returns validated marker evidence do
 * we publish mutation-authorized and fence-established under the same exact
 * process lease. Synchronous providers receive a synchronous result; an async
 * callback retains the lease until its promise settles.
 */
export function executePersistedEngineStateMutation<T>(
  input: PersistedEngineLifecycleExecutionInput,
  mutate: (scope: AuthorizedPersistedEngineLifecycle) => T,
): PersistedEngineStateMutationResult<T>;
export function executePersistedEngineStateMutation<T>(
  input: PersistedEngineLifecycleExecutionInput,
  mutate: (scope: AuthorizedPersistedEngineLifecycle) => Promise<T>,
): Promise<PersistedEngineStateMutationResult<T>>;
export function executePersistedEngineStateMutation<T>(
  input: PersistedEngineLifecycleExecutionInput,
  mutate: (scope: AuthorizedPersistedEngineLifecycle) => Promise<T> | T,
): PersistedEngineStateMutationResult<T> | Promise<PersistedEngineStateMutationResult<T>> {
  if (input.action !== "state-mutation") {
    throw new Error("Persisted state mutation requires the state-mutation lifecycle action.");
  }
  const current = requireExpectedLifecycle(input);
  if (current.phase === "completed") {
    throw new Error("Persisted lifecycle transaction is already completed.");
  }
  if (current.phase === "fence-established") {
    throw new Error("Persisted state mutation fence is already established.");
  }
  if (current.phase !== "prepared" && current.phase !== "mutation-authorized") {
    throw new Error(`Persisted state mutation cannot establish a fence from ${current.phase}.`);
  }
  const lease = input.lifecycleStore.acquireMutationExecution(input.transactionId);
  return withStateMutationExecutionLease(input, lease, () => {
    const outcome = mutate(authorizedScope(input, current, lease));
    const publishFence = (value: T): PersistedEngineStateMutationResult<T> => {
      const after = requireExpectedLifecycle(input);
      if (after.phase !== current.phase) {
        throw new Error("Persisted state mutation authority changed before fence establishment.");
      }
      input.lifecycleStore.assertMutationExecution(lease);
      const authorized =
        after.phase === "prepared"
          ? input.lifecycleStore.authorizeMutation(input.transactionId)
          : after;
      if (authorized.phase !== "mutation-authorized") {
        throw new Error("Persisted state mutation did not publish exact mutation authority.");
      }
      input.lifecycleStore.assertMutationExecution(lease);
      const established = input.lifecycleStore.establishStateMutationFence(lease);
      return Object.freeze({ record: established, value });
    };
    if (isPromiseLike<T>(outcome)) return Promise.resolve(outcome).then(publishFence);
    return publishFence(outcome);
  });
}

/**
 * Run final activation and publish completion only while the same durable
 * state-mutation authority and one exact execution lease remain active.
 */
export function completePersistedEngineStateMutation<T>(
  input: PersistedEngineLifecycleExecutionInput,
  activate: (
    scope: AuthorizedPersistedEngineLifecycle,
  ) => PersistedEngineLifecycleMutationResult<T>,
  release: (
    scope: AuthorizedPersistedEngineLifecycle,
    completed: PersistedEngineLifecycleRecord,
  ) => void,
): PersistedEngineStateMutationResult<T>;
export function completePersistedEngineStateMutation<T>(
  input: PersistedEngineLifecycleExecutionInput,
  activate: (
    scope: AuthorizedPersistedEngineLifecycle,
  ) =>
    | Promise<PersistedEngineLifecycleMutationResult<T>>
    | PersistedEngineLifecycleMutationResult<T>,
  release: (
    scope: AuthorizedPersistedEngineLifecycle,
    completed: PersistedEngineLifecycleRecord,
  ) => Promise<void> | void,
): PersistedEngineStateMutationResult<T> | Promise<PersistedEngineStateMutationResult<T>>;
export function completePersistedEngineStateMutation<T>(
  input: PersistedEngineLifecycleExecutionInput,
  activate: (
    scope: AuthorizedPersistedEngineLifecycle,
  ) =>
    | Promise<PersistedEngineLifecycleMutationResult<T>>
    | PersistedEngineLifecycleMutationResult<T>,
  release: (
    scope: AuthorizedPersistedEngineLifecycle,
    completed: PersistedEngineLifecycleRecord,
  ) => Promise<void> | void,
): PersistedEngineStateMutationResult<T> | Promise<PersistedEngineStateMutationResult<T>> {
  if (input.action !== "state-mutation") {
    throw new Error("Persisted state mutation requires the state-mutation lifecycle action.");
  }
  const current = requireExpectedLifecycle(input);
  if (current.phase === "completed") {
    throw new Error("Persisted lifecycle transaction is already completed.");
  }
  if (current.phase !== "fence-established") {
    throw new Error("Persisted state mutation completion requires an established fence.");
  }
  const lease = input.lifecycleStore.acquireMutationExecution(input.transactionId);
  return withStateMutationExecutionLease(input, lease, () => {
    const activated = activate(authorizedScope(input, current, lease));
    const completeAndRelease = (
      result: PersistedEngineLifecycleMutationResult<T>,
    ): PersistedEngineStateMutationResult<T> | Promise<PersistedEngineStateMutationResult<T>> => {
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
      if (after.phase !== "fence-established") {
        throw new Error("Persisted state mutation fence changed before completion.");
      }
      input.lifecycleStore.assertMutationExecution(lease);
      const completed = input.lifecycleStore.complete(lease, resultSha256);
      const released = release(authorizedScope(input, completed, lease), completed);
      const finalize = (): PersistedEngineStateMutationResult<T> => {
        input.lifecycleStore.assertMutationExecution(lease);
        input.lifecycleStore.finalizeStateMutationRelease(lease, resultSha256);
        return Object.freeze({ record: completed, value });
      };
      return isPromiseLike<void>(released) ? Promise.resolve(released).then(finalize) : finalize();
    };
    return isPromiseLike<PersistedEngineLifecycleMutationResult<T>>(activated)
      ? Promise.resolve(activated).then(completeAndRelease)
      : completeAndRelease(activated);
  });
}

/**
 * Finish provider-fence release after a controller exited between durable host
 * completion and the provider's nonce-bound release. Activation is never run
 * twice: the exact completion digest is supplied from the persisted receipt.
 */
export function releaseCompletedPersistedEngineStateMutation<T>(
  input: PersistedEngineLifecycleExecutionInput,
  release: (
    scope: AuthorizedPersistedEngineLifecycle,
    completed: PersistedEngineLifecycleRecord,
  ) => Promise<T> | T,
):
  | PersistedEngineStateMutationResult<T | undefined>
  | Promise<PersistedEngineStateMutationResult<T | undefined>> {
  if (input.action !== "state-mutation") {
    throw new Error("Persisted state mutation requires the state-mutation lifecycle action.");
  }
  const current = requireExpectedLifecycle(input);
  if (current.phase !== "completed" || current.resultSha256 === null) {
    throw new Error("Persisted state mutation release requires a completed activation receipt.");
  }
  const lease = input.lifecycleStore.acquireMutationExecution(input.transactionId);
  return withStateMutationExecutionLease(input, lease, () => {
    if (
      input.lifecycleStore.isStateMutationReleaseFinalized(
        current.transactionId,
        current.resultSha256 as string,
      )
    ) {
      input.lifecycleStore.assertMutationExecution(lease);
      const finalized = input.lifecycleStore.finalizeStateMutationRelease(
        lease,
        current.resultSha256 as string,
      );
      return Object.freeze({ record: finalized, value: undefined });
    }
    const released = release(authorizedScope(input, current, lease), current);
    const finalize = (value: T): PersistedEngineStateMutationResult<T | undefined> => {
      input.lifecycleStore.assertMutationExecution(lease);
      const finalized = input.lifecycleStore.finalizeStateMutationRelease(
        lease,
        current.resultSha256 as string,
      );
      return Object.freeze({ record: finalized, value });
    };
    return isPromiseLike<T>(released)
      ? Promise.resolve(released).then(finalize)
      : finalize(released);
  });
}
