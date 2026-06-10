// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { DockerGpuPatchResult } from "../../../dist/lib/onboard/docker-gpu-patch";
import { finalizeDockerGpuPatchBackup } from "../../../dist/lib/onboard/docker-gpu-patch-finalize";

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
    expect(outcome).toEqual({ backupRemoved: false, rolledBack: true });
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
    expect(outcome).toEqual({ backupRemoved: false, rolledBack: false });
    expect(dockerStart).not.toHaveBeenCalled();
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
});
