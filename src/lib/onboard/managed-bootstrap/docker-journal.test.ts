// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileDockerManagedBootstrapJournalStore,
  DOCKER_MANAGED_BOOTSTRAP_JOURNAL_DIRECTORY,
  DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  type DockerManagedBootstrapJournal,
  parseDockerManagedBootstrapJournal,
  serializeDockerManagedBootstrapJournal,
} from "./docker-journal";

const roots: string[] = [];
const IDENTITY = "1".repeat(64);
const journal = Object.freeze({
  schemaVersion: DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  phase: "staged",
  bootstrapIdentity: IDENTITY,
  sandbox: {
    sandboxName: "alpha",
    sandboxId: "sandbox-alpha",
    driverId: "docker",
  },
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
} satisfies DockerManagedBootstrapJournal);

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
});
