// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { collectDockerGpuPatchDiagnostics, type DockerGpuPatchResult } from "./docker-gpu-patch";
import {
  type DockerGpuPatchFinalizeOutcome,
  finalizeDockerGpuPatchBackup,
} from "./docker-gpu-patch-finalize";

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

function collectRollbackDiagnostics(
  newContainerId: string,
  outcome: DockerGpuPatchFinalizeOutcome,
): { cleanupCommands: string[]; cleanupDisposition: string; summary: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-finalize-"));
  try {
    const diagnostics = collectDockerGpuPatchDiagnostics(
      "alpha",
      {
        context: {
          sandboxName: "alpha",
          newContainerId,
          ...outcome,
        },
      },
      {
        dockerCapture: vi.fn(() => ""),
        dockerLogs: vi.fn(() => ""),
        homedir: () => tmpDir,
        now: () => new Date("2026-08-04T00:00:00Z"),
      },
    );
    return {
      cleanupCommands: diagnostics?.cleanupCommands ?? [],
      cleanupDisposition: diagnostics?.cleanupDisposition ?? "missing",
      summary: fs.readFileSync(path.join(diagnostics?.dir ?? "", "summary.txt"), "utf-8"),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("finalizeDockerGpuPatchBackup", () => {
  it("makes the replacement restart the final lifecycle event after removing the backup", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: deferredCreateResult(),
        supervisorReady: true,
        sandboxName: "alpha",
        lifecycleReleaseTimeoutSecs: 60,
      },
      {
        dockerStop,
        dockerRm,
        dockerStart,
        runOpenshell: vi.fn(() => ({ status: 0, stdout: "No sandboxes found.\n" })),
      },
    );
    expect(outcome).toEqual({
      backupRemoved: true,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      lifecycleReleaseObserved: true,
    });
    expect(dockerStop).toHaveBeenCalledWith(
      "new-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRm).toHaveBeenCalledWith(
      "openshell-alpha-nemoclaw-gpu-backup-1780491860342",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStart).toHaveBeenCalledWith(
      "new-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStop.mock.invocationCallOrder[0]).toBeLessThan(
      dockerRm.mock.invocationCallOrder[0],
    );
    expect(dockerRm.mock.invocationCallOrder[0]).toBeLessThan(
      dockerStart.mock.invocationCallOrder[0],
    );
  });

  it("waits for the sandbox name to disappear before restarting the replacement (#9531)", () => {
    const events: string[] = [];
    const dockerStop = vi.fn(() => {
      events.push("stop replacement");
      return { status: 0 };
    });
    const dockerRm = vi.fn(() => {
      events.push("remove backup");
      return { status: 0 };
    });
    const dockerStart = vi.fn(() => {
      events.push("start replacement");
      return { status: 0 };
    });
    const runOpenshell = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push("observe deleting");
        return { status: 0, stdout: "alpha  2026-08-21 05:53:16  Deleting\n" };
      })
      .mockImplementationOnce(() => {
        events.push("observe error");
        return { status: 0, stdout: "alpha  2026-08-21 05:53:18  Error\n" };
      })
      .mockImplementationOnce(() => {
        events.push("observe name absence");
        return { status: 0, stdout: "beta  2026-08-21 05:53:20  Ready\n" };
      });

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: deferredCreateResult(),
        supervisorReady: true,
        sandboxName: "alpha",
        lifecycleReleaseTimeoutSecs: 60,
      },
      { dockerStop, dockerRm, dockerStart, runOpenshell, sleep: vi.fn() },
    );

    expect(outcome).toMatchObject({
      backupRemoved: true,
      lifecycleReleaseObserved: true,
      replacementRestarted: true,
    });
    expect(events).toEqual([
      "stop replacement",
      "remove backup",
      "observe deleting",
      "observe error",
      "observe name absence",
      "start replacement",
    ]);
  });

  it("does not treat failed lifecycle probes as a release receipt (#9531)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "Error: gateway unavailable" })
      .mockReturnValueOnce({ status: 1, stderr: "gateway unavailable" });
    const dockerStart = vi.fn(() => ({ status: 0 }));

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: deferredCreateResult(),
        supervisorReady: true,
        sandboxName: "alpha",
        lifecycleReleaseTimeoutSecs: 1,
      },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerStart,
        runOpenshell,
        sleep: vi.fn(),
      },
    );

    expect(outcome).toMatchObject({
      backupRemoved: true,
      lifecycleReleaseObserved: false,
      replacementRestarted: false,
    });
    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(runOpenshell.mock.calls[0]?.[1]?.timeout).toBeGreaterThan(0);
    expect(runOpenshell.mock.calls[0]?.[1]?.timeout).toBeLessThanOrEqual(1000);
    expect(runOpenshell.mock.calls[1]?.[1]?.timeout).toBeGreaterThan(0);
    expect(runOpenshell.mock.calls[1]?.[1]?.timeout).toBeLessThanOrEqual(1000);
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("does not treat an unrelated terminal lifecycle phase as the stopped replacement (#9531)", () => {
    const runOpenshell = vi.fn(() => ({
      status: 0,
      stdout: "alpha  2026-08-21 05:53:18  Failed\n",
    }));

    const dockerStart = vi.fn(() => ({ status: 0 }));
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: deferredCreateResult(),
        supervisorReady: true,
        sandboxName: "alpha",
        lifecycleReleaseTimeoutSecs: 1,
      },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerStart,
        runOpenshell,
        sleep: vi.fn(),
      },
    );

    expect(outcome.lifecycleReleaseObserved).toBe(false);
    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(dockerStart).not.toHaveBeenCalled();
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
    const newContainerId = "e".repeat(64);
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({
      status: 1,
      stderr: "no such container",
    }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: { ...deferredCreateResult(), newContainerId },
        supervisorReady: false,
      },
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
    const diagnostics = collectRollbackDiagnostics(newContainerId, outcome);
    expect(diagnostics.cleanupDisposition).toBe("unknown");
    expect(diagnostics.cleanupCommands).toEqual([]);
    expect(diagnostics.summary).toContain("rolled_back=failed");
    expect(diagnostics.summary).not.toContain("openshell sandbox delete");
    expect(diagnostics.summary).not.toContain("docker rm -f");
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
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        lifecycleReleaseTimeoutSecs: 60,
      },
      { dockerRm },
    );
    expect(outcome).toEqual({ backupRemoved: true, rolledBack: false });
    expect(dockerRm).not.toHaveBeenCalled();
  });

  it("reports backupRemoved=false when supervisor reconnect succeeded but docker rm of the backup failed", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({
      status: 1,
      stderr: "Error response from daemon: container is in use",
    }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: deferredCreateResult(),
        supervisorReady: true,
        sandboxName: "alpha",
        lifecycleReleaseTimeoutSecs: 60,
      },
      { dockerStop, dockerRm, dockerStart },
    );
    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: false,
      lifecycleReleaseObserved: false,
    });
    expect(dockerRm).toHaveBeenCalledWith(
      "openshell-alpha-nemoclaw-gpu-backup-1780491860342",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("fails closed when backup removal has no exit status", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: null, stderr: "timed out" }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: deferredCreateResult(),
        supervisorReady: true,
        sandboxName: "alpha",
        lifecycleReleaseTimeoutSecs: 60,
      },
      { dockerStop, dockerRm, dockerStart },
    );
    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: false,
      lifecycleReleaseObserved: false,
    });
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("retains the backup when the replacement cannot be stopped for the final handoff", () => {
    const dockerStop = vi.fn(() => ({ status: 1 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: deferredCreateResult(),
        supervisorReady: true,
        sandboxName: "alpha",
        lifecycleReleaseTimeoutSecs: 60,
      },
      { dockerStop, dockerRm, dockerStart },
    );

    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStoppedForCommit: false,
    });
    expect(dockerRm).not.toHaveBeenCalled();
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("reports a failed replacement restart after the backup is removed", () => {
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: deferredCreateResult(),
        supervisorReady: true,
        sandboxName: "alpha",
        lifecycleReleaseTimeoutSecs: 60,
      },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: 1 })),
        runOpenshell: vi.fn(() => ({ status: 0, stdout: "No sandboxes found.\n" })),
      },
    );

    expect(outcome).toEqual({
      backupRemoved: true,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: false,
      lifecycleReleaseObserved: true,
    });
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

  it("retries a failed replacement observation before confirming absence (#7996)", () => {
    const newContainerId = "c".repeat(64);
    const dockerRun = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "daemon unavailable" })
      .mockReturnValueOnce({ status: 0, stdout: "" });
    const sleep = vi.fn();
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: { ...deferredCreateResult(), newContainerId },
        supervisorReady: false,
      },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 1 })),
        dockerRun,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: 0 })),
        sleep,
      },
    );

    expect(outcome.replacementPresence).toBe("absent");
    expect(dockerRun).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(0.5);
  });

  it("keeps replacement presence unknown after repeated daemon errors (#7996)", () => {
    const newContainerId = "d".repeat(64);
    const dockerRun = vi.fn(() => ({ status: 1, stderr: "daemon unavailable" }));
    const sleep = vi.fn();
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result: { ...deferredCreateResult(), newContainerId },
        supervisorReady: false,
      },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 1 })),
        dockerRun,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: 0 })),
        sleep,
      },
    );

    expect(outcome.replacementPresence).toBe("unknown");
    expect(dockerRun).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 0.5);
    expect(sleep).toHaveBeenNthCalledWith(2, 0.5);
    const diagnostics = collectRollbackDiagnostics(newContainerId, outcome);
    expect(diagnostics.cleanupDisposition).toBe("manual");
    expect(diagnostics.cleanupCommands).toEqual([`docker rm -f ${JSON.stringify(newContainerId)}`]);
    expect(diagnostics.summary).toContain("replacement_presence=unknown");
    expect(diagnostics.summary).toContain("cleanup_required=yes");
    expect(diagnostics.summary).not.toContain("openshell sandbox delete");
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
