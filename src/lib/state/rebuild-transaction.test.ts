// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  advanceToReplacement,
  cleanupRebuildTransactionTests,
  deletedReceipts,
  expectCode,
  FP_A,
  FP_D,
  intent,
  makeStore,
  preparedReceipts,
  replacementReceipts,
  SANDBOX,
  tempDir,
  TRANSACTION_ID,
  writeRawRecord,
} from "../../../test/helpers/rebuild-transaction-store";

import {
  getRebuildTransactionPath,
  REBUILD_TRANSACTION_DIRNAME,
  type RebuildTransactionIntentV1,
  type RebuildTransactionReceiptsV1,
  RebuildTransactionStore,
} from "./rebuild-transaction";

afterEach(cleanupRebuildTransactionTests);

describe("RebuildTransactionStore", () => {
  it("round-trips the versioned prepared record with secure paths and permissions", async () => {
    const { stateDir, store } = makeStore();

    const created = await store.create(intent(), preparedReceipts());
    const filePath = getRebuildTransactionPath(SANDBOX, stateDir);

    expect(store.load(SANDBOX)).toEqual(created);
    expect(created).toMatchObject({
      version: 1,
      transactionId: TRANSACTION_ID,
      revision: 1,
      status: "active",
      phase: "prepared",
      failure: null,
      completedAt: null,
    });
    expect(path.basename(filePath)).not.toContain(SANDBOX);
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("returns null only when no transaction exists", async () => {
    const { store } = makeStore();
    expect(store.load(SANDBOX)).toBeNull();
  });

  it("reports NOT_FOUND for every mutation without a transaction", async () => {
    const { store } = makeStore();

    await expectCode(
      () => store.transition(SANDBOX, 1, "old_deleted", deletedReceipts()),
      "NOT_FOUND",
    );
    await expectCode(
      () =>
        store.recordFailure(SANDBOX, 1, {
          code: "MISSING",
          recordedAt: "2026-07-08T00:00:30.000Z",
          retryable: true,
        }),
      "NOT_FOUND",
    );
    await expectCode(() => store.complete(SANDBOX, 1), "NOT_FOUND");
  });

  it("advances every V1 phase with monotonic revisions and clears prior failures", async () => {
    const { store } = makeStore();
    const prepared = await store.create(intent(), preparedReceipts());
    const failed = await store.recordFailure(SANDBOX, prepared.revision, {
      code: "DELETE_RETRY_REQUIRED",
      recordedAt: "2026-07-08T00:00:30.000Z",
      retryable: true,
    });
    const deleted = await store.transition(
      SANDBOX,
      failed.revision,
      "old_deleted",
      deletedReceipts(),
    );
    const replacement = await store.transition(
      SANDBOX,
      deleted.revision,
      "replacement_created",
      replacementReceipts(),
    );
    const completed = await store.complete(SANDBOX, replacement.revision);

    expect([prepared.phase, deleted.phase, replacement.phase, completed.phase]).toEqual([
      "prepared",
      "old_deleted",
      "replacement_created",
      "completed",
    ]);
    expect([
      prepared.revision,
      failed.revision,
      deleted.revision,
      replacement.revision,
      completed.revision,
    ]).toEqual([1, 2, 3, 4, 5]);
    expect(deleted.failure).toBeNull();
    expect(completed).toMatchObject({ status: "completed", failure: null });
    expect(completed.completedAt).not.toBeNull();
    expect(store.load(SANDBOX)).toEqual(completed);
  });

  it("rejects stale revisions without overwriting the newer generation", async () => {
    const { store } = makeStore();
    const prepared = await store.create(intent(), preparedReceipts());
    const failed = await store.recordFailure(SANDBOX, prepared.revision, {
      code: "FIRST_WRITER",
      recordedAt: "2026-07-08T00:00:30.000Z",
      retryable: true,
    });

    await expectCode(
      () =>
        store.recordFailure(SANDBOX, prepared.revision, {
          code: "STALE_WRITER",
          recordedAt: "2026-07-08T00:00:31.000Z",
          retryable: true,
        }),
      "REVISION_CONFLICT",
    );
    expect(store.load(SANDBOX)).toEqual(failed);
  });

  it("allows only one active record per sandbox", async () => {
    const { store } = makeStore();
    const first = await store.create(intent(), preparedReceipts());

    await expectCode(() => store.create(intent(), preparedReceipts()), "ALREADY_EXISTS");
    expect(store.load(SANDBOX)).toEqual(first);
  });

  it("refreshes recovery inputs only while the old sandbox is still prepared", async () => {
    const { store } = makeStore();
    const prepared = await store.create(intent(), preparedReceipts());
    const refreshedReceipts: RebuildTransactionReceiptsV1 = {
      backup: {
        manifestTimestamp: "2026-07-08T00-00-30-000Z",
        manifestFingerprint: FP_D,
      },
    };

    const refreshed = await store.refreshPrepared(
      SANDBOX,
      prepared.revision,
      intent(),
      refreshedReceipts,
    );
    expect(refreshed).toMatchObject({
      transactionId: prepared.transactionId,
      phase: "prepared",
      revision: 2,
      receipts: refreshedReceipts,
    });
    const deleted = await store.transition(SANDBOX, refreshed.revision, "old_deleted", {
      ...refreshedReceipts,
      oldSandboxDeletion: { observedAt: "2026-07-08T00:01:00.000Z" },
    });
    await expectCode(
      () => store.refreshPrepared(SANDBOX, deleted.revision, intent(), preparedReceipts()),
      "INVALID_TRANSITION",
    );
  });

  it("starts a new transaction generation after the prior one completes", async () => {
    const { stateDir, store } = makeStore();
    const replacement = await advanceToReplacement(store);
    await store.complete(SANDBOX, replacement.revision);
    const nextStore = new RebuildTransactionStore({
      stateDir,
      transactionId: () => "22222222-2222-4222-8222-222222222222",
    });

    const next = await nextStore.create(intent(), preparedReceipts());

    expect(next).toMatchObject({
      transactionId: "22222222-2222-4222-8222-222222222222",
      revision: 1,
      status: "active",
      phase: "prepared",
    });
    expect(nextStore.load(SANDBOX)).toEqual(next);
  });

  it("makes completion idempotent without allowing a terminal record to become active", async () => {
    const { store } = makeStore();
    const replacement = await advanceToReplacement(store);
    const completed = await store.complete(SANDBOX, replacement.revision);

    expect(await store.complete(SANDBOX, completed.revision)).toEqual(completed);
    await expectCode(() => store.complete(SANDBOX, replacement.revision), "REVISION_CONFLICT");
    await expectCode(
      () =>
        store.transition(SANDBOX, completed.revision, "replacement_created", replacementReceipts()),
      "INVALID_TRANSITION",
    );
    expect(store.load(SANDBOX)).toEqual(completed);
  });

  it("persists a failure after deletion and clears it when replacement is observed", async () => {
    const { store } = makeStore();
    const prepared = await store.create(intent(), preparedReceipts());
    const deleted = await store.transition(
      SANDBOX,
      prepared.revision,
      "old_deleted",
      deletedReceipts(),
    );
    const failed = await store.recordFailure(SANDBOX, deleted.revision, {
      code: "REPLACEMENT_RETRY_REQUIRED",
      recordedAt: "2026-07-08T00:01:30.000Z",
      retryable: true,
    });

    expect(store.load(SANDBOX)).toEqual(failed);
    const replacement = await store.transition(
      SANDBOX,
      failed.revision,
      "replacement_created",
      replacementReceipts(),
    );
    expect(replacement.failure).toBeNull();
  });

  it("rejects skipped, reversed, and prematurely completed transitions", async () => {
    const { store } = makeStore();
    const prepared = await store.create(intent(), preparedReceipts());

    await expectCode(
      () =>
        store.transition(SANDBOX, prepared.revision, "replacement_created", replacementReceipts()),
      "INVALID_TRANSITION",
    );
    await expectCode(() => store.complete(SANDBOX, prepared.revision), "INVALID_TRANSITION");
    await expectCode(
      () => makeStore().store.create(intent(), replacementReceipts()),
      "INVALID_INPUT",
    );
  });

  it("does not allow a later phase to replace an existing receipt", async () => {
    const { store } = makeStore();
    const prepared = await store.create(intent(), preparedReceipts());
    const changedBackup: RebuildTransactionReceiptsV1 = {
      ...deletedReceipts(),
      backup: { ...preparedReceipts().backup, manifestFingerprint: FP_D },
    };

    await expectCode(
      () => store.transition(SANDBOX, prepared.revision, "old_deleted", changedBackup),
      "INVALID_TRANSITION",
    );
    expect(store.load(SANDBOX)).toEqual(prepared);
  });

  it("leaves the prior valid record when atomic replacement fails", async () => {
    const { stateDir, store } = makeStore();
    const prepared = await store.create(intent(), preparedReceipts());
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated rename failure"), {
        code: "EIO",
      });
    });

    await expect(
      store.transition(SANDBOX, prepared.revision, "old_deleted", deletedReceipts()),
    ).rejects.toThrow("simulated rename failure");

    expect(store.load(SANDBOX)).toEqual(prepared);
    const transactionDir = path.join(stateDir, REBUILD_TRANSACTION_DIRNAME);
    expect(fs.readdirSync(transactionDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("fails closed for malformed JSON and unknown future versions", async () => {
    const { stateDir, store } = makeStore();
    await store.create(intent(), preparedReceipts());
    const filePath = getRebuildTransactionPath(SANDBOX, stateDir);

    writeRawRecord(filePath, (record) => {
      record.version = 2;
    });
    await expectCode(() => store.load(SANDBOX), "UNSUPPORTED_VERSION");

    fs.writeFileSync(filePath, "{not-json", { mode: 0o600 });
    await expectCode(() => store.load(SANDBOX), "CORRUPT");
  });

  it.each([
    [
      "transaction ID",
      (record: Record<string, unknown>) => {
        record.transactionId = "not-a-uuid";
      },
    ],
    [
      "revision",
      (record: Record<string, unknown>) => {
        record.revision = -1;
      },
    ],
    [
      "phase/status",
      (record: Record<string, unknown>) => {
        record.status = "completed";
      },
    ],
    [
      "timestamp",
      (record: Record<string, unknown>) => {
        record.updatedAt = "yesterday";
      },
    ],
  ])("rejects a malformed %s", async (_label, mutate) => {
    const { stateDir, store } = makeStore();
    await store.create(intent(), preparedReceipts());
    writeRawRecord(getRebuildTransactionPath(SANDBOX, stateDir), mutate);
    await expectCode(() => store.load(SANDBOX), "CORRUPT");
  });

  it("rejects invalid and traversal-shaped sandbox names before path construction", async () => {
    const { stateDir, store } = makeStore();
    for (const name of ["../escape", "has/slash", "UPPER", "", "a".repeat(64)]) {
      await expectCode(() => store.load(name), "INVALID_INPUT");
      await expectCode(() => getRebuildTransactionPath(name, stateDir), "INVALID_INPUT");
    }
  });

  it("does not adopt a valid record stored under another sandbox key", async () => {
    const { stateDir, store } = makeStore();
    await store.create(intent(), preparedReceipts());
    const otherName = "other-sandbox";
    const otherPath = getRebuildTransactionPath(otherName, stateDir);
    fs.copyFileSync(getRebuildTransactionPath(SANDBOX, stateDir), otherPath);

    await expectCode(() => store.load(otherName), "CORRUPT");
  });

  it("rejects symlinked transaction directories and record files", async () => {
    const root = tempDir();
    // rejectSymlinksOnPath scopes user-controlled components beneath HOME.
    vi.stubEnv("HOME", root);
    const stateDir = path.join(root, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const attackerDir = path.join(root, "attacker");
    fs.mkdirSync(attackerDir);
    fs.symlinkSync(attackerDir, path.join(stateDir, REBUILD_TRANSACTION_DIRNAME));
    const store = makeStore(root).store;

    await expect(store.create(intent(), preparedReceipts())).rejects.toThrow(/symbolic link/);

    fs.unlinkSync(path.join(stateDir, REBUILD_TRANSACTION_DIRNAME));
    const created = await store.create(intent(), preparedReceipts());
    const filePath = getRebuildTransactionPath(SANDBOX, stateDir);
    fs.unlinkSync(filePath);
    const attackerFile = path.join(attackerDir, "record.json");
    fs.writeFileSync(attackerFile, JSON.stringify(created), { mode: 0o600 });
    fs.symlinkSync(attackerFile, filePath);

    await expectCode(() => store.load(SANDBOX), "CORRUPT");
  });

  it("normalizes allow-listed data and emits a redacted diagnostic projection", async () => {
    const { stateDir, store } = makeStore();
    const secret = "secret-sentinel-do-not-persist";
    const untrustedIntent = {
      ...intent(),
      token: secret,
      target: {
        ...intent().target,
        endpointUrl: `https://user:${secret}@example.test/v1`,
        environment: { NVIDIA_API_KEY: secret },
      },
    } as unknown as RebuildTransactionIntentV1;

    const record = await store.create(untrustedIntent, preparedReceipts());
    const serialized = fs.readFileSync(getRebuildTransactionPath(SANDBOX, stateDir), "utf8");
    const diagnostic = JSON.stringify(store.diagnostic(record));

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("endpointUrl");
    expect(serialized).not.toContain("environment");
    expect(diagnostic).not.toContain("NVIDIA_API_KEY");
    expect(diagnostic).not.toContain("provider");
    expect(store.diagnostic(record)).toMatchObject({
      sandboxName: SANDBOX,
      phase: "prepared",
      receipts: {
        backup: true,
        oldSandboxDeletion: false,
        replacement: false,
      },
    });
  });

  it("repairs loose state-directory and record permissions while loading", async () => {
    const { stateDir, store } = makeStore();
    await store.create(intent(), preparedReceipts());
    const filePath = getRebuildTransactionPath(SANDBOX, stateDir);
    fs.chmodSync(path.dirname(filePath), 0o755);
    fs.chmodSync(filePath, 0o644);

    expect(store.load(SANDBOX)).not.toBeNull();
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });
});
