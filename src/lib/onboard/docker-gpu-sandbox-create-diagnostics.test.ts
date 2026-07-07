// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DockerGpuPatchResult } from "./docker-gpu-patch";
import { createDockerGpuSandboxCreatePatch } from "./docker-gpu-sandbox-create";

const RESULT: DockerGpuPatchResult = {
  applied: true,
  oldContainerId: "old-container-id",
  newContainerId: "new-container-id",
  originalName: "openshell-alpha",
  backupContainerName: "backup-container",
  mode: {
    kind: "gpus",
    label: "--gpus all",
    device: "all",
    args: ["--gpus", "all"],
  },
  backupRemoved: false,
};

describe("Docker GPU create diagnostics fail-safety (#6110)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("still rolls back when pre-rollback diagnostic capture fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = {
      runOpenshell: vi.fn(() => ({ status: 0 })),
      runCaptureOpenshell: vi.fn(() => ""),
      sleep: vi.fn(),
      dockerCapture: vi.fn(() => ""),
    };
    const finalizeBackup = vi.fn(() => ({ backupRemoved: false, rolledBack: true }));
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      enabled: true,
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => RESULT),
        waitForSupervisor: vi.fn(() => false),
        capturePreRollbackDiagnostics: vi.fn(() => {
          throw new Error("disk full");
        }),
        finalizeBackup,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    patch.waitForSupervisorReconnectIfNeeded();

    expect(finalizeBackup).toHaveBeenCalledWith({ result: RESULT, supervisorReady: false }, deps);
    expect(onPatchFailureExit).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Could not capture the failed GPU container before rollback: disk full",
      ),
    );
  });

  it("captures before rollback when ensureApplied performs the recreate after create exits", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = {
      runOpenshell: vi.fn(() => ({ status: 0 })),
      runCaptureOpenshell: vi.fn(() => ""),
      sleep: vi.fn(),
      dockerCapture: vi.fn(() => ""),
    };
    const recreatePatch = vi.fn(() => RESULT);
    const waitForSupervisor = vi.fn(() => false);
    const capturePreRollbackDiagnostics = vi.fn(() => null);
    const finalizeBackup = vi.fn(() => ({ backupRemoved: false, rolledBack: true }));
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      enabled: true,
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        recreatePatch,
        waitForSupervisor,
        capturePreRollbackDiagnostics,
        finalizeBackup,
        onPatchFailureExit,
      },
    });

    patch.ensureApplied();
    patch.waitForSupervisorReconnectIfNeeded();

    expect(recreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ waitForSupervisor: false }),
      deps,
    );
    expect(capturePreRollbackDiagnostics).toHaveBeenCalledWith("alpha", RESULT, deps);
    expect(capturePreRollbackDiagnostics.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeBackup.mock.invocationCallOrder[0],
    );
    expect(finalizeBackup).toHaveBeenCalledWith({ result: RESULT, supervisorReady: false }, deps);
    expect(onPatchFailureExit).toHaveBeenCalledTimes(1);
  });
});
