// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  makeRebuildFlowSandboxEntry,
} from "../../../../test/helpers/rebuild-flow-test-harness";
import { fingerprintRebuildReplacement } from "../../rebuild-correlation";
import type { RebuildTransactionRecordV1 } from "../../state/rebuild-transaction";
import type { SandboxEntry } from "../../state/registry";
import { makePreparedRecoveryManifest } from "./rebuild-flow-test-fixtures";

installRebuildFlowTestHooks();

function correlationOverrides(
  transaction: RebuildTransactionRecordV1 | null,
  replacement: SandboxEntry,
) {
  return {
    sessionRebuildTransactionId: transaction?.transactionId,
    sessionRebuildImageFingerprint: transaction?.intent.target.imageFingerprint,
    sessionRebuildConfigurationFingerprint: transaction?.intent.target.configurationFingerprint,
    sessionRebuildReplacementFingerprint: fingerprintRebuildReplacement(replacement),
  };
}

async function interruptBeforeReplacementReceipt() {
  const interrupted = createRebuildFlowHarness();
  const transition = interrupted.transactionStore.transition.bind(interrupted.transactionStore);
  const interruptedTransition = vi
    .spyOn(interrupted.transactionStore, "transition")
    .mockImplementation((sandboxName, revision, phase, receipts) =>
      phase === "replacement_created"
        ? Promise.reject(new Error("simulated process interruption before replacement receipt"))
        : transition(sandboxName, revision, phase, receipts),
    );
  await expect(
    interrupted.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      recoveryManifest: makePreparedRecoveryManifest(),
    }),
  ).rejects.toThrow("simulated process interruption before replacement receipt");
  interruptedTransition.mockRestore();
  return {
    interrupted,
    transaction: interrupted.transactionStore.load("alpha"),
  };
}

async function interruptAfterReplacementReceipt() {
  const interrupted = createRebuildFlowHarness({
    onboardReplacementEntry: {
      credentialEnv: null,
      observabilityEnabled: false,
      toolDisclosure: "progressive",
    },
  });
  vi.spyOn(interrupted.transactionStore, "complete").mockRejectedValueOnce(
    new Error("simulated process interruption after replacement creation"),
  );
  await expect(
    interrupted.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      recoveryManifest: makePreparedRecoveryManifest(),
    }),
  ).rejects.toThrow("simulated process interruption after replacement creation");
  return {
    interrupted,
    transaction: interrupted.transactionStore.load("alpha"),
  };
}

describe("rebuild replacement recovery boundary", () => {
  it("resumes a correlated replacement without creating or deleting again (#6436)", async () => {
    const { interrupted, transaction } = await interruptAfterReplacementReceipt();
    expect(transaction).toMatchObject({ status: "active", phase: "replacement_created" });

    const replacement = makeRebuildFlowSandboxEntry({
      credentialEnv: null,
      observabilityEnabled: false,
      policyPresetsFinalized: true,
      toolDisclosure: "progressive",
    });
    const resumed = createRebuildFlowHarness({
      sandboxEntry: replacement,
      ...correlationOverrides(transaction, replacement as SandboxEntry),
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

  it("refuses a receipted replacement whose policy tier drifted (#6436)", async () => {
    const { interrupted, transaction } = await interruptAfterReplacementReceipt();
    const expected = makeRebuildFlowSandboxEntry({
      credentialEnv: null,
      observabilityEnabled: false,
      policyPresetsFinalized: true,
      toolDisclosure: "progressive",
    });
    const resumed = createRebuildFlowHarness({
      sandboxEntry: { ...expected, policyTier: "restricted" },
      ...correlationOverrides(transaction, expected as SandboxEntry),
    });
    resumed.onboardSpy.mockClear();
    resumed.runOpenshellSpy.mockClear();
    resumed.restoreSandboxStateSpy.mockClear();

    await expect(
      resumed.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        transactionStore: interrupted.transactionStore,
      }),
    ).rejects.toThrow("Rebuild replacement recovery failed");

    expect(resumed.restoreSandboxStateSpy).not.toHaveBeenCalled();
    expect(resumed.onboardSpy).not.toHaveBeenCalled();
    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(interrupted.transactionStore.load("alpha")).toMatchObject({
      status: "active",
      phase: "replacement_created",
    });
  });

  it("adopts a correlated replacement created before receipt publication (#6436)", async () => {
    const { interrupted, transaction } = await interruptBeforeReplacementReceipt();
    expect(transaction).toMatchObject({ status: "active", phase: "old_deleted" });
    const replacement = makeRebuildFlowSandboxEntry({
      credentialEnv: null,
      observabilityEnabled: false,
      policyPresetsFinalized: true,
      toolDisclosure: "progressive",
    });
    const resumed = createRebuildFlowHarness({
      sandboxEntry: replacement,
      ...correlationOverrides(transaction, replacement as SandboxEntry),
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

  it("refuses adoption when a correlated-looking replacement has image drift (#6436)", async () => {
    const { interrupted, transaction } = await interruptBeforeReplacementReceipt();
    const expected = makeRebuildFlowSandboxEntry({
      credentialEnv: null,
      observabilityEnabled: false,
      policyPresetsFinalized: true,
      toolDisclosure: "progressive",
    });
    const drifted = { ...expected, imageTag: "unrelated-image:latest" };
    const resumed = createRebuildFlowHarness({
      sandboxEntry: drifted,
      ...correlationOverrides(transaction, expected as SandboxEntry),
    });
    resumed.onboardSpy.mockClear();
    resumed.runOpenshellSpy.mockClear();

    await expect(
      resumed.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        transactionStore: interrupted.transactionStore,
      }),
    ).rejects.toThrow("Rebuild replacement recovery failed");

    expect(resumed.onboardSpy).not.toHaveBeenCalled();
    expect(resumed.restoreSandboxStateSpy).not.toHaveBeenCalled();
    expect(resumed.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    const retained = interrupted.transactionStore.load("alpha");
    expect(retained).toMatchObject({
      status: "active",
      phase: "old_deleted",
    });
    expect(retained?.receipts.replacement).toBeUndefined();
  });

  it("refreshes the receipt when an absent receipted replacement is recreated (#6436)", async () => {
    const { interrupted, transaction } = await interruptAfterReplacementReceipt();
    const replacement = makeRebuildFlowSandboxEntry({
      credentialEnv: null,
      observabilityEnabled: false,
      policyPresetsFinalized: true,
      toolDisclosure: "progressive",
    });
    const recreated = { ...replacement, imageTag: "nemoclaw-alpha:recreated" };
    const resumed = createRebuildFlowHarness({
      staleRecovery: true,
      sandboxEntry: replacement,
      onboardReplacementEntry: recreated,
      ...correlationOverrides(transaction, replacement as SandboxEntry),
    });
    resumed.onboardSpy.mockClear();
    resumed.runOpenshellSpy.mockClear();

    await resumed.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore: interrupted.transactionStore,
    });

    const completed = interrupted.transactionStore.load("alpha");
    expect(resumed.onboardSpy).toHaveBeenCalledOnce();
    expect(completed).toMatchObject({ status: "completed", phase: "completed" });
    expect(completed?.receipts.replacement?.identityFingerprint).toBe(
      fingerprintRebuildReplacement(recreated as SandboxEntry),
    );
    expect(completed?.receipts.replacement?.identityFingerprint).not.toBe(
      transaction?.receipts.replacement?.identityFingerprint,
    );
    expect((resumed.session.metadata as Record<string, unknown>).rebuild).toEqual({
      transactionId: transaction?.transactionId,
      imageFingerprint: transaction?.intent.target.imageFingerprint,
      configurationFingerprint: transaction?.intent.target.configurationFingerprint,
      replacementFingerprint: fingerprintRebuildReplacement(recreated as SandboxEntry),
    });
  }, 10_000);
});
