// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createDockerGpuInspectFixture as inspectFixture } from "./__test-helpers__/docker-gpu-patch-fixtures";
import { collectDockerGpuPatchDiagnostics, type DockerGpuPatchResult } from "./docker-gpu-patch";
import {
  type DockerGpuPatchFinalizeOutcome,
  finalizeDockerGpuPatchBackup,
} from "./docker-gpu-patch-finalize";

const ROLLBACK_IMAGE_ID = `sha256:${"d".repeat(64)}`;
const RESTORED_CONTAINER_ID = "e".repeat(64);
const ROLLBACK_TEST_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "nemoclaw-docker-gpu-rollback-record-"),
);

afterAll(() => {
  fs.rmSync(ROLLBACK_TEST_ROOT, { recursive: true, force: true });
});

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

function rollbackPlanDeps(result: DockerGpuPatchResult = exactDeferredCreateResult()) {
  const homeDir = fs.mkdtempSync(path.join(ROLLBACK_TEST_ROOT, "case-"));
  const inspect = inspectFixture();
  inspect.Config = {
    ...inspect.Config,
    Env: [...(inspect.Config?.Env ?? []), "ROLLBACK_TEST_TOKEN=super-secret-value"],
  };
  return {
    dockerCapture: vi.fn(() => JSON.stringify([{ ...inspect, Id: result.oldContainerId }])),
    dockerRun: vi.fn((args: readonly string[]) => {
      switch (args[0]) {
        case "commit":
          return { status: 0, stdout: `${ROLLBACK_IMAGE_ID}\n` };
        case "image":
          return { status: 0 };
        case "ps":
          return { status: 0, stdout: `${result.newContainerId}\n` };
        case "inspect":
          return { status: 0, stdout: "true\n" };
        default:
          return { status: 1, stderr: "unexpected Docker command" };
      }
    }),
    dockerRunDetached: vi.fn((_args: readonly string[]) => ({
      status: 0,
      stdout: `${RESTORED_CONTAINER_ID}\n`,
      stderr: "",
    })),
    homedir: () => homeDir,
  };
}

function rollbackRecordFiles(homeDir: string): string[] {
  const directory = path.join(homeDir, ".nemoclaw", "recovery", "docker-gpu");
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).map((entry) => path.join(directory, entry))
    : [];
}

function readyHandoffDeps() {
  return {
    ...rollbackPlanDeps(),
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
    const rollbackDeps = rollbackPlanDeps(result);
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
      switch (args[0]) {
        case "commit":
          events.push("commit rollback image");
          return rollbackDeps.dockerRun(args);
        case "image":
          events.push("remove rollback image");
          return rollbackDeps.dockerRun(args);
        default: {
          const response = dockerResults[String(args[0]) as keyof typeof dockerResults];
          events.push(response.event);
          return response.result;
        }
      }
    });

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 60,
      },
      {
        dockerCapture: rollbackDeps.dockerCapture,
        dockerStop,
        dockerRm,
        dockerRun,
        dockerRunDetached: rollbackDeps.dockerRunDetached,
        dockerStart,
        runCaptureOpenshell,
        runOpenshell,
        sleep: vi.fn(),
      },
    );

    expect(outcome).toEqual({
      backupRemoved: true,
      rolledBack: false,
      rollbackImageRemoved: true,
      rollbackRecordRemoved: true,
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      lifecycleReleaseObserved: true,
      finalHandoffAcknowledged: true,
      lastSandboxPhase: "Ready",
    });
    expect(rollbackRecordFiles(rollbackDeps.homedir())).toEqual([]);
    expect(events).toEqual([
      "stop replacement",
      "commit rollback image",
      "remove backup",
      "observe lifecycle release",
      "start replacement",
      "observe ready",
      "exec ready",
      "confirm sole replacement",
      "confirm running replacement",
      "remove rollback image",
    ]);
    expect(dockerStop).toHaveBeenCalledWith(
      result.newContainerId,
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRm).toHaveBeenCalledWith(
      result.oldContainerId,
      expect.objectContaining({ ignoreError: true }),
    );
    const commitCall = dockerRun.mock.calls.findIndex((call) => call[0][0] === "commit");
    expect(commitCall).toBeGreaterThanOrEqual(0);
    expect(dockerRun.mock.invocationCallOrder[commitCall]).toBeLessThan(
      dockerRm.mock.invocationCallOrder[0],
    );
    expect(dockerStart).toHaveBeenCalledWith(
      result.newContainerId,
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("restores the prior container when OpenShell reports Deleting after final start (#9531)", () => {
    const result = exactDeferredCreateResult();
    const rollbackDeps = rollbackPlanDeps(result);
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
        dockerCapture: rollbackDeps.dockerCapture,
        dockerStop: vi.fn(() => {
          events.push("stop replacement");
          return { status: 0 };
        }),
        dockerRm: vi.fn((target: string) => {
          events.push(target === result.oldContainerId ? "remove backup" : "remove replacement");
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
        dockerRun: rollbackDeps.dockerRun,
        dockerRunDetached: rollbackDeps.dockerRunDetached,
        sleep,
      },
    );

    expect(outcome).toEqual({
      backupRemoved: true,
      rolledBack: true,
      rollbackImageId: ROLLBACK_IMAGE_ID,
      rollbackImageRemoved: false,
      rollbackRecordRemoved: true,
      replacementStopConfirmed: true,
      replacementRemovalConfirmed: true,
      replacementPresence: "absent",
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
      "stop replacement",
      "remove replacement",
    ]);
    expect(sleep).not.toHaveBeenCalled();
    expect(rollbackDeps.dockerRunDetached).toHaveBeenCalledOnce();
    expect(rollbackDeps.dockerRunDetached.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "--name",
        "openshell-alpha",
        "--label",
        "openshell.ai/managed-by=openshell",
        "--label",
        "openshell.ai/sandbox-name=alpha",
        "--volume",
        "/host:/container:rw",
        ROLLBACK_IMAGE_ID,
      ]),
    );
    expect(rollbackDeps.dockerRunDetached.mock.calls[0]?.[0]).not.toContain("--gpus");
    expect(rollbackRecordFiles(rollbackDeps.homedir())).toEqual([]);
    const diagnostics = collectRollbackDiagnostics(result.newContainerId, outcome);
    expect(diagnostics.summary).toContain(`rollback_image_id=${ROLLBACK_IMAGE_ID}`);
    expect(diagnostics.summary).toContain("rollback_image_removed=no");
    expect(diagnostics.summary).toContain("rollback_record_path=none");
    expect(diagnostics.summary).toContain("rollback_record_removed=yes");
    expect(diagnostics.summary).toContain("rolled_back=yes");
  });

  it("reports a retained rollback image when successful-handoff cleanup fails (#9531)", () => {
    const result = exactDeferredCreateResult();
    const deps = readyHandoffDeps();
    const baseDockerRun = deps.dockerRun;
    deps.dockerRun = vi.fn((args: readonly string[]) =>
      args[0] === "image" ? { status: 1, stderr: "image is busy" } : baseDockerRun(args),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 60,
      },
      {
        ...deps,
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: 0 })),
      },
    );

    expect(outcome).toMatchObject({
      backupRemoved: true,
      rolledBack: false,
      rollbackImageId: ROLLBACK_IMAGE_ID,
      rollbackImageRemoved: false,
      rollbackRecordRemoved: true,
      finalHandoffAcknowledged: true,
    });
    expect(warn).toHaveBeenCalledWith(
      `  Could not remove temporary Docker rollback image ${ROLLBACK_IMAGE_ID}.`,
    );
  });

  it("accepts a retiring Error row only when the exact replacement has the OpenShell label (#9962)", () => {
    const result = exactDeferredCreateResult();
    const rollbackDeps = rollbackPlanDeps(result);
    const dockerRunResults = {
      inspect: { status: 0, stdout: "true\n" },
      ps: { status: 0, stdout: `${result.newContainerId}\n` },
    } as const;
    const dockerRun = vi.fn((args: readonly string[]) =>
      args[0] === "commit" || args[0] === "image"
        ? rollbackDeps.dockerRun(args)
        : dockerRunResults[String(args[0]) as keyof typeof dockerRunResults],
    );

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "restored-name",
        finalHandoffTimeoutSecs: 60,
      },
      {
        dockerCapture: rollbackDeps.dockerCapture,
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: 0 })),
        dockerRun,
        dockerRunDetached: rollbackDeps.dockerRunDetached,
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
    expect(dockerRun.mock.calls.find((call) => call[0][0] === "ps")?.[0]).toEqual([
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
  ])("restores the prior container when lifecycle release has %s (#9531)", (_case, query) => {
    const result = exactDeferredCreateResult();
    const rollbackDeps = rollbackPlanDeps(result);
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRun = vi.fn((args: readonly string[]) =>
      args[0] === "commit" || args[0] === "image" ? rollbackDeps.dockerRun(args) : query,
    );

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 1,
      },
      {
        dockerCapture: rollbackDeps.dockerCapture,
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerRun,
        dockerRunDetached: rollbackDeps.dockerRunDetached,
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
      rolledBack: true,
      rollbackImageId: ROLLBACK_IMAGE_ID,
      lifecycleReleaseObserved: false,
      replacementRestarted: false,
    });
    expect(dockerStart).not.toHaveBeenCalled();
    expect(rollbackDeps.dockerRunDetached).toHaveBeenCalledOnce();
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

  it.each([
    ["an explicit failure", { status: 1, stderr: "container is in use" }],
    ["no exit status", { status: null, stderr: "timed out" }],
  ])("retains the backup when Docker removal returns %s (#9531)", (_case, removal) => {
    const result = exactDeferredCreateResult();
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => removal);
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 60,
      },
      { dockerStop, dockerRm, dockerStart, ...readyHandoffDeps() },
    );
    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      rollbackImageRemoved: true,
      rollbackRecordRemoved: true,
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      finalHandoffAcknowledged: false,
      lastSandboxPhase: null,
    });
    expect(dockerRm).toHaveBeenCalledWith(
      result.oldContainerId,
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStart).toHaveBeenCalledWith(
      result.newContainerId,
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

  it("retains the backup when Docker cannot prepare the rollback image (#9531)", () => {
    const result = exactDeferredCreateResult();
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 60,
      },
      {
        ...readyHandoffDeps(),
        dockerCapture: rollbackPlanDeps(result).dockerCapture,
        dockerRun: vi.fn(() => ({ status: 1, stderr: "commit failed" })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm,
        dockerStart,
      },
    );

    expect(outcome).toEqual({
      backupRemoved: false,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      finalHandoffAcknowledged: false,
      lastSandboxPhase: null,
    });
    expect(dockerRm).not.toHaveBeenCalled();
    expect(dockerStart).toHaveBeenCalledWith(
      result.newContainerId,
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("restores the prior container when replacement restart fails after removal (#9531)", () => {
    const result = exactDeferredCreateResult();
    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
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
      rolledBack: true,
      rollbackImageId: ROLLBACK_IMAGE_ID,
      rollbackImageRemoved: false,
      rollbackRecordRemoved: true,
      replacementStopConfirmed: true,
      replacementRemovalConfirmed: true,
      replacementPresence: "absent",
      replacementStoppedForCommit: true,
      replacementRestarted: false,
      finalHandoffAcknowledged: false,
      lastSandboxPhase: null,
    });
  });

  it("retains the rollback image when post-commit restoration fails (#9531)", () => {
    const result = exactDeferredCreateResult();
    const deps = readyHandoffDeps();
    deps.dockerRunDetached.mockReturnValue({ status: 1, stdout: "", stderr: "restore failed" });

    const outcome = finalizeDockerGpuPatchBackup(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 60,
      },
      {
        ...deps,
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerStart: vi.fn(() => ({ status: 1 })),
      },
    );

    expect(outcome).toMatchObject({
      backupRemoved: true,
      rolledBack: false,
      rollbackImageId: ROLLBACK_IMAGE_ID,
      rollbackImageRemoved: false,
      rollbackRecordRemoved: false,
      replacementPresence: "absent",
      replacementRestarted: false,
    });
    expect(deps.dockerRun).not.toHaveBeenCalledWith(
      ["image", "rm", "--force", ROLLBACK_IMAGE_ID],
      expect.anything(),
    );
    const recordPath = outcome.rollbackRecordPath;
    expect(recordPath).toBeTypeOf("string");
    expect(fs.statSync(recordPath as string).mode & 0o777).toBe(0o600);
    const record = fs.readFileSync(recordPath as string, "utf8");
    expect(record).toContain(ROLLBACK_IMAGE_ID);
    expect(record).toContain('"command": "docker"');
    expect(record).toContain('"run"');
    expect(record).toContain('"--detach"');
    expect(record).not.toContain("super-secret-value");
    expect(record).not.toContain("ROLLBACK_TEST_TOKEN");
    expect(record).not.toContain('"--env"');
    expect(record).not.toContain('"--label"');
    const diagnostics = collectRollbackDiagnostics(result.newContainerId, outcome);
    expect(diagnostics.summary).toContain("rollback_record_removed=no");
    expect(diagnostics.summary).toContain("rollback_recovery_action=");
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
