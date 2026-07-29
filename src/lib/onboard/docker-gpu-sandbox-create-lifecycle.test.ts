// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as dockerAdapters from "../adapters/docker";
import { createDockerGpuInspectFixture } from "./__test-helpers__/docker-gpu-patch-fixtures";
import type { DockerGpuPatchFailureContext, DockerGpuPatchResult } from "./docker-gpu-patch";
import { createDockerGpuSandboxCreatePatch } from "./docker-gpu-sandbox-create";

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

function makeDeps() {
  return {
    runOpenshell: vi.fn(() => ({ status: 0 })),
    runCaptureOpenshell: vi.fn(() => ""),
    sleep: vi.fn(),
    dockerCapture: vi.fn(() => ""),
  };
}

describe("createDockerGpuSandboxCreatePatch composed flow", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defers backup removal until waitForSupervisorReconnectIfNeeded sees supervisorReady=true", () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const recreatePatch = vi.fn(() => result);
    const waitForSupervisor = vi.fn(() => true);
    const finalizeBackup = vi.fn(() => ({
      backupRemoved: true,
      rolledBack: false,
    }));
    const capturePreRollbackDiagnostics = vi.fn(() => null);
    const onPatchFailureExit = vi.fn();
    const findContainerIds = vi.fn(() => ["existing-container"]);

    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds,
        recreatePatch,
        waitForSupervisor,
        finalizeBackup,
        capturePreRollbackDiagnostics,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    expect(recreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ waitForSupervisor: false }),
      expect.objectContaining({
        runCaptureOpenshell: deps.runCaptureOpenshell,
      }),
    );
    // Critical invariant: the patch helper must NOT remove the backup during
    // create (recreatePatch was called with waitForSupervisor: false; the
    // result still carries backupRemoved=false).
    expect(finalizeBackup).not.toHaveBeenCalled();

    patch.waitForSupervisorReconnectIfNeeded();
    expect(waitForSupervisor).toHaveBeenCalledTimes(1);
    expect(finalizeBackup).toHaveBeenCalledTimes(1);
    expect(finalizeBackup).toHaveBeenCalledWith({ result, supervisorReady: true }, deps);
    expect(capturePreRollbackDiagnostics).not.toHaveBeenCalled();
    expect(onPatchFailureExit).not.toHaveBeenCalled();
  });

  it("refuses compatibility success when the backup container cannot be removed", () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => result),
        waitForSupervisor: vi.fn(() => true),
        finalizeBackup: vi.fn(() => ({
          backupRemoved: false,
          rolledBack: false,
        })),
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    patch.waitForSupervisorReconnectIfNeeded();

    expect(onPatchFailureExit).toHaveBeenCalledOnce();
    expect(onPatchFailureExit.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("backup container"),
      }),
    );
    expect(onPatchFailureExit.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        additionalSummaryLines: ["selected_gpu_route=compatibility"],
        context: expect.objectContaining({
          backupContainerName: result.backupContainerName,
        }),
      }),
    );
  });

  it("rolls back to the backup container and surfaces rolledBack=true diagnostics when supervisorReady=false", () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const recreatePatch = vi.fn(() => result);
    const waitForSupervisor = vi.fn(() => false);
    const capturePreRollbackDiagnostics = vi.fn(() => null);
    const finalizeBackup = vi.fn(() => ({
      backupRemoved: false,
      rolledBack: true,
    }));
    const onPatchFailureExit = vi.fn();
    const findContainerIds = vi.fn(() => ["existing-container"]);

    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds,
        recreatePatch,
        waitForSupervisor,
        finalizeBackup,
        capturePreRollbackDiagnostics,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    patch.waitForSupervisorReconnectIfNeeded();

    expect(capturePreRollbackDiagnostics).toHaveBeenCalledWith("alpha", result, deps);
    expect(capturePreRollbackDiagnostics.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeBackup.mock.invocationCallOrder[0],
    );
    expect(finalizeBackup).toHaveBeenCalledWith({ result, supervisorReady: false }, deps);
    expect(onPatchFailureExit).toHaveBeenCalledTimes(1);
    const [sandboxName, error, exitDeps] = onPatchFailureExit.mock.calls[0];
    expect(sandboxName).toBe("alpha");
    expect((error as Error).message).toMatch(/pre-patch sandbox restored/);
    const context = (exitDeps as { context: DockerGpuPatchFailureContext }).context;
    expect(context.rolledBack).toBe(true);
    expect(context.newContainerId).toBe("new-container-id");
    expect(context.backupContainerName).toBe(result.backupContainerName);
  });

  it("reports rolledBack=false in diagnostics when rollback itself fails", () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const recreatePatch = vi.fn(() => result);
    const waitForSupervisor = vi.fn(() => false);
    const finalizeBackup = vi.fn(() => ({
      backupRemoved: false,
      rolledBack: false,
    }));
    const capturePreRollbackDiagnostics = vi.fn(() => null);
    const onPatchFailureExit = vi.fn();
    const findContainerIds = vi.fn(() => ["existing-container"]);

    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds,
        recreatePatch,
        waitForSupervisor,
        finalizeBackup,
        capturePreRollbackDiagnostics,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    patch.waitForSupervisorReconnectIfNeeded();

    expect(onPatchFailureExit).toHaveBeenCalledTimes(1);
    const [, error, exitDeps] = onPatchFailureExit.mock.calls[0];
    expect((error as Error).message).toMatch(/rollback failed; pre-patch sandbox was NOT restored/);
    const context = (exitDeps as { context: DockerGpuPatchFailureContext }).context;
    expect(context.rolledBack).toBe(false);
  });

  it("skips both apply and supervisor wait when no OpenShell container is found", () => {
    const deps = makeDeps();
    const recreatePatch = vi.fn();
    const waitForSupervisor = vi.fn();
    const finalizeBackup = vi.fn();
    const onPatchFailureExit = vi.fn();
    const findContainerIds = vi.fn(() => []);

    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds,
        recreatePatch,
        waitForSupervisor,
        finalizeBackup,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    patch.waitForSupervisorReconnectIfNeeded();

    expect(recreatePatch).not.toHaveBeenCalled();
    expect(waitForSupervisor).not.toHaveBeenCalled();
    expect(finalizeBackup).not.toHaveBeenCalled();
    expect(onPatchFailureExit).not.toHaveBeenCalled();
  });

  it("uses the injected Docker capture for default container discovery", () => {
    const deps = makeDeps();
    const recreatePatch = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: { recreatePatch },
    });

    patch.maybeApplyDuringCreate();

    expect(deps.dockerCapture).toHaveBeenCalledWith(
      expect.arrayContaining(["ps", "-a", "--filter", "label=openshell.ai/sandbox-name=alpha"]),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(recreatePatch).not.toHaveBeenCalled();
  });

  it("keeps polling recreation and rollback on bound engine A when ambient adapters select B", () => {
    const failOnEngineB = () => {
      throw new Error("ambient engine B must not receive Docker operations");
    };
    const engineBSpies = [
      vi.spyOn(dockerAdapters, "dockerCapture").mockImplementation(failOnEngineB),
      vi.spyOn(dockerAdapters, "dockerRun").mockImplementation(failOnEngineB),
      vi.spyOn(dockerAdapters, "dockerRunDetached").mockImplementation(failOnEngineB),
      vi.spyOn(dockerAdapters, "dockerRename").mockImplementation(failOnEngineB),
      vi.spyOn(dockerAdapters, "dockerRm").mockImplementation(failOnEngineB),
      vi.spyOn(dockerAdapters, "dockerStart").mockImplementation(failOnEngineB),
      vi.spyOn(dockerAdapters, "dockerStop").mockImplementation(failOnEngineB),
    ];
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([createDockerGpuInspectFixture()]);
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "engine-a-probe\n" }));
    const dockerRunDetached = vi.fn(() => ({
      status: 1,
      stderr: "engine A forced recreate failure",
    }));
    const dockerRename = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      dockerDesktopWsl: false,
      deps: {
        runOpenshell: vi.fn(() => ({ status: 0 })),
        runCaptureOpenshell: vi.fn(() => ""),
        sleep: vi.fn(),
        dockerCapture,
        dockerRun,
        dockerRunDetached,
        dockerRename,
        dockerRm,
        dockerStart,
        dockerStop,
        now: () => new Date("2026-07-29T00:00:00Z"),
        detectSandboxFallbackDns: () => null,
        readDir: () => null,
        readFile: () => null,
      },
      overrides: { onPatchFailureExit },
    });

    patch.maybeApplyDuringCreate();
    patch.exitOnPatchError();

    expect(dockerCapture).toHaveBeenCalledWith(
      ["inspect", "--type", "container", "old-container-id"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRun).toHaveBeenCalledWith(
      expect.arrayContaining(["create", "--gpus", "all"]),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStop).toHaveBeenCalledWith(
      "old-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRename).toHaveBeenCalledWith(
      "old-container-id",
      expect.stringContaining("openshell-alpha-nemoclaw-gpu-backup-"),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRunDetached).toHaveBeenCalledWith(
      expect.arrayContaining(["--name", "openshell-alpha", "--gpus", "all"]),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStop).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRm).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRename).toHaveBeenCalledWith(
      expect.stringContaining("openshell-alpha-nemoclaw-gpu-backup-"),
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(onPatchFailureExit).toHaveBeenCalledOnce();
    for (const engineBSpy of engineBSpies) expect(engineBSpy).not.toHaveBeenCalled();
  });

  it("records patchError when recreate throws and exitOnPatchError reports it via printDockerGpuPatchFailureAndExit", () => {
    const deps = makeDeps();
    const recreatePatch = vi.fn(() => {
      throw new Error("docker rename failed");
    });
    const waitForSupervisor = vi.fn();
    const finalizeBackup = vi.fn();
    const onPatchFailureExit = vi.fn();
    const findContainerIds = vi.fn(() => ["existing-container"]);

    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds,
        recreatePatch,
        waitForSupervisor,
        finalizeBackup,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    expect(patch.createFailureMessage()).toMatch(/Docker GPU patch failed/);
    patch.exitOnPatchError();
    expect(onPatchFailureExit).toHaveBeenCalledTimes(1);
    // Supervisor wait must be skipped because needsSupervisorWait stayed false.
    patch.waitForSupervisorReconnectIfNeeded();
    expect(waitForSupervisor).not.toHaveBeenCalled();
    expect(finalizeBackup).not.toHaveBeenCalled();
  });

  it("hard-stops a structured failed GPU proof on the compatibility route", () => {
    const deps = makeDeps();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => []),
      },
    });

    expect(() =>
      patch.verifyGpuOrExit(() => ({
        status: "failed",
        cudaVerified: false,
        label: "nvidia-smi when available",
        detail: "No devices were found",
        at: "2026-07-07T00:00:00.000Z",
      })),
    ).toThrow("Sandbox GPU proof returned failed status: nvidia-smi when available");
  });
});
