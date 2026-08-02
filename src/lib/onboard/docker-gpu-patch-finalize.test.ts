// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { DockerGpuPatchResult } from "./docker-gpu-patch";
import { finalizeDockerGpuPatchBackup } from "./docker-gpu-patch-finalize";

function deferredCreateResult(): DockerGpuPatchResult {
  return {
    applied: true,
    oldContainerId: "old-container-id",
    newContainerId: "new-container-id",
    originalName: "openshell-alpha",
    backupContainerName: "openshell-alpha-nemoclaw-gpu-backup-1780491860342",
    mode: {
      kind: "gpus",
      label: "--gpus all",
      device: "all",
      args: ["--gpus", "all"],
    },
    backupRemoved: false,
  };
}

describe("finalizeDockerGpuPatchBackup", () => {
  it("removes the backup container when supervisor reconnect succeeded", () => {
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const outcome = finalizeDockerGpuPatchBackup(
      { result: deferredCreateResult(), supervisorReady: true },
      { dockerRm },
    );
    expect(outcome).toEqual({ backupRemoved: true, rolledBack: false });
    expect(dockerRm).toHaveBeenCalledWith(
      "openshell-alpha-nemoclaw-gpu-backup-1780491860342",
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("rolls back to the backup container when supervisor reconnect failed", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const outcome = finalizeDockerGpuPatchBackup(
      { result: deferredCreateResult(), supervisorReady: false },
      { dockerStop, dockerRm, dockerRename, dockerStart },
    );
    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: true,
      replacementStopConfirmed: true,
      replacementRemovalConfirmed: true,
      replacementPresence: "absent",
    });
    expect(dockerStop).toHaveBeenCalledWith(
      "new-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRename).toHaveBeenCalledWith(
      "openshell-alpha-nemoclaw-gpu-backup-1780491860342",
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
  });

  it("reports rolledBack=false when restoring the backup fails", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({
      status: 1,
      stderr: "no such container",
    }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const outcome = finalizeDockerGpuPatchBackup(
      { result: deferredCreateResult(), supervisorReady: false },
      { dockerStop, dockerRm, dockerRename, dockerStart },
    );
    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStopConfirmed: true,
      replacementRemovalConfirmed: true,
      replacementPresence: "absent",
    });
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("does not report rollback success when restarting the backup has no exit status", () => {
    const outcome = finalizeDockerGpuPatchBackup(
      { result: deferredCreateResult(), supervisorReady: false },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: null, error: new Error("spawn timed out") })),
      },
    );

    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStopConfirmed: true,
      replacementRemovalConfirmed: true,
      replacementPresence: "absent",
    });
  });

  it("is a no-op when the backup was already removed by the patch helper", () => {
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const result = { ...deferredCreateResult(), backupRemoved: true };
    const outcome = finalizeDockerGpuPatchBackup({ result, supervisorReady: true }, { dockerRm });
    expect(outcome).toEqual({ backupRemoved: true, rolledBack: false });
    expect(dockerRm).not.toHaveBeenCalled();
  });

  it("reports backupRemoved=false when supervisor reconnect succeeded but docker rm of the backup failed", () => {
    const dockerRm = vi.fn((_name: string) => ({
      status: 1,
      stderr: "Error response from daemon: container is in use",
    }));
    const outcome = finalizeDockerGpuPatchBackup(
      { result: deferredCreateResult(), supervisorReady: true },
      { dockerRm },
    );
    expect(outcome).toEqual({ backupRemoved: false, rolledBack: false });
    expect(dockerRm).toHaveBeenCalledWith(
      "openshell-alpha-nemoclaw-gpu-backup-1780491860342",
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("fails closed when backup removal has no exit status", () => {
    const dockerRm = vi.fn((_name: string) => ({ status: null, stderr: "timed out" }));
    const outcome = finalizeDockerGpuPatchBackup(
      { result: deferredCreateResult(), supervisorReady: true },
      { dockerRm },
    );
    expect(outcome).toEqual({ backupRemoved: false, rolledBack: false });
  });

  it("records a remaining exact-ID replacement when removal fails (#7996)", () => {
    const newContainerId = "a".repeat(64);
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: { ...deferredCreateResult(), newContainerId },
        supervisorReady: false,
      },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 1 })),
        dockerRun: vi.fn(() => ({ status: 0, stdout: `${newContainerId}\n` })),
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: 0 })),
      },
    );

    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: true,
      replacementStopConfirmed: true,
      replacementRemovalConfirmed: false,
      replacementPresence: "present",
    });
  });

  it("records confirmed absence when exact-ID removal reports failure but listing is empty (#7996)", () => {
    const newContainerId = "b".repeat(64);
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: { ...deferredCreateResult(), newContainerId },
        supervisorReady: false,
      },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 1 })),
        dockerRun: vi.fn(() => ({ status: 0, stdout: "" })),
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: 0 })),
      },
    );

    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: true,
      replacementStopConfirmed: true,
      replacementRemovalConfirmed: false,
      replacementPresence: "absent",
    });
  });

  it("stops rollback before start when rename has no exit status", () => {
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const outcome = finalizeDockerGpuPatchBackup(
      { result: deferredCreateResult(), supervisorReady: false },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerRename: vi.fn(() => ({ status: null })),
        dockerStart,
      },
    );
    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStopConfirmed: true,
      replacementRemovalConfirmed: true,
      replacementPresence: "absent",
    });
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("fails closed when rollback start has no exit status", () => {
    const outcome = finalizeDockerGpuPatchBackup(
      { result: deferredCreateResult(), supervisorReady: false },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: null })),
      },
    );
    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStopConfirmed: true,
      replacementRemovalConfirmed: true,
      replacementPresence: "absent",
    });
  });
});
