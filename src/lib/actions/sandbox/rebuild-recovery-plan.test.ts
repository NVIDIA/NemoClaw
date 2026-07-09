// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { RebuildTransactionRecordV1 } from "../../state/rebuild-transaction";
import { prepareRebuildRecoveryPreflight } from "./rebuild-recovery";

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
  it("does not observe or mutate state without a recoverable transaction", async () => {
    const readRegistryEntry = vi.fn();
    const result = await prepareRebuildRecoveryPreflight({
      transaction: null,
      resolveLiveState: async () => ({ staleRecovery: false, observation: "ready" }),
      readRegistryEntry,
      readSession: vi.fn(),
      restoreRegistry: vi.fn(),
      log: vi.fn(),
      bail: (message) => {
        throw new Error(message);
      },
    });

    expect(result).toEqual({
      liveState: { staleRecovery: false, observation: "ready" },
      plan: null,
    });
    expect(readRegistryEntry).not.toHaveBeenCalled();
  });

  it("restores source metadata only for an absent old-deleted replacement", async () => {
    const restoreRegistry = vi.fn(() => true);
    const result = await prepareRebuildRecoveryPreflight({
      transaction: deletedTransaction(),
      resolveLiveState: async () => ({ staleRecovery: true, observation: "absent" }),
      readRegistryEntry: () => null,
      readSession: () => null,
      restoreRegistry,
      log: vi.fn(),
      bail: (message) => {
        throw new Error(message);
      },
    });

    expect(result).toMatchObject({
      plan: "create",
    });
    expect(restoreRegistry).toHaveBeenCalledOnce();
  });

  it("refuses mismatched observed state without restoring registry metadata", async () => {
    const restoreRegistry = vi.fn(() => true);

    await expect(
      prepareRebuildRecoveryPreflight({
        transaction: deletedTransaction(),
        resolveLiveState: async () => ({ staleRecovery: false, observation: "ready" }),
        readRegistryEntry: () => null,
        readSession: () => null,
        restoreRegistry,
        log: vi.fn(),
        bail: (message) => {
          throw new Error(message);
        },
      }),
    ).rejects.toThrow("Rebuild replacement recovery failed");
    expect(restoreRegistry).not.toHaveBeenCalled();
  });
});
