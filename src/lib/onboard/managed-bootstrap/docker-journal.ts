// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { MANAGED_STARTUP_AGENTS, type ManagedStartupAgent } from "../managed-startup/profile";
import type {
  ManagedBootstrapCompletionReceipt,
  ManagedBootstrapDurablePreparationReceipt,
  ManagedBootstrapFinalizationReceipt,
  ManagedBootstrapSandboxIdentity,
} from "./adapter";

export const DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION = 3 as const;
export const DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY = "managed-bootstrap";
export const DOCKER_MANAGED_BOOTSTRAP_FINALIZATION_SCHEMA_VERSION = 2 as const;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const MANIFEST_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const MAX_JOURNAL_BYTES = 32 * 1024;
const JOURNAL_DIRECTORY_MODE = 0o700;
const JOURNAL_FILE_MODE = 0o600;
const DECISION_PHASES = new Set<DockerManagedBootstrapJournalPhase>([
  "rollback-authorized",
  "shared-state-committed",
]);

export type DockerManagedBootstrapJournalPhase =
  | "staged"
  | "cutover"
  | "rollback-authorized"
  | "owner-cleanup-required"
  | "shared-state-committed";

export interface DockerManagedBootstrapJournal {
  readonly schemaVersion: typeof DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION;
  readonly phase: DockerManagedBootstrapJournalPhase;
  readonly bootstrapIdentity: string;
  readonly providerId: string;
  readonly agent: ManagedStartupAgent;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly planFingerprint: string;
  readonly profileFingerprint: string;
  readonly imageReference: string;
  readonly runtimeImageContentId: string;
  readonly originalRuntimeId: string;
  readonly replacementRuntimeId: string;
  readonly originalName: string;
  readonly replacementStagingName: string;
  readonly backupName: string;
  readonly originalSpecHash: string;
  readonly replacementSpecHash: string;
  readonly rollbackTargetRuntimeId: string;
  readonly rollbackTargetSpecHash: string;
  readonly preparationReceipt: ManagedBootstrapDurablePreparationReceipt | null;
  readonly commitReceipt: ManagedBootstrapCompletionReceipt | null;
}

export interface DockerManagedBootstrapFinalizationRecord {
  readonly schemaVersion: typeof DOCKER_MANAGED_BOOTSTRAP_FINALIZATION_SCHEMA_VERSION;
  readonly phase: "committed" | "rolled-back";
  readonly bootstrapIdentity: string;
  readonly providerId: string;
  readonly agent: ManagedStartupAgent;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly planFingerprint: string;
  readonly profileFingerprint: string;
  readonly imageReference: string;
  readonly commitReceipt: ManagedBootstrapCompletionReceipt | null;
  readonly cleanupReceipt: ManagedBootstrapFinalizationReceipt;
}

export type DockerManagedBootstrapFinalizationContext = Pick<
  DockerManagedBootstrapFinalizationRecord,
  | "agent"
  | "bootstrapIdentity"
  | "imageReference"
  | "planFingerprint"
  | "profileFingerprint"
  | "providerId"
  | "sandbox"
>;

export interface DockerManagedBootstrapJournalStore {
  create(journal: DockerManagedBootstrapJournal): void;
  load(bootstrapIdentity: string): DockerManagedBootstrapJournal | null;
  listUnfinishedIdentities(): readonly string[];
  transition(
    bootstrapIdentity: string,
    expected: DockerManagedBootstrapJournalPhase,
    next: DockerManagedBootstrapJournalPhase,
  ): DockerManagedBootstrapJournal;
  recordCompletion(
    bootstrapIdentity: string,
    receipt: ManagedBootstrapCompletionReceipt,
  ): DockerManagedBootstrapJournal;
  remove(bootstrapIdentity: string, expected: readonly DockerManagedBootstrapJournalPhase[]): void;
  recordFinalization(
    record: DockerManagedBootstrapFinalizationRecord,
    context?: DockerManagedBootstrapFinalizationContext,
  ): void;
  loadFinalization(
    bootstrapIdentity: string,
    context?: DockerManagedBootstrapFinalizationContext,
  ): DockerManagedBootstrapFinalizationRecord | null;
}

export interface DockerManagedBootstrapLegacyJournalContext {
  readonly schemaVersion: 1 | 2;
  readonly phase: Exclude<DockerManagedBootstrapJournalPhase, "owner-cleanup-required">;
  readonly bootstrapIdentity: string;
  readonly providerId: string;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly originalRuntimeId: string;
  readonly replacementRuntimeId: string;
}

/**
 * Alternate stores may use this only when the durable mutation completed and
 * the caller lost its acknowledgement. Ordinary I/O and fsync failures must
 * retain their original error type and are never reconciled as success.
 */
export class DockerManagedBootstrapJournalAcknowledgementLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerManagedBootstrapJournalAcknowledgementLostError";
  }
}

export class DockerManagedBootstrapLegacyRecordRequiresAgentError extends Error {
  readonly bootstrapIdentity: string;
  readonly journalContext: DockerManagedBootstrapLegacyJournalContext | null;
  readonly recordKind: "finalization" | "journal";
  readonly reason: "context-mismatch" | "missing-context" | undefined;
  readonly schemaVersion: number;

  constructor(input: {
    readonly bootstrapIdentity: string;
    readonly journalContext?: DockerManagedBootstrapLegacyJournalContext;
    readonly recordKind: "finalization" | "journal";
    readonly reason?: "context-mismatch" | "missing-context";
    readonly schemaVersion: number;
  }) {
    const reason = input.reason;
    const journalContext = input.journalContext
      ? Object.freeze({
          ...input.journalContext,
          sandbox: Object.freeze({ ...input.journalContext.sandbox }),
        })
      : undefined;
    const journalGuidance = journalContext
      ? `; recovery is fenced to sandbox '${journalContext.sandbox.sandboxName}' ` +
        `(ID ${journalContext.sandbox.sandboxId}, provider ${journalContext.providerId}, ` +
        `journal-body phase ${journalContext.phase}) with exact original runtime ` +
        `${journalContext.originalRuntimeId} and replacement runtime ` +
        `${journalContext.replacementRuntimeId}; preserve the journal and follow ` +
        "https://github.com/NVIDIA/NemoClaw/blob/main/src/lib/onboard/managed-bootstrap/README.md#legacy-journal-drain-schema-1-and-2"
      : "";
    super(
      `Managed bootstrap Docker ${input.recordKind} schema ${input.schemaVersion} for ` +
        `${input.bootstrapIdentity} lacks durable agent identity` +
        (reason === "context-mismatch"
          ? "; supplied durable context does not match this record"
          : "") +
        journalGuidance,
    );
    this.name = "DockerManagedBootstrapLegacyRecordRequiresAgentError";
    this.bootstrapIdentity = input.bootstrapIdentity;
    this.journalContext = journalContext ?? null;
    this.recordKind = input.recordKind;
    this.reason = reason;
    this.schemaVersion = input.schemaVersion;
  }
}

class DockerManagedBootstrapJournalExistsError extends Error {
  constructor() {
    super(
      "Managed bootstrap Docker journal is invalid: journal already exists for this bootstrap identity",
    );
    this.name = "DockerManagedBootstrapJournalExistsError";
  }
}

const ALLOWED_TRANSITIONS = new Set([
  "staged->cutover",
  "staged->owner-cleanup-required",
  "cutover->rollback-authorized",
  "cutover->shared-state-committed",
  "rollback-authorized->owner-cleanup-required",
]);

function fail(message: string): never {
  throw new Error(`Managed bootstrap Docker journal is invalid: ${message}`);
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]) {
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function exactString(value: unknown, label: string, maxBytes = 4096): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    fail(`${label} must be one bounded exact string`);
  }
  return value;
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    fail(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function exactPhase(value: unknown): DockerManagedBootstrapJournalPhase {
  if (
    ![
      "staged",
      "cutover",
      "rollback-authorized",
      "owner-cleanup-required",
      "shared-state-committed",
    ].includes(String(value))
  ) {
    fail("phase is unsupported");
  }
  return value as DockerManagedBootstrapJournalPhase;
}

function exactLegacyPhase(
  value: unknown,
): Exclude<DockerManagedBootstrapJournalPhase, "owner-cleanup-required"> {
  if (
    !["staged", "cutover", "rollback-authorized", "shared-state-committed"].includes(String(value))
  ) {
    fail("legacy phase is unsupported");
  }
  return value as Exclude<DockerManagedBootstrapJournalPhase, "owner-cleanup-required">;
}

function exactAgent(value: unknown): ManagedStartupAgent {
  if (!MANAGED_STARTUP_AGENTS.includes(value as ManagedStartupAgent)) {
    fail("agent is unsupported");
  }
  return value as ManagedStartupAgent;
}

function exactSandbox(value: unknown): ManagedBootstrapSandboxIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("sandbox identity must be an object");
  }
  const sandbox = value as Record<string, unknown>;
  if (Object.keys(sandbox).sort().join(",") !== "driverId,sandboxId,sandboxName") {
    fail("sandbox identity schema is invalid");
  }
  return Object.freeze({
    sandboxName: exactString(sandbox.sandboxName, "sandbox name"),
    sandboxId: exactString(sandbox.sandboxId, "sandbox ID"),
    driverId: exactString(sandbox.driverId, "driver ID"),
  });
}

function sameSandboxIdentity(
  left: ManagedBootstrapSandboxIdentity,
  right: ManagedBootstrapSandboxIdentity,
): boolean {
  return (
    left.sandboxName === right.sandboxName &&
    left.sandboxId === right.sandboxId &&
    left.driverId === right.driverId
  );
}

// Frozen historical schemas: these branches must reproduce the exact canonical
// bytes written by schema 1 and schema 2. Do not share their implementation with
// the current normalizer or update them when the current schema changes.
function normalizeLegacyDockerManagedBootstrapJournal(
  journal: Readonly<Record<string, unknown>>,
  schemaVersion: 1 | 2,
): {
  readonly bootstrapIdentity: string;
  readonly canonical: string;
  readonly journalContext: DockerManagedBootstrapLegacyJournalContext;
} {
  if (schemaVersion === 1) {
    const expectedKeys = [
      "backupName",
      "bootstrapIdentity",
      "imageReference",
      "originalName",
      "originalRuntimeId",
      "originalSpecHash",
      "phase",
      "profileFingerprint",
      "replacementRuntimeId",
      "replacementSpecHash",
      "replacementStagingName",
      "runtimeImageContentId",
      "sandbox",
      "schemaVersion",
    ];
    if (!hasExactKeys(journal, expectedKeys)) fail("legacy journal schema is invalid");
    const normalized = Object.freeze({
      schemaVersion: 1 as const,
      phase: exactLegacyPhase(journal.phase),
      bootstrapIdentity: exactSha256(journal.bootstrapIdentity, "bootstrap identity"),
      sandbox: exactSandbox(journal.sandbox),
      profileFingerprint: exactSha256(journal.profileFingerprint, "profile fingerprint"),
      imageReference: exactString(journal.imageReference, "image reference"),
      runtimeImageContentId: exactString(journal.runtimeImageContentId, "runtime image content ID"),
      originalRuntimeId: exactSha256(journal.originalRuntimeId, "original runtime ID"),
      replacementRuntimeId: exactSha256(journal.replacementRuntimeId, "replacement runtime ID"),
      originalName: exactString(journal.originalName, "original name", 253),
      replacementStagingName: exactString(
        journal.replacementStagingName,
        "replacement staging name",
        253,
      ),
      backupName: exactString(journal.backupName, "backup name", 253),
      originalSpecHash: exactSha256(journal.originalSpecHash, "original spec hash"),
      replacementSpecHash: exactSha256(journal.replacementSpecHash, "replacement spec hash"),
    });
    if (normalized.originalRuntimeId === normalized.replacementRuntimeId) {
      fail("original and replacement runtime IDs must differ");
    }
    if (
      new Set([normalized.originalName, normalized.replacementStagingName, normalized.backupName])
        .size !== 3
    ) {
      fail("original, staging, and backup names must be distinct");
    }
    return {
      bootstrapIdentity: normalized.bootstrapIdentity,
      canonical: `${JSON.stringify(normalized)}\n`,
      journalContext: Object.freeze({
        schemaVersion,
        phase: normalized.phase,
        bootstrapIdentity: normalized.bootstrapIdentity,
        providerId: normalized.sandbox.driverId,
        sandbox: normalized.sandbox,
        originalRuntimeId: normalized.originalRuntimeId,
        replacementRuntimeId: normalized.replacementRuntimeId,
      }),
    };
  }

  const expectedKeys = [
    "backupName",
    "bootstrapIdentity",
    "commitReceipt",
    "imageReference",
    "originalName",
    "originalRuntimeId",
    "originalSpecHash",
    "phase",
    "planFingerprint",
    "preparationReceipt",
    "profileFingerprint",
    "providerId",
    "replacementRuntimeId",
    "replacementSpecHash",
    "replacementStagingName",
    "rollbackTargetRuntimeId",
    "rollbackTargetSpecHash",
    "runtimeImageContentId",
    "sandbox",
    "schemaVersion",
  ];
  if (!hasExactKeys(journal, expectedKeys)) fail("legacy journal schema is invalid");
  const normalized = Object.freeze({
    schemaVersion: 2 as const,
    phase: exactLegacyPhase(journal.phase),
    bootstrapIdentity: exactSha256(journal.bootstrapIdentity, "bootstrap identity"),
    providerId: exactString(journal.providerId, "provider ID"),
    sandbox: exactSandbox(journal.sandbox),
    planFingerprint: exactSha256(journal.planFingerprint, "plan fingerprint"),
    profileFingerprint: exactSha256(journal.profileFingerprint, "profile fingerprint"),
    imageReference: exactString(journal.imageReference, "image reference"),
    runtimeImageContentId: exactString(journal.runtimeImageContentId, "runtime image content ID"),
    originalRuntimeId: exactSha256(journal.originalRuntimeId, "original runtime ID"),
    replacementRuntimeId: exactSha256(journal.replacementRuntimeId, "replacement runtime ID"),
    originalName: exactString(journal.originalName, "original name", 253),
    replacementStagingName: exactString(
      journal.replacementStagingName,
      "replacement staging name",
      253,
    ),
    backupName: exactString(journal.backupName, "backup name", 253),
    originalSpecHash: exactSha256(journal.originalSpecHash, "original spec hash"),
    replacementSpecHash: exactSha256(journal.replacementSpecHash, "replacement spec hash"),
    rollbackTargetRuntimeId: exactSha256(
      journal.rollbackTargetRuntimeId,
      "rollback target runtime ID",
    ),
    rollbackTargetSpecHash: exactSha256(
      journal.rollbackTargetSpecHash,
      "rollback target spec hash",
    ),
    preparationReceipt:
      journal.preparationReceipt === null
        ? null
        : exactPreparationReceipt(journal.preparationReceipt),
    commitReceipt:
      journal.commitReceipt === null ? null : exactCompletionReceipt(journal.commitReceipt),
  });
  if (normalized.originalRuntimeId === normalized.replacementRuntimeId) {
    fail("original and replacement runtime IDs must differ");
  }
  if (
    new Set([normalized.originalName, normalized.replacementStagingName, normalized.backupName])
      .size !== 3
  ) {
    fail("original, staging, and backup names must be distinct");
  }
  if (
    normalized.providerId !== normalized.sandbox.driverId ||
    normalized.rollbackTargetRuntimeId !== normalized.originalRuntimeId ||
    normalized.rollbackTargetSpecHash !== normalized.originalSpecHash
  ) {
    fail("provider or rollback authority does not match the transaction identity");
  }
  if (
    (normalized.preparationReceipt !== null &&
      (normalized.preparationReceipt.bootstrapIdentity !== normalized.bootstrapIdentity ||
        !sameSandboxIdentity(normalized.preparationReceipt.sandbox, normalized.sandbox))) ||
    (normalized.commitReceipt !== null &&
      (normalized.commitReceipt.bootstrapIdentity !== normalized.bootstrapIdentity ||
        !sameSandboxIdentity(normalized.commitReceipt.sandbox, normalized.sandbox) ||
        normalized.commitReceipt.runtimeId !== normalized.replacementRuntimeId ||
        normalized.commitReceipt.profileFingerprint !== normalized.profileFingerprint ||
        normalized.commitReceipt.originalSpecHash !== normalized.originalSpecHash ||
        normalized.commitReceipt.replacementSpecHash !== normalized.replacementSpecHash ||
        `${normalized.commitReceipt.image.repository}@${normalized.commitReceipt.image.manifestDigest}` !==
          normalized.imageReference))
  ) {
    fail("durable preparation or commit receipt does not match the transaction identity");
  }
  return {
    bootstrapIdentity: normalized.bootstrapIdentity,
    canonical: `${JSON.stringify(normalized)}\n`,
    journalContext: Object.freeze({
      schemaVersion,
      phase: normalized.phase,
      bootstrapIdentity: normalized.bootstrapIdentity,
      providerId: normalized.providerId,
      sandbox: normalized.sandbox,
      originalRuntimeId: normalized.originalRuntimeId,
      replacementRuntimeId: normalized.replacementRuntimeId,
    }),
  };
}

export function normalizeDockerManagedBootstrapJournal(
  value: unknown,
): DockerManagedBootstrapJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("journal must be an object");
  }
  const journal = value as Record<string, unknown>;
  if (journal.schemaVersion === 1 || journal.schemaVersion === 2) {
    const legacy = normalizeLegacyDockerManagedBootstrapJournal(journal, journal.schemaVersion);
    throw new DockerManagedBootstrapLegacyRecordRequiresAgentError({
      bootstrapIdentity: legacy.bootstrapIdentity,
      journalContext: legacy.journalContext,
      recordKind: "journal",
      schemaVersion: journal.schemaVersion,
    });
  }
  const expectedKeys = [
    "agent",
    "backupName",
    "bootstrapIdentity",
    "commitReceipt",
    "imageReference",
    "originalName",
    "originalRuntimeId",
    "originalSpecHash",
    "phase",
    "planFingerprint",
    "preparationReceipt",
    "profileFingerprint",
    "providerId",
    "replacementRuntimeId",
    "replacementSpecHash",
    "replacementStagingName",
    "rollbackTargetRuntimeId",
    "rollbackTargetSpecHash",
    "runtimeImageContentId",
    "sandbox",
    "schemaVersion",
  ];
  if (
    !hasExactKeys(journal, expectedKeys) ||
    journal.schemaVersion !== DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION
  ) {
    fail("journal schema is invalid");
  }
  const normalized = Object.freeze({
    schemaVersion: DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
    phase: exactPhase(journal.phase),
    bootstrapIdentity: exactSha256(journal.bootstrapIdentity, "bootstrap identity"),
    providerId: exactString(journal.providerId, "provider ID"),
    agent: exactAgent(journal.agent),
    sandbox: exactSandbox(journal.sandbox),
    planFingerprint: exactSha256(journal.planFingerprint, "plan fingerprint"),
    profileFingerprint: exactSha256(journal.profileFingerprint, "profile fingerprint"),
    imageReference: exactString(journal.imageReference, "image reference"),
    runtimeImageContentId: exactString(journal.runtimeImageContentId, "runtime image content ID"),
    originalRuntimeId: exactSha256(journal.originalRuntimeId, "original runtime ID"),
    replacementRuntimeId: exactSha256(journal.replacementRuntimeId, "replacement runtime ID"),
    originalName: exactString(journal.originalName, "original name", 253),
    replacementStagingName: exactString(
      journal.replacementStagingName,
      "replacement staging name",
      253,
    ),
    backupName: exactString(journal.backupName, "backup name", 253),
    originalSpecHash: exactSha256(journal.originalSpecHash, "original spec hash"),
    replacementSpecHash: exactSha256(journal.replacementSpecHash, "replacement spec hash"),
    rollbackTargetRuntimeId: exactSha256(
      journal.rollbackTargetRuntimeId,
      "rollback target runtime ID",
    ),
    rollbackTargetSpecHash: exactSha256(
      journal.rollbackTargetSpecHash,
      "rollback target spec hash",
    ),
    preparationReceipt:
      journal.preparationReceipt === null
        ? null
        : exactPreparationReceipt(journal.preparationReceipt),
    commitReceipt:
      journal.commitReceipt === null ? null : exactCompletionReceipt(journal.commitReceipt),
  } satisfies DockerManagedBootstrapJournal);
  if (normalized.originalRuntimeId === normalized.replacementRuntimeId) {
    fail("original and replacement runtime IDs must differ");
  }
  if (
    new Set([normalized.originalName, normalized.replacementStagingName, normalized.backupName])
      .size !== 3
  ) {
    fail("original, staging, and backup names must be distinct");
  }
  if (
    normalized.providerId !== normalized.sandbox.driverId ||
    normalized.rollbackTargetRuntimeId !== normalized.originalRuntimeId ||
    normalized.rollbackTargetSpecHash !== normalized.originalSpecHash
  ) {
    fail("provider or rollback authority does not match the transaction identity");
  }
  if (
    (normalized.preparationReceipt !== null &&
      (normalized.preparationReceipt.bootstrapIdentity !== normalized.bootstrapIdentity ||
        !sameSandboxIdentity(normalized.preparationReceipt.sandbox, normalized.sandbox))) ||
    (normalized.commitReceipt !== null &&
      (normalized.commitReceipt.bootstrapIdentity !== normalized.bootstrapIdentity ||
        !sameSandboxIdentity(normalized.commitReceipt.sandbox, normalized.sandbox) ||
        normalized.commitReceipt.runtimeId !== normalized.replacementRuntimeId ||
        normalized.commitReceipt.profileFingerprint !== normalized.profileFingerprint ||
        normalized.commitReceipt.originalSpecHash !== normalized.originalSpecHash ||
        normalized.commitReceipt.replacementSpecHash !== normalized.replacementSpecHash ||
        `${normalized.commitReceipt.image.repository}@${normalized.commitReceipt.image.manifestDigest}` !==
          normalized.imageReference))
  ) {
    fail("durable preparation or commit receipt does not match the transaction identity");
  }
  return normalized;
}

export function serializeDockerManagedBootstrapJournal(
  journal: DockerManagedBootstrapJournal,
): string {
  const normalized = normalizeDockerManagedBootstrapJournal(journal);
  const serialized = `${JSON.stringify(normalized)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_BYTES) {
    fail("serialized journal exceeds its bounded transport");
  }
  return serialized;
}

export function parseDockerManagedBootstrapJournal(text: string): DockerManagedBootstrapJournal {
  if (
    text.length === 0 ||
    text.includes("\0") ||
    Buffer.byteLength(text, "utf8") > MAX_JOURNAL_BYTES
  ) {
    fail("serialized journal is empty or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("serialized journal is not valid JSON");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    ((parsed as Record<string, unknown>).schemaVersion === 1 ||
      (parsed as Record<string, unknown>).schemaVersion === 2)
  ) {
    const record = parsed as Record<string, unknown> & { readonly schemaVersion: 1 | 2 };
    const legacy = normalizeLegacyDockerManagedBootstrapJournal(record, record.schemaVersion);
    if (legacy.canonical !== text) fail("serialized legacy journal is not canonical");
    throw new DockerManagedBootstrapLegacyRecordRequiresAgentError({
      bootstrapIdentity: legacy.bootstrapIdentity,
      journalContext: legacy.journalContext,
      recordKind: "journal",
      schemaVersion: record.schemaVersion,
    });
  }
  const journal = normalizeDockerManagedBootstrapJournal(parsed);
  if (serializeDockerManagedBootstrapJournal(journal) !== text) {
    fail("serialized journal is not canonical");
  }
  return journal;
}

function exactTimestamp(value: unknown, label: string): string {
  const timestamp = exactString(value, label, 128);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail(`${label} must be one canonical timestamp`);
  }
  return timestamp;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}

function exactNullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : exactSha256(value, label);
}

function exactImage(value: unknown): ManagedBootstrapCompletionReceipt["image"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("completion image identity must be an object");
  }
  const image = value as Record<string, unknown>;
  if (Object.keys(image).sort().join(",") !== "manifestDigest,repository") {
    fail("completion image identity schema is invalid");
  }
  const manifestDigest = exactString(image.manifestDigest, "completion manifest digest", 128);
  if (!MANIFEST_DIGEST_RE.test(manifestDigest)) {
    fail("completion manifest digest must be canonical sha256");
  }
  return Object.freeze({
    repository: exactString(image.repository, "completion image repository"),
    manifestDigest: manifestDigest as `sha256:${string}`,
  });
}

function exactPreparationReceipt(value: unknown): ManagedBootstrapDurablePreparationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("durable preparation receipt must be an object");
  }
  const receipt = value as Record<string, unknown>;
  const expectedKeys = [
    "authorityFingerprint",
    "bootstrapIdentity",
    "recordId",
    "recordedAt",
    "sandbox",
    "schemaVersion",
  ];
  if (
    Object.keys(receipt).sort().join(",") !== expectedKeys.sort().join(",") ||
    receipt.schemaVersion !== 1
  ) {
    fail("durable preparation receipt schema is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    sandbox: exactSandbox(receipt.sandbox),
    bootstrapIdentity: exactSha256(
      receipt.bootstrapIdentity,
      "durable preparation bootstrap identity",
    ),
    authorityFingerprint: exactSha256(
      receipt.authorityFingerprint,
      "durable preparation authority fingerprint",
    ),
    recordId: exactString(receipt.recordId, "durable preparation record ID", 1024),
    recordedAt: exactTimestamp(receipt.recordedAt, "durable preparation timestamp"),
  });
}

function exactCompletionReceipt(value: unknown): ManagedBootstrapCompletionReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("commit receipt must be an object");
  }
  const receipt = value as Record<string, unknown>;
  const expectedKeys = [
    "bootstrapIdentity",
    "completedAt",
    "image",
    "originalSpecHash",
    "profileFingerprint",
    "replacementSpecHash",
    "runtimeId",
    "runtimeImageContentId",
    "sandbox",
    "schemaVersion",
    "transactionPending",
  ];
  if (
    Object.keys(receipt).sort().join(",") !== expectedKeys.sort().join(",") ||
    receipt.schemaVersion !== 1
  ) {
    fail("commit receipt schema is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    sandbox: exactSandbox(receipt.sandbox),
    runtimeId: exactSha256(receipt.runtimeId, "commit runtime ID"),
    image: exactImage(receipt.image),
    runtimeImageContentId: exactString(
      receipt.runtimeImageContentId,
      "commit runtime image content ID",
    ),
    originalSpecHash: exactSha256(receipt.originalSpecHash, "commit original spec hash"),
    replacementSpecHash: exactSha256(receipt.replacementSpecHash, "commit replacement spec hash"),
    profileFingerprint: exactSha256(receipt.profileFingerprint, "commit profile fingerprint"),
    bootstrapIdentity: exactSha256(receipt.bootstrapIdentity, "commit bootstrap identity"),
    transactionPending: exactBoolean(receipt.transactionPending, "commit transaction pending"),
    completedAt: exactTimestamp(receipt.completedAt, "commit completion timestamp"),
  });
}

function exactCleanupReceipt(value: unknown): ManagedBootstrapFinalizationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("cleanup receipt must be an object");
  }
  const receipt = value as Record<string, unknown>;
  const expectedKeys = [
    "alreadyRolledBack",
    "bootstrapIdentity",
    "finalizedAt",
    "heldWorkloadRemoved",
    "outcome",
    "restoredRuntimeId",
    "restoredSpecHash",
    "sandbox",
    "schemaVersion",
  ];
  if (
    Object.keys(receipt).sort().join(",") !== expectedKeys.sort().join(",") ||
    receipt.schemaVersion !== 1 ||
    !["committed", "rolled-back"].includes(String(receipt.outcome))
  ) {
    fail("cleanup receipt schema is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    sandbox: exactSandbox(receipt.sandbox),
    bootstrapIdentity: exactSha256(receipt.bootstrapIdentity, "cleanup bootstrap identity"),
    outcome: receipt.outcome as "committed" | "rolled-back",
    restoredRuntimeId: exactNullableSha256(receipt.restoredRuntimeId, "restored runtime ID"),
    restoredSpecHash: exactNullableSha256(receipt.restoredSpecHash, "restored spec hash"),
    heldWorkloadRemoved: exactBoolean(receipt.heldWorkloadRemoved, "held workload removed"),
    alreadyRolledBack: exactBoolean(receipt.alreadyRolledBack, "already rolled back"),
    finalizedAt: exactTimestamp(receipt.finalizedAt, "cleanup finalization timestamp"),
  });
}

type DockerManagedBootstrapFinalizationWithoutAgent = Omit<
  DockerManagedBootstrapFinalizationRecord,
  "agent" | "schemaVersion"
>;

function normalizeFinalizationWithoutAgent(
  record: Readonly<Record<string, unknown>>,
): DockerManagedBootstrapFinalizationWithoutAgent {
  if (!["committed", "rolled-back"].includes(String(record.phase))) {
    fail("finalization phase is invalid");
  }
  const phase = record.phase as "committed" | "rolled-back";
  const sandbox = exactSandbox(record.sandbox);
  const commitReceipt =
    record.commitReceipt === null ? null : exactCompletionReceipt(record.commitReceipt);
  const cleanupReceipt = exactCleanupReceipt(record.cleanupReceipt);
  const normalized = Object.freeze({
    phase,
    bootstrapIdentity: exactSha256(record.bootstrapIdentity, "finalization bootstrap identity"),
    providerId: exactString(record.providerId, "finalization provider ID"),
    sandbox,
    planFingerprint: exactSha256(record.planFingerprint, "finalization plan fingerprint"),
    profileFingerprint: exactSha256(record.profileFingerprint, "finalization profile fingerprint"),
    imageReference: exactString(record.imageReference, "finalization image reference"),
    commitReceipt,
    cleanupReceipt,
  } satisfies DockerManagedBootstrapFinalizationWithoutAgent);
  if (
    normalized.providerId !== sandbox.driverId ||
    normalized.bootstrapIdentity !== cleanupReceipt.bootstrapIdentity ||
    normalized.phase !== cleanupReceipt.outcome ||
    !sameSandboxIdentity(normalized.sandbox, cleanupReceipt.sandbox) ||
    (phase === "committed") !== (commitReceipt !== null) ||
    (commitReceipt !== null &&
      (commitReceipt.bootstrapIdentity !== normalized.bootstrapIdentity ||
        commitReceipt.profileFingerprint !== normalized.profileFingerprint ||
        !sameSandboxIdentity(commitReceipt.sandbox, normalized.sandbox) ||
        `${commitReceipt.image.repository}@${commitReceipt.image.manifestDigest}` !==
          normalized.imageReference))
  ) {
    fail("finalization receipts do not match their durable transaction identity");
  }
  return normalized;
}

function normalizeLegacyFinalizationShape(value: unknown): {
  readonly canonical: string;
  readonly record: DockerManagedBootstrapFinalizationWithoutAgent;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("finalization record must be an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "bootstrapIdentity",
    "cleanupReceipt",
    "commitReceipt",
    "imageReference",
    "phase",
    "planFingerprint",
    "profileFingerprint",
    "providerId",
    "sandbox",
    "schemaVersion",
  ];
  if (!hasExactKeys(record, expectedKeys) || record.schemaVersion !== 1) {
    fail("legacy finalization record schema is invalid");
  }
  const normalized = normalizeFinalizationWithoutAgent(record);
  const legacy = Object.freeze({
    schemaVersion: 1 as const,
    phase: normalized.phase,
    bootstrapIdentity: normalized.bootstrapIdentity,
    providerId: normalized.providerId,
    sandbox: normalized.sandbox,
    planFingerprint: normalized.planFingerprint,
    profileFingerprint: normalized.profileFingerprint,
    imageReference: normalized.imageReference,
    commitReceipt: normalized.commitReceipt,
    cleanupReceipt: normalized.cleanupReceipt,
  });
  return { canonical: `${JSON.stringify(legacy)}\n`, record: normalized };
}

function normalizeFinalizationContext(
  context: DockerManagedBootstrapFinalizationContext,
): DockerManagedBootstrapFinalizationContext {
  return Object.freeze({
    bootstrapIdentity: exactSha256(
      context.bootstrapIdentity,
      "finalization context bootstrap identity",
    ),
    providerId: exactString(context.providerId, "finalization context provider ID"),
    agent: exactAgent(context.agent),
    sandbox: exactSandbox(context.sandbox),
    planFingerprint: exactSha256(context.planFingerprint, "finalization context plan fingerprint"),
    profileFingerprint: exactSha256(
      context.profileFingerprint,
      "finalization context profile fingerprint",
    ),
    imageReference: exactString(context.imageReference, "finalization context image reference"),
  });
}

function matchesFinalizationContext(
  record: DockerManagedBootstrapFinalizationWithoutAgent,
  context: DockerManagedBootstrapFinalizationContext,
): boolean {
  return (
    context.bootstrapIdentity === record.bootstrapIdentity &&
    context.providerId === record.providerId &&
    sameSandboxIdentity(context.sandbox, record.sandbox) &&
    context.planFingerprint === record.planFingerprint &&
    context.profileFingerprint === record.profileFingerprint &&
    context.imageReference === record.imageReference
  );
}

function assertFinalizationMatchesContext(
  record: DockerManagedBootstrapFinalizationRecord,
  context: DockerManagedBootstrapFinalizationContext,
): void {
  const normalizedContext = normalizeFinalizationContext(context);
  if (
    record.agent !== normalizedContext.agent ||
    !matchesFinalizationContext(record, normalizedContext)
  ) {
    fail("finalization record does not match supplied durable context");
  }
}

function upgradeLegacyFinalization(
  legacy: DockerManagedBootstrapFinalizationWithoutAgent,
  context: DockerManagedBootstrapFinalizationContext | undefined,
): DockerManagedBootstrapFinalizationRecord {
  const missingAgent = (reason: "context-mismatch" | "missing-context" = "missing-context") =>
    new DockerManagedBootstrapLegacyRecordRequiresAgentError({
      bootstrapIdentity: legacy.bootstrapIdentity,
      recordKind: "finalization",
      reason,
      schemaVersion: 1,
    });
  // Runtime names and image repositories are mutable descriptions, never
  // agent authority. Only an exact live handle or current journal may supply
  // the field omitted by schema v1.
  if (!context) throw missingAgent();
  const normalizedContext = normalizeFinalizationContext(context);
  if (!matchesFinalizationContext(legacy, normalizedContext)) {
    throw missingAgent("context-mismatch");
  }
  return Object.freeze({
    schemaVersion: DOCKER_MANAGED_BOOTSTRAP_FINALIZATION_SCHEMA_VERSION,
    phase: legacy.phase,
    bootstrapIdentity: legacy.bootstrapIdentity,
    providerId: legacy.providerId,
    agent: normalizedContext.agent,
    sandbox: legacy.sandbox,
    planFingerprint: legacy.planFingerprint,
    profileFingerprint: legacy.profileFingerprint,
    imageReference: legacy.imageReference,
    commitReceipt: legacy.commitReceipt,
    cleanupReceipt: legacy.cleanupReceipt,
  });
}

export function normalizeDockerManagedBootstrapFinalizationRecord(
  value: unknown,
): DockerManagedBootstrapFinalizationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("finalization record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 1) {
    const legacy = normalizeLegacyFinalizationShape(record).record;
    throw new DockerManagedBootstrapLegacyRecordRequiresAgentError({
      bootstrapIdentity: legacy.bootstrapIdentity,
      recordKind: "finalization",
      schemaVersion: 1,
    });
  }
  const expectedKeys = [
    "agent",
    "bootstrapIdentity",
    "cleanupReceipt",
    "commitReceipt",
    "imageReference",
    "phase",
    "planFingerprint",
    "profileFingerprint",
    "providerId",
    "sandbox",
    "schemaVersion",
  ];
  if (
    !hasExactKeys(record, expectedKeys) ||
    record.schemaVersion !== DOCKER_MANAGED_BOOTSTRAP_FINALIZATION_SCHEMA_VERSION
  ) {
    fail("finalization record schema is invalid");
  }
  const normalized = normalizeFinalizationWithoutAgent(record);
  return Object.freeze({
    schemaVersion: DOCKER_MANAGED_BOOTSTRAP_FINALIZATION_SCHEMA_VERSION,
    phase: normalized.phase,
    bootstrapIdentity: normalized.bootstrapIdentity,
    providerId: normalized.providerId,
    agent: exactAgent(record.agent),
    sandbox: normalized.sandbox,
    planFingerprint: normalized.planFingerprint,
    profileFingerprint: normalized.profileFingerprint,
    imageReference: normalized.imageReference,
    commitReceipt: normalized.commitReceipt,
    cleanupReceipt: normalized.cleanupReceipt,
  });
}

export function serializeDockerManagedBootstrapFinalizationRecord(
  record: DockerManagedBootstrapFinalizationRecord,
): string {
  const serialized = `${JSON.stringify(normalizeDockerManagedBootstrapFinalizationRecord(record))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_BYTES) {
    fail("serialized finalization record exceeds its bounded transport");
  }
  return serialized;
}

function parseDockerManagedBootstrapFinalizationRecordWithContext(
  text: string,
  context?: DockerManagedBootstrapFinalizationContext,
): { readonly record: DockerManagedBootstrapFinalizationRecord; readonly upgradedLegacy: boolean } {
  if (
    text.length === 0 ||
    text.includes("\0") ||
    Buffer.byteLength(text, "utf8") > MAX_JOURNAL_BYTES
  ) {
    fail("serialized finalization record is empty or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("serialized finalization record is not valid JSON");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).schemaVersion === 1
  ) {
    const legacy = normalizeLegacyFinalizationShape(parsed);
    if (legacy.canonical !== text) fail("serialized legacy finalization record is not canonical");
    return { record: upgradeLegacyFinalization(legacy.record, context), upgradedLegacy: true };
  }
  const record = normalizeDockerManagedBootstrapFinalizationRecord(parsed);
  if (serializeDockerManagedBootstrapFinalizationRecord(record) !== text) {
    fail("serialized finalization record is not canonical");
  }
  if (context) assertFinalizationMatchesContext(record, context);
  return { record, upgradedLegacy: false };
}

export function parseDockerManagedBootstrapFinalizationRecord(
  text: string,
  context?: DockerManagedBootstrapFinalizationContext,
): DockerManagedBootstrapFinalizationRecord {
  return parseDockerManagedBootstrapFinalizationRecordWithContext(text, context).record;
}

function assertDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: JOURNAL_DIRECTORY_MODE });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail("journal directory must be a private real directory");
  }
}

function journalPath(directory: string, bootstrapIdentity: string): string {
  exactSha256(bootstrapIdentity, "bootstrap identity");
  return path.join(directory, `${bootstrapIdentity}.json`);
}

function decisionPath(target: string): string {
  return `${target}.decision`;
}

function finalizationPath(target: string): string {
  return `${target}.finalized`;
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

function readPrivateFile(target: string, label: string): string | null {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    fail(`cannot safely open ${label} because O_NOFOLLOW is unavailable`);
  }
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow | nonblock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      fail(`${label} file ownership boundary is invalid`);
    }
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size <= 0n ||
      before.size > BigInt(MAX_JOURNAL_BYTES)
    ) {
      fail(`${label} file ownership boundary is invalid`);
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
      fail(`${label} file changed during its stable read`);
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

function atomicWrite(
  directory: string,
  target: string,
  contents: string,
  exclusive: boolean,
): void {
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now().toString(16)}.tmp`,
  );
  let descriptor: number | null = null;
  let primaryFailure: { readonly error: unknown } | null = null;
  try {
    descriptor = fs.openSync(temporary, "wx", JOURNAL_FILE_MODE);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (exclusive) {
      try {
        fs.linkSync(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new DockerManagedBootstrapJournalExistsError();
        }
        throw error;
      }
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, target);
    }
    fs.chmodSync(target, JOURNAL_FILE_MODE);
    fsyncDirectory(directory);
  } catch (error) {
    primaryFailure = { error };
  }
  let cleanupFailure: { readonly error: unknown } | null = null;
  if (descriptor !== null) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      cleanupFailure = { error };
    }
  }
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && cleanupFailure === null) {
      cleanupFailure = { error };
    }
  }
  if (primaryFailure !== null) throw primaryFailure.error;
  if (cleanupFailure !== null) throw cleanupFailure.error;
}

function sameSerializedJournal(
  left: DockerManagedBootstrapJournal,
  right: DockerManagedBootstrapJournal,
): boolean {
  return (
    serializeDockerManagedBootstrapJournal(left) === serializeDockerManagedBootstrapJournal(right)
  );
}

export function createFileDockerManagedBootstrapJournalStore(
  stateRoot: string,
): DockerManagedBootstrapJournalStore {
  const directory = path.join(stateRoot, DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY);
  const load = (bootstrapIdentity: string): DockerManagedBootstrapJournal | null => {
    assertDirectory(directory);
    const target = journalPath(directory, bootstrapIdentity);
    const contents = readPrivateFile(target, "journal");
    if (contents === null) return null;
    let journal: DockerManagedBootstrapJournal;
    try {
      journal = parseDockerManagedBootstrapJournal(contents);
    } catch (error) {
      if (
        error instanceof DockerManagedBootstrapLegacyRecordRequiresAgentError &&
        error.recordKind === "journal" &&
        error.bootstrapIdentity !== bootstrapIdentity
      ) {
        fail("journal bootstrap identity does not match its file name");
      }
      throw error;
    }
    if (journal.bootstrapIdentity !== bootstrapIdentity) {
      fail("journal bootstrap identity does not match its file name");
    }
    const decision = readPrivateFile(decisionPath(target), "decision");
    if (decision === null) return journal;
    const phase = decision.endsWith("\n") ? decision.slice(0, -1) : "";
    if (
      !DECISION_PHASES.has(phase as DockerManagedBootstrapJournalPhase) ||
      (journal.phase !== "cutover" && journal.phase !== phase)
    ) {
      fail("decision does not match its cutover journal");
    }
    const decided = normalizeDockerManagedBootstrapJournal({ ...journal, phase });
    if (journal.phase === "cutover") {
      atomicWrite(directory, target, serializeDockerManagedBootstrapJournal(decided), false);
    }
    return decided;
  };
  const loadFinalization = (
    bootstrapIdentity: string,
    context?: DockerManagedBootstrapFinalizationContext,
  ): DockerManagedBootstrapFinalizationRecord | null => {
    assertDirectory(directory);
    const target = finalizationPath(journalPath(directory, bootstrapIdentity));
    const contents = readPrivateFile(target, "finalization");
    if (contents === null) return null;
    const parsed = parseDockerManagedBootstrapFinalizationRecordWithContext(contents, context);
    if (parsed.record.bootstrapIdentity !== bootstrapIdentity) {
      fail("finalization bootstrap identity does not match its file name");
    }
    if (parsed.upgradedLegacy) {
      const serialized = serializeDockerManagedBootstrapFinalizationRecord(parsed.record);
      atomicWrite(directory, target, serialized, false);
      if (readPrivateFile(target, "finalization") !== serialized) {
        fail("upgraded finalization record was not durably re-readable");
      }
    }
    return parsed.record;
  };
  return Object.freeze({
    create(journal: DockerManagedBootstrapJournal) {
      const normalized = normalizeDockerManagedBootstrapJournal(journal);
      if (
        normalized.phase !== "staged" ||
        normalized.preparationReceipt === null ||
        normalized.commitReceipt !== null
      ) {
        fail("a new journal requires staged durable preparation authority");
      }
      assertDirectory(directory);
      const target = journalPath(directory, normalized.bootstrapIdentity);
      if (readPrivateFile(decisionPath(target), "decision") !== null) {
        fail("stale decision exists for this bootstrap identity");
      }
      atomicWrite(directory, target, serializeDockerManagedBootstrapJournal(normalized), true);
    },
    load,
    listUnfinishedIdentities() {
      assertDirectory(directory);
      const identities: string[] = [];
      for (const name of fs.readdirSync(directory)) {
        const match = name.match(/^([a-f0-9]{64})\.json$/u);
        if (match) {
          identities.push(match[1]);
          continue;
        }
        if (
          /^\.[a-f0-9]{64}\.json(?:\.decision|\.finalized)?\.[0-9]+\.[a-f0-9]+\.tmp$/u.test(name) ||
          /^[a-f0-9]{64}\.json\.(?:decision|finalized)$/u.test(name)
        ) {
          continue;
        }
        fail(`journal directory contains an unsupported entry: ${name}`);
      }
      return Object.freeze(identities.sort());
    },
    transition(
      bootstrapIdentity: string,
      expected: DockerManagedBootstrapJournalPhase,
      next: DockerManagedBootstrapJournalPhase,
    ) {
      if (!ALLOWED_TRANSITIONS.has(`${expected}->${next}`)) {
        fail(`transition ${expected} to ${next} is unsupported`);
      }
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (current?.phase === next) return current;
      if (!current || current.phase !== expected) {
        fail(`expected phase ${expected} before transition to ${next}`);
      }
      const updated = normalizeDockerManagedBootstrapJournal({ ...current, phase: next });
      if (expected === "cutover") {
        const decision = decisionPath(target);
        try {
          atomicWrite(directory, decision, `${next}\n`, true);
        } catch (error) {
          if (
            !(error instanceof DockerManagedBootstrapJournalExistsError) ||
            readPrivateFile(decision, "decision") !== `${next}\n`
          ) {
            throw error;
          }
        }
      }
      atomicWrite(directory, target, serializeDockerManagedBootstrapJournal(updated), false);
      return updated;
    },
    recordCompletion(
      bootstrapIdentity: string,
      receipt: ManagedBootstrapCompletionReceipt,
    ): DockerManagedBootstrapJournal {
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (!current || current.phase !== "cutover") {
        fail(`completion recording requires phase cutover, found ${current?.phase ?? "absent"}`);
      }
      const updated = normalizeDockerManagedBootstrapJournal({
        ...current,
        commitReceipt: receipt,
      });
      if (current.commitReceipt !== null) {
        if (!sameSerializedJournal(current, updated)) {
          fail("completion receipt changed for this bootstrap identity");
        }
        return current;
      }
      atomicWrite(directory, target, serializeDockerManagedBootstrapJournal(updated), false);
      const persisted = load(bootstrapIdentity);
      if (!persisted || !sameSerializedJournal(persisted, updated)) {
        fail("completion receipt was not durably re-readable");
      }
      return persisted;
    },
    remove(bootstrapIdentity: string, expected: readonly DockerManagedBootstrapJournalPhase[]) {
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (!current || !expected.includes(current.phase)) {
        fail(`journal removal is not authorized from phase ${current?.phase ?? "absent"}`);
      }
      const decision = decisionPath(target);
      if (readPrivateFile(decision, "decision") !== null) {
        fs.unlinkSync(decision);
        fsyncDirectory(directory);
      }
      fs.unlinkSync(target);
      fsyncDirectory(directory);
    },
    recordFinalization(
      record: DockerManagedBootstrapFinalizationRecord,
      context?: DockerManagedBootstrapFinalizationContext,
    ) {
      const normalized = normalizeDockerManagedBootstrapFinalizationRecord(record);
      if (context) assertFinalizationMatchesContext(normalized, context);
      assertDirectory(directory);
      const target = finalizationPath(journalPath(directory, normalized.bootstrapIdentity));
      const serialized = serializeDockerManagedBootstrapFinalizationRecord(normalized);
      const existing = loadFinalization(normalized.bootstrapIdentity, context);
      if (existing !== null) {
        if (serializeDockerManagedBootstrapFinalizationRecord(existing) !== serialized) {
          fail("finalization record changed for this bootstrap identity");
        }
        return;
      }
      try {
        atomicWrite(directory, target, serialized, true);
      } catch (error) {
        const recovered = loadFinalization(normalized.bootstrapIdentity, context);
        if (
          !recovered ||
          serializeDockerManagedBootstrapFinalizationRecord(recovered) !== serialized
        ) {
          throw error;
        }
      }
      const persisted = loadFinalization(normalized.bootstrapIdentity, context);
      if (
        !persisted ||
        serializeDockerManagedBootstrapFinalizationRecord(persisted) !== serialized
      ) {
        fail("finalization record was not durably re-readable");
      }
    },
    loadFinalization,
  });
}
