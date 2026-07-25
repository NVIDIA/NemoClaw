// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const phaseMocks = vi.hoisted(() => ({
  runBackup: vi.fn(),
  runDestroy: vi.fn(),
  runPreflight: vi.fn(),
  runShields: vi.fn(),
}));

vi.mock("./rebuild-backup-phase", () => ({
  runRebuildBackupPhase: phaseMocks.runBackup,
}));

vi.mock("./rebuild-preflight-phase", () => ({
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
  const relockShields = vi.fn(() => {
    rebuildWindow.relocked = true;
    return true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    rebuildWindow.relocked = false;
    phaseMocks.runPreflight.mockResolvedValue({
      sandboxEntry: { name: "alpha", customPolicies: [] },
      targetConfig: { durableConfig: { webSearchConfig: null } },
      recreateOptions: { observabilityEnabled: false },
      liveState: { staleRecovery: false, staleRegistrySnapshot: null },
      recoveryManifest: null,
      dcodePreflight: { cleanup: cleanupDcodePreflight },
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
  });

  it("relocks shields when an unexpected rebuild phase exception escapes after auto-unlock (#6245)", async () => {
    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      "unexpected backup exception",
    );

    expect(phaseMocks.runBackup).toHaveBeenCalledOnce();
    expect(relockShields).toHaveBeenCalledWith(true);
    expect(rebuildWindow.relocked).toBe(true);
  });

  it("blocks a pending baseline transition before shields, backup, or destroy phases begin (#7194)", async () => {
    const bail = vi.fn();
    phaseMocks.runPreflight.mockResolvedValue({
      sandboxEntry: {
        name: "alpha",
        customPolicies: [],
        baselineExclusionTransition: {
          id: "0b2f3297-a9ab-4c2f-80da-bf1760a1afbf",
          operation: "restore",
          exclusion: {
            version: 1,
            agent: "openclaw",
            key: "agents.openclaw.default",
            digest: "a".repeat(64),
          },
          startedAt: "2026-07-19T00:00:00.000Z",
          targetLiveDigest: "b".repeat(64),
        },
      },
      targetConfig: { durableConfig: { webSearchConfig: null } },
      recreateOptions: { observabilityEnabled: false },
      liveState: { staleRecovery: false, staleRegistrySnapshot: null },
      recoveryManifest: null,
      dcodePreflight: { cleanup: cleanupDcodePreflight },
      preparedImage: null,
      releaseOnboardLock,
      log: vi.fn(),
      bail,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await rebuildSandbox("alpha", ["--yes"], { throwOnError: true });

    expect(bail).toHaveBeenCalledWith(
      "Pending baseline policy restore for 'agents.openclaw.default' blocks rebuild.",
      1,
    );
    expect(phaseMocks.runShields).not.toHaveBeenCalled();
    expect(phaseMocks.runBackup).not.toHaveBeenCalled();
    expect(phaseMocks.runDestroy).not.toHaveBeenCalled();
    expect(cleanupDcodePreflight).toHaveBeenCalledOnce();
    expect(releaseOnboardLock).toHaveBeenCalledOnce();
  });
});
