// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const phaseMocks = vi.hoisted(() => ({
  runBackup: vi.fn(),
  runDestroy: vi.fn(),
  runPreflight: vi.fn(),
  runShields: vi.fn(),
  openRecreateJournal: vi.fn(),
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
  fingerprintRebuildRecreateTargetIntent: () => "intent-1",
  openRebuildRecreateJournal: phaseMocks.openRecreateJournal,
}));

vi.mock("./rebuild-backup-phase", () => ({
  runRebuildBackupPhase: phaseMocks.runBackup,
}));

vi.mock("./rebuild-preflight-phase", () => ({
  runHermesCronRestoreBackupPreflight: () => ({ plan: null }),
  runRebuildPreflightPhase: phaseMocks.runPreflight,
}));

vi.mock("./rebuild-destroy-phase", () => ({
  runRebuildDestroyPhase: phaseMocks.runDestroy,
}));

vi.mock("./rebuild-shields-phase", () => ({
  runRebuildShieldsPhase: phaseMocks.runShields,
}));

import { rebuildSandbox } from "./rebuild";

describe("rebuild shields relock guard", () => {
  const rebuildWindow = { relocked: false, wasLocked: true };
  const cleanupDcodePreflight = vi.fn();
  const releaseOnboardLock = vi.fn();
  const revalidateDcodeBeforeDelete = vi.fn(async () => true);
  const relockShields = vi.fn(() => {
    rebuildWindow.relocked = true;
    return true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    rebuildWindow.relocked = false;
    phaseMocks.runPreflight.mockResolvedValue({
      sandboxEntry: { name: "alpha" },
      targetConfig: { durableConfig: { webSearchConfig: null } },
      recreateOptions: {
        observabilityEnabled: false,
        targetGatewayName: "nemoclaw",
        targetGatewayPort: 8080,
        rebuildGatewayAuthority: gatewayAuthority,
      },
      liveState: { staleRecovery: false, staleRegistrySnapshot: null },
      recoveryManifest: null,
      dcodePreflight: {
        cleanup: cleanupDcodePreflight,
        revalidateBeforeDelete: revalidateDcodeBeforeDelete,
      },
      preparedImage: null,
      releaseOnboardLock,
      log: vi.fn(),
      bail: vi.fn(),
    });
    phaseMocks.runShields.mockReturnValue({
      window: rebuildWindow,
      staleSandboxWasLocked: false,
      relock: relockShields,
    });
    phaseMocks.runBackup.mockImplementation(() => {
      throw new Error("unexpected backup exception");
    });
    phaseMocks.openRecreateJournal.mockReturnValue({
      id: "journal-1",
      gatewayAuthority,
      targetGeneration: "generation-1",
      targetIntentFingerprint: "intent-1",
      markDeleting: vi.fn(),
      confirmDeleted: vi.fn(),
    });
  });

  it("relocks shields when an unexpected rebuild phase exception escapes after auto-unlock (#6245)", async () => {
    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      "unexpected backup exception",
    );

    expect(phaseMocks.runBackup).toHaveBeenCalledOnce();
    expect(relockShields).toHaveBeenCalledWith(true);
    expect(rebuildWindow.relocked).toBe(true);
  });

  it("does not relock shields when sandbox deletion remains ambiguous (#7062)", async () => {
    phaseMocks.runBackup.mockReturnValue({ backupManifest: null });
    phaseMocks.runDestroy.mockImplementation(
      ({ onDeleteStateAmbiguous }: { onDeleteStateAmbiguous?: () => void }) => {
        onDeleteStateAmbiguous?.();
        throw new Error("Sandbox deletion could not be confirmed.");
      },
    );

    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      "Sandbox deletion could not be confirmed.",
    );

    expect(phaseMocks.runDestroy).toHaveBeenCalledOnce();
    expect(relockShields).not.toHaveBeenCalled();
    expect(rebuildWindow.relocked).toBe(false);
  });
});
