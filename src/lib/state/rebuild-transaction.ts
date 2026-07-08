// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isErrnoException } from "../core/errno";
import { isRecord, type UnknownRecord } from "../core/json-types";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../name-validation";
import type { ToolDisclosure } from "../tool-disclosure";
import { ensureConfigDir } from "./config-io";
import { withMcpLifecycleLock } from "./mcp-lifecycle-lock";
import { resolveNemoclawStateDir } from "./paths";

export const REBUILD_TRANSACTION_VERSION = 1 as const;
export const REBUILD_TRANSACTION_DIRNAME = "rebuild-transactions";

const MAX_TRANSACTION_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const BACKUP_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

export type RebuildTransactionPhaseV1 =
  | "prepared"
  | "old_deleted"
  | "replacement_created"
  | "completed";
export type RebuildTransactionStatusV1 = "active" | "completed";

export interface RebuildTransactionIntentV1 {
  readonly sandboxName: string;
  readonly source: {
    readonly agent: string | null;
    readonly registryFingerprint: string;
  };
  readonly target: {
    readonly agent: string | null;
    readonly provider: string;
    readonly model: string;
    readonly credentialEnv: string | null;
    readonly endpointFingerprint: string | null;
    readonly imageFingerprint: string;
    readonly configurationFingerprint: string;
    readonly gatewayName: string;
    readonly gatewayPort: number;
    readonly toolDisclosure: ToolDisclosure;
    readonly observabilityEnabled: boolean;
  };
}

export interface RebuildTransactionReceiptsV1 {
  readonly backup: {
    readonly manifestTimestamp: string;
    readonly manifestFingerprint: string;
  };
  readonly oldSandboxDeletion?: {
    readonly observedAt: string;
  };
  readonly replacement?: {
    readonly identityFingerprint: string;
    readonly observedAt: string;
  };
}

export interface RebuildTransactionFailureV1 {
  readonly code: string;
  readonly recordedAt: string;
  readonly retryable: boolean;
}

export interface RebuildTransactionRecordV1 {
  readonly version: typeof REBUILD_TRANSACTION_VERSION;
  readonly transactionId: string;
  readonly revision: number;
  readonly status: RebuildTransactionStatusV1;
  readonly phase: RebuildTransactionPhaseV1;
  readonly intent: RebuildTransactionIntentV1;
  readonly receipts: RebuildTransactionReceiptsV1;
  readonly failure: RebuildTransactionFailureV1 | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export type RebuildTransactionErrorCode =
  | "ALREADY_EXISTS"
  | "CORRUPT"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "UNSUPPORTED_VERSION";

export class RebuildTransactionError extends Error {
  constructor(
    readonly code: RebuildTransactionErrorCode,
    readonly sandboxName: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RebuildTransactionError";
  }
}

export interface RebuildTransactionDiagnosticV1 {
  version: typeof REBUILD_TRANSACTION_VERSION;
  transactionId: string;
  sandboxName: string;
  revision: number;
  status: RebuildTransactionStatusV1;
  phase: RebuildTransactionPhaseV1;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  receipts: {
    backup: boolean;
    oldSandboxDeletion: boolean;
    replacement: boolean;
  };
}

export interface RebuildTransactionStoreOptions {
  stateDir?: string;
  now?: () => Date;
  transactionId?: () => string;
}

function transactionFileStem(sandboxName: string): string {
  return crypto.createHash("sha256").update(sandboxName).digest("hex");
}

export function getRebuildTransactionPath(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): string {
  assertSandboxName(sandboxName);
  return path.join(
    stateDir,
    REBUILD_TRANSACTION_DIRNAME,
    `${transactionFileStem(sandboxName)}.json`,
  );
}

function transactionError(
  code: RebuildTransactionErrorCode,
  sandboxName: string,
  detail: string,
  cause?: unknown,
): RebuildTransactionError {
  return new RebuildTransactionError(code, sandboxName, `Rebuild transaction ${detail}`, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

function assertSandboxName(sandboxName: string): void {
  if (
    typeof sandboxName !== "string" ||
    sandboxName.length === 0 ||
    sandboxName.length > NAME_MAX_LENGTH ||
    !NAME_VALID_PATTERN.test(sandboxName)
  ) {
    throw transactionError("INVALID_INPUT", String(sandboxName), "has an invalid sandbox name");
  }
}

function requiredRecord(value: unknown, label: string, sandboxName: string): UnknownRecord {
  if (!isRecord(value)) throw transactionError("CORRUPT", sandboxName, `${label} is invalid`);
  return value;
}

function requiredString(value: unknown, label: string, sandboxName: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw transactionError("CORRUPT", sandboxName, `${label} is invalid`);
  }
  return value;
}

function nullableString(value: unknown, label: string, sandboxName: string): string | null {
  if (value === null) return null;
  return requiredString(value, label, sandboxName);
}

function timestamp(value: unknown, label: string, sandboxName: string): string {
  const candidate = requiredString(value, label, sandboxName);
  if (!Number.isFinite(Date.parse(candidate))) {
    throw transactionError("CORRUPT", sandboxName, `${label} is not a timestamp`);
  }
  return candidate;
}

function backupManifestTimestamp(value: unknown, sandboxName: string): string {
  const candidate = requiredString(value, "receipts.backup.manifestTimestamp", sandboxName);
  const match = BACKUP_TIMESTAMP_PATTERN.exec(candidate);
  const parseable = match
    ? `${match[1]}${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
    : candidate;
  if (!Number.isFinite(Date.parse(parseable))) {
    throw transactionError(
      "CORRUPT",
      sandboxName,
      "receipts.backup.manifestTimestamp is not a timestamp",
    );
  }
  return candidate;
}

function fingerprint(value: unknown, label: string, sandboxName: string): string {
  const candidate = requiredString(value, label, sandboxName);
  if (!FINGERPRINT_PATTERN.test(candidate)) {
    throw transactionError("CORRUPT", sandboxName, `${label} is not a SHA-256 fingerprint`);
  }
  return candidate;
}

function safeRevision(value: unknown, label: string, sandboxName: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw transactionError("CORRUPT", sandboxName, `${label} is invalid`);
  }
  return Number(value);
}

function normalizeIntent(value: unknown, sandboxName: string): RebuildTransactionIntentV1 {
  const intent = requiredRecord(value, "intent", sandboxName);
  const source = requiredRecord(intent.source, "intent.source", sandboxName);
  const target = requiredRecord(intent.target, "intent.target", sandboxName);
  const normalizedSandboxName = requiredString(
    intent.sandboxName,
    "intent.sandboxName",
    sandboxName,
  );
  if (normalizedSandboxName !== sandboxName) {
    throw transactionError("CORRUPT", sandboxName, "intent belongs to another sandbox");
  }
  const gatewayPort = safeRevision(target.gatewayPort, "intent.target.gatewayPort", sandboxName);
  if (gatewayPort < 1 || gatewayPort > 65_535) {
    throw transactionError("CORRUPT", sandboxName, "intent.target.gatewayPort is invalid");
  }
  if (target.toolDisclosure !== "progressive" && target.toolDisclosure !== "direct") {
    throw transactionError("CORRUPT", sandboxName, "intent.target.toolDisclosure is invalid");
  }
  if (typeof target.observabilityEnabled !== "boolean") {
    throw transactionError("CORRUPT", sandboxName, "intent.target.observabilityEnabled is invalid");
  }
  return {
    sandboxName,
    source: {
      agent: nullableString(source.agent, "intent.source.agent", sandboxName),
      registryFingerprint: fingerprint(
        source.registryFingerprint,
        "intent.source.registryFingerprint",
        sandboxName,
      ),
    },
    target: {
      agent: nullableString(target.agent, "intent.target.agent", sandboxName),
      provider: requiredString(target.provider, "intent.target.provider", sandboxName),
      model: requiredString(target.model, "intent.target.model", sandboxName),
      credentialEnv: nullableString(
        target.credentialEnv,
        "intent.target.credentialEnv",
        sandboxName,
      ),
      endpointFingerprint:
        target.endpointFingerprint === null
          ? null
          : fingerprint(
              target.endpointFingerprint,
              "intent.target.endpointFingerprint",
              sandboxName,
            ),
      imageFingerprint: fingerprint(
        target.imageFingerprint,
        "intent.target.imageFingerprint",
        sandboxName,
      ),
      configurationFingerprint: fingerprint(
        target.configurationFingerprint,
        "intent.target.configurationFingerprint",
        sandboxName,
      ),
      gatewayName: requiredString(target.gatewayName, "intent.target.gatewayName", sandboxName),
      gatewayPort,
      toolDisclosure: target.toolDisclosure,
      observabilityEnabled: target.observabilityEnabled,
    },
  };
}

function normalizeReceipts(value: unknown, sandboxName: string): RebuildTransactionReceiptsV1 {
  const receipts = requiredRecord(value, "receipts", sandboxName);
  const backup = requiredRecord(receipts.backup, "receipts.backup", sandboxName);
  const oldSandboxDeletionValue = receipts.oldSandboxDeletion;
  const oldSandboxDeletion =
    oldSandboxDeletionValue === undefined
      ? undefined
      : requiredRecord(oldSandboxDeletionValue, "receipts.oldSandboxDeletion", sandboxName);
  const normalizedOldSandboxDeletion = oldSandboxDeletion
    ? {
        observedAt: timestamp(
          oldSandboxDeletion.observedAt,
          "receipts.oldSandboxDeletion.observedAt",
          sandboxName,
        ),
      }
    : undefined;
  const replacementValue = receipts.replacement;
  const replacement =
    replacementValue === undefined
      ? undefined
      : requiredRecord(replacementValue, "receipts.replacement", sandboxName);
  const normalizedReplacement = replacement
    ? {
        identityFingerprint: fingerprint(
          replacement.identityFingerprint,
          "receipts.replacement.identityFingerprint",
          sandboxName,
        ),
        observedAt: timestamp(
          replacement.observedAt,
          "receipts.replacement.observedAt",
          sandboxName,
        ),
      }
    : undefined;
  return {
    backup: {
      manifestTimestamp: backupManifestTimestamp(backup.manifestTimestamp, sandboxName),
      manifestFingerprint: fingerprint(
        backup.manifestFingerprint,
        "receipts.backup.manifestFingerprint",
        sandboxName,
      ),
    },
    ...(normalizedOldSandboxDeletion ? { oldSandboxDeletion: normalizedOldSandboxDeletion } : {}),
    ...(normalizedReplacement ? { replacement: normalizedReplacement } : {}),
  };
}

function normalizeFailure(value: unknown, sandboxName: string): RebuildTransactionFailureV1 | null {
  if (value === null) return null;
  const failure = requiredRecord(value, "failure", sandboxName);
  const code = requiredString(failure.code, "failure.code", sandboxName);
  if (!FAILURE_CODE_PATTERN.test(code) || typeof failure.retryable !== "boolean") {
    throw transactionError("CORRUPT", sandboxName, "failure is invalid");
  }
  return {
    code,
    recordedAt: timestamp(failure.recordedAt, "failure.recordedAt", sandboxName),
    retryable: failure.retryable,
  };
}

function normalizeRecord(value: unknown, sandboxName: string): RebuildTransactionRecordV1 {
  const record = requiredRecord(value, "record", sandboxName);
  if (record.version !== REBUILD_TRANSACTION_VERSION) {
    if (typeof record.version === "number" && record.version > REBUILD_TRANSACTION_VERSION) {
      throw transactionError(
        "UNSUPPORTED_VERSION",
        sandboxName,
        `uses unsupported schema version ${String(record.version)}`,
      );
    }
    throw transactionError("CORRUPT", sandboxName, "has an invalid schema version");
  }
  const transactionId = requiredString(record.transactionId, "transactionId", sandboxName);
  if (!UUID_PATTERN.test(transactionId)) {
    throw transactionError("CORRUPT", sandboxName, "has an invalid transaction ID");
  }
  const revision = safeRevision(record.revision, "revision", sandboxName);
  if (revision < 1) throw transactionError("CORRUPT", sandboxName, "has an invalid revision");
  const phase = record.phase;
  const status = record.status;
  if (
    phase !== "prepared" &&
    phase !== "old_deleted" &&
    phase !== "replacement_created" &&
    phase !== "completed"
  ) {
    throw transactionError("CORRUPT", sandboxName, "has an invalid phase");
  }
  if (status !== "active" && status !== "completed") {
    throw transactionError("CORRUPT", sandboxName, "has an invalid status");
  }
  const receipts = normalizeReceipts(record.receipts, sandboxName);
  const failure = normalizeFailure(record.failure, sandboxName);
  const completedAt =
    record.completedAt === null ? null : timestamp(record.completedAt, "completedAt", sandboxName);
  if (
    (status === "completed" && (phase !== "completed" || completedAt === null || failure)) ||
    (status === "active" && (phase === "completed" || completedAt !== null))
  ) {
    throw transactionError("CORRUPT", sandboxName, "has an invalid phase/status combination");
  }
  if (phase !== "prepared" && !receipts.oldSandboxDeletion) {
    throw transactionError("CORRUPT", sandboxName, "is missing the old-sandbox deletion receipt");
  }
  if ((phase === "replacement_created" || phase === "completed") && !receipts.replacement) {
    throw transactionError("CORRUPT", sandboxName, "is missing the replacement receipt");
  }
  if (
    (phase === "prepared" && (receipts.oldSandboxDeletion || receipts.replacement)) ||
    (phase === "old_deleted" && receipts.replacement)
  ) {
    throw transactionError("CORRUPT", sandboxName, "contains receipts from a future phase");
  }
  if (
    receipts.oldSandboxDeletion &&
    receipts.replacement &&
    Date.parse(receipts.replacement.observedAt) < Date.parse(receipts.oldSandboxDeletion.observedAt)
  ) {
    throw transactionError("CORRUPT", sandboxName, "has out-of-order phase receipts");
  }
  return {
    version: REBUILD_TRANSACTION_VERSION,
    transactionId,
    revision,
    status,
    phase,
    intent: normalizeIntent(record.intent, sandboxName),
    receipts,
    failure,
    createdAt: timestamp(record.createdAt, "createdAt", sandboxName),
    updatedAt: timestamp(record.updatedAt, "updatedAt", sandboxName),
    completedAt,
  };
}

function syncDirectory(dirPath: string): void {
  // Durability boundary review:
  // - Invalid state: a published directory entry can be lost after power loss.
  // - Source boundary: filesystem/device-specific fsync semantics, outside NemoClaw.
  // - Constraint: Node exposes fsync but not macOS F_FULLFSYNC/fcntl.
  // - Regression evidence: atomicity and torn-record validation are testable;
  //   physical power-loss persistence requires platform/storage fault injection.
  // - Removal condition: use F_FULLFSYNC when Node exposes it (or a native
  //   adapter is adopted). Until then macOS power-loss durability is best-effort.
  // Linux ext4/xfs directory fsync commonly persists entries; other filesystems
  // and storage devices may provide weaker guarantees.
  const fd = fs.openSync(dirPath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function durablePublish(
  filePath: string,
  record: RebuildTransactionRecordV1,
  createOnly: boolean,
): void {
  const dirPath = path.dirname(filePath);
  ensureConfigDir(dirPath);
  const candidatePath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${String(process.pid)}.${crypto.randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      candidatePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (createOnly) {
      // Publication boundary review:
      // - Invalid state: a second creator overwrites the first transaction.
      // - Source boundary: both names are created directly inside dirPath, so a
      //   hard link is same-directory and same-filesystem by construction.
      // - Constraint: copy/rename cannot preserve link(2)'s atomic no-replace.
      // - Regression evidence: EEXIST and injected EXDEV both fail closed.
      // - Removal condition: replace this when Node exposes renameat2(RENAME_NOREPLACE).
      try {
        fs.linkSync(candidatePath, filePath);
      } catch (error) {
        if (isErrnoException(error) && error.code === "EXDEV") {
          throw new Error(
            "Rebuild transaction atomic-publication invariant failed: candidate and record must share a filesystem",
            { cause: error },
          );
        }
        throw error;
      }
      try {
        fs.unlinkSync(candidatePath);
      } catch {
        // The canonical hard link is already durable; finally retries cleanup.
      }
    } else {
      fs.renameSync(candidatePath, filePath);
    }
    syncDirectory(dirPath);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(candidatePath);
    } catch {
      // A persistent cleanup failure can leave a 0600 dotfile hard link inside
      // the 0700 state directory. It is inert: only the canonical hashed path is
      // loaded, and publication already fsynced the same inode.
    }
  }
}

function readStrictRecord(
  filePath: string,
  sandboxName: string,
): RebuildTransactionRecordV1 | null {
  ensureConfigDir(path.dirname(filePath));
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw transactionError("CORRUPT", sandboxName, "cannot be opened safely", error);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TRANSACTION_BYTES) {
      throw transactionError("CORRUPT", sandboxName, "is not a valid state file");
    }
    if ((stat.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch (error) {
      throw transactionError("CORRUPT", sandboxName, "contains invalid JSON", error);
    }
    return normalizeRecord(parsed, sandboxName);
  } finally {
    fs.closeSync(fd);
  }
}

const NEXT_PHASE: Readonly<
  Record<Exclude<RebuildTransactionPhaseV1, "completed">, RebuildTransactionPhaseV1>
> = {
  prepared: "old_deleted",
  old_deleted: "replacement_created",
  replacement_created: "completed",
};

function assertReceiptHistoryUnchanged(
  current: RebuildTransactionReceiptsV1,
  next: RebuildTransactionReceiptsV1,
  sandboxName: string,
): void {
  for (const key of ["backup", "oldSandboxDeletion", "replacement"] as const) {
    if (current[key] !== undefined && !isDeepStrictEqual(current[key], next[key])) {
      throw transactionError(
        "INVALID_TRANSITION",
        sandboxName,
        `cannot replace the existing ${key} receipt`,
      );
    }
  }
}

/** Durable state for the rebuild coordinator. Each mutation acquires the
 * existing per-sandbox lifecycle lock before revision validation and durable
 * publication. Reentrancy is intra-process only via AsyncLocalStorage;
 * cross-process callers always contend on the filesystem lock.
 *
 * On macOS, Node's lack of F_FULLFSYNC means strict power-loss durability is
 * unsupported; atomic publication and fail-closed record validation still hold.
 */
export class RebuildTransactionStore {
  private readonly stateDir: string;
  private readonly now: () => Date;
  private readonly transactionId: () => string;

  constructor(options: RebuildTransactionStoreOptions = {}) {
    this.stateDir = options.stateDir ?? resolveNemoclawStateDir();
    this.now = options.now ?? (() => new Date());
    this.transactionId = options.transactionId ?? (() => crypto.randomUUID());
  }

  async create(
    intent: RebuildTransactionIntentV1,
    receipts: RebuildTransactionReceiptsV1,
  ): Promise<RebuildTransactionRecordV1> {
    assertSandboxName(intent.sandboxName);
    return this.withMutationLock(intent.sandboxName, () => {
      const now = this.now().toISOString();
      let record: RebuildTransactionRecordV1;
      try {
        record = normalizeRecord(
          {
            version: REBUILD_TRANSACTION_VERSION,
            transactionId: this.transactionId(),
            revision: 1,
            status: "active",
            phase: "prepared",
            intent,
            receipts,
            failure: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
          },
          intent.sandboxName,
        );
      } catch (error) {
        if (error instanceof RebuildTransactionError && error.code === "CORRUPT") {
          throw transactionError(
            "INVALID_INPUT",
            intent.sandboxName,
            "creation input is invalid",
            error,
          );
        }
        throw error;
      }
      try {
        durablePublish(this.path(intent.sandboxName), record, true);
      } catch (error) {
        if (isErrnoException(error) && error.code === "EEXIST") {
          throw transactionError(
            "ALREADY_EXISTS",
            intent.sandboxName,
            "already exists; load and reconcile it before starting another rebuild",
            error,
          );
        }
        throw error;
      }
      return record;
    });
  }

  load(sandboxName: string): RebuildTransactionRecordV1 | null {
    assertSandboxName(sandboxName);
    return readStrictRecord(this.path(sandboxName), sandboxName);
  }

  async transition(
    sandboxName: string,
    expectedRevision: number,
    phase: Exclude<RebuildTransactionPhaseV1, "prepared" | "completed">,
    receipts: RebuildTransactionReceiptsV1,
  ): Promise<RebuildTransactionRecordV1> {
    return this.withMutationLock(sandboxName, () => {
      const current = this.requireActive(sandboxName, expectedRevision);
      if (current.phase === "completed" || NEXT_PHASE[current.phase] !== phase) {
        throw transactionError(
          "INVALID_TRANSITION",
          sandboxName,
          `cannot advance from ${current.phase} to ${phase}`,
        );
      }
      assertReceiptHistoryUnchanged(current.receipts, receipts, sandboxName);
      const updated = normalizeRecord(
        {
          ...current,
          phase,
          receipts,
          failure: null,
          revision: current.revision + 1,
          updatedAt: this.now().toISOString(),
        },
        sandboxName,
      );
      durablePublish(this.path(sandboxName), updated, false);
      return updated;
    });
  }

  async recordFailure(
    sandboxName: string,
    expectedRevision: number,
    failure: RebuildTransactionFailureV1,
  ): Promise<RebuildTransactionRecordV1> {
    return this.withMutationLock(sandboxName, () => {
      const current = this.requireActive(sandboxName, expectedRevision);
      const updated = normalizeRecord(
        {
          ...current,
          failure,
          revision: current.revision + 1,
          updatedAt: this.now().toISOString(),
        },
        sandboxName,
      );
      durablePublish(this.path(sandboxName), updated, false);
      return updated;
    });
  }

  async complete(
    sandboxName: string,
    expectedRevision: number,
  ): Promise<RebuildTransactionRecordV1> {
    return this.withMutationLock(sandboxName, () => {
      const current = this.require(sandboxName);
      this.assertRevision(current, expectedRevision);
      if (current.status === "completed") return current;
      if (current.phase !== "replacement_created") {
        throw transactionError(
          "INVALID_TRANSITION",
          sandboxName,
          `cannot complete from ${current.phase}`,
        );
      }
      const completedAt = this.now().toISOString();
      const completed = normalizeRecord(
        {
          ...current,
          phase: "completed",
          status: "completed",
          failure: null,
          revision: current.revision + 1,
          updatedAt: completedAt,
          completedAt,
        },
        sandboxName,
      );
      durablePublish(this.path(sandboxName), completed, false);
      return completed;
    });
  }

  diagnostic(record: RebuildTransactionRecordV1): RebuildTransactionDiagnosticV1 {
    return {
      version: record.version,
      transactionId: record.transactionId,
      sandboxName: record.intent.sandboxName,
      revision: record.revision,
      status: record.status,
      phase: record.phase,
      failureCode: record.failure?.code ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      completedAt: record.completedAt,
      receipts: {
        backup: true,
        oldSandboxDeletion: record.receipts.oldSandboxDeletion !== undefined,
        replacement: record.receipts.replacement !== undefined,
      },
    };
  }

  private path(sandboxName: string): string {
    return getRebuildTransactionPath(sandboxName, this.stateDir);
  }

  private withMutationLock<T>(sandboxName: string, operation: () => T): Promise<T> {
    assertSandboxName(sandboxName);
    return withMcpLifecycleLock(sandboxName, operation, { stateDir: this.stateDir });
  }

  private require(sandboxName: string): RebuildTransactionRecordV1 {
    const current = this.load(sandboxName);
    if (!current) throw transactionError("NOT_FOUND", sandboxName, "does not exist");
    return current;
  }

  private requireActive(sandboxName: string, expectedRevision: number): RebuildTransactionRecordV1 {
    const current = this.require(sandboxName);
    if (current.status !== "active") {
      throw transactionError(
        "INVALID_TRANSITION",
        sandboxName,
        "is completed and cannot become active again",
      );
    }
    this.assertRevision(current, expectedRevision);
    return current;
  }

  private assertRevision(record: RebuildTransactionRecordV1, expectedRevision: number): void {
    if (record.revision !== expectedRevision) {
      throw transactionError(
        "REVISION_CONFLICT",
        record.intent.sandboxName,
        `revision conflict: expected ${String(expectedRevision)}, found ${String(record.revision)}`,
      );
    }
  }
}
