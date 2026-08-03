// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFileDockerManagedBootstrapJournalStore,
  DOCKER_MANAGED_BOOTSTRAP_FINALIZATION_SCHEMA_VERSION,
  DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY,
  DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  type DockerManagedBootstrapFinalizationContext,
  type DockerManagedBootstrapFinalizationRecord,
  type DockerManagedBootstrapJournal,
  type DockerManagedBootstrapJournalStore,
  DockerManagedBootstrapLegacyRecordRequiresAgentError,
  normalizeDockerManagedBootstrapJournal,
  parseDockerManagedBootstrapFinalizationRecord,
  parseDockerManagedBootstrapJournal,
  sameDockerManagedBootstrapReceipt,
  serializeDockerManagedBootstrapFinalizationRecord,
  serializeDockerManagedBootstrapJournal,
} from "./docker-journal";

const roots: string[] = [];
const IDENTITY = "1".repeat(64);
const OTHER_IDENTITY = "0".repeat(64);

function loadUnfinished(
  store: DockerManagedBootstrapJournalStore,
): readonly DockerManagedBootstrapJournal[] {
  return store.listUnfinishedIdentities().map((identity) => {
    const record = store.load(identity);
    expect(record, `enumerated journal ${identity} must remain loadable`).not.toBeNull();
    return record as DockerManagedBootstrapJournal;
  });
}
const journal = Object.freeze({
  schemaVersion: DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  phase: "staged",
  bootstrapIdentity: IDENTITY,
  providerId: "docker",
  agent: "hermes",
  sandbox: {
    sandboxName: "alpha",
    sandboxId: "sandbox-alpha",
    driverId: "docker",
  },
  planFingerprint: "9".repeat(64),
  profileFingerprint: "2".repeat(64),
  imageReference: `registry.example/image@sha256:${"3".repeat(64)}`,
  runtimeImageContentId: `sha256:${"4".repeat(64)}`,
  originalRuntimeId: "5".repeat(64),
  replacementRuntimeId: "6".repeat(64),
  originalName: "openshell-alpha",
  replacementStagingName: "openshell-alpha-staged",
  backupName: "openshell-alpha-backup",
  originalSpecHash: "7".repeat(64),
  replacementSpecHash: "8".repeat(64),
  rollbackTargetRuntimeId: "5".repeat(64),
  rollbackTargetSpecHash: "7".repeat(64),
  preparationReceipt: {
    schemaVersion: 1,
    sandbox: {
      sandboxName: "alpha",
      sandboxId: "sandbox-alpha",
      driverId: "docker",
    },
    bootstrapIdentity: IDENTITY,
    authorityFingerprint: "a".repeat(64),
    recordId: "prepared-alpha",
    recordedAt: "2026-07-31T19:59:59.000Z",
  },
  commitReceipt: null,
} satisfies DockerManagedBootstrapJournal);
const finalization = Object.freeze({
  schemaVersion: DOCKER_MANAGED_BOOTSTRAP_FINALIZATION_SCHEMA_VERSION,
  phase: "committed",
  bootstrapIdentity: IDENTITY,
  providerId: "docker",
  agent: journal.agent,
  sandbox: journal.sandbox,
  planFingerprint: journal.planFingerprint,
  profileFingerprint: journal.profileFingerprint,
  imageReference: journal.imageReference,
  commitReceipt: {
    schemaVersion: 1,
    sandbox: journal.sandbox,
    runtimeId: journal.replacementRuntimeId,
    image: {
      repository: "registry.example/image",
      manifestDigest: `sha256:${"3".repeat(64)}` as const,
    },
    runtimeImageContentId: journal.runtimeImageContentId,
    originalSpecHash: journal.originalSpecHash,
    replacementSpecHash: journal.replacementSpecHash,
    profileFingerprint: journal.profileFingerprint,
    bootstrapIdentity: IDENTITY,
    transactionPending: false,
    completedAt: "2026-07-31T20:00:00.000Z",
  },
  cleanupReceipt: {
    schemaVersion: 1,
    sandbox: journal.sandbox,
    bootstrapIdentity: IDENTITY,
    outcome: "committed",
    restoredRuntimeId: null,
    restoredSpecHash: null,
    heldWorkloadRemoved: false,
    alreadyRolledBack: false,
    finalizedAt: "2026-07-31T20:00:01.000Z",
  },
} satisfies DockerManagedBootstrapFinalizationRecord);

const finalizationContext = Object.freeze({
  bootstrapIdentity: finalization.bootstrapIdentity,
  providerId: finalization.providerId,
  agent: finalization.agent,
  sandbox: finalization.sandbox,
  planFingerprint: finalization.planFingerprint,
  profileFingerprint: finalization.profileFingerprint,
  imageReference: finalization.imageReference,
} satisfies DockerManagedBootstrapFinalizationContext);

function legacyJournalV1() {
  return Object.freeze({
    schemaVersion: 1 as const,
    phase: journal.phase,
    bootstrapIdentity: journal.bootstrapIdentity,
    sandbox: journal.sandbox,
    profileFingerprint: journal.profileFingerprint,
    imageReference: journal.imageReference,
    runtimeImageContentId: journal.runtimeImageContentId,
    originalRuntimeId: journal.originalRuntimeId,
    replacementRuntimeId: journal.replacementRuntimeId,
    originalName: journal.originalName,
    replacementStagingName: journal.replacementStagingName,
    backupName: journal.backupName,
    originalSpecHash: journal.originalSpecHash,
    replacementSpecHash: journal.replacementSpecHash,
  });
}

function legacyJournalV2() {
  return Object.freeze({
    schemaVersion: 2 as const,
    phase: journal.phase,
    bootstrapIdentity: journal.bootstrapIdentity,
    providerId: journal.providerId,
    sandbox: journal.sandbox,
    planFingerprint: journal.planFingerprint,
    profileFingerprint: journal.profileFingerprint,
    imageReference: journal.imageReference,
    runtimeImageContentId: journal.runtimeImageContentId,
    originalRuntimeId: journal.originalRuntimeId,
    replacementRuntimeId: journal.replacementRuntimeId,
    originalName: journal.originalName,
    replacementStagingName: journal.replacementStagingName,
    backupName: journal.backupName,
    originalSpecHash: journal.originalSpecHash,
    replacementSpecHash: journal.replacementSpecHash,
    rollbackTargetRuntimeId: journal.rollbackTargetRuntimeId,
    rollbackTargetSpecHash: journal.rollbackTargetSpecHash,
    preparationReceipt: journal.preparationReceipt,
    commitReceipt: journal.commitReceipt,
  });
}

function legacyFinalizationV1() {
  return Object.freeze({
    schemaVersion: 1 as const,
    phase: finalization.phase,
    bootstrapIdentity: finalization.bootstrapIdentity,
    providerId: finalization.providerId,
    sandbox: finalization.sandbox,
    planFingerprint: finalization.planFingerprint,
    profileFingerprint: finalization.profileFingerprint,
    imageReference: finalization.imageReference,
    commitReceipt: finalization.commitReceipt,
    cleanupReceipt: finalization.cleanupReceipt,
  });
}

function readPinnedPrivateFile(target: string): { readonly mode: number; readonly text: string } {
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const text = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor, { bigint: true });
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).toBe(before.ctimeNs);
    return { mode: Number(before.mode & 0o777n), text };
  } finally {
    fs.closeSync(descriptor);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Docker managed bootstrap journal", () => {
  it("rejects comma-joined keys as a different schema", () => {
    const { agent: _agent, backupName: _backupName, ...withoutSeparateKeys } = journal;

    expect(() =>
      normalizeDockerManagedBootstrapJournal({
        ...withoutSeparateKeys,
        "agent,backupName": "hermes",
      }),
    ).toThrow("journal schema is invalid");
  });

  it("publishes private canonical state through only monotonic phases", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    store.create(journal);
    const directory = path.join(root, DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY);
    const file = path.join(directory, `${IDENTITY}.json`);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    const persisted = readPinnedPrivateFile(file);
    expect(persisted.mode).toBe(0o600);
    expect(parseDockerManagedBootstrapJournal(persisted.text)).toEqual(journal);
    expect(() => store.create(journal)).toThrow("already exists");
    expect(() => store.transition(IDENTITY, "staged", "shared-state-committed")).toThrow(
      "unsupported",
    );

    expect(store.transition(IDENTITY, "staged", "cutover").phase).toBe("cutover");
    expect(store.recordCompletion(IDENTITY, finalization.commitReceipt).commitReceipt).toEqual(
      finalization.commitReceipt,
    );
    expect(store.transition(IDENTITY, "cutover", "shared-state-committed").phase).toBe(
      "shared-state-committed",
    );
    store.remove(IDENTITY, ["shared-state-committed"]);
    expect(store.load(IDENTITY)).toBeNull();
  });

  it("persists owner cleanup as a restart-safe non-terminal phase", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const first = createFileDockerManagedBootstrapJournalStore(root);
    first.create(journal);

    const retained = first.transition(IDENTITY, "staged", "owner-cleanup-required");
    expect(retained.phase).toBe("owner-cleanup-required");
    expect(first.listUnfinishedIdentities()).toEqual([IDENTITY]);

    const restarted = createFileDockerManagedBootstrapJournalStore(root);
    expect(restarted.load(IDENTITY)).toEqual(retained);
    expect(restarted.listUnfinishedIdentities()).toEqual([IDENTITY]);
    expect(() =>
      restarted.transition(IDENTITY, "owner-cleanup-required", "shared-state-committed"),
    ).toThrow("unsupported");
    restarted.remove(IDENTITY, ["owner-cleanup-required"]);
    expect(restarted.load(IDENTITY)).toBeNull();
  });

  it("recovers one durable cutover decision before journal replacement", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    store.create(journal);
    store.transition(IDENTITY, "staged", "cutover");
    const file = path.join(root, DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY, `${IDENTITY}.json`);
    fs.writeFileSync(`${file}.decision`, "rollback-authorized\n", { mode: 0o600 });

    expect(store.load(IDENTITY)?.phase).toBe("rollback-authorized");
    expect(parseDockerManagedBootstrapJournal(readPinnedPrivateFile(file).text).phase).toBe(
      "rollback-authorized",
    );
    fs.unlinkSync(`${file}.decision`);
    expect(store.load(IDENTITY)?.phase).toBe("rollback-authorized");
    expect(() => store.transition(IDENTITY, "cutover", "shared-state-committed")).toThrow(
      "expected phase cutover",
    );
    store.remove(IDENTITY, ["rollback-authorized"]);
  });

  it("reconciles an exclusive decision collision by typed durable authority", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    store.create(journal);
    store.transition(IDENTITY, "staged", "cutover");
    const target = path.join(
      root,
      DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY,
      `${IDENTITY}.json.decision`,
    );
    const link = vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
      fs.writeFileSync(target, "rollback-authorized\n", { flag: "wx", mode: 0o600 });
      throw Object.assign(new Error("exclusive decision collision"), { code: "EEXIST" });
    });
    try {
      expect(store.transition(IDENTITY, "cutover", "rollback-authorized").phase).toBe(
        "rollback-authorized",
      );
    } finally {
      link.mockRestore();
    }
  });

  it("preserves a primary journal write failure when temporary cleanup also fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    store.create(journal);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("primary journal rename failure");
    });
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw new Error("temporary cleanup failure");
    });
    try {
      expect(() => store.transition(IDENTITY, "staged", "cutover")).toThrow(
        "primary journal rename failure",
      );
    } finally {
      rename.mockRestore();
      unlink.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("refuses a symlink in place of journal authority", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    store.create(journal);
    const file = path.join(root, DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY, `${IDENTITY}.json`);
    const moved = `${file}.moved`;
    fs.renameSync(file, moved);
    fs.symlinkSync(moved, file);

    expect(() => store.load(IDENTITY)).toThrow("journal file ownership boundary is invalid");
  });

  it("rejects non-canonical authority", () => {
    expect(() =>
      parseDockerManagedBootstrapJournal(`${JSON.stringify({ ...journal, phase: "unknown" })}\n`),
    ).toThrow("phase is unsupported");
    expect(
      serializeDockerManagedBootstrapJournal(Object.freeze({ ...journal, phase: "staged" })),
    ).toBe(`${JSON.stringify(journal)}\n`);
  });

  it("compares equivalent receipts independent of property insertion order", () => {
    const preparation = journal.preparationReceipt;
    const reorderedPreparation = {
      recordedAt: preparation.recordedAt,
      recordId: preparation.recordId,
      authorityFingerprint: preparation.authorityFingerprint,
      bootstrapIdentity: preparation.bootstrapIdentity,
      sandbox: {
        driverId: preparation.sandbox.driverId,
        sandboxId: preparation.sandbox.sandboxId,
        sandboxName: preparation.sandbox.sandboxName,
      },
      schemaVersion: preparation.schemaVersion,
    } satisfies typeof preparation;
    expect(
      sameDockerManagedBootstrapReceipt("preparation", preparation, reorderedPreparation),
    ).toBe(true);

    const completion = finalization.commitReceipt;
    const reorderedCompletion = {
      completedAt: completion.completedAt,
      transactionPending: completion.transactionPending,
      bootstrapIdentity: completion.bootstrapIdentity,
      profileFingerprint: completion.profileFingerprint,
      replacementSpecHash: completion.replacementSpecHash,
      originalSpecHash: completion.originalSpecHash,
      runtimeImageContentId: completion.runtimeImageContentId,
      image: {
        manifestDigest: completion.image.manifestDigest,
        repository: completion.image.repository,
      },
      runtimeId: completion.runtimeId,
      sandbox: {
        driverId: completion.sandbox.driverId,
        sandboxId: completion.sandbox.sandboxId,
        sandboxName: completion.sandbox.sandboxName,
      },
      schemaVersion: completion.schemaVersion,
    } satisfies typeof completion;
    expect(sameDockerManagedBootstrapReceipt("completion", completion, reorderedCompletion)).toBe(
      true,
    );
  });

  it("reloads exact terminal receipts from a new journal store", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const first = createFileDockerManagedBootstrapJournalStore(root);
    first.create(journal);
    expect(loadUnfinished(first)).toEqual([journal]);

    first.recordFinalization(finalization);
    expect(loadUnfinished(first)).toEqual([journal]);
    first.remove(IDENTITY, ["staged"]);
    expect(loadUnfinished(first)).toEqual([]);
    const restarted = createFileDockerManagedBootstrapJournalStore(root);
    expect(restarted.loadFinalization(IDENTITY)).toEqual(finalization);
    expect(
      parseDockerManagedBootstrapFinalizationRecord(
        serializeDockerManagedBootstrapFinalizationRecord(finalization),
      ),
    ).toEqual(finalization);
    expect(() =>
      restarted.recordFinalization({
        ...finalization,
        cleanupReceipt: { ...finalization.cleanupReceipt, finalizedAt: "2026-07-31T20:00:02.000Z" },
      }),
    ).toThrow("finalization record changed");
    expect(() =>
      restarted.recordFinalization({
        ...finalization,
        phase: "rolled-back",
        commitReceipt: null,
        cleanupReceipt: { ...finalization.cleanupReceipt, outcome: "rolled-back" },
      }),
    ).toThrow("finalization record changed");
  });

  it.each([
    { label: "journal", suffix: "" },
    { label: "decision", suffix: ".decision" },
    { label: "finalization", suffix: ".finalized" },
  ])("ignores an atomic $label write left by a crash during enumeration", ({ suffix }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    store.create(journal);
    const directory = path.join(root, DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY);
    fs.writeFileSync(
      path.join(directory, `.${IDENTITY}.json${suffix}.1234.deadbeef.tmp`),
      "partial",
      {
        mode: 0o600,
      },
    );

    expect(loadUnfinished(store)).toEqual([journal]);
  });

  it("rejects an unsupported journal-directory entry during enumeration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    store.create(journal);
    const directory = path.join(root, DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY);
    fs.writeFileSync(path.join(directory, `${IDENTITY}.json.unknown`), "unexpected", {
      mode: 0o600,
    });

    expect(() => store.listUnfinishedIdentities()).toThrow(
      "journal directory contains an unsupported entry",
    );
  });

  it("reloads the exact completion receipt from a new journal store", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const first = createFileDockerManagedBootstrapJournalStore(root);
    first.create(journal);
    first.transition(IDENTITY, "staged", "cutover");
    const completed = first.recordCompletion(IDENTITY, finalization.commitReceipt);
    expect(completed.commitReceipt).toEqual(finalization.commitReceipt);

    const restarted = createFileDockerManagedBootstrapJournalStore(root);
    expect(restarted.recordCompletion(IDENTITY, finalization.commitReceipt)).toEqual(completed);
    expect(loadUnfinished(restarted)).toEqual([completed]);
    expect(() =>
      restarted.recordCompletion(IDENTITY, {
        ...finalization.commitReceipt,
        completedAt: "2026-07-31T20:00:02.000Z",
      }),
    ).toThrow("completion receipt changed");
  });

  it.each([
    [1, legacyJournalV1],
    [2, legacyJournalV2],
  ] as const)("fails typed and closed for exact legacy journal schema %i", (schemaVersion, legacy) => {
    const record = legacy();
    const serialized = `${JSON.stringify(record)}\n`;
    let failure: unknown;
    try {
      parseDockerManagedBootstrapJournal(serialized);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DockerManagedBootstrapLegacyRecordRequiresAgentError);
    expect(failure).toMatchObject({
      bootstrapIdentity: IDENTITY,
      journalContext: {
        schemaVersion,
        phase: record.phase,
        bootstrapIdentity: IDENTITY,
        providerId: record.sandbox.driverId,
        sandbox: record.sandbox,
        originalRuntimeId: record.originalRuntimeId,
        replacementRuntimeId: record.replacementRuntimeId,
      },
      recordKind: "journal",
      schemaVersion,
    });
    const legacyFailure = failure as DockerManagedBootstrapLegacyRecordRequiresAgentError;
    expect(Object.isFrozen(legacyFailure.journalContext)).toBe(true);
    expect(Object.isFrozen(legacyFailure.journalContext?.sandbox)).toBe(true);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    expect(loadUnfinished(store)).toEqual([]);
    const target = path.join(root, DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY, `${IDENTITY}.json`);
    fs.writeFileSync(target, serialized, { mode: 0o600 });
    expect(store.listUnfinishedIdentities()).toEqual([IDENTITY]);
    expect(() => store.load(IDENTITY)).toThrowError(
      DockerManagedBootstrapLegacyRecordRequiresAgentError,
    );
    expect(readPinnedPrivateFile(target).text).toBe(serialized);
  });

  it("does not classify a malformed legacy journal as upgradeable authority", () => {
    const malformed = { ...legacyJournalV2(), agent: "hermes" };
    expect(() => parseDockerManagedBootstrapJournal(`${JSON.stringify(malformed)}\n`)).toThrow(
      "legacy journal schema is invalid",
    );
    try {
      parseDockerManagedBootstrapJournal(`${JSON.stringify(malformed)}\n`);
    } catch (error) {
      expect(error).not.toBeInstanceOf(DockerManagedBootstrapLegacyRecordRequiresAgentError);
    }
  });

  it("rejects owner cleanup as authority invented by a legacy journal", () => {
    expect(() =>
      parseDockerManagedBootstrapJournal(
        `${JSON.stringify({ ...legacyJournalV2(), phase: "owner-cleanup-required" })}\n`,
      ),
    ).toThrow("legacy phase is unsupported");
  });

  it("upgrades legacy finalization only with exact immutable transaction context", () => {
    const serialized = `${JSON.stringify(legacyFinalizationV1())}\n`;
    let missingContextFailure: unknown;
    try {
      parseDockerManagedBootstrapFinalizationRecord(serialized);
    } catch (error) {
      missingContextFailure = error;
    }
    expect(missingContextFailure).toBeInstanceOf(
      DockerManagedBootstrapLegacyRecordRequiresAgentError,
    );
    expect(missingContextFailure).toMatchObject({ reason: "missing-context" });

    let contextMismatchFailure: unknown;
    try {
      parseDockerManagedBootstrapFinalizationRecord(serialized, {
        ...finalizationContext,
        planFingerprint: "0".repeat(64),
      });
    } catch (error) {
      contextMismatchFailure = error;
    }
    expect(contextMismatchFailure).toBeInstanceOf(
      DockerManagedBootstrapLegacyRecordRequiresAgentError,
    );
    expect(contextMismatchFailure).toMatchObject({
      message: expect.stringContaining("supplied durable context does not match this record"),
      reason: "context-mismatch",
    });
    expect(parseDockerManagedBootstrapFinalizationRecord(serialized, finalizationContext)).toEqual(
      finalization,
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    expect(loadUnfinished(store)).toEqual([]);
    const target = path.join(
      root,
      DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY,
      `${IDENTITY}.json.finalized`,
    );
    fs.writeFileSync(target, serialized, { mode: 0o600 });
    expect(() => store.loadFinalization(IDENTITY)).toThrowError(
      DockerManagedBootstrapLegacyRecordRequiresAgentError,
    );
    expect(() => store.recordFinalization(finalization)).toThrowError(
      DockerManagedBootstrapLegacyRecordRequiresAgentError,
    );
    expect(readPinnedPrivateFile(target).text).toBe(serialized);

    expect(() =>
      store.recordFinalization(finalization, {
        ...finalizationContext,
        agent: "openclaw",
      }),
    ).toThrow("does not match supplied durable context");
    expect(readPinnedPrivateFile(target).text).toBe(serialized);

    store.recordFinalization(finalization, finalizationContext);
    expect(store.loadFinalization(IDENTITY)).toEqual(finalization);
    expect(readPinnedPrivateFile(target).text).toBe(
      serializeDockerManagedBootstrapFinalizationRecord(finalization),
    );
  });

  it("rejects a current finalization that contradicts supplied durable context", () => {
    const wrongAgent = Object.freeze({ ...finalization, agent: "openclaw" as const });
    expect(() =>
      parseDockerManagedBootstrapFinalizationRecord(
        serializeDockerManagedBootstrapFinalizationRecord(wrongAgent),
        finalizationContext,
      ),
    ).toThrow("does not match supplied durable context");
  });

  it("does not create a finalization before validating durable context", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    expect(loadUnfinished(store)).toEqual([]);
    const target = path.join(
      root,
      DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY,
      `${IDENTITY}.json.finalized`,
    );

    expect(() =>
      store.recordFinalization(finalization, {
        ...finalizationContext,
        agent: "openclaw",
      }),
    ).toThrow("does not match supplied durable context");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("rejects current journal and finalization records stored under another identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    expect(loadUnfinished(store)).toEqual([]);
    const directory = path.join(root, DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY);
    const misplacedJournal = path.join(directory, `${OTHER_IDENTITY}.json`);
    const misplacedFinalization = `${misplacedJournal}.finalized`;
    fs.writeFileSync(misplacedJournal, serializeDockerManagedBootstrapJournal(journal), {
      mode: 0o600,
    });
    fs.writeFileSync(
      misplacedFinalization,
      serializeDockerManagedBootstrapFinalizationRecord(finalization),
      { mode: 0o600 },
    );

    expect(() => store.load(OTHER_IDENTITY)).toThrow(
      "journal bootstrap identity does not match its file name",
    );
    expect(() => store.loadFinalization(OTHER_IDENTITY)).toThrow(
      "finalization bootstrap identity does not match its file name",
    );
    fs.writeFileSync(misplacedJournal, `${JSON.stringify(legacyJournalV2())}\n`, {
      mode: 0o600,
    });
    expect(() => store.load(OTHER_IDENTITY)).toThrow(
      "journal bootstrap identity does not match its file name",
    );
    expect(fs.existsSync(misplacedJournal)).toBe(true);
    expect(fs.existsSync(misplacedFinalization)).toBe(true);
  });

  it("fails closed when enumeration encounters an unsupported state entry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const store = createFileDockerManagedBootstrapJournalStore(root);
    store.create(journal);
    fs.writeFileSync(
      path.join(root, DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY, "unexpected.json"),
      "{}\n",
      { mode: 0o600 },
    );
    expect(() => store.listUnfinishedIdentities()).toThrow("unsupported entry");
  });
});
