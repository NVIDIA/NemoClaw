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

const STARTUP_RESULT: DockerGpuPatchResult = {
  ...RESULT,
  mode: {
    kind: "startup-command",
    label: "persistent sandbox startup command",
    device: "",
    args: [],
  },
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
      "  ⚠ Could not capture the failed container before rollback.",
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
    const capturePreRollbackDiagnostics = vi.fn<typeof captureDockerGpuPreRollbackDiagnostics>(
      () => null,
    );
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
    expect(capturePreRollbackDiagnostics).toHaveBeenCalledWith(
      "alpha",
      RESULT,
      deps,
      expect.objectContaining({ cleanupReason: "supervisor_reconnect_failed" }),
    );
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

  it("retains startup replacement evidence after backup finalization and before cleanup (#8690)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const secretCanary = "opaque-diagnostic-secret";
    const deps = {
      runOpenshell: vi.fn(() => ({ status: 0 })),
      runCaptureOpenshell: vi.fn(() => "alpha Error"),
      sleep: vi.fn(),
      dockerCapture: vi.fn(() => ""),
    };
    const capturePreRollbackDiagnostics = vi.fn<typeof captureDockerGpuPreRollbackDiagnostics>(
      () => null,
    );
    const finalizeBackup = vi.fn(() => ({
      backupRemoved: true,
      rolledBack: false,
    }));
    const patch = createDockerGpuSandboxCreatePatch({
      route: "none",
      persistStartupCommand: true,
      sandboxName: "alpha",
      openshellSandboxCommand: ["env", "nemoclaw-start"],
      timeoutSecs: 60,
      lifecycleGeneration: "generation-2",
      diagnosticSummaryLines: ["changed_credential_hash_providers=alpha-discord-bridge"],
      diagnosticSensitiveValues: [secretCanary],
      deps,
      overrides: {
        recreateStartupPatch: vi.fn(() => STARTUP_RESULT),
        waitForSupervisor: vi.fn((_name, _timeout, reconnectDeps) => {
          reconnectDeps.runOpenshell?.(["sandbox", "exec", "-n", "alpha", "--", "true"]);
          reconnectDeps.runCaptureOpenshell?.(["sandbox", "list"]);
          return true;
        }),
        capturePreRollbackDiagnostics,
        finalizeBackup,
      },
    });

    await patch.ensureApplied();
    patch.waitForSupervisorReconnectIfNeeded();
    await patch.commitAfterReady();
    for (let attempt = 0; attempt < 130; attempt += 1) {
      patch.recordLifecycleObservation({
        stage: "sandbox_readiness",
        event: "phase_probe",
        attempt,
        output: `alpha Ready poll ${String(attempt)}`,
      });
    }
    patch.recordLifecycleObservation({
      stage: "dashboard_readiness",
      event: "timeout",
      output: `${"x".repeat(1_600)}${secretCanary}`,
    });
    patch.captureLifecycleFailureDiagnostics({
      error: new Error("sandbox is not ready"),
      cleanupReason: "dashboard_forward_start_failed",
      cleanupStartedAt: "2026-08-10T00:00:00Z",
      forwardDiagnostic: `sandbox is not ready ${secretCanary}`,
      forwardListOutput: "",
    });

    expect(capturePreRollbackDiagnostics).toHaveBeenCalledWith(
      "alpha",
      STARTUP_RESULT,
      deps,
      expect.objectContaining({
        additionalSummaryLines: expect.arrayContaining([
          "selected_gpu_route=none",
          "changed_credential_hash_providers=alpha-discord-bridge",
        ]),
        additionalSensitiveValues: [secretCanary],
        cleanupReason: "dashboard_forward_start_failed",
        captureStage: "post-cutover-pre-cleanup",
        lifecycleGeneration: "generation-2",
        lifecycleObservationDroppedCount: 8,
        lifecycleObservations: expect.arrayContaining([
          expect.objectContaining({
            stage: "container_recreate",
            event: "replacement_started",
            output: expect.stringContaining("new_container_id=new-container-id"),
          }),
          expect.objectContaining({ stage: "supervisor_reconnect", event: "exec_probe" }),
          expect.objectContaining({
            stage: "supervisor_reconnect",
            event: "sandbox_phase_probe",
            output: "alpha Error",
          }),
          expect.objectContaining({ stage: "supervisor_reconnect", event: "reconnected" }),
          expect.objectContaining({ stage: "backup_finalize", event: "backup_removed" }),
          expect.objectContaining({ stage: "dashboard_readiness", event: "timeout" }),
        ]),
      }),
    );
    const lifecycleObservations = capturePreRollbackDiagnostics.mock.calls[0]?.[3]
      ?.lifecycleObservations as readonly { stage: string; event: string }[];
    expect(JSON.stringify(lifecycleObservations)).not.toContain(secretCanary);
    expect(JSON.stringify(lifecycleObservations)).toContain(
      "oversized single-line lifecycle output omitted",
    );
    expect(
      lifecycleObservations.findIndex(({ stage }) => stage === "backup_finalize"),
    ).toBeLessThan(lifecycleObservations.findIndex(({ stage }) => stage === "dashboard_readiness"));
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
