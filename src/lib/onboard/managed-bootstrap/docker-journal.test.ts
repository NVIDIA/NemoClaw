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
  type DockerManagedBootstrapFinalizationRecord,
  type DockerManagedBootstrapJournal,
  parseDockerManagedBootstrapFinalizationRecord,
  parseDockerManagedBootstrapJournal,
  sameDockerManagedBootstrapReceipt,
  serializeDockerManagedBootstrapFinalizationRecord,
  serializeDockerManagedBootstrapJournal,
} from "./docker-journal";

const roots: string[] = [];
const IDENTITY = "1".repeat(64);
const journal = Object.freeze({
  schemaVersion: DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  phase: "staged",
  bootstrapIdentity: IDENTITY,
  providerId: "docker",
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

    first.recordFinalization(finalization);
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
    expect(() =>
      restarted.recordCompletion(IDENTITY, {
        ...finalization.commitReceipt,
        completedAt: "2026-07-31T20:00:02.000Z",
      }),
    ).toThrow("completion receipt changed");
  });
});
