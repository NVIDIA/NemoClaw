// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const phaseMocks = vi.hoisted(() => ({
  clearPolicyHandoff: vi.fn(),
  clearRecoveryBackup: vi.fn(),
  cleanupPolicySource: vi.fn(),
  findRecoveryBackup: vi.fn(),
  openRecreateJournal: vi.fn(),
  recoverCronRestore: vi.fn(),
  runBackup: vi.fn(),
  runCronRestoreTransaction: vi.fn(),
  runDestroy: vi.fn(),
  runPostRestore: vi.fn(),
  runPreflight: vi.fn(),
  runRestore: vi.fn(),
  runShields: vi.fn(),
}));

vi.mock("../../onboard/temp-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/temp-files")>()),
  cleanupTempDir: phaseMocks.cleanupPolicySource,
}));

vi.mock("../../state/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/sandbox")>()),
  clearRebuildPolicyHandoff: phaseMocks.clearPolicyHandoff,
}));

const gatewayAuthority = {
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  mode: "nemoclaw-managed",
  source: "standalone",
  endpoint: null,
  stateDir: null,
  supervisor: null,
  requiredCapabilities: [],
} as const;

vi.mock("./rebuild-recreate-journal", () => ({
  clearRebuildRecoveryBackup: phaseMocks.clearRecoveryBackup,
  findRebuildRecoveryBackup: phaseMocks.findRecoveryBackup,
  fingerprintRebuildRecreateTargetIntent: () => "intent-1",
  openRebuildRecreateJournal: phaseMocks.openRecreateJournal,
  recordRebuildRecoveryBackup: vi.fn(),
}));

vi.mock("./rebuild-backup-phase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-backup-phase")>()),
  runRebuildBackupPhase: phaseMocks.runBackup,
}));

vi.mock("./rebuild-preflight-phase", () => ({
  finalizePreparedRebuildImageMessagingPlan: vi.fn(),
  runHermesCronRestoreBackupPreflight: () => ({ plan: null }),
  runRebuildPreflightPhase: phaseMocks.runPreflight,
}));

vi.mock("./rebuild-destroy-phase", () => ({
  runRebuildDestroyPhase: phaseMocks.runDestroy,
}));

vi.mock("./rebuild-shields-phase", () => ({
  runRebuildShieldsPhase: phaseMocks.runShields,
}));

vi.mock("./rebuild-restore-phase", () => ({
  runRebuildRestorePhase: phaseMocks.runRestore,
}));

vi.mock("./rebuild-post-restore-phase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-post-restore-phase")>()),
  recoverHermesCronRestore: phaseMocks.recoverCronRestore,
  runHermesCronRestoreTransaction: phaseMocks.runCronRestoreTransaction,
  runRebuildPostRestorePhase: phaseMocks.runPostRestore,
}));

import { rebuildSandbox } from "./rebuild";

describe("Hermes accepted replacement recovery", () => {
  const backupPath = "/tmp/nemoclaw-rebuild-backup";
  const recoveryBackupPath = "/tmp/nemoclaw-rebuild-backup-original";
  const policySourcePath = "/tmp/nemoclaw-rebuild-policy-test/policy.yaml";
  const bail = vi.fn();
  const cleanupDcodePreflight = vi.fn();
  const completeAcceptedTarget = vi.fn();
  const log = vi.fn();
  const releaseOnboardLock = vi.fn();
  const relockShields = vi.fn(() => true);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    phaseMocks.clearPolicyHandoff.mockImplementation((manifest) => {
      delete manifest.rebuildPolicyHandoff;
      return true;
    });
    phaseMocks.clearRecoveryBackup.mockImplementation(() => undefined);
    phaseMocks.recoverCronRestore.mockReturnValue("dispatch-reactivated");
    phaseMocks.findRecoveryBackup.mockReturnValue({
      backupPath: recoveryBackupPath,
      timestamp: "2026-08-28T00-00-00-000Z",
    });
    phaseMocks.runRestore.mockReturnValue({ restoreSucceeded: true });
    phaseMocks.runPostRestore.mockResolvedValue(undefined);
    phaseMocks.runPreflight.mockResolvedValue({
      sandboxEntry: { name: "alpha" },
      rebuildAgent: "hermes",
      versionCheck: {},
      targetConfig: {
        resumeConfig: {},
        sessionSnapshot: null,
        sessionMatchesSandbox: false,
        durableConfig: {
          dcodeAutoApprovalMode: null,
          toolDisclosure: null,
          webSearchConfig: null,
        },
        hermesToolGateways: [],
        hasHermesToolGateways: false,
        credentialEnv: null,
        fromDockerfile: null,
      },
      recreateOptions: {
        observabilityEnabled: false,
        targetGatewayName: "nemoclaw",
        targetGatewayPort: 8080,
        rebuildGatewayAuthority: gatewayAuthority,
      },
      messagingPlan: null,
      baseImagePreflight: null,
      liveState: { staleRecovery: false, staleRegistrySnapshot: null },
      recoveryManifest: null,
      dcodePreflight: {
        cleanup: cleanupDcodePreflight,
        revalidateBeforeDelete: vi.fn(async () => true),
      },
      preparedImage: null,
      routePreflightReceipt: {},
      releaseOnboardLock,
      log,
      bail,
    });
    phaseMocks.runShields.mockReturnValue({
      window: { relocked: false, wasLocked: false },
      staleSandboxWasLocked: false,
      relock: relockShields,
    });
    phaseMocks.runBackup.mockReturnValue({
      backupManifest: {
        backupPath,
        backedUpDirs: ["cron"],
        preservedEnv: [],
        rebuildPolicyHandoff: { file: "current.yaml", sha256: "a".repeat(64) },
      },
      backupWasForceSkipped: false,
      policySourcePath,
    });
    phaseMocks.openRecreateJournal.mockReturnValue({
      id: "journal-1",
      acceptedTarget: true,
      sourceConfirmedAbsent: true,
      gatewayAuthority,
      targetGeneration: "generation-1",
      targetIntentFingerprint: "intent-1",
      completeAcceptedTarget,
      markDeleting: vi.fn(),
      observeSourceForDelete: vi.fn(),
      confirmDeleted: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers a stranded cron gate without a current gate plan before accepting the replacement (#7806)", async () => {
    const events: string[] = [];
    phaseMocks.recoverCronRestore.mockImplementation(() => {
      events.push("recover");
      return "dispatch-reactivated";
    });
    completeAcceptedTarget.mockImplementation(() => events.push("complete"));
    phaseMocks.runRestore.mockImplementation(() => {
      events.push("restore");
      return { restoreSucceeded: true };
    });
    phaseMocks.runPostRestore.mockImplementation(async () => {
      events.push("post-restore");
    });
    phaseMocks.clearRecoveryBackup.mockImplementation(() => events.push("clear-recovery"));

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(events).toEqual(["recover", "restore", "post-restore", "clear-recovery", "complete"]);
    expect(log).toHaveBeenCalledWith(
      "Hermes cron restore recovery for accepted replacement: dispatch-reactivated",
    );
    expect(phaseMocks.runDestroy).not.toHaveBeenCalled();
    expect(phaseMocks.runCronRestoreTransaction).not.toHaveBeenCalled();
    expect(phaseMocks.runPostRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        backupManifest: expect.objectContaining({ backupPath: recoveryBackupPath }),
        preparedBackupRecovery: true,
        recoveryRecreate: true,
      }),
    );
    expect(phaseMocks.clearPolicyHandoff).toHaveBeenCalledOnce();
    expect(phaseMocks.cleanupPolicySource).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("  Recovered the accepted replacement for 'alpha'.");
    expect(console.log).toHaveBeenCalledWith(
      `  Backup is preserved at: ${recoveryBackupPath}`,
    );
  });

  it("retires both the unused current policy handoff and the recovered transaction handoff", async () => {
    const currentManifest = {
      backupPath,
      backedUpDirs: ["cron"],
      preservedEnv: [],
      rebuildPolicyHandoff: { file: "current.yaml", sha256: "a".repeat(64) },
    };
    const recoveryManifest = {
      backupPath: recoveryBackupPath,
      timestamp: "2026-08-28T00-00-00-000Z",
      rebuildPolicyHandoff: { file: "recovery.yaml", sha256: "b".repeat(64) },
    };
    phaseMocks.runBackup.mockReturnValue({
      backupManifest: currentManifest,
      backupWasForceSkipped: false,
      policySourcePath,
    });
    phaseMocks.findRecoveryBackup.mockReturnValue(recoveryManifest);

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(phaseMocks.clearPolicyHandoff.mock.calls.map(([manifest]) => manifest)).toEqual([
      currentManifest,
      recoveryManifest,
    ]);
  });

  it("reports an operator drain that remains after accepted replacement recovery (#7806)", async () => {
    phaseMocks.recoverCronRestore.mockReturnValue("operator-drain-preserved");

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(console.log).toHaveBeenCalledWith(
      "  Hermes cron restore gate cleared; the independent operator drain remains active.",
    );
    expect(completeAcceptedTarget).toHaveBeenCalledOnce();
  });

  it("retains the replacement journal when cron validation fails (#7806)", async () => {
    phaseMocks.recoverCronRestore.mockImplementation(() => {
      throw new Error("restored job script is missing");
    });

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(completeAcceptedTarget).not.toHaveBeenCalled();
    expect(bail).toHaveBeenCalledWith(
      "Hermes cron restore recovery failed; the replacement journal was retained.",
    );
    expect(console.error).toHaveBeenCalledWith(`  Backup is preserved at: ${backupPath}`);
    expect(console.error).toHaveBeenCalledWith(
      "  Correct the reported restore problem, then run `nemoclaw alpha recover`.",
    );
    expect(phaseMocks.runDestroy).not.toHaveBeenCalled();
    expect(phaseMocks.clearRecoveryBackup).not.toHaveBeenCalled();
  });

  it("retains the replacement journal when the accepted target lacks recovery control (#7806)", async () => {
    phaseMocks.recoverCronRestore.mockReturnValue("unsupported");

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(completeAcceptedTarget).not.toHaveBeenCalled();
    expect(bail).toHaveBeenCalledWith(
      "Hermes cron restore recovery is unavailable; the replacement journal was retained.",
    );
    expect(console.error).toHaveBeenCalledWith(
      "  The accepted Hermes replacement does not provide cron restore recovery.",
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("then run `nemoclaw alpha recover`"),
    );
    expect(phaseMocks.runDestroy).not.toHaveBeenCalled();
    expect(phaseMocks.clearRecoveryBackup).not.toHaveBeenCalled();
  });

  it("retains the replacement journal when its recovery backup is unavailable", async () => {
    phaseMocks.findRecoveryBackup.mockReturnValue(null);

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(bail).toHaveBeenCalledWith(
      "Replacement state restoration is incomplete; the replacement journal was retained.",
    );
    expect(completeAcceptedTarget).not.toHaveBeenCalled();
    expect(phaseMocks.runRestore).not.toHaveBeenCalled();
  });
});
