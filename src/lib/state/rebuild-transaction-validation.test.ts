// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, describe, it } from "vitest";

import {
  advanceToReplacement,
  cleanupRebuildTransactionTests,
  deletedReceipts,
  expectCode,
  intent,
  makeStore,
  preparedReceipts,
  SANDBOX,
  writeRawRecord,
} from "../../../test/helpers/rebuild-transaction-store";
import { getRebuildTransactionPath } from "./rebuild-transaction";

afterEach(cleanupRebuildTransactionTests);

describe("RebuildTransactionStore validation", () => {
  it.each([
    "2026-07-08T00:00:00.000Z",
    "2026-07-08T00-00-00-000Z",
  ])("accepts the documented backup timestamp shape %s", async (manifestTimestamp) => {
    const { store } = makeStore();
    await store.create(intent(), {
      backup: { ...preparedReceipts().backup, manifestTimestamp },
    });
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
    ["transaction ID", (record: Record<string, unknown>) => (record.transactionId = "bad")],
    ["revision", (record: Record<string, unknown>) => (record.revision = -1)],
    ["phase/status", (record: Record<string, unknown>) => (record.status = "completed")],
    [
      "legacy recovery authorization",
      (record: Record<string, unknown>) => {
        const value = record.intent as Record<string, Record<string, unknown>>;
        value.source!.legacyManagedImageRecoveryAuthorized = "yes";
      },
    ],
    [
      "source shields posture",
      (record: Record<string, unknown>) => {
        const value = record.intent as Record<string, Record<string, unknown>>;
        value.source!.shieldsLocked = "yes";
      },
    ],
    [
      "registry recovery entry",
      (record: Record<string, unknown>) => {
        const value = record.intent as Record<string, Record<string, unknown>>;
        const recovery = value.source!.registryRecovery as Record<string, unknown>;
        recovery.entry = { name: "another-sandbox" };
      },
    ],
    [
      "registry default ownership revision",
      (record: Record<string, unknown>) => {
        const value = record.intent as Record<string, Record<string, unknown>>;
        const recovery = value.source!.registryRecovery as Record<string, unknown>;
        recovery.defaultSelectionRevision = -1;
      },
    ],
    [
      "credential environment variable",
      (record: Record<string, unknown>) => {
        const value = record.intent as Record<string, Record<string, unknown>>;
        value.target!.credentialEnv = "not-an-env-name";
      },
    ],
    ["timestamp", (record: Record<string, unknown>) => (record.updatedAt = "2026-07-08")],
    [
      "backup timestamp",
      (record: Record<string, unknown>) => {
        const receipts = record.receipts as Record<string, unknown>;
        (receipts.backup as Record<string, unknown>).manifestTimestamp = "2026-07-08T00:00:00Z";
      },
    ],
    [
      "old-sandbox deletion receipt",
      (record: Record<string, unknown>) => {
        (record.receipts as Record<string, unknown>).oldSandboxDeletion = "bad";
      },
    ],
    [
      "replacement receipt",
      (record: Record<string, unknown>) => {
        (record.receipts as Record<string, unknown>).replacement = "bad";
      },
    ],
  ])("rejects a malformed %s", async (_label, mutate) => {
    const { stateDir, store } = makeStore();
    await store.create(intent(), preparedReceipts());
    writeRawRecord(getRebuildTransactionPath(SANDBOX, stateDir), mutate);
    await expectCode(() => store.load(SANDBOX), "CORRUPT");
  });

  it("rejects replacement evidence timestamped before deletion", async () => {
    const { stateDir, store } = makeStore();
    await advanceToReplacement(store);
    writeRawRecord(getRebuildTransactionPath(SANDBOX, stateDir), (record) => {
      const receipts = record.receipts as Record<string, Record<string, unknown>>;
      receipts.replacement!.observedAt = "2026-07-08T00:00:30.000Z";
    });
    await expectCode(() => store.load(SANDBOX), "CORRUPT");
  });

  it("classifies malformed mutation arguments separately from corrupt state", async () => {
    const { store } = makeStore();
    await expectCode(
      () =>
        store.create(
          intent({ target: { ...intent().target, credentialEnv: "bad-name" } }),
          preparedReceipts(),
        ),
      "INVALID_INPUT",
    );
    const prepared = await store.create(intent(), preparedReceipts());
    await expectCode(
      () =>
        store.transition(SANDBOX, prepared.revision, "old_deleted", {
          ...deletedReceipts(),
          oldSandboxDeletion: { observedAt: "2026-07-08" },
        }),
      "INVALID_TRANSITION",
    );
    await expectCode(
      () =>
        store.recordFailure(SANDBOX, prepared.revision, {
          code: "bad-code",
          recordedAt: "2026-07-08T00:00:30.000Z",
          retryable: true,
        }),
      "INVALID_INPUT",
    );
  });
});
