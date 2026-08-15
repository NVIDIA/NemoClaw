// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DockerGpuPatchResult } from "./docker-gpu-patch";
import {
  captureDockerGpuPreRollbackDiagnostics,
  type DockerGpuPreRollbackDiagnostics,
} from "./docker-gpu-pre-rollback-diagnostics";
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
    const finalizeBackup = vi.fn(() => ({
      backupRemoved: false,
      rolledBack: true,
    }));
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
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
    const finalizeBackup = vi.fn(() => ({
      backupRemoved: false,
      rolledBack: true,
    }));
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
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

  it("forwards the pre-rollback classification when bundle collection fails (#7996)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = {
      runOpenshell: vi.fn(() => ({ status: 0 })),
      runCaptureOpenshell: vi.fn(() => ""),
      sleep: vi.fn(),
      dockerCapture: vi.fn(() => ""),
    };
    const classification = {
      kind: "patched_container_failed" as const,
      headline: "Patched GPU container exited with code 127 (--gpus all).",
      summaryLines: ["patched_container_exit_code=127"],
      hints: ["Container logs show that `nemoclaw-start` is missing."],
    };
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        recreatePatch: vi.fn(() => RESULT),
        waitForSupervisor: vi.fn(() => false),
        capturePreRollbackDiagnostics: vi.fn(() => ({
          classification,
          diagnostics: null,
        })),
        finalizeBackup: vi.fn(() => ({ backupRemoved: false, rolledBack: true })),
        onPatchFailureExit,
      },
    });

    patch.ensureApplied();
    patch.waitForSupervisorReconnectIfNeeded();

    // The printer cannot rely on the replacement remaining inspectable after
    // rollback, so this hand-off preserves the exit-code evidence.
    expect(onPatchFailureExit).toHaveBeenCalledWith(
      "alpha",
      expect.any(Error),
      expect.objectContaining({ preRollbackClassification: classification }),
    );
  });

  it("passes a null pre-rollback classification when capture returns nothing (#7996)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = {
      runOpenshell: vi.fn(() => ({ status: 0 })),
      runCaptureOpenshell: vi.fn(() => ""),
      sleep: vi.fn(),
      dockerCapture: vi.fn(() => ""),
    };
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        recreatePatch: vi.fn(() => RESULT),
        waitForSupervisor: vi.fn(() => false),
        capturePreRollbackDiagnostics: vi.fn(() => null),
        finalizeBackup: vi.fn(() => ({ backupRemoved: false, rolledBack: true })),
        onPatchFailureExit,
      },
    });

    patch.ensureApplied();
    patch.waitForSupervisorReconnectIfNeeded();

    expect(onPatchFailureExit).toHaveBeenCalledWith(
      "alpha",
      expect.any(Error),
      expect.objectContaining({ preRollbackClassification: null }),
    );
  });

  it("uses exact-ID cleanup when a restored sandbox retains the failed replacement (#7996)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__test_exit__");
    }) as never);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gpu-composed-rollback-"));
    const replacementId = "a".repeat(64);
    let captured: DockerGpuPreRollbackDiagnostics | null = null;
    const dockerResponses = new Map([
      [
        "ps -a --no-trunc --filter label=openshell.ai/managed-by=openshell --filter label=openshell.ai/sandbox-name=alpha --format {{.ID}}",
        `${replacementId}\n`,
      ],
      [
        `inspect --format {{json .State}} ${replacementId}`,
        JSON.stringify({ Status: "exited", Running: false, ExitCode: 127 }),
      ],
      [
        `inspect ${replacementId}`,
        JSON.stringify([
          {
            Id: replacementId,
            Name: "/failed-replacement",
            Config: { Env: [] },
            HostConfig: {},
            NetworkSettings: { Networks: {} },
          },
        ]),
      ],
      ["inspect old-container-id", "[]"],
      ["inspect backup-container", "[]"],
    ]);
    const dockerCapture = vi.fn(
      (args: readonly string[]) => dockerResponses.get(args.join(" ")) ?? "",
    );
    const openshellResponses = new Map([
      ["sandbox get", "Phase: Error\n"],
      ["sandbox list", "alpha  Error\n"],
    ]);
    const runCaptureOpenshell = vi.fn(
      (args: readonly string[]) =>
        openshellResponses.get(`${args[0] ?? ""} ${args[1] ?? ""}`.trim()) ?? "",
    );
    const dockerRm = vi.fn(() => ({ status: 1, stderr: "daemon timeout" }));
    const dockerRun = vi.fn(() => ({ status: 0, stdout: `${replacementId}\n` }));
    const dockerRename = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const deps = {
      runOpenshell: vi.fn(() => ({ status: 0 })),
      runCaptureOpenshell,
      sleep: vi.fn(),
      dockerCapture,
      dockerRun,
      dockerLogs: vi.fn(() => "/usr/bin/env: 'nemoclaw-start': No such file or directory\n"),
      homedir: () => tmpDir,
      now: vi
        .fn()
        .mockReturnValueOnce(new Date("2026-07-03T00:00:00Z"))
        .mockReturnValue(new Date("2026-07-03T00:00:01Z")),
      dockerStop: vi.fn(() => ({ status: 0 })),
      dockerRm,
      dockerRename,
      dockerStart,
    };
    const result = { ...RESULT, newContainerId: replacementId };

    try {
      const patch = createDockerGpuSandboxCreatePatch({
        route: "compatibility",
        sandboxName: "alpha",
        timeoutSecs: 60,
        deps,
        overrides: {
          recreatePatch: vi.fn(() => result),
          waitForSupervisor: vi.fn(() => false),
          capturePreRollbackDiagnostics: (...args) => {
            captured = captureDockerGpuPreRollbackDiagnostics(...args);
            return captured;
          },
        },
      });

      patch.ensureApplied();
      expect(() => patch.waitForSupervisorReconnectIfNeeded()).toThrow(/__test_exit__/);

      const preRollback = (captured as DockerGpuPreRollbackDiagnostics | null)?.diagnostics;
      const preRollbackSummary = fs.readFileSync(
        path.join(preRollback?.dir ?? "", "summary.txt"),
        "utf-8",
      );
      expect(preRollback?.cleanupCommands).toEqual([]);
      expect(preRollbackSummary).toContain("cleanup_disposition=pending_rollback");
      expect(preRollbackSummary).toContain("cleanup_required=unknown");
      expect(preRollbackSummary).not.toContain("openshell sandbox delete");
      const postRollbackDir = path.join(
        tmpDir,
        ".nemoclaw",
        "onboard-failures",
        "2026-07-03T00-00-01-000Z-alpha-docker-gpu-patch",
      );
      const postRollbackSummary = fs.readFileSync(
        path.join(postRollbackDir, "summary.txt"),
        "utf-8",
      );
      expect(postRollbackSummary).toContain("rolled_back=yes");
      expect(postRollbackSummary).toContain("replacement_stop_confirmed=yes");
      expect(postRollbackSummary).toContain("replacement_removal_confirmed=no");
      expect(postRollbackSummary).toContain("replacement_presence=present");
      expect(postRollbackSummary).toContain("cleanup_disposition=manual");
      expect(postRollbackSummary).toContain("cleanup_required=yes");
      expect(postRollbackSummary).toContain(`docker rm -f ${JSON.stringify(replacementId)}`);
      expect(postRollbackSummary).not.toContain("openshell sandbox delete");
      expect(dockerRm).toHaveBeenCalledWith(
        replacementId,
        expect.objectContaining({ ignoreError: true }),
      );
      expect(dockerRename).toHaveBeenCalledWith(
        "backup-container",
        "openshell-alpha",
        expect.objectContaining({ ignoreError: true }),
      );
      expect(dockerStart).toHaveBeenCalledWith(
        "openshell-alpha",
        expect.objectContaining({ ignoreError: true }),
      );
      const output = stderr.join("\n");
      expect(output).toContain("pre-patch sandbox container was restored and started");
      expect(output).toContain("failed replacement container may still be present");
      expect(output).toContain(`docker rm -f ${JSON.stringify(replacementId)}`);
      expect(output).not.toContain("openshell sandbox delete");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
