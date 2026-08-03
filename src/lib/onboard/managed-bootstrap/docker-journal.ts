// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { ManagedBootstrapSandboxIdentity } from "./adapter";

export const DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION = 1 as const;
export const DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY = "managed-bootstrap";

const SHA256_RE = /^[a-f0-9]{64}$/u;
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
  | "shared-state-committed";

export interface DockerManagedBootstrapJournal {
  readonly schemaVersion: typeof DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION;
  readonly phase: DockerManagedBootstrapJournalPhase;
  readonly bootstrapIdentity: string;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
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
}

export interface DockerManagedBootstrapJournalStore {
  create(journal: DockerManagedBootstrapJournal): void;
  load(bootstrapIdentity: string): DockerManagedBootstrapJournal | null;
  transition(
    bootstrapIdentity: string,
    expected: DockerManagedBootstrapJournalPhase,
    next: DockerManagedBootstrapJournalPhase,
  ): DockerManagedBootstrapJournal;
  remove(bootstrapIdentity: string, expected: readonly DockerManagedBootstrapJournalPhase[]): void;
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
  "cutover->rollback-authorized",
  "cutover->shared-state-committed",
]);

function fail(message: string): never {
  throw new Error(`Managed bootstrap Docker journal is invalid: ${message}`);
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
    !["staged", "cutover", "rollback-authorized", "shared-state-committed"].includes(String(value))
  ) {
    fail("phase is unsupported");
  }
  return value as DockerManagedBootstrapJournalPhase;
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

export function normalizeDockerManagedBootstrapJournal(
  value: unknown,
): DockerManagedBootstrapJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("journal must be an object");
  }
  const journal = value as Record<string, unknown>;
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
  if (
    Object.keys(journal).sort().join(",") !== expectedKeys.sort().join(",") ||
    journal.schemaVersion !== DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION
  ) {
    fail("journal schema is invalid");
  }
  const normalized = Object.freeze({
    schemaVersion: DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
    phase: exactPhase(journal.phase),
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
  const journal = normalizeDockerManagedBootstrapJournal(parsed);
  if (serializeDockerManagedBootstrapJournal(journal) !== text) {
    fail("serialized journal is not canonical");
  }
  return journal;
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

export function createFileDockerManagedBootstrapJournalStore(
  stateRoot: string,
): DockerManagedBootstrapJournalStore {
  const directory = path.join(stateRoot, DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY);
  const load = (bootstrapIdentity: string): DockerManagedBootstrapJournal | null => {
    assertDirectory(directory);
    const target = journalPath(directory, bootstrapIdentity);
    const contents = readPrivateFile(target, "journal");
    if (contents === null) return null;
    const journal = parseDockerManagedBootstrapJournal(contents);
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
  return Object.freeze({
    create(journal: DockerManagedBootstrapJournal) {
      const normalized = normalizeDockerManagedBootstrapJournal(journal);
      assertDirectory(directory);
      const target = journalPath(directory, normalized.bootstrapIdentity);
      if (readPrivateFile(decisionPath(target), "decision") !== null) {
        fail("stale decision exists for this bootstrap identity");
      }
      atomicWrite(directory, target, serializeDockerManagedBootstrapJournal(normalized), true);
    },
    load,
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
  });
}
