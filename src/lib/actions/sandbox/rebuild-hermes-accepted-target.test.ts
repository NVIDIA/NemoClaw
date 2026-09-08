// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const phaseMocks = vi.hoisted(() => ({
  clearPolicyHandoff: vi.fn(),
  clearRecoveryBackup: vi.fn(),
  cleanupPolicySource: vi.fn(),
  findRecoveryBackup: vi.fn(),
  isRecoveryCleanupOnly: vi.fn(),
  markRecoveryCleanupOnly: vi.fn(),
  openRecreateJournal: vi.fn(),
  recoverCronRestore: vi.fn(),
  enforceRemovedImmutabilityMigrationBoundary: vi.fn(),
  retireRemovedImmutabilityStateRecord: vi.fn(),
  runBackup: vi.fn(),
  runCronRestoreTransaction: vi.fn(),
  runDestroy: vi.fn(),
  runPostRestore: vi.fn(),
  runPreflight: vi.fn(),
  runRestore: vi.fn(),
}));

vi.mock("../../onboard/temp-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/temp-files")>()),
  cleanupTempDir: phaseMocks.cleanupPolicySource,
}));

vi.mock("../../state/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/sandbox")>()),
  clearRebuildPolicyHandoff: phaseMocks.clearPolicyHandoff,
}));
vi.mock("../../state/migrations/removed-immutability", () => ({
  enforceRemovedImmutabilityMigrationBoundary:
    phaseMocks.enforceRemovedImmutabilityMigrationBoundary,
  retireRemovedImmutabilityStateRecord: phaseMocks.retireRemovedImmutabilityStateRecord,
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
  isRebuildRecoveryCleanupOnly: phaseMocks.isRecoveryCleanupOnly,
  markRebuildRecoveryCleanupOnly: phaseMocks.markRecoveryCleanupOnly,
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

vi.mock("./rebuild-prepared-recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-prepared-recovery")>()),
  revalidatePreparedRecoveryBeforeDelete: (
    _sandboxName: unknown,
    _sandboxEntry: unknown,
    manifest: unknown,
    registrySnapshot: unknown,
  ) => ({ manifest, registrySnapshot }),
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    phaseMocks.clearPolicyHandoff.mockImplementation((manifest, options) =>
      options?.retainRetirement === true && manifest.rebuildPolicyHandoff
        ? Boolean(Object.assign(manifest.rebuildPolicyHandoff, { retired: true }))
        : Reflect.deleteProperty(manifest, "rebuildPolicyHandoff"),
    );
    phaseMocks.clearRecoveryBackup.mockImplementation(() => undefined);
    phaseMocks.recoverCronRestore.mockReturnValue("dispatch-reactivated");
    phaseMocks.findRecoveryBackup.mockReturnValue({
      backupPath: recoveryBackupPath,
      timestamp: "2026-08-28T00-00-00-000Z",
    });
    phaseMocks.isRecoveryCleanupOnly.mockReturnValue(false);
    phaseMocks.markRecoveryCleanupOnly.mockImplementation(() => undefined);
    phaseMocks.runRestore.mockReturnValue({ restoreSucceeded: true });
    phaseMocks.runPostRestore.mockResolvedValue({ mutableConfigPermissionsVerified: true });
    phaseMocks.retireRemovedImmutabilityStateRecord.mockReturnValue(true);
    phaseMocks.enforceRemovedImmutabilityMigrationBoundary.mockReturnValue({
      stateRecord: null,
      recoveryArtifacts: [],
    });
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
    phaseMocks.runBackup.mockReturnValue({
      backupManifest: {
        backupPath,
        backedUpDirs: ["cron"],
        preservedEnv: [],
        rebuildPolicyHandoff: { file: "current.yaml", sha256: "a".repeat(64) },
      },
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
      beginDelete: vi.fn(),
      confirmDeleted: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores accepted replacement state before reopening cron dispatch (#7806)", async () => {
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
      return { mutableConfigPermissionsVerified: true };
    });
    phaseMocks.enforceRemovedImmutabilityMigrationBoundary.mockReturnValue({
      stateRecord: "/tmp/shields-alpha.json",
      recoveryArtifacts: [],
    });
    phaseMocks.retireRemovedImmutabilityStateRecord.mockImplementation(() => {
      events.push("retire-removed-immutability");
      return true;
    });
    phaseMocks.clearRecoveryBackup.mockImplementation(() => events.push("clear-recovery"));

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(events).toEqual([
      "restore",
      "post-restore",
      "recover",
      "retire-removed-immutability",
      "clear-recovery",
      "complete",
    ]);
    expect(log).toHaveBeenCalledWith(
      "Hermes cron restore recovery for accepted replacement: dispatch-reactivated",
    );
    expect(phaseMocks.runDestroy).not.toHaveBeenCalled();
    expect(phaseMocks.runCronRestoreTransaction).not.toHaveBeenCalled();
    expect(phaseMocks.runPostRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        backupManifest: expect.objectContaining({ backupPath: recoveryBackupPath }),
        preparedBackupRecovery: true,
      }),
    );
    expect(phaseMocks.retireRemovedImmutabilityStateRecord).toHaveBeenCalledWith(
      "alpha",
      "mutable-rebuild",
    );
    expect(phaseMocks.clearPolicyHandoff).toHaveBeenCalledTimes(2);
    expect(phaseMocks.cleanupPolicySource).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("  Recovered the accepted replacement for 'alpha'.");
    expect(console.log).toHaveBeenCalledWith(`  Backup is preserved at: ${recoveryBackupPath}`);
  });

  it("retains removed Shields state when the rebuilt Hermes mutable posture is unverified", async () => {
    phaseMocks.enforceRemovedImmutabilityMigrationBoundary.mockReturnValue({
      stateRecord: "/tmp/shields-alpha.json",
      recoveryArtifacts: [],
    });
    phaseMocks.runPostRestore.mockResolvedValue({ mutableConfigPermissionsVerified: false });

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(bail).toHaveBeenCalledWith(
      "Removed Shields state was retained because the rebuilt sandbox's mutable config posture was not verified.",
    );
    expect(phaseMocks.retireRemovedImmutabilityStateRecord).not.toHaveBeenCalled();
    expect(completeAcceptedTarget).not.toHaveBeenCalled();
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
      policySourcePath,
    });
    phaseMocks.findRecoveryBackup.mockReturnValue(recoveryManifest);

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(phaseMocks.clearPolicyHandoff.mock.calls.map(([manifest]) => manifest)).toEqual([
      currentManifest,
      recoveryManifest,
      recoveryManifest,
    ]);
  });

  it("resumes cleanup without restoring the accepted replacement twice", async () => {
    const recoveryManifest = {
      backupPath: recoveryBackupPath,
      timestamp: "2026-08-28T00-00-00-000Z",
      rebuildPolicyHandoff: { file: "recovery.yaml", sha256: "b".repeat(64) },
    };
    phaseMocks.findRecoveryBackup.mockReturnValue(recoveryManifest);
    phaseMocks.clearRecoveryBackup.mockImplementationOnce(() => {
      throw new Error("marker cleanup denied");
    });

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(recoveryManifest).not.toHaveProperty("rebuildPolicyHandoff");
    expect(completeAcceptedTarget).not.toHaveBeenCalled();
    expect(bail).toHaveBeenCalledWith(
      "Recovered replacement cleanup is incomplete; the replacement journal was retained.",
    );
    expect(console.error).toHaveBeenCalledWith(
      "  Retry `nemoclaw alpha rebuild --yes`; the accepted replacement will not be restored again.",
    );

    const firstPreflight = await phaseMocks.runPreflight.mock.results[0]!.value;
    phaseMocks.runPreflight.mockResolvedValue({
      ...firstPreflight,
      recoveryManifest,
    });
    phaseMocks.clearRecoveryBackup.mockImplementation(() => undefined);
    phaseMocks.isRecoveryCleanupOnly.mockReturnValue(true);

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(phaseMocks.runRestore).toHaveBeenCalledOnce();
    expect(phaseMocks.runPostRestore).toHaveBeenCalledOnce();
    expect(phaseMocks.clearRecoveryBackup).toHaveBeenCalledTimes(2);
    expect(recoveryManifest).not.toHaveProperty("rebuildPolicyHandoff");
    expect(completeAcceptedTarget).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith("  Completed retained recovery cleanup for 'alpha'.");
  });

  it("retains cleanup authority when final policy-handoff cleanup fails", async () => {
    const recoveryManifest = {
      backupPath: recoveryBackupPath,
      timestamp: "2026-08-28T00-00-00-000Z",
      rebuildPolicyHandoff: { file: "recovery.yaml", sha256: "b".repeat(64) },
    };
    phaseMocks.findRecoveryBackup.mockReturnValue(recoveryManifest);
    phaseMocks.clearPolicyHandoff
      .mockImplementationOnce((manifest) =>
        Reflect.deleteProperty(manifest, "rebuildPolicyHandoff"),
      )
      .mockImplementationOnce((manifest) => {
        Object.assign(manifest.rebuildPolicyHandoff, { retired: true });
        return true;
      })
      .mockReturnValueOnce(false);

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(recoveryManifest.rebuildPolicyHandoff).toMatchObject({ retired: true });
    expect(phaseMocks.clearRecoveryBackup).not.toHaveBeenCalled();
    expect(completeAcceptedTarget).not.toHaveBeenCalled();
    expect(bail).toHaveBeenCalledWith(
      "Recovered replacement cleanup is incomplete; the recovery marker was retained.",
    );
    expect(console.error).toHaveBeenCalledWith(`  Backup is preserved at: ${recoveryBackupPath}`);
    expect(console.error).toHaveBeenCalledWith(
      "  Retry `nemoclaw alpha rebuild --yes`; the accepted replacement will not be restored again.",
    );

    const firstPreflight = await phaseMocks.runPreflight.mock.results[0]!.value;
    phaseMocks.runPreflight.mockResolvedValue({
      ...firstPreflight,
      recoveryManifest,
    });
    phaseMocks.clearPolicyHandoff.mockImplementation((manifest) =>
      Reflect.deleteProperty(manifest, "rebuildPolicyHandoff"),
    );

    await expect(
      rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(phaseMocks.runBackup).toHaveBeenCalledOnce();
    expect(phaseMocks.runRestore).toHaveBeenCalledOnce();
    expect(phaseMocks.runPostRestore).toHaveBeenCalledOnce();
    expect(phaseMocks.runDestroy).not.toHaveBeenCalled();
    expect(phaseMocks.clearRecoveryBackup).toHaveBeenCalledOnce();
    expect(recoveryManifest).not.toHaveProperty("rebuildPolicyHandoff");
    expect(completeAcceptedTarget).toHaveBeenCalledOnce();
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
