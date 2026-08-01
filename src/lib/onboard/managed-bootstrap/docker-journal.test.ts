// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileDockerManagedBootstrapJournalStore,
  DOCKER_MANAGED_BOOTSTRAP_FINALIZATION_SCHEMA_VERSION,
  DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY,
  DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  type DockerManagedBootstrapFinalizationRecord,
  type DockerManagedBootstrapJournal,
  parseDockerManagedBootstrapFinalizationRecord,
  parseDockerManagedBootstrapJournal,
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
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(parseDockerManagedBootstrapJournal(fs.readFileSync(file, "utf8"))).toEqual(journal);
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
    expect(parseDockerManagedBootstrapJournal(fs.readFileSync(file, "utf8")).phase).toBe(
      "rollback-authorized",
    );
    fs.unlinkSync(`${file}.decision`);
    expect(store.load(IDENTITY)?.phase).toBe("rollback-authorized");
    expect(() => store.transition(IDENTITY, "cutover", "shared-state-committed")).toThrow(
      "expected phase cutover",
    );
    store.remove(IDENTITY, ["rollback-authorized"]);
  });

  it("rejects non-canonical authority", () => {
    expect(() =>
      parseDockerManagedBootstrapJournal(`${JSON.stringify({ ...journal, phase: "unknown" })}\n`),
    ).toThrow("phase is unsupported");
    expect(
      serializeDockerManagedBootstrapJournal(Object.freeze({ ...journal, phase: "staged" })),
    ).toBe(`${JSON.stringify(journal)}\n`);
  });

  it("enumerates unfinished records and persists exact terminal receipts across restart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const first = createFileDockerManagedBootstrapJournalStore(root);
    first.create(journal);
    expect(first.listUnfinished()).toEqual([journal]);

    first.recordFinalization(finalization);
    expect(first.listUnfinished()).toEqual([]);
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
  });

  it("persists the exact completion receipt for restart reconstruction", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-journal-"));
    roots.push(root);
    const first = createFileDockerManagedBootstrapJournalStore(root);
    first.create(journal);
    first.transition(IDENTITY, "staged", "cutover");
    const completed = first.recordCompletion(IDENTITY, finalization.commitReceipt);
    expect(completed.commitReceipt).toEqual(finalization.commitReceipt);

    const restarted = createFileDockerManagedBootstrapJournalStore(root);
    expect(restarted.listUnfinished()).toEqual([completed]);
    expect(restarted.recordCompletion(IDENTITY, finalization.commitReceipt)).toEqual(completed);
    expect(() =>
      restarted.recordCompletion(IDENTITY, {
        ...finalization.commitReceipt,
        completedAt: "2026-07-31T20:00:02.000Z",
      }),
    ).toThrow("completion receipt changed");
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
    expect(() => store.listUnfinished()).toThrow("unsupported entry");
  });
});
