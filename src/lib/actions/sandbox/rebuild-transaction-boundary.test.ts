// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-test-harness";
import { makePreparedRecoveryManifest } from "./rebuild-flow-test-fixtures";

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

  it("resumes a correlated replacement without creating or deleting again (#6436)", async () => {
    const interrupted = createRebuildFlowHarness();
    vi.spyOn(interrupted.transactionStore, "complete").mockRejectedValueOnce(
      new Error("simulated process interruption after replacement creation"),
    );
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("simulated process interruption after replacement creation");
    const interruptedRecord = interrupted.transactionStore.load("alpha");
    expect(interruptedRecord).toMatchObject({
      status: "active",
      phase: "replacement_created",
    });

    const resumed = createRebuildFlowHarness({
      sandboxEntry: { policyPresetsFinalized: true },
      sessionRebuildTransactionId: interruptedRecord?.transactionId,
      sessionRebuildImageFingerprint: interruptedRecord?.intent.target.imageFingerprint,
      sessionRebuildConfigurationFingerprint:
        interruptedRecord?.intent.target.configurationFingerprint,
    });
    resumed.runOpenshellSpy.mockClear();
    resumed.onboardSpy.mockClear();
    await resumed.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore: interrupted.transactionStore,
    });

    expect(resumed.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(resumed.onboardSpy, resumed.logSpy.mock.calls.flat().join("\n")).not.toHaveBeenCalled();
    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      status: "completed",
      phase: "completed",
    });
  });

  it("adopts a correlated replacement created before receipt publication (#6436)", async () => {
    const interrupted = createRebuildFlowHarness();
    const transition = interrupted.transactionStore.transition.bind(interrupted.transactionStore);
    const interruptedTransition = vi
      .spyOn(interrupted.transactionStore, "transition")
      .mockImplementation(async (sandboxName, revision, phase, receipts) => {
        if (phase === "replacement_created") {
          throw new Error("simulated process interruption before replacement receipt");
        }
        return transition(sandboxName, revision, phase, receipts);
      });
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("simulated process interruption before replacement receipt");
    const interruptedRecord = interrupted.transactionStore.load("alpha");
    expect(interruptedRecord).toMatchObject({ status: "active", phase: "old_deleted" });
    interruptedTransition.mockRestore();

    const resumed = createRebuildFlowHarness({
      sandboxEntry: {
        credentialEnv: null,
        observabilityEnabled: false,
        policyPresetsFinalized: true,
        toolDisclosure: "progressive",
      },
      sessionRebuildTransactionId: interruptedRecord?.transactionId,
      sessionRebuildImageFingerprint: interruptedRecord?.intent.target.imageFingerprint,
      sessionRebuildConfigurationFingerprint:
        interruptedRecord?.intent.target.configurationFingerprint,
    });
    resumed.onboardSpy.mockClear();
    resumed.runOpenshellSpy.mockClear();

    await resumed.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore: interrupted.transactionStore,
    });

    expect(resumed.onboardSpy).not.toHaveBeenCalled();
    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      status: "completed",
      phase: "completed",
      receipts: { replacement: expect.any(Object) },
    });
  });

  it("recreates a receipted replacement that is now absent (#6436)", async () => {
    const interrupted = createRebuildFlowHarness();
    vi.spyOn(interrupted.transactionStore, "complete").mockRejectedValueOnce(
      new Error("simulated process interruption after replacement creation"),
    );
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("simulated process interruption after replacement creation");
    const interruptedRecord = interrupted.transactionStore.load("alpha");

    const resumed = createRebuildFlowHarness({
      staleRecovery: true,
      sandboxEntry: { policyPresetsFinalized: true },
      sessionRebuildTransactionId: interruptedRecord?.transactionId,
      sessionRebuildImageFingerprint: interruptedRecord?.intent.target.imageFingerprint,
      sessionRebuildConfigurationFingerprint:
        interruptedRecord?.intent.target.configurationFingerprint,
    });
    resumed.onboardSpy.mockClear();
    resumed.runOpenshellSpy.mockClear();

    await resumed.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore: interrupted.transactionStore,
    });

    expect(resumed.onboardSpy).toHaveBeenCalledOnce();
    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      status: "completed",
      phase: "completed",
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

  it("keeps recovery guidance when failure-metadata persistence also fails", async () => {
    const harness = createRebuildFlowHarness({
      onboard: () => {
        throw new Error("simulated recreate failure");
      },
    });
    const failureWrite = vi
      .spyOn(harness.transactionStore, "recordFailure")
      .mockRejectedValueOnce(new Error("simulated journal write failure"));

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");

    expect(failureWrite).toHaveBeenCalledOnce();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain("Backup is preserved at:");
    expect(harness.transactionStore.load("alpha")).toMatchObject({
      status: "active",
      phase: "old_deleted",
      failure: null,
    });
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

  it("restores a missing registry row from durable recovery metadata", async () => {
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

    const resumed = createRebuildFlowHarness({
      staleRecovery: true,
      registryEntryMissing: true,
    });
    await resumed.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore: interrupted.transactionStore,
    });

    expect(resumed.restoreRebuildRegistryRecoveryIfMissingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ entry: expect.objectContaining({ name: "alpha" }) }),
    );
    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      status: "completed",
      phase: "completed",
    });
  });

  it("does not overwrite a replacement registry row during recovery", async () => {
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

    const resumed = createRebuildFlowHarness({
      staleRecovery: true,
      sandboxEntry: { model: "replacement-owner" },
    });
    await expect(
      resumed.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        transactionStore: interrupted.transactionStore,
      }),
    ).rejects.toThrow("Rebuild replacement recovery failed");

    expect(resumed.restoreRebuildRegistryRecoveryIfMissingSpy).not.toHaveBeenCalled();
    expect(resumed.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("resumes confirmed legacy recovery without the original process options", async () => {
    const interrupted = createRebuildFlowHarness({
      sandboxListOutput: "alpha Error",
      sandboxEntry: { nemoclawVersion: null },
      managedImageEvidence: false,
      onboard: () => {
        throw new Error("simulated process interruption");
      },
    });
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
        allowLegacyManagedImageRecovery: true,
      }),
    ).rejects.toThrow("Recreate failed");
    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      phase: "old_deleted",
      intent: { source: { legacyManagedImageRecoveryAuthorized: true } },
    });

    const resumed = createRebuildFlowHarness({
      staleRecovery: true,
      sandboxEntry: { nemoclawVersion: null },
      managedImageEvidence: false,
    });
    resumed.runOpenshellSpy.mockClear();
    await resumed.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore: interrupted.transactionStore,
    });

    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      phase: "completed",
      status: "completed",
    });
  });

  it("preserves original locked-shields guidance across a fresh resume", async () => {
    const interrupted = createRebuildFlowHarness({
      shieldsWasLocked: true,
      shieldsDown: false,
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
    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      intent: { source: { shieldsLocked: true } },
    });

    const resumed = createRebuildFlowHarness({ staleRecovery: true });
    resumed.logSpy.mockClear();
    await resumed.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore: interrupted.transactionStore,
    });
    expect(resumed.logSpy.mock.calls.flat().join("\n")).toContain(
      "Shields were previously enabled",
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
