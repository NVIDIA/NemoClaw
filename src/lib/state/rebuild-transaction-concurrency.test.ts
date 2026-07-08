// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  advanceToReplacement,
  cleanupRebuildTransactionTests,
  deletedReceipts,
  intent,
  makeStore,
  preparedReceipts,
  SANDBOX,
} from "../../../test/helpers/rebuild-transaction-store";
import type { RebuildTransactionRecordV1, RebuildTransactionStore } from "./rebuild-transaction";

async function expectOneRevisionWinner(
  store: RebuildTransactionStore,
  operations: [Promise<RebuildTransactionRecordV1>, Promise<RebuildTransactionRecordV1>],
): Promise<void> {
  const results = await Promise.allSettled(operations);
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<RebuildTransactionRecordV1> =>
      result.status === "fulfilled",
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({ code: "REVISION_CONFLICT" });
  expect(store.load(SANDBOX)).toEqual(fulfilled[0]?.value);
}

afterEach(cleanupRebuildTransactionTests);

describe("RebuildTransactionStore concurrency", () => {
  it("serializes competing transitions before revision validation", async () => {
    const { store } = makeStore();
    const prepared = await store.create(intent(), preparedReceipts());

    await expectOneRevisionWinner(store, [
      store.transition(SANDBOX, prepared.revision, "old_deleted", deletedReceipts()),
      store.transition(SANDBOX, prepared.revision, "old_deleted", deletedReceipts()),
    ]);
  });

  it("serializes competing failure records before revision validation", async () => {
    const { store } = makeStore();
    const prepared = await store.create(intent(), preparedReceipts());
    const failure = (code: string) => ({
      code,
      recordedAt: "2026-07-08T00:00:30.000Z",
      retryable: true,
    });

    await expectOneRevisionWinner(store, [
      store.recordFailure(SANDBOX, prepared.revision, failure("FIRST_WRITER")),
      store.recordFailure(SANDBOX, prepared.revision, failure("SECOND_WRITER")),
    ]);
  });

  it("serializes competing completions before revision validation", async () => {
    const { store } = makeStore();
    const replacement = await advanceToReplacement(store);

    await expectOneRevisionWinner(store, [
      store.complete(SANDBOX, replacement.revision),
      store.complete(SANDBOX, replacement.revision),
    ]);
  });
});
