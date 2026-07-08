// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  advanceToReplacement,
  cleanupRebuildTransactionTests,
  expectCode,
  FP_D,
  intent,
  makeStore,
  preparedReceipts,
  SANDBOX,
} from "../../../test/helpers/rebuild-transaction-store";

import { type RebuildTransactionReceiptsV1, RebuildTransactionStore } from "./rebuild-transaction";

afterEach(cleanupRebuildTransactionTests);

describe("RebuildTransactionStore prepared refresh", () => {
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
});
