// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFilePodmanBootstrapJournalStore,
  normalizePodmanBootstrapJournal,
  PODMAN_BOOTSTRAP_JOURNAL_DIRECTORY,
  PODMAN_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  type PodmanBootstrapJournal,
  parsePodmanBootstrapJournal,
  serializePodmanBootstrapJournal,
} from "./podman-bootstrap-journal";

const BOOTSTRAP_IDENTITY = "1".repeat(64);
const ORIGINAL_RUNTIME_ID = "2".repeat(64);
const REPLACEMENT_RUNTIME_ID = "3".repeat(64);
const STATE_VOLUME_NAME = "openshell-sandbox-alpha-nemoclaw-bootstrap-state-111111111111";
const STATE_VOLUME_MOUNTPOINT = "/var/lib/containers/storage/volumes/bootstrap-state/_data";
const journal = Object.freeze({
  schemaVersion: PODMAN_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  phase: "preparing-replacement",
  bootstrapIdentity: BOOTSTRAP_IDENTITY,
  engineAuthorityId: `podman-sha256:${"4".repeat(64)}`,
  watcherLeaseId: "123e4567-e89b-42d3-a456-426614174000",
  sandboxName: "alpha",
  sandboxId: "sandbox-alpha",
  originalRuntimeId: ORIGINAL_RUNTIME_ID,
  originalContainerName: "openshell-sandbox-alpha",
  originalImageContentId: `sha256:${"5".repeat(64)}`,
  originalSpecFingerprint: "6".repeat(64),
  replacementStateVolumeName: STATE_VOLUME_NAME,
  replacementStateVolumeMountpoint: null,
  replacementRuntimeId: null,
  replacementStagingName: "openshell-sandbox-alpha-nemoclaw-bootstrap",
  replacementImageContentId: `sha256:${"7".repeat(64)}`,
  replacementSpecFingerprint: "8".repeat(64),
} satisfies PodmanBootstrapJournal);

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-bootstrap-journal-"));
  roots.push(root);
  return root;
}

function journalFile(root: string): string {
  return path.join(root, PODMAN_BOOTSTRAP_JOURNAL_DIRECTORY, `${BOOTSTRAP_IDENTITY}.json`);
}

function recordOriginalStopped(store: ReturnType<typeof createFilePodmanBootstrapJournalStore>) {
  store.create(journal);
  store.recordStateVolume(BOOTSTRAP_IDENTITY, STATE_VOLUME_MOUNTPOINT);
  store.recordReplacement(BOOTSTRAP_IDENTITY, REPLACEMENT_RUNTIME_ID);
  return store.recordOriginalStopped(BOOTSTRAP_IDENTITY);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("Podman bootstrap phase journal", () => {
  it("persists private canonical authority before replacement creation", () => {
    const root = temporaryRoot();
    const store = createFilePodmanBootstrapJournalStore(root);

    store.create(journal);

    const directory = path.join(root, PODMAN_BOOTSTRAP_JOURNAL_DIRECTORY);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(journalFile(root)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(journalFile(root), "utf8")).toBe(
      serializePodmanBootstrapJournal(journal),
    );
    expect(store.load(BOOTSTRAP_IDENTITY)).toEqual(journal);
    expect(store.listUnfinished()).toEqual([journal]);
    expect(() => store.create(journal)).toThrow("already exists");
  });

  it("records one exact replacement and original stop in monotonic order", () => {
    const store = createFilePodmanBootstrapJournalStore(temporaryRoot());
    store.create(journal);

    const volume = store.recordStateVolume(BOOTSTRAP_IDENTITY, STATE_VOLUME_MOUNTPOINT);
    expect(volume.phase).toBe("state-volume-created");
    expect(volume.replacementStateVolumeMountpoint).toBe(STATE_VOLUME_MOUNTPOINT);
    expect(store.recordStateVolume(BOOTSTRAP_IDENTITY, STATE_VOLUME_MOUNTPOINT)).toEqual(volume);
    expect(() =>
      store.recordStateVolume(BOOTSTRAP_IDENTITY, "/var/lib/containers/storage/other"),
    ).toThrow("changed for this bootstrap identity");

    const created = store.recordReplacement(BOOTSTRAP_IDENTITY, REPLACEMENT_RUNTIME_ID);
    expect(created.phase).toBe("replacement-created");
    expect(created.replacementRuntimeId).toBe(REPLACEMENT_RUNTIME_ID);
    expect(store.recordReplacement(BOOTSTRAP_IDENTITY, REPLACEMENT_RUNTIME_ID)).toEqual(created);
    expect(() => store.recordReplacement(BOOTSTRAP_IDENTITY, "9".repeat(64))).toThrow(
      "changed for this bootstrap identity",
    );

    const stopped = store.recordOriginalStopped(BOOTSTRAP_IDENTITY);
    expect(stopped.phase).toBe("original-stopped");
    expect(store.recordOriginalStopped(BOOTSTRAP_IDENTITY)).toEqual(stopped);
    expect(() => store.recordReplacement(BOOTSTRAP_IDENTITY, REPLACEMENT_RUNTIME_ID)).toThrow(
      "requires state-volume-created",
    );
  });

  it("makes rollback durable before runtime cleanup begins", () => {
    const root = temporaryRoot();
    const store = createFilePodmanBootstrapJournalStore(root);
    store.create(journal);
    store.recordStateVolume(BOOTSTRAP_IDENTITY, STATE_VOLUME_MOUNTPOINT);
    store.recordReplacement(BOOTSTRAP_IDENTITY, REPLACEMENT_RUNTIME_ID);

    const rollback = store.authorizeRollback(BOOTSTRAP_IDENTITY, ["replacement-created"]);

    expect(rollback.phase).toBe("rollback-authorized");
    expect(fs.readFileSync(`${journalFile(root)}.decision`, "utf8")).toBe("rollback-authorized\n");
    expect(store.authorizeRollback(BOOTSTRAP_IDENTITY, ["replacement-created"])).toEqual(rollback);
    store.removeAfterRollback(BOOTSTRAP_IDENTITY);
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
  });

  it("makes commit durable before original removal and compacts it idempotently", () => {
    const root = temporaryRoot();
    const store = createFilePodmanBootstrapJournalStore(root);
    recordOriginalStopped(store);

    const authorized = store.authorizeCommit(BOOTSTRAP_IDENTITY, ["original-stopped"]);
    expect(authorized.phase).toBe("commit-authorized");
    expect(fs.readFileSync(`${journalFile(root)}.decision`, "utf8")).toBe("commit-authorized\n");
    expect(store.recordCommitted(BOOTSTRAP_IDENTITY).phase).toBe("committed");

    // Simulate a crash after decision-file removal but before committed-journal
    // removal. The committed journal alone is sufficient terminal authority.
    fs.unlinkSync(`${journalFile(root)}.decision`);
    store.removeAfterCommit(BOOTSTRAP_IDENTITY);
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
  });

  it("recovers a commit decision that survived its journal acknowledgement", () => {
    const root = temporaryRoot();
    const store = createFilePodmanBootstrapJournalStore(root);
    recordOriginalStopped(store);
    fs.writeFileSync(`${journalFile(root)}.decision`, "commit-authorized\n", {
      flag: "wx",
      mode: 0o600,
    });

    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("commit-authorized");
  });

  it("recovers a rollback decision that survived its journal acknowledgement", () => {
    const root = temporaryRoot();
    const store = createFilePodmanBootstrapJournalStore(root);
    store.create(journal);
    store.recordStateVolume(BOOTSTRAP_IDENTITY, STATE_VOLUME_MOUNTPOINT);
    store.recordReplacement(BOOTSTRAP_IDENTITY, REPLACEMENT_RUNTIME_ID);
    fs.writeFileSync(`${journalFile(root)}.decision`, "rollback-authorized\n", {
      flag: "wx",
      mode: 0o600,
    });

    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("rollback-authorized");
    expect(parsePodmanBootstrapJournal(fs.readFileSync(journalFile(root), "utf8")).phase).toBe(
      "rollback-authorized",
    );
  });

  it("reconciles an exclusive rollback-decision collision", () => {
    const root = temporaryRoot();
    const store = createFilePodmanBootstrapJournalStore(root);
    store.create(journal);
    const target = `${journalFile(root)}.decision`;
    const originalLink = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync").mockImplementationOnce((source, destination) => {
      fs.writeFileSync(target, "rollback-authorized\n", { flag: "wx", mode: 0o600 });
      return originalLink(source, destination);
    });

    expect(store.authorizeRollback(BOOTSTRAP_IDENTITY, ["preparing-replacement"]).phase).toBe(
      "rollback-authorized",
    );
  });

  it("rejects an orphan rollback decision during recovery enumeration", () => {
    const root = temporaryRoot();
    const directory = path.join(root, PODMAN_BOOTSTRAP_JOURNAL_DIRECTORY);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(
      path.join(directory, `${BOOTSTRAP_IDENTITY}.json.decision`),
      "rollback-authorized\n",
      {
        mode: 0o600,
      },
    );

    expect(() => createFilePodmanBootstrapJournalStore(root).listUnfinished()).toThrow(
      "has no journal",
    );
  });

  it("rejects a symlinked journal before reading outside state", () => {
    const root = temporaryRoot();
    const directory = path.join(root, PODMAN_BOOTSTRAP_JOURNAL_DIRECTORY);
    const outside = path.join(root, "outside.json");
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(outside, serializePodmanBootstrapJournal(journal), { mode: 0o600 });
    fs.symlinkSync(outside, journalFile(root));

    expect(() => createFilePodmanBootstrapJournalStore(root).load(BOOTSTRAP_IDENTITY)).toThrow(
      "ownership boundary",
    );
  });

  it("rejects a future schema or an identity that does not match its phase", () => {
    expect(() => normalizePodmanBootstrapJournal({ ...journal, schemaVersion: 2 })).toThrow(
      "schema is invalid",
    );
    expect(() =>
      normalizePodmanBootstrapJournal({
        ...journal,
        phase: "replacement-created",
        replacementRuntimeId: null,
      }),
    ).toThrow("phase does not match");
    expect(() =>
      normalizePodmanBootstrapJournal({
        ...journal,
        engineAuthorityId: `docker-sha256:${"4".repeat(64)}`,
      }),
    ).toThrow("exact Podman authority");
  });

  it("rejects noncanonical or oversized serialized state", () => {
    expect(() => parsePodmanBootstrapJournal(JSON.stringify(journal))).toThrow("not canonical");
    expect(() => parsePodmanBootstrapJournal(`{\"value\":\"${"x".repeat(33 * 1024)}\"}\n`)).toThrow(
      "too large",
    );
  });
});
