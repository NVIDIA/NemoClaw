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

function exactDeferredCreateResult(): DockerGpuPatchResult {
  return {
    ...deferredCreateResult(),
    oldContainerId: "a".repeat(64),
    newContainerId: "b".repeat(64),
  };
}

function readyHandoffDeps() {
  return {
    runCaptureOpenshell: vi.fn(() => "alpha  2026-08-23 10:00:00  Ready\n"),
    runOpenshell: vi.fn((args: readonly string[]) =>
      args[1] === "list"
        ? { status: 0, stdout: "beta  2026-08-23 10:00:00  Ready\n" }
        : { status: 0 },
    ),
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
  it("retains both containers when final acknowledgement probes are unavailable (#9531)", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));

    expect(
      finalizeDockerGpuPatchBackup(
        {
          result: exactDeferredCreateResult(),
          supervisorReady: true,
          sandboxName: "alpha",
          finalHandoffTimeoutSecs: 60,
        },
        { dockerRm, dockerStart, dockerStop },
      ),
    ).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStoppedForCommit: false,
      finalHandoffAcknowledged: false,
      lastSandboxPhase: null,
    });
    expect(dockerStop).not.toHaveBeenCalled();
    expect(dockerRm).not.toHaveBeenCalled();
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("uses one exact stop, remove, start, and Ready acknowledgement handoff (#9531)", () => {
    const result = exactDeferredCreateResult();
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
    const runCaptureOpenshell = vi.fn(() => {
      events.push("observe ready");
      return "alpha  2026-08-23 10:00:00  Ready\n";
    });
    const runOpenshellResults = {
      exec: { event: "exec ready", result: { status: 0 } },
      list: {
        event: "observe lifecycle release",
        result: { status: 0, stdout: "beta  2026-08-23 10:00:00  Ready\n" },
      },
    } as const;
    const runOpenshell = vi.fn((args: readonly string[]) => {
      const response = runOpenshellResults[args[1] === "list" ? "list" : "exec"];
      events.push(response.event);
      return response.result;
    });
    const dockerResults = {
      ps: {
        event: "confirm sole replacement",
        result: { status: 0, stdout: `${result.newContainerId}\n` },
      },
      inspect: { event: "confirm running replacement", result: { status: 0, stdout: "true\n" } },
    } as const;
    const dockerRun = vi.fn((args: readonly string[]) => {
      const response = dockerResults[String(args[0]) as keyof typeof dockerResults];
      events.push(response.event);
      return response.result;
    });

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 60,
      },
      {
        dockerStop,
        dockerRm,
        dockerRun,
        dockerStart,
        runCaptureOpenshell,
        runOpenshell,
        sleep: vi.fn(),
      },
    );

    expect(outcome).toEqual({
      backupRemoved: true,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      lifecycleReleaseObserved: true,
      finalHandoffAcknowledged: true,
      lastSandboxPhase: "Ready",
    });
    expect(events).toEqual([
      "stop replacement",
      "remove backup",
      "observe lifecycle release",
      "start replacement",
      "observe ready",
      "exec ready",
      "confirm sole replacement",
      "confirm running replacement",
    ]);
    expect(dockerStop).toHaveBeenCalledWith(
      result.newContainerId,
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRm).toHaveBeenCalledWith(
      result.oldContainerId,
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStart).toHaveBeenCalledWith(
      result.newContainerId,
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("fails immediately when OpenShell reports Deleting after the final start (#9531)", () => {
    const result = exactDeferredCreateResult();
    const events: string[] = [];
    const sleep = vi.fn();
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 60,
      },
      {
        dockerStop: vi.fn(() => {
          events.push("stop replacement");
          return { status: 0 };
        }),
        dockerRm: vi.fn(() => {
          events.push("remove backup");
          return { status: 0 };
        }),
        dockerStart: vi.fn(() => {
          events.push("start replacement");
          return { status: 0 };
        }),
        runCaptureOpenshell: vi.fn(() => {
          events.push("observe deleting");
          return "alpha  2026-08-23 10:00:00  Deleting\n";
        }),
        runOpenshell: vi.fn((args: readonly string[]) =>
          args[1] === "list"
            ? { status: 0, stdout: "beta  2026-08-23 10:00:00  Ready\n" }
            : { status: 1 },
        ),
        dockerRun: vi.fn(() => ({ status: 0, stdout: `${result.newContainerId}\n` })),
        sleep,
      },
    );

    expect(outcome).toEqual({
      backupRemoved: true,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      lifecycleReleaseObserved: true,
      finalHandoffAcknowledged: false,
      lastSandboxPhase: "Deleting",
    });
    expect(events).toEqual([
      "stop replacement",
      "remove backup",
      "start replacement",
      "observe deleting",
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("accepts a retiring Error row only when the exact replacement has the OpenShell label (#9962)", () => {
    const result = exactDeferredCreateResult();
    const dockerRunResults = {
      inspect: { status: 0, stdout: "true\n" },
      ps: { status: 0, stdout: `${result.newContainerId}\n` },
    } as const;
    const dockerRun = vi.fn(
      (args: readonly string[]) =>
        dockerRunResults[String(args[0]) as keyof typeof dockerRunResults],
    );

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "restored-name",
        finalHandoffTimeoutSecs: 60,
      },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: 0 })),
        dockerRun,
        runCaptureOpenshell: vi.fn(() => "restored-name  2026-08-23 01:40:35  Ready\n"),
        runOpenshell: vi.fn((args: readonly string[]) =>
          args[1] === "list"
            ? { status: 0, stdout: "restored-name  2026-08-23 01:40:35  Error\n" }
            : { status: 0 },
        ),
        sleep: vi.fn(),
      },
    );

    expect(outcome).toMatchObject({
      backupRemoved: true,
      lifecycleReleaseObserved: true,
      finalHandoffAcknowledged: true,
    });
    expect(dockerRun.mock.calls[0]?.[0]).toEqual([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      "label=openshell.ai/sandbox-name=restored-name",
      "--format",
      "{{.ID}}",
    ]);
  });

  it.each([
    ["a failed query", { status: 1, stderr: "daemon unavailable" }],
    ["no labeled replacement", { status: 0, stdout: "" }],
    ["a different replacement", { status: 0, stdout: `${"c".repeat(64)}\n` }],
    [
      "multiple labeled replacements",
      { status: 0, stdout: `${"b".repeat(64)}\n${"c".repeat(64)}\n` },
    ],
  ])("rejects retiring Error when the canonical query returns %s (#9531)", (_case, query) => {
    const result = exactDeferredCreateResult();
    const dockerStart = vi.fn(() => ({ status: 0 }));

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 1,
      },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerRun: vi.fn(() => query),
        dockerStart,
        runCaptureOpenshell: vi.fn(() => "alpha  2026-08-23 01:40:35  Ready\n"),
        runOpenshell: vi.fn(() => ({
          status: 0,
          stdout: "alpha  2026-08-23 01:40:35  Error\n",
        })),
        sleep: vi.fn(),
      },
    );

    expect(outcome).toMatchObject({
      backupRemoved: true,
      lifecycleReleaseObserved: false,
      replacementRestarted: false,
    });
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
        finalHandoffTimeoutSecs: 60,
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
        finalHandoffTimeoutSecs: 60,
      },
      { dockerStop, dockerRm, dockerStart, ...readyHandoffDeps() },
    );
    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      finalHandoffAcknowledged: false,
      lastSandboxPhase: null,
    });
    expect(dockerRm).toHaveBeenCalledWith(
      "old-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStart).toHaveBeenCalledWith(
      "new-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
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
        finalHandoffTimeoutSecs: 60,
      },
      { dockerStop, dockerRm, dockerStart, ...readyHandoffDeps() },
    );
    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      finalHandoffAcknowledged: false,
      lastSandboxPhase: null,
    });
    expect(dockerStart).toHaveBeenCalledWith(
      "new-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
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
        finalHandoffTimeoutSecs: 60,
      },
      { dockerStop, dockerRm, dockerStart, ...readyHandoffDeps() },
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
        finalHandoffTimeoutSecs: 60,
      },
      {
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: 1 })),
        ...readyHandoffDeps(),
      },
    );

    expect(outcome).toEqual({
      backupRemoved: true,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: false,
      finalHandoffAcknowledged: false,
      lastSandboxPhase: null,
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
