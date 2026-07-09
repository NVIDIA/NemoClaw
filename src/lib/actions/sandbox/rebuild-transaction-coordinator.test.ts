// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  RebuildTransactionRecordV1,
  RebuildTransactionStore,
} from "../../state/rebuild-transaction";
import {
  RebuildTransactionCoordinator,
  type StartOrResumeRebuildTransactionInput,
} from "./rebuild-transaction-coordinator";
const entry = { name: "alpha", agent: "openclaw", imageTag: "source:latest" };
function record(phase: RebuildTransactionRecordV1["phase"]): RebuildTransactionRecordV1 {
  return {
    status: phase === "completed" ? "completed" : "active",
    phase,
    revision: 1,
    intent: { source: { registryRecovery: { entry } } },
    receipts: { backup: { manifestTimestamp: "old", manifestFingerprint: "old" } },
  } as RebuildTransactionRecordV1;
}
const input = {
  sandboxEntry: entry,
  registryRecovery: { entry, wasDefault: true, defaultSelectionRevision: 3 },
  targetConfig: {
    resumeConfig: { agent: "openclaw", provider: "nvidia", model: "nvidia/test-model" },
    durableConfig: { toolDisclosure: "progressive" },
  },
  recreateOptions: { targetGatewayName: "nemoclaw", targetGatewayPort: 18000 },
  backupManifest: { timestamp: "new" },
  baseImage: "source:latest",
  fromDockerfile: null,
  legacyManagedImageRecoveryAuthorized: false,
  shieldsLocked: false,
} as unknown as StartOrResumeRebuildTransactionInput;
describe("RebuildTransactionCoordinator startOrResume", () => {
  it.each([
    ["completed", false, "create", "prepared"],
    ["prepared", false, "refreshPrepared", "prepared"],
    ["prepared", true, "transition", "old_deleted"],
    ["old_deleted", true, null, "old_deleted"],
    ["replacement_created", true, null, "replacement_created"],
  ] as const)("owns %s generation and phase routing", async (phase, stale, operation, expected) => {
    const store = {
      create: vi.fn(async () => record("prepared")),
      refreshPrepared: vi.fn(async () => record("prepared")),
      transition: vi.fn(async () => record("old_deleted")),
    } as unknown as RebuildTransactionStore;
    const coordinator = new RebuildTransactionCoordinator(store, "alpha", record(phase));
    await coordinator.startOrResume({ ...input, staleRecovery: stale });

    expect(coordinator.phase).toBe(expected);
    for (const name of ["create", "refreshPrepared", "transition"] as const) {
      expect(store[name]).toHaveBeenCalledTimes(name === operation ? 1 : 0);
    }
  });
});
