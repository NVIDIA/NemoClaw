// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makePreparedRecoveryManifest } from "./rebuild-flow-test-fixtures";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-test-harness";

installRebuildFlowTestHooks();

describe("rebuild transaction boundary", () => {
  it("completes the durable transaction only after restore succeeds", async () => {
    const harness = createRebuildFlowHarness();
    const createTransaction = vi.spyOn(harness.transactionStore, "create");

    await harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true });

    expect(createTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      harness.prepareMcpBridgesForRebuildSpy.mock.invocationCallOrder[0],
    );
    expect(createTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      harness.runOpenshellSpy.mock.invocationCallOrder.find((_order, index) => {
        const args = harness.runOpenshellSpy.mock.calls[index]?.[0] as string[];
        return args[0] === "sandbox" && args[1] === "delete";
      }) ?? Number.POSITIVE_INFINITY,
    );
    expect(harness.transactionStore.load("alpha")).toMatchObject({
      status: "completed",
      phase: "completed",
      failure: null,
      receipts: {
        backup: { manifestTimestamp: "2026-06-01T00:00:00.000Z" },
        oldSandboxDeletion: expect.any(Object),
        replacement: expect.any(Object),
      },
    });
  });

  it("does not create a transaction when backup fails", async () => {
    const harness = createRebuildFlowHarness({
      beforeBackup: () => {
        throw new Error("simulated backup failure");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("simulated backup failure");

    expect(harness.transactionStore.load("alpha")).toBeNull();
    expect(harness.prepareMcpBridgesForRebuildSpy).not.toHaveBeenCalled();
  });

  it("blocks an unrelated incomplete MCP destroy before backup", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        mcp: { bridges: {}, destroyPendingAt: "2026-07-08T00:00:00.000Z" },
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("incomplete MCP destroy transaction");

    expect(harness.transactionStore.load("alpha")).toBeNull();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("keeps an actionable old-deleted transaction when recreate fails", async () => {
    const harness = createRebuildFlowHarness({
      onboard: () => {
        throw new Error("simulated recreate failure");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.transactionStore.load("alpha")).toMatchObject({
      status: "active",
      phase: "old_deleted",
      failure: { code: "REPLACEMENT_RETRY_REQUIRED", retryable: true },
    });
    expect(harness.restoreSandboxEntrySpy).not.toHaveBeenCalled();
  });

  it("leaves a prepared transaction when delete fails after compensation", async () => {
    const harness = createRebuildFlowHarness({
      runOpenshell: (args) =>
        args[0] === "sandbox" && args[1] === "delete"
          ? { status: 7, output: "delete failed" }
          : { status: 0, output: "" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Failed to delete sandbox");

    expect(harness.transactionStore.load("alpha")).toMatchObject({
      status: "active",
      phase: "prepared",
    });
    expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).toHaveBeenCalledOnce();
  });

  it("takes a fresh backup before retrying a prepared transaction against a live sandbox", async () => {
    const manifest = makePreparedRecoveryManifest();
    const interrupted = createRebuildFlowHarness({
      runOpenshell: (args) =>
        args[0] === "sandbox" && args[1] === "delete"
          ? { status: 7, output: "delete failed" }
          : { status: 0, output: "" },
    });
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: manifest,
      }),
    ).rejects.toThrow("Failed to delete sandbox");

    const resumed = createRebuildFlowHarness();
    resumed.runOpenshellSpy.mockClear();
    await resumed.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore: interrupted.transactionStore,
    });

    const deleteCallOrder = resumed.runOpenshellSpy.mock.invocationCallOrder.find(
      (_order, index) => {
        const args = resumed.runOpenshellSpy.mock.calls[index]?.[0];
        return args?.[0] === "sandbox" && args[1] === "delete";
      },
    );
    expect(resumed.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(resumed.backupSandboxStateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      deleteCallOrder ?? Number.POSITIVE_INFINITY,
    );
    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      status: "completed",
      receipts: { backup: { manifestTimestamp: "2026-06-01T00:00:00.000Z" } },
    });
  });

  it("resumes old-deleted recovery in a fresh coordinator without deleting twice", async () => {
    const interrupted = createRebuildFlowHarness({
      staleRecovery: true,
      onboard: () => {
        throw new Error("simulated process interruption");
      },
    });
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Recreate failed");

    const resumed = createRebuildFlowHarness({ staleRecovery: true });
    await resumed.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore: interrupted.transactionStore,
    });

    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      status: "completed",
      phase: "completed",
    });
    expect(resumed.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("reconciles prepared state when a fresh coordinator observes deletion", async () => {
    const manifest = makePreparedRecoveryManifest();
    const interrupted = createRebuildFlowHarness({
      runOpenshell: (args) =>
        args[0] === "sandbox" && args[1] === "delete"
          ? { status: 7, output: "interrupted delete result" }
          : { status: 0, output: "" },
    });
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: manifest,
      }),
    ).rejects.toThrow("Failed to delete sandbox");

    const resumed = createRebuildFlowHarness({
      staleRecovery: true,
    });
    resumed.runOpenshellSpy.mockClear();
    await resumed.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore: interrupted.transactionStore,
    });

    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      status: "completed",
      phase: "completed",
    });
    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("reports mismatched journal recovery through the preflight error boundary", async () => {
    const interrupted = createRebuildFlowHarness({
      runOpenshell: (args) =>
        args[0] === "sandbox" && args[1] === "delete"
          ? { status: 7, output: "delete failed" }
          : { status: 0, output: "" },
    });
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Failed to delete sandbox");

    const resumed = createRebuildFlowHarness({
      preDeleteLatestManifest: {
        ...makePreparedRecoveryManifest(),
        timestamp: "2026-07-08T12-00-00-000Z",
      },
    });
    resumed.runOpenshellSpy.mockClear();
    await expect(
      resumed.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        transactionStore: interrupted.transactionStore,
      }),
    ).rejects.toThrow("Rebuild transaction recovery failed");

    expect(resumed.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("fails closed when resumed target intent drifts", async () => {
    const interrupted = createRebuildFlowHarness({
      staleRecovery: true,
      onboard: () => {
        throw new Error("simulated process interruption");
      },
    });
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Recreate failed");

    const resumed = createRebuildFlowHarness({ staleRecovery: true });
    resumed.runOpenshellSpy.mockClear();
    resumed.prepareMcpBridgesForAbsentSandboxRebuildSpy.mockClear();
    await expect(
      resumed.rebuildSandbox("alpha", ["--yes", "--tool-disclosure", "direct"], {
        throwOnError: true,
        transactionStore: interrupted.transactionStore,
      }),
    ).rejects.toThrow("intent changed");

    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      status: "active",
      phase: "old_deleted",
    });
    expect(resumed.prepareMcpBridgesForAbsentSandboxRebuildSpy).not.toHaveBeenCalled();
  });
});
