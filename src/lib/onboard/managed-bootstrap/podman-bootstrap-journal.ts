// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PODMAN_BOOTSTRAP_JOURNAL_SCHEMA_VERSION = 1 as const;
export const PODMAN_BOOTSTRAP_JOURNAL_DIRECTORY = "managed-bootstrap-podman";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_JOURNAL_BYTES = 32 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_CONTENT_ID = /^sha256:[a-f0-9]{64}$/u;
const AUTHORITY_ID = /^podman-sha256:[a-f0-9]{64}$/u;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export type PodmanBootstrapJournalPhase =
  | "preparing-replacement"
  | "state-volume-created"
  | "replacement-created"
  | "original-stopped"
  | "rollback-authorized"
  | "commit-authorized"
  | "committed";

export interface PodmanBootstrapJournal {
  readonly schemaVersion: typeof PODMAN_BOOTSTRAP_JOURNAL_SCHEMA_VERSION;
  readonly phase: PodmanBootstrapJournalPhase;
  readonly bootstrapIdentity: string;
  readonly engineAuthorityId: string;
  readonly watcherLeaseId: string;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly originalRuntimeId: string;
  readonly originalContainerName: string;
  readonly originalImageContentId: string;
  readonly originalSpecFingerprint: string;
  readonly replacementStateVolumeName: string;
  readonly replacementStateVolumeMountpoint: string | null;
  readonly replacementRuntimeId: string | null;
  readonly replacementStagingName: string;
  readonly replacementImageContentId: string;
  readonly replacementSpecFingerprint: string;
}

export interface PodmanBootstrapJournalStore {
  /** Create durable mutation authority before the first replacement command. */
  readonly create: (journal: PodmanBootstrapJournal) => void;
  readonly load: (bootstrapIdentity: string) => PodmanBootstrapJournal | null;
  readonly listUnfinished: () => readonly PodmanBootstrapJournal[];
  /** Record the exact Podman-managed state volume before container creation. */
  readonly recordStateVolume: (
    bootstrapIdentity: string,
    replacementStateVolumeMountpoint: string,
  ) => PodmanBootstrapJournal;
  /** Record the exact stopped replacement ID after a stable inspect. */
  readonly recordReplacement: (
    bootstrapIdentity: string,
    replacementRuntimeId: string,
  ) => PodmanBootstrapJournal;
  /** Record that the exact original container is stopped. */
  readonly recordOriginalStopped: (bootstrapIdentity: string) => PodmanBootstrapJournal;
  /** Make rollback the only legal pre-commit outcome. */
  readonly authorizeRollback: (
    bootstrapIdentity: string,
    expected: readonly Exclude<
      PodmanBootstrapJournalPhase,
      "rollback-authorized" | "commit-authorized" | "committed"
    >[],
  ) => PodmanBootstrapJournal;
  /** Durably make commit the only legal terminal outcome before original removal. */
  readonly authorizeCommit: (
    bootstrapIdentity: string,
    expected: readonly Exclude<
      PodmanBootstrapJournalPhase,
      "rollback-authorized" | "commit-authorized" | "committed"
    >[],
  ) => PodmanBootstrapJournal;
  /** Record that exact final runtime identity and canonical name were independently proven. */
  readonly recordCommitted: (bootstrapIdentity: string) => PodmanBootstrapJournal;
  /** Remove the journal only after exact rollback state is independently proven. */
  readonly removeAfterRollback: (bootstrapIdentity: string) => void;
  /** Remove commit authority only after the committed runtime was independently proven. */
  readonly removeAfterCommit: (bootstrapIdentity: string) => void;
}

class PodmanBootstrapJournalExistsError extends Error {
  public constructor() {
    super("Podman bootstrap journal already exists for this bootstrap identity.");
    this.name = "PodmanBootstrapJournalExistsError";
  }
}

function fail(message: string): never {
  throw new Error(`Podman bootstrap journal is invalid: ${message}`);
}

function exactString(value: unknown, label: string, maxBytes = 4096): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    CONTROL_CHARACTER.test(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    fail(`${label} must be one bounded exact string`);
  }
  return value;
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function exactRuntimeId(value: unknown, label: string): string {
  return exactSha256(value, label);
}

function exactImageContentId(value: unknown, label: string): string {
  if (typeof value !== "string" || !IMAGE_CONTENT_ID.test(value)) {
    fail(`${label} must be one immutable sha256 image content ID`);
  }
  return value;
}

function exactPhase(value: unknown): PodmanBootstrapJournalPhase {
  if (
    ![
      "preparing-replacement",
      "state-volume-created",
      "replacement-created",
      "original-stopped",
      "rollback-authorized",
      "commit-authorized",
      "committed",
    ].includes(String(value))
  ) {
    fail("phase is unsupported");
  }
  return value as PodmanBootstrapJournalPhase;
}

function exactAbsolutePath(value: unknown, label: string): string {
  const target = exactString(value, label);
  if (
    !path.isAbsolute(target) ||
    path.normalize(target) !== target ||
    target === path.parse(target).root
  ) {
    fail(`${label} must be one normalized non-root absolute path`);
  }
  return target;
}

function exactContainerName(value: unknown, label: string): string {
  const name = exactString(value, label, 253);
  if (!SAFE_NAME.test(name)) fail(`${label} is malformed`);
  return name;
}

export function normalizePodmanBootstrapJournal(value: unknown): PodmanBootstrapJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("journal must be an object");
  }
  const journal = value as Record<string, unknown>;
  const expectedKeys = [
    "bootstrapIdentity",
    "engineAuthorityId",
    "originalContainerName",
    "originalImageContentId",
    "originalRuntimeId",
    "originalSpecFingerprint",
    "phase",
    "replacementImageContentId",
    "replacementRuntimeId",
    "replacementSpecFingerprint",
    "replacementStateVolumeMountpoint",
    "replacementStateVolumeName",
    "replacementStagingName",
    "sandboxId",
    "sandboxName",
    "schemaVersion",
    "watcherLeaseId",
  ];
  if (
    Object.keys(journal).sort().join(",") !== expectedKeys.sort().join(",") ||
    journal.schemaVersion !== PODMAN_BOOTSTRAP_JOURNAL_SCHEMA_VERSION
  ) {
    fail("journal schema is invalid");
  }
  const replacementRuntimeId =
    journal.replacementRuntimeId === null
      ? null
      : exactRuntimeId(journal.replacementRuntimeId, "replacement runtime ID");
  const replacementStateVolumeMountpoint =
    journal.replacementStateVolumeMountpoint === null
      ? null
      : exactAbsolutePath(
          journal.replacementStateVolumeMountpoint,
          "replacement state volume mountpoint",
        );
  const normalized = Object.freeze({
    schemaVersion: PODMAN_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
    phase: exactPhase(journal.phase),
    bootstrapIdentity: exactSha256(journal.bootstrapIdentity, "bootstrap identity"),
    engineAuthorityId: exactString(journal.engineAuthorityId, "engine authority ID", 256),
    watcherLeaseId: exactString(journal.watcherLeaseId, "watcher lease ID", 64),
    sandboxName: exactString(journal.sandboxName, "sandbox name", 128),
    sandboxId: exactString(journal.sandboxId, "sandbox ID"),
    originalRuntimeId: exactRuntimeId(journal.originalRuntimeId, "original runtime ID"),
    originalContainerName: exactContainerName(
      journal.originalContainerName,
      "original container name",
    ),
    originalImageContentId: exactImageContentId(
      journal.originalImageContentId,
      "original image content ID",
    ),
    originalSpecFingerprint: exactSha256(
      journal.originalSpecFingerprint,
      "original spec fingerprint",
    ),
    replacementStateVolumeName: exactContainerName(
      journal.replacementStateVolumeName,
      "replacement state volume name",
    ),
    replacementStateVolumeMountpoint,
    replacementRuntimeId,
    replacementStagingName: exactContainerName(
      journal.replacementStagingName,
      "replacement staging name",
    ),
    replacementImageContentId: exactImageContentId(
      journal.replacementImageContentId,
      "replacement image content ID",
    ),
    replacementSpecFingerprint: exactSha256(
      journal.replacementSpecFingerprint,
      "replacement spec fingerprint",
    ),
  } satisfies PodmanBootstrapJournal);
  if (!AUTHORITY_ID.test(normalized.engineAuthorityId)) {
    fail("engine authority ID is not an exact Podman authority");
  }
  if (!LEASE_ID.test(normalized.watcherLeaseId)) {
    fail("watcher lease ID is malformed");
  }
  if (normalized.originalContainerName === normalized.replacementStagingName) {
    fail("original and replacement names must differ");
  }
  if (normalized.originalRuntimeId === normalized.replacementRuntimeId) {
    fail("original and replacement runtime IDs must differ");
  }
  if (
    (normalized.phase === "preparing-replacement" &&
      (replacementStateVolumeMountpoint !== null || replacementRuntimeId !== null)) ||
    (normalized.phase === "state-volume-created" &&
      (replacementStateVolumeMountpoint === null || replacementRuntimeId !== null)) ||
    (["replacement-created", "original-stopped", "commit-authorized", "committed"].includes(
      normalized.phase,
    ) &&
      (replacementStateVolumeMountpoint === null || replacementRuntimeId === null)) ||
    (normalized.phase === "rollback-authorized" &&
      replacementRuntimeId !== null &&
      replacementStateVolumeMountpoint === null)
  ) {
    fail("phase does not match the replacement runtime identity");
  }
  return normalized;
}

export function serializePodmanBootstrapJournal(journal: PodmanBootstrapJournal): string {
  const serialized = `${JSON.stringify(normalizePodmanBootstrapJournal(journal))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_BYTES) {
    fail("serialized journal exceeds its bounded transport");
  }
  return serialized;
}

export function parsePodmanBootstrapJournal(text: string): PodmanBootstrapJournal {
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
  const journal = normalizePodmanBootstrapJournal(parsed);
  if (serializePodmanBootstrapJournal(journal) !== text) {
    fail("serialized journal is not canonical");
  }
  return journal;
}

function assertDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
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
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  let primaryFailure: unknown;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      FILE_MODE,
    );
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (exclusive) {
      try {
        fs.linkSync(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new PodmanBootstrapJournalExistsError();
        }
        throw error;
      }
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, target);
    }
    fs.chmodSync(target, FILE_MODE);
    fsyncDirectory(directory);
  } catch (error) {
    primaryFailure = error;
  }
  let cleanupFailure: unknown;
  if (descriptor !== null) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      cleanupFailure = error;
    }
  }
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && cleanupFailure === undefined) {
      cleanupFailure = error;
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

function sameJournal(left: PodmanBootstrapJournal, right: PodmanBootstrapJournal): boolean {
  return serializePodmanBootstrapJournal(left) === serializePodmanBootstrapJournal(right);
}

export function createFilePodmanBootstrapJournalStore(
  stateRoot: string,
): PodmanBootstrapJournalStore {
  const directory = path.join(stateRoot, PODMAN_BOOTSTRAP_JOURNAL_DIRECTORY);
  const load = (bootstrapIdentity: string): PodmanBootstrapJournal | null => {
    assertDirectory(directory);
    const target = journalPath(directory, bootstrapIdentity);
    const contents = readPrivateFile(target, "journal");
    if (contents === null) return null;
    const journal = parsePodmanBootstrapJournal(contents);
    const decision = readPrivateFile(decisionPath(target), "terminal decision");
    if (decision === null) return journal;
    if (decision !== "rollback-authorized\n" && decision !== "commit-authorized\n") {
      fail("terminal decision is invalid");
    }
    const decidedPhase = decision.trim() as "rollback-authorized" | "commit-authorized";
    if (
      journal.phase === decidedPhase ||
      (decidedPhase === "commit-authorized" && journal.phase === "committed")
    ) {
      return journal;
    }
    if (journal.phase === "rollback-authorized" || journal.phase === "committed") {
      fail("journal terminal phase conflicts with its durable decision");
    }
    const decided = normalizePodmanBootstrapJournal({
      ...journal,
      phase: decidedPhase,
    });
    atomicWrite(directory, target, serializePodmanBootstrapJournal(decided), false);
    return decided;
  };

  return Object.freeze({
    create(journal: PodmanBootstrapJournal) {
      const normalized = normalizePodmanBootstrapJournal(journal);
      if (normalized.phase !== "preparing-replacement") {
        fail("a new journal must begin before replacement creation");
      }
      assertDirectory(directory);
      const target = journalPath(directory, normalized.bootstrapIdentity);
      if (readPrivateFile(decisionPath(target), "terminal decision") !== null) {
        fail("stale terminal decision exists for this bootstrap identity");
      }
      atomicWrite(directory, target, serializePodmanBootstrapJournal(normalized), true);
    },
    load,
    listUnfinished() {
      assertDirectory(directory);
      const identities = new Set<string>();
      const decisions = new Set<string>();
      for (const name of fs.readdirSync(directory)) {
        const journalMatch = name.match(/^([a-f0-9]{64})\.json$/u);
        if (journalMatch?.[1]) {
          identities.add(journalMatch[1]);
          continue;
        }
        const decisionMatch = name.match(/^([a-f0-9]{64})\.json\.decision$/u);
        if (decisionMatch?.[1]) {
          decisions.add(decisionMatch[1]);
          continue;
        }
        if (/^\.[a-f0-9]{64}\.json(?:\.decision)?\.[0-9a-f-]+\.tmp$/u.test(name)) {
          continue;
        }
        fail(`journal directory contains an unsupported entry: ${name}`);
      }
      for (const identity of decisions) {
        if (!identities.has(identity)) fail(`terminal decision ${identity} has no journal`);
      }
      return Object.freeze(
        [...identities].sort().map((identity) => {
          const journal = load(identity);
          if (!journal) fail(`enumerated journal ${identity} disappeared`);
          return journal;
        }),
      );
    },
    recordStateVolume(bootstrapIdentity: string, replacementStateVolumeMountpoint: string) {
      const normalizedMountpoint = exactAbsolutePath(
        replacementStateVolumeMountpoint,
        "replacement state volume mountpoint",
      );
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (current?.phase === "state-volume-created") {
        if (current.replacementStateVolumeMountpoint !== normalizedMountpoint) {
          fail("replacement state volume mountpoint changed for this bootstrap identity");
        }
        return current;
      }
      if (!current || current.phase !== "preparing-replacement") {
        fail(
          `state volume recording requires preparing-replacement, found ${current?.phase ?? "absent"}`,
        );
      }
      const updated = normalizePodmanBootstrapJournal({
        ...current,
        phase: "state-volume-created",
        replacementStateVolumeMountpoint: normalizedMountpoint,
      });
      atomicWrite(directory, target, serializePodmanBootstrapJournal(updated), false);
      const persisted = load(bootstrapIdentity);
      if (!persisted || !sameJournal(persisted, updated)) {
        fail("replacement state volume was not durably re-readable");
      }
      return persisted;
    },
    recordReplacement(bootstrapIdentity: string, replacementRuntimeId: string) {
      const normalizedId = exactRuntimeId(replacementRuntimeId, "replacement runtime ID");
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (current?.phase === "replacement-created") {
        if (current.replacementRuntimeId !== normalizedId) {
          fail("replacement runtime ID changed for this bootstrap identity");
        }
        return current;
      }
      if (!current || current.phase !== "state-volume-created") {
        fail(
          `replacement recording requires state-volume-created, found ${current?.phase ?? "absent"}`,
        );
      }
      const updated = normalizePodmanBootstrapJournal({
        ...current,
        phase: "replacement-created",
        replacementRuntimeId: normalizedId,
      });
      atomicWrite(directory, target, serializePodmanBootstrapJournal(updated), false);
      const persisted = load(bootstrapIdentity);
      if (!persisted || !sameJournal(persisted, updated)) {
        fail("replacement identity was not durably re-readable");
      }
      return persisted;
    },
    recordOriginalStopped(bootstrapIdentity: string) {
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (current?.phase === "original-stopped") return current;
      if (!current || current.phase !== "replacement-created") {
        fail(
          `original stop recording requires replacement-created, found ${current?.phase ?? "absent"}`,
        );
      }
      const updated = normalizePodmanBootstrapJournal({ ...current, phase: "original-stopped" });
      atomicWrite(directory, target, serializePodmanBootstrapJournal(updated), false);
      const persisted = load(bootstrapIdentity);
      if (!persisted || !sameJournal(persisted, updated)) {
        fail("original stop was not durably re-readable");
      }
      return persisted;
    },
    authorizeRollback(
      bootstrapIdentity: string,
      expected: readonly Exclude<
        PodmanBootstrapJournalPhase,
        "rollback-authorized" | "commit-authorized" | "committed"
      >[],
    ) {
      if (!Array.isArray(expected) || expected.length === 0) {
        fail("rollback authorization requires at least one expected phase");
      }
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (current?.phase === "rollback-authorized") return current;
      if (!current || !expected.includes(current.phase as (typeof expected)[number])) {
        fail(`rollback authorization is not allowed from ${current?.phase ?? "absent"}`);
      }
      const decision = decisionPath(target);
      try {
        atomicWrite(directory, decision, "rollback-authorized\n", true);
      } catch (error) {
        if (
          !(error instanceof PodmanBootstrapJournalExistsError) ||
          readPrivateFile(decision, "terminal decision") !== "rollback-authorized\n"
        ) {
          throw error;
        }
      }
      const updated = normalizePodmanBootstrapJournal({
        ...current,
        phase: "rollback-authorized",
      });
      atomicWrite(directory, target, serializePodmanBootstrapJournal(updated), false);
      return updated;
    },
    authorizeCommit(
      bootstrapIdentity: string,
      expected: readonly Exclude<
        PodmanBootstrapJournalPhase,
        "rollback-authorized" | "commit-authorized" | "committed"
      >[],
    ) {
      if (!Array.isArray(expected) || expected.length === 0) {
        fail("commit authorization requires at least one expected phase");
      }
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (current?.phase === "commit-authorized" || current?.phase === "committed") return current;
      if (!current || !expected.includes(current.phase as (typeof expected)[number])) {
        fail(`commit authorization is not allowed from ${current?.phase ?? "absent"}`);
      }
      const decision = decisionPath(target);
      try {
        atomicWrite(directory, decision, "commit-authorized\n", true);
      } catch (error) {
        if (
          !(error instanceof PodmanBootstrapJournalExistsError) ||
          readPrivateFile(decision, "terminal decision") !== "commit-authorized\n"
        ) {
          throw error;
        }
      }
      const updated = normalizePodmanBootstrapJournal({
        ...current,
        phase: "commit-authorized",
      });
      atomicWrite(directory, target, serializePodmanBootstrapJournal(updated), false);
      return updated;
    },
    recordCommitted(bootstrapIdentity: string) {
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (current?.phase === "committed") return current;
      if (!current || current.phase !== "commit-authorized") {
        fail(`commit recording requires commit-authorized, found ${current?.phase ?? "absent"}`);
      }
      const updated = normalizePodmanBootstrapJournal({ ...current, phase: "committed" });
      atomicWrite(directory, target, serializePodmanBootstrapJournal(updated), false);
      const persisted = load(bootstrapIdentity);
      if (!persisted || !sameJournal(persisted, updated)) {
        fail("committed runtime identity was not durably re-readable");
      }
      return persisted;
    },
    removeAfterRollback(bootstrapIdentity: string) {
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (!current || current.phase !== "rollback-authorized") {
        fail(`rollback removal requires rollback-authorized, found ${current?.phase ?? "absent"}`);
      }
      const decision = decisionPath(target);
      if (readPrivateFile(decision, "terminal decision") !== null) {
        fs.unlinkSync(decision);
        fsyncDirectory(directory);
      }
      fs.unlinkSync(target);
      fsyncDirectory(directory);
    },
    removeAfterCommit(bootstrapIdentity: string) {
      assertDirectory(directory);
      const target = journalPath(directory, bootstrapIdentity);
      const current = load(bootstrapIdentity);
      if (!current || current.phase !== "committed") {
        fail(`commit removal requires committed, found ${current?.phase ?? "absent"}`);
      }
      const decision = decisionPath(target);
      const terminalDecision = readPrivateFile(decision, "terminal decision");
      if (terminalDecision !== null && terminalDecision !== "commit-authorized\n") {
        fail("commit removal requires its durable terminal decision");
      }
      // A committed journal is itself sufficient terminal authority. This
      // makes compaction retryable after a crash between removing the decision
      // file and removing the committed journal.
      if (terminalDecision !== null) {
        fs.unlinkSync(decision);
        fsyncDirectory(directory);
      }
      fs.unlinkSync(target);
      fsyncDirectory(directory);
    },
  });
}
