// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  collectDockerGpuPatchDiagnostics,
  type DockerContainerInspect,
  getDockerGpuPatchFailureContext,
  recreateOpenShellDockerSandboxWithGpu,
} from "./docker-gpu-patch";
import { finalizeDockerGpuPatchBackup } from "./docker-gpu-patch-finalize";

// The recreate path probes sandbox DNS through a real `docker run` when these
// stay unstubbed, which makes the rollback assertions depend on a live Docker
// daemon and registry reachability.
const offlineDnsDeps = {
  detectSandboxFallbackDns: () => null,
  probeContainerDns: () => ({ ok: true }),
};

function inspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: [
        "A=1",
        "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/",
        "OPENSHELL_TEST=1",
        "OPENSHELL_SANDBOX_COMMAND=sleep infinity",
        "NVIDIA_VISIBLE_DEVICES=void",
      ],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
        "openshell.ai/sandbox-id": "sandbox-id",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
      User: "0",
      WorkingDir: "/workspace",
      Hostname: "alpha-host",
      Tty: true,
    },
    HostConfig: {
      Binds: ["/host:/container:rw"],
      NetworkMode: "openshell-docker",
      RestartPolicy: { Name: "unless-stopped" },
      CapAdd: ["SYS_ADMIN", "NET_ADMIN"],
      SecurityOpt: ["apparmor=unconfined"],
      ExtraHosts: ["host.openshell.internal:172.17.0.1"],
      Memory: 8 * 1024 * 1024 * 1024,
      NanoCpus: 2_500_000_000,
    },
    NetworkSettings: {
      Networks: {
        "openshell-docker": {
          IPAddress: "172.18.0.2",
          Gateway: "172.18.0.1",
          Aliases: ["openshell-alpha"],
        },
      },
    },
  };
}

describe("recreateOpenShellDockerSandboxWithGpu rollback path", () => {
  it("rolls back to the backup container when supervisor reconnect fails", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "supervisor unreachable" }));
    const runCaptureOpenshell = vi.fn(() => "alpha Error\n");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runOpenshell,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          ...offlineDnsDeps,
          errorPhaseDebouncePolls: 1,
        },
      ),
    ).toThrow(/pre-patch sandbox restored/);

    const restoreRename = dockerRename.mock.calls.find(
      (call) => String(call[0]).includes("nemoclaw-gpu-backup") && call[1] === "openshell-alpha",
    );
    expect(restoreRename).toBeDefined();
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
  });

  it("retries from the restored sandbox after exact-ID replacement cleanup (#7996)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gpu-rollback-retry-"));
    const restoredId = "b".repeat(64);
    const replacementId = "a".repeat(64);
    const retryId = "d".repeat(64);
    const unrelatedId = "e".repeat(64);
    const unrelatedName = "openshell-beta";
    const originalName = "openshell-alpha";
    const initialBackupName = "backup-container";
    let restoredName = initialBackupName;
    let restoredPresent = true;
    let restoredRunning = false;
    let replacementPresent = true;
    let retryPresent = false;
    let unrelatedPresent = true;
    const stopTargets: string[] = [];
    const removeTargets: string[] = [];
    const renameTargets: string[] = [];
    const startTargets: string[] = [];

    const alphaContainerIds = () =>
      [
        restoredPresent ? restoredId : null,
        replacementPresent ? replacementId : null,
        retryPresent ? retryId : null,
      ].filter((value): value is string => value !== null);
    const inspectByTarget: Record<string, () => DockerContainerInspect[]> = {
      [restoredId]: () =>
        restoredPresent ? [{ ...inspectFixture(), Id: restoredId, Name: `/${restoredName}` }] : [],
      [replacementId]: () =>
        replacementPresent
          ? [
              {
                Id: replacementId,
                Name: "/failed-replacement",
                Config: { Image: "openshell/sandbox:abc", Env: [], Labels: {} },
                State: { Running: false },
                HostConfig: {},
                NetworkSettings: { Networks: {} },
              },
            ]
          : [],
      [retryId]: () =>
        retryPresent ? [{ ...inspectFixture(), Id: retryId, Name: `/${originalName}` }] : [],
    };
    const captureByCommand: Record<string, (args: readonly string[]) => string> = {
      ps: () => `${alphaContainerIds().join("\n")}\n`,
      info: () => "",
      inspect: (args) => JSON.stringify(inspectByTarget[String(args.at(-1))]?.() ?? []),
    };
    const dockerCapture = vi.fn(
      (args: readonly string[]) => captureByCommand[String(args[0])]?.(args) ?? "",
    );
    const runByCommand: Record<string, () => { status: number; stdout: string }> = {
      ps: () => ({
        status: 0,
        stdout: `${alphaContainerIds().join("\n")}\n`,
      }),
      inspect: () => ({ status: 0, stdout: "true\n" }),
    };
    const dockerRun = vi.fn(
      (args: readonly string[]) =>
        runByCommand[String(args[0])]?.() ?? { status: 0, stdout: "probe-id\n" },
    );
    const stopHandlers = new Map<string, () => void>([
      [
        restoredId,
        () => {
          restoredRunning = false;
        },
      ],
    ]);
    const dockerStop = vi.fn((target: string) => {
      stopTargets.push(target);
      stopHandlers.get(target)?.();
      return { status: 0 };
    });
    const successfulRemoval = () => ({ status: 0 });
    const replacementRemovalHandlers = [
      () => ({ status: 1, stderr: "daemon timeout" }),
      () => {
        replacementPresent = false;
        return successfulRemoval();
      },
    ];
    const removalHandlers = new Map<string, () => { status: number; stderr?: string }>([
      [replacementId, () => (replacementRemovalHandlers.shift() ?? successfulRemoval)()],
      [
        unrelatedId,
        () => {
          unrelatedPresent = false;
          return successfulRemoval();
        },
      ],
      [
        unrelatedName,
        () => {
          unrelatedPresent = false;
          return successfulRemoval();
        },
      ],
    ]);
    const removeRestored = () => {
      restoredPresent = false;
      return successfulRemoval();
    };
    removalHandlers.set(restoredName, removeRestored);
    removalHandlers.set(restoredId, removeRestored);
    const dockerRm = vi.fn((target: string) => {
      removeTargets.push(target);
      return removalHandlers.get(target)?.() ?? successfulRemoval();
    });
    const updateRestoredName = (next: string) => {
      removalHandlers.delete(restoredName);
      restoredName = next;
      removalHandlers.set(restoredName, removeRestored);
    };
    const renameHandlers = new Map<string, (next: string) => void>([
      [initialBackupName, updateRestoredName],
      [restoredId, updateRestoredName],
    ]);
    const dockerRename = vi.fn((from: string, to: string) => {
      renameTargets.push(from, to);
      renameHandlers.get(from)?.(to);
      return { status: 0 };
    });
    const startHandlers = new Map<string, () => void>([
      [
        originalName,
        () => {
          restoredRunning = true;
        },
      ],
    ]);
    const dockerStart = vi.fn((target: string) => {
      startTargets.push(target);
      startHandlers.get(target)?.();
      return { status: 0 };
    });
    const dockerRunDetached = vi.fn(() => {
      retryPresent = true;
      return { status: 0, stdout: `${retryId}\n` };
    });
    const deps = {
      dockerCapture,
      dockerRun,
      dockerRunDetached,
      dockerStop,
      dockerRm,
      dockerRename,
      dockerStart,
      dockerLogs: vi.fn(() => ""),
      runOpenshell: vi.fn((args: readonly string[]) =>
        args[1] === "list" ? { status: 0, stdout: "No sandboxes found.\n" } : { status: 0 },
      ),
      runCaptureOpenshell: vi.fn(() => "alpha  2026-08-23 10:00:00  Ready\n"),
      sleep: vi.fn(),
      homedir: () => tmpDir,
      now: () => new Date("2026-07-03T00:00:00Z"),
      readDir: vi.fn(() => null),
      readFile: vi.fn(() => null),
      ...offlineDnsDeps,
    };
    const failedResult = {
      applied: true as const,
      oldContainerId: restoredId,
      newContainerId: replacementId,
      originalName,
      backupContainerName: initialBackupName,
      mode: {
        kind: "gpus" as const,
        label: "--gpus all",
        device: "all",
        args: ["--gpus", "all"],
      },
      backupRemoved: false,
    };

    try {
      const rollback = finalizeDockerGpuPatchBackup(
        { result: failedResult, supervisorReady: false },
        deps,
      );

      expect(rollback).toEqual({
        backupRemoved: false,
        rolledBack: true,
        replacementStopConfirmed: true,
        replacementRemovalConfirmed: false,
        replacementPresence: "present",
      });
      expect(restoredName).toBe(originalName);
      expect(restoredRunning).toBe(true);
      expect(replacementPresent).toBe(true);

      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            oldContainerId: restoredId,
            newContainerId: replacementId,
            backupContainerName: initialBackupName,
            selectedMode: failedResult.mode,
            ...rollback,
          },
        },
        deps,
      );
      expect(diagnostics?.cleanupCommands).toEqual([
        `docker rm -f ${JSON.stringify(replacementId)}`,
      ]);

      // Model the operator applying the sole exact-ID cleanup command before
      // rerunning onboarding. The restored sandbox and unrelated beta sandbox
      // remain outside that cleanup boundary.
      const cleanupCommand = diagnostics?.cleanupCommands[0];
      expect(cleanupCommand).toBeDefined();
      const cleanupTarget = JSON.parse(String(cleanupCommand).slice("docker rm -f ".length));
      expect(cleanupTarget).toBe(replacementId);
      expect(dockerRm(cleanupTarget).status).toBe(0);
      expect(alphaContainerIds()).toEqual([restoredId]);
      expect(unrelatedPresent).toBe(true);

      const retried = recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        deps,
      );

      expect(retried.oldContainerId).toBe(restoredId);
      expect(retried.oldContainerId).not.toBe(replacementId);
      expect(retried.newContainerId).toBe(retryId);
      expect(retried.backupRemoved).toBe(true);
      expect(alphaContainerIds()).toEqual([retryId]);
      expect(unrelatedPresent).toBe(true);
      const touchedTargets = [...stopTargets, ...removeTargets, ...renameTargets, ...startTargets];
      expect(touchedTargets).not.toContain(unrelatedId);
      expect(touchedTargets).not.toContain(unrelatedName);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    1,
    null,
  ])("restores the pre-patch sandbox when the recreate run returns status %s before the supervisor wait (#5512)", (runStatus) => {
    const captureResponses: Record<string, string> = {
      ps: "old-container-id\n",
      inspect: JSON.stringify([inspectFixture()]),
      info: "",
    };
    const dockerCapture = vi.fn(
      (args: readonly string[]) => captureResponses[String(args[0])] ?? "",
    );
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    // The recreate `docker run` fails after the original was renamed aside.
    const dockerRunDetached = vi.fn(() => ({ status: runStatus, stderr: "docker: boom" }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runCaptureOpenshell = vi.fn(() => "");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          ...offlineDnsDeps,
        },
      ),
    ).toThrow(/Could not start GPU-enabled sandbox container/);

    // The original sandbox is restored from the backup (rename backup -> original, then start).
    const restoreRename = dockerRename.mock.calls.find(
      (call) => String(call[0]).includes("nemoclaw-gpu-backup") && call[1] === "openshell-alpha",
    );
    expect(restoreRename).toBeDefined();
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    // The failed recreate container (named originalName by `docker run --name`) is removed.
    expect(dockerRm).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    // The backup is renamed back, never left as an orphaned container.
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
  });

  it("does not start a replacement when the original-container rename has no exit status", () => {
    const captureResponses: Record<string, string> = {
      ps: "old-container-id\n",
      inspect: JSON.stringify([inspectFixture()]),
    };
    const dockerCapture = vi.fn(
      (args: readonly string[]) => captureResponses[String(args[0])] ?? "",
    );
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
          dockerRunDetached,
          dockerRename: vi.fn(() => ({ status: null, stderr: "timed out" })),
          dockerStop: vi.fn(() => ({ status: 0 })),
          dockerRm: vi.fn(() => ({ status: 0 })),
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          ...offlineDnsDeps,
        },
      ),
    ).toThrow(/Could not move original sandbox container aside/);
    expect(dockerRunDetached).not.toHaveBeenCalled();
  });

  it("reports early recreate rollback failure when backup rename back fails (#5512)", () => {
    const captureResponses: Record<string, string> = {
      ps: "old-container-id\n",
      inspect: JSON.stringify([inspectFixture()]),
      info: "",
    };
    const dockerCapture = vi.fn(
      (args: readonly string[]) => captureResponses[String(args[0])] ?? "",
    );
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 1, stderr: "docker: boom" }));
    const dockerRename = vi.fn((oldName: string) =>
      String(oldName).includes("nemoclaw-gpu-backup")
        ? { status: 1, stderr: "rename failed" }
        : { status: 0 },
    );
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runCaptureOpenshell = vi.fn(() => "");

    let thrown: unknown;
    try {
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          ...offlineDnsDeps,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(String((thrown as Error).message)).toMatch(
      /rollback failed; pre-patch sandbox was NOT restored/,
    );
    expect(getDockerGpuPatchFailureContext(thrown)?.rolledBack).toBe(false);
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("reports early recreate rollback failure when restored original start fails (#5512)", () => {
    const captureResponses: Record<string, string> = {
      ps: "old-container-id\n",
      inspect: JSON.stringify([inspectFixture()]),
      info: "",
    };
    const dockerCapture = vi.fn(
      (args: readonly string[]) => captureResponses[String(args[0])] ?? "",
    );
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 1, stderr: "docker: boom" }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 1, stderr: "container start failed" }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runCaptureOpenshell = vi.fn(() => "");

    let thrown: unknown;
    try {
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          ...offlineDnsDeps,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(String((thrown as Error).message)).toMatch(
      /rollback failed; pre-patch sandbox was NOT restored/,
    );
    expect(getDockerGpuPatchFailureContext(thrown)?.rolledBack).toBe(false);
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("reports rollback failure when restoring the backup container fails", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi.fn((oldName: string) => {
      if (String(oldName).includes("nemoclaw-gpu-backup")) {
        return { status: 1, stderr: "no such container" };
      }
      return { status: 0 };
    });
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "supervisor unreachable" }));
    const runCaptureOpenshell = vi.fn(() => "alpha Error\n");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runOpenshell,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          ...offlineDnsDeps,
          errorPhaseDebouncePolls: 1,
        },
      ),
    ).toThrow(/rollback failed; pre-patch sandbox was NOT restored/);

    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("reports rollback failure when restarting the backup container fails", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 1, stderr: "container start failed" }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "supervisor unreachable" }));
    const runCaptureOpenshell = vi.fn(() => "alpha Error\n");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runOpenshell,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          ...offlineDnsDeps,
          errorPhaseDebouncePolls: 1,
        },
      ),
    ).toThrow(/rollback failed; pre-patch sandbox was NOT restored/);

    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
  });
});
