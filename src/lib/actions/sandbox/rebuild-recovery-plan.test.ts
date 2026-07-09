// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { RebuildTransactionRecordV1 } from "../../state/rebuild-transaction";
import {
  publishAdoptedRebuildReplacement,
  publishCreatedRebuildReplacement,
  type RebuildRecoveryPlan,
  reconcileRebuildRecovery,
} from "./rebuild-recovery-plan";
import type { RebuildTransactionCoordinator } from "./rebuild-transaction-coordinator";

function deletedTransaction(): RebuildTransactionRecordV1 {
  return {
    status: "active",
    phase: "old_deleted",
    transactionId: "11111111-1111-4111-8111-111111111111",
    intent: {
      source: { registryRecovery: { entry: { name: "alpha" } } },
    },
  } as RebuildTransactionRecordV1;
}

describe("rebuild recovery plan orchestration", () => {
  it("does not observe or mutate state without a recoverable transaction", () => {
    const readRegistryEntry = vi.fn();
    const result = reconcileRebuildRecovery({
      transaction: null,
      live: "ready",
      readRegistryEntry,
      readSession: vi.fn(),
      restoreRegistry: vi.fn(),
    });

    expect(result).toEqual({ ok: true, plan: null });
    expect(readRegistryEntry).not.toHaveBeenCalled();
  });

  it("restores source metadata only for an absent old-deleted replacement", () => {
    const restoreRegistry = vi.fn(() => true);
    const result = reconcileRebuildRecovery({
      transaction: deletedTransaction(),
      live: "absent",
      readRegistryEntry: () => null,
      readSession: () => null,
      restoreRegistry,
    });

    expect(result).toMatchObject({
      ok: true,
      plan: { action: "create", replacementAlreadyPresent: false, registryRestored: true },
    });
    expect(restoreRegistry).toHaveBeenCalledOnce();
  });

  it("publishes adoption and compensation receipts through the coordinator", async () => {
    const coordinator = {
      markReplacementCreated: vi.fn(),
      markReplacementRecreated: vi.fn(),
    } as unknown as RebuildTransactionCoordinator;
    const replacement = { name: "alpha" };
    const adopt = {
      action: "adopt",
      replacementAlreadyPresent: true,
      registryRestored: false,
    } satisfies RebuildRecoveryPlan;
    const recreate = {
      ...adopt,
      action: "recreate",
      replacementAlreadyPresent: false,
    } satisfies RebuildRecoveryPlan;

    await publishAdoptedRebuildReplacement(
      adopt,
      coordinator,
      () => replacement,
      (message) => {
        throw new Error(message);
      },
    );
    await publishCreatedRebuildReplacement(recreate, coordinator, replacement);

    expect(coordinator.markReplacementCreated).toHaveBeenCalledWith(replacement);
    expect(coordinator.markReplacementRecreated).toHaveBeenCalledWith(replacement);
  });
});
