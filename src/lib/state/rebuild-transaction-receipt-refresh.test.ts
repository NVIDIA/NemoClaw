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
  replacementReceipts,
  SANDBOX,
} from "../../../test/helpers/rebuild-transaction-store";

afterEach(cleanupRebuildTransactionTests);

describe("RebuildTransactionStore replacement receipt refresh", () => {
  it("requires an active replacement-created transaction", async () => {
    const { store } = makeStore();
    await expectCode(
      () => store.refreshReplacementReceipt(SANDBOX, 1, replacementReceipts().replacement!),
      "NOT_FOUND",
    );
    const prepared = await store.create(intent(), preparedReceipts());
    await expectCode(
      () =>
        store.refreshReplacementReceipt(
          SANDBOX,
          prepared.revision,
          replacementReceipts().replacement!,
        ),
      "INVALID_TRANSITION",
    );
  });

  it("replaces only the missing replacement's receipt before completion", async () => {
    const { store } = makeStore();
    const replacement = await advanceToReplacement(store);
    const refreshed = await store.refreshReplacementReceipt(SANDBOX, replacement.revision, {
      identityFingerprint: FP_D,
      observedAt: "2026-07-08T00:03:00.000Z",
    });

    expect(refreshed).toMatchObject({
      phase: "replacement_created",
      revision: replacement.revision + 1,
      receipts: {
        backup: replacement.receipts.backup,
        oldSandboxDeletion: replacement.receipts.oldSandboxDeletion,
        replacement: { identityFingerprint: FP_D },
      },
    });
    await expectCode(
      () =>
        store.refreshReplacementReceipt(
          SANDBOX,
          replacement.revision,
          refreshed.receipts.replacement!,
        ),
      "REVISION_CONFLICT",
    );
    await expect(store.complete(SANDBOX, refreshed.revision)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("refuses a compensated receipt that does not match the registered replacement", async () => {
    const { store } = makeStore(undefined, () => false);
    const replacement = await advanceToReplacement(store);

    await expectCode(
      () =>
        store.refreshReplacementReceipt(
          SANDBOX,
          replacement.revision,
          replacementReceipts().replacement!,
        ),
      "INVALID_TRANSITION",
    );
  });
});
