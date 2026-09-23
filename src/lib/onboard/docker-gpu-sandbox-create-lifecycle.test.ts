// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as dockerContainer from "../adapters/docker/container";
import * as dockerRun from "../adapters/docker/run";
import type { DockerGpuPatchFailureContext, DockerGpuPatchResult } from "./docker-gpu-patch";
import type { DockerGpuPatchDeps } from "./docker-gpu-patch-types";
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
    runOpenshell: vi.fn<NonNullable<DockerGpuPatchDeps["runOpenshell"]>>(() => ({ status: 0 })),
    runCaptureOpenshell: vi.fn<NonNullable<DockerGpuPatchDeps["runCaptureOpenshell"]>>(() => ""),
    sleep: vi.fn<NonNullable<DockerGpuPatchDeps["sleep"]>>(),
    dockerCapture: vi.fn<NonNullable<DockerGpuPatchDeps["dockerCapture"]>>(() => ""),
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

  it("retains the backup after reconnect and removes it only after post-Ready commit", async () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const recreatePatch = vi.fn(() => result);
    const waitForSupervisor = vi.fn(async () => true);
    const finalizeBackup = vi.fn(async () => ({
      backupRemoved: true,
      rolledBack: false,
      replacementRestarted: true,
      finalHandoffAcknowledged: true,
      lastSandboxPhase: "Ready",
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

    expect(patch.replacementRuntimeId()).toBeNull();
    expect(patch.allowsNotReadyLifecycleRevalidation()).toBe(false);
    patch.maybeApplyDuringCreate();
    expect(patch.replacementRuntimeId()).toBe(result.newContainerId);
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

    await patch.waitForSupervisorReconnectIfNeeded();
    expect(waitForSupervisor).toHaveBeenCalledTimes(1);
    expect(finalizeBackup).not.toHaveBeenCalled();

    const beforeFinalHandoff = vi.fn();
    await patch.commitAfterReady({ beforeFinalHandoff });
    expect(beforeFinalHandoff).toHaveBeenCalledExactlyOnceWith(result.newContainerId);
    expect(patch.allowsNotReadyLifecycleRevalidation()).toBe(true);
    expect(finalizeBackup).toHaveBeenCalledTimes(1);
    expect(finalizeBackup).toHaveBeenCalledWith(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 900,
      },
      deps,
    );
    expect(waitForSupervisor).toHaveBeenCalledOnce();
    expect(capturePreRollbackDiagnostics).not.toHaveBeenCalled();
    expect(onPatchFailureExit).not.toHaveBeenCalled();
  });

  it("accepts a backup that the patch helper already finalized after reconnect", async () => {
    const deps = makeDeps();
    const result = { ...deferredCreateResult(), backupRemoved: true };
    const waitForSupervisor = vi.fn(async () => true);
    const finalizeBackup = vi.fn(async () => ({
      backupRemoved: true,
      rolledBack: false,
    }));
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => result),
        waitForSupervisor,
        finalizeBackup,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    await patch.waitForSupervisorReconnectIfNeeded();
    await expect(patch.commitAfterReady()).resolves.toBeUndefined();

    expect(finalizeBackup).toHaveBeenCalledWith(
      {
        result,
        supervisorReady: true,
        sandboxName: "alpha",
        finalHandoffTimeoutSecs: 900,
      },
      deps,
    );
    expect(waitForSupervisor).toHaveBeenCalledTimes(1);
    expect(onPatchFailureExit).not.toHaveBeenCalled();
  });

  it("rejects an explicit replacement restart failure after backup removal", async () => {
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
        waitForSupervisor: vi.fn(async () => true),
        finalizeBackup: vi.fn(async () => ({
          backupRemoved: true,
          rolledBack: false,
          replacementRestarted: false,
        })),
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    await patch.waitForSupervisorReconnectIfNeeded();
    await expect(patch.commitAfterReady()).rejects.toThrow("automatic rollback is unavailable");
    expect(patch.allowsNotReadyLifecycleRevalidation()).toBe(false);
    expect(onPatchFailureExit).toHaveBeenCalledOnce();
    expect(onPatchFailureExit.mock.calls[0]?.[2]?.context).toMatchObject({
      backupRemoved: true,
    });
  });

  it("rejects final handoff when OpenShell reports Deleting after restart (#9531)", async () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const waitForSupervisor = vi.fn(async () => true);
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => result),
        waitForSupervisor,
        finalizeBackup: vi.fn(async () => ({
          backupRemoved: true,
          rolledBack: false,
          replacementRestarted: true,
          finalHandoffAcknowledged: false,
          lastSandboxPhase: "Deleting",
        })),
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    await patch.waitForSupervisorReconnectIfNeeded();
    await expect(patch.commitAfterReady()).rejects.toThrow("automatic rollback is unavailable");

    expect(waitForSupervisor).toHaveBeenCalledOnce();
    expect(onPatchFailureExit).toHaveBeenCalledOnce();
  });

  it("reports a failed post-Ready rollback instead of treating it as restored", async () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const finalizeBackup = vi.fn(async () => ({
      backupRemoved: false,
      rolledBack: false,
    }));
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => result),
        waitForSupervisor: vi.fn(async () => true),
        finalizeBackup,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    await patch.waitForSupervisorReconnectIfNeeded();
    await expect(patch.rollbackManagedStartupAfterCreateFailure()).rejects.toThrow(
      "pre-patch container was not restored",
    );

    expect(finalizeBackup).toHaveBeenCalledWith({ result, supervisorReady: false }, deps);
    expect(onPatchFailureExit).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        message: expect.stringContaining("pre-patch container was not restored"),
      }),
      expect.objectContaining({
        context: expect.objectContaining({
          backupContainerName: result.backupContainerName,
          rolledBack: false,
        }),
      }),
    );
  });

  it("refuses compatibility success when the backup container cannot be removed", async () => {
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
        waitForSupervisor: vi.fn(async () => true),
        finalizeBackup: vi.fn(async () => ({
          backupRemoved: false,
          rolledBack: false,
        })),
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    await patch.waitForSupervisorReconnectIfNeeded();
    expect(onPatchFailureExit).not.toHaveBeenCalled();

    await expect(patch.commitAfterReady()).rejects.toThrow("final runtime handoff");
    await expect(patch.commitAfterReady()).rejects.toThrow("final runtime handoff");

    expect(onPatchFailureExit).toHaveBeenCalledOnce();
    expect(onPatchFailureExit.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("final runtime handoff"),
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

  it("rejects an early commit after rolling back before supervisor reconnect", async () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const finalizeBackup = vi.fn(async () => ({ backupRemoved: false, rolledBack: true }));
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => result),
        finalizeBackup,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();

    await expect(patch.commitAfterReady()).rejects.toThrow(
      "cannot commit before the recreated OpenShell supervisor reconnects",
    );
    await expect(patch.commitAfterReady()).rejects.toThrow(
      "cannot commit before the recreated OpenShell supervisor reconnects",
    );
    expect(finalizeBackup).toHaveBeenCalledWith({ result, supervisorReady: false }, deps);
    expect(onPatchFailureExit).toHaveBeenCalledOnce();
  });

  it("redacts a failed early-commit rollback before reporting it", async () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const secret = `nvapi-${"f".repeat(60)}`;
    const rollbackError = new Error(`Rollback failed: ${secret}`);
    rollbackError.stack = `Rollback stack: ${secret}`;
    const finalizeBackup = vi.fn(async () => {
      throw rollbackError;
    });
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => result),
        finalizeBackup,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();

    const failure = (await patch.commitAfterReady().catch((error: unknown) => error)) as Error & {
      runtimeRollbackError?: unknown;
    };

    expect(onPatchFailureExit).toHaveBeenCalledWith("alpha", failure, expect.any(Object));
    expect(failure.runtimeRollbackError).toBe(rollbackError);
    expect(failure.message).toContain(
      "Runtime rollback requires attention: Rollback failed: <REDACTED>",
    );
    expect(failure.message).not.toContain(secret);
    expect(rollbackError.message).toBe("Rollback failed: <REDACTED>");
    expect(rollbackError.stack).not.toContain(secret);
    expect(rollbackError.stack).toContain("<REDACTED>");
    expect(finalizeBackup).toHaveBeenCalledWith({ result, supervisorReady: false }, deps);
  });

  it("rolls back to the backup container and surfaces rolledBack=true diagnostics when supervisorReady=false", async () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const recreatePatch = vi.fn(() => result);
    const waitForSupervisor = vi.fn(async () => false);
    const capturePreRollbackDiagnostics = vi.fn(() => null);
    const finalizeBackup = vi.fn(async () => ({
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
    await patch.waitForSupervisorReconnectIfNeeded();

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

  it("uses production Docker evidence to reconcile one stale OpenShell Error row (#11905)", async () => {
    const injected = makeDeps();
    const deps = {
      runOpenshell: injected.runOpenshell,
      runCaptureOpenshell: injected.runCaptureOpenshell,
      sleep: injected.sleep,
    };
    const result = deferredCreateResult();
    const inspectResponses = new Map([
      ["{{json .State}}", JSON.stringify({ Running: true, Status: "running" })],
      ["{{.Name}}", `/${result.originalName}\n`],
    ]);
    const capture = vi
      .spyOn(dockerRun, "dockerCapture")
      .mockImplementation(
        (args: readonly string[]) => inspectResponses.get(String(args[2] ?? "")) ?? "",
      );
    const logs = vi
      .spyOn(dockerContainer, "dockerLogs")
      .mockReturnValue("OpenShell Sandbox Supervisor success\n");
    const waitForSupervisor = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const finalizeBackup = vi.fn();
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => result),
        waitForSupervisor,
        finalizeBackup,
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    await patch.waitForSupervisorReconnectIfNeeded();

    expect(waitForSupervisor).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(logs).toHaveBeenCalledWith(result.newContainerId, {
      tail: 256,
      timeout: 60_000,
    });
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["sandbox", "stop", "alpha"],
      expect.objectContaining({ timeout: 60_000 }),
    );
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["sandbox", "start", "alpha"],
      expect.objectContaining({ timeout: 60_000 }),
    );
    expect(finalizeBackup).not.toHaveBeenCalled();
    expect(onPatchFailureExit).not.toHaveBeenCalled();
  });

  it("attempts the bounded start after a stale Error row rejects stop (#11905)", async () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    deps.dockerCapture.mockImplementation((args: readonly string[]) =>
      args.includes("{{json .State}}")
        ? JSON.stringify({ Running: true, Status: "running" })
        : `/${result.originalName}\n`,
    );
    deps.runOpenshell.mockReturnValue({ status: 1 });
    const waitForSupervisor = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps: { ...deps, dockerLogs: vi.fn(() => "OpenShell Sandbox Supervisor success\n") },
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => result),
        waitForSupervisor,
        finalizeBackup: vi.fn(),
        onPatchFailureExit: vi.fn(),
      },
    });

    patch.maybeApplyDuringCreate();
    await patch.waitForSupervisorReconnectIfNeeded();

    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["sandbox", "stop", "alpha"],
      expect.objectContaining({ timeout: 60_000 }),
    );
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["sandbox", "start", "alpha"],
      expect.objectContaining({ timeout: 60_000 }),
    );
    expect(waitForSupervisor).toHaveBeenCalledTimes(2);
  });

  it("does not reconcile a stale row without exact replacement supervisor evidence (#11905)", async () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    deps.dockerCapture.mockImplementation((args: readonly string[]) =>
      args.includes("{{json .State}}")
        ? JSON.stringify({ Running: true, Status: "running" })
        : `/${result.originalName}\n`,
    );
    const waitForSupervisor = vi.fn(async () => false);
    const finalizeBackup = vi.fn(async () => ({ backupRemoved: false, rolledBack: true }));
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps: { ...deps, dockerLogs: vi.fn(() => "supervisor still starting\n") },
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => result),
        waitForSupervisor,
        finalizeBackup,
        capturePreRollbackDiagnostics: vi.fn(() => null),
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    await patch.waitForSupervisorReconnectIfNeeded();

    expect(waitForSupervisor).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(finalizeBackup).toHaveBeenCalledWith(
      { result, supervisorReady: false },
      expect.anything(),
    );
    expect(onPatchFailureExit).toHaveBeenCalledOnce();
  });

  it("reports rolledBack=false in diagnostics when rollback itself fails", async () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const recreatePatch = vi.fn(() => result);
    const waitForSupervisor = vi.fn(async () => false);
    const finalizeBackup = vi.fn(async () => ({
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
    await patch.waitForSupervisorReconnectIfNeeded();

    expect(onPatchFailureExit).toHaveBeenCalledTimes(1);
    const [, error, exitDeps] = onPatchFailureExit.mock.calls[0];
    expect((error as Error).message).toMatch(/rollback failed; pre-patch sandbox was NOT restored/);
    const context = (exitDeps as { context: DockerGpuPatchFailureContext }).context;
    expect(context.rolledBack).toBe(false);
  });

  it("skips both apply and supervisor wait when no OpenShell container is found", async () => {
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
    await patch.waitForSupervisorReconnectIfNeeded();

    expect(recreatePatch).not.toHaveBeenCalled();
    expect(waitForSupervisor).not.toHaveBeenCalled();
    expect(finalizeBackup).not.toHaveBeenCalled();
    expect(onPatchFailureExit).not.toHaveBeenCalled();
  });

  it("records patchError when recreate throws and exitOnPatchError reports it via printDockerGpuPatchFailureAndExit", async () => {
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
    await patch.exitOnPatchError();
    expect(onPatchFailureExit).toHaveBeenCalledTimes(1);
    // Supervisor wait must be skipped because needsSupervisorWait stayed false.
    await patch.waitForSupervisorReconnectIfNeeded();
    expect(waitForSupervisor).not.toHaveBeenCalled();
    expect(finalizeBackup).not.toHaveBeenCalled();
  });

  it("redacts a managed rollback failure before reporting a patch error", async () => {
    const deps = makeDeps();
    const secret = `nvapi-${"f".repeat(60)}`;
    const rollbackError = new Error(`Rollback failed: ${secret}`);
    rollbackError.stack = `Rollback stack: ${secret}`;
    const patchError = new Error("docker rename failed") as Error & {
      runtimeRollbackError?: unknown;
    };
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => {
          throw patchError;
        }),
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    patch.attachManagedBootstrapCutover({
      selectedMode: {
        kind: "gpus",
        label: "--gpus all",
        device: "all",
        args: ["--gpus", "all"],
      },
      replacementRuntimeId: "replacement-container-id",
      failureContext: {
        sandboxName: "alpha",
        oldContainerId: "old-container-id",
        newContainerId: "replacement-container-id",
        backupContainerName: null,
        selectedMode: null,
      },
      rollback: vi.fn(async () => {
        throw rollbackError;
      }),
      commit: vi.fn(),
    });

    await patch.exitOnPatchError();

    expect(onPatchFailureExit).toHaveBeenCalledWith("alpha", patchError, expect.any(Object));
    expect(patchError.runtimeRollbackError).toBe(rollbackError);
    expect(patchError.message).toContain(
      "Runtime rollback requires attention: Rollback failed: <REDACTED>",
    );
    expect(patchError.message).not.toContain(secret);
    expect(rollbackError.message).toBe("Rollback failed: <REDACTED>");
    expect(rollbackError.stack).not.toContain(secret);
    expect(rollbackError.stack).toContain("<REDACTED>");
  });

  it("hard-stops a structured failed GPU proof on the compatibility route", async () => {
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

    await expect(
      patch.verifyGpuOrExit(() => ({
        status: "failed",
        cudaVerified: false,
        label: "nvidia-smi when available",
        detail: "No devices were found",
        at: "2026-07-07T00:00:00.000Z",
      })),
    ).rejects.toThrow("Sandbox GPU proof returned failed status: nvidia-smi when available");
  });

  it("reports a failed rollback after GPU-proof diagnostics", async () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreatePatch: vi.fn(() => result),
        waitForSupervisor: vi.fn(async () => true),
        finalizeBackup: vi.fn(async () => ({
          backupRemoved: false,
          rolledBack: false,
        })),
      },
    });

    patch.maybeApplyDuringCreate();
    await patch.waitForSupervisorReconnectIfNeeded();

    await expect(
      patch.verifyGpuOrExit(() => {
        throw new Error("nvidia-smi failed");
      }),
    ).rejects.toThrow("nvidia-smi failed");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("pre-patch container was not restored"),
    );
  });

  it("logs only the sanitized rollback fallback after a terminal sandbox phase", async () => {
    const deps = makeDeps();
    deps.runCaptureOpenshell.mockReturnValue("alpha Error");
    const secret = `nvapi-${"g".repeat(60)}`;
    const rollbackError = new Error(`Rollback failed: ${secret}`);
    Object.preventExtensions(rollbackError);
    const verifyGpu = vi.fn(() => {
      throw new Error("GPU proof must not run after a terminal phase");
    });
    const patch = createDockerGpuSandboxCreatePatch({
      route: "compatibility",
      externalRecreation: true,
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
    });
    patch.attachManagedBootstrapCutover({
      selectedMode: {
        kind: "gpus",
        label: "--gpus all",
        device: "all",
        args: ["--gpus", "all"],
      },
      replacementRuntimeId: "replacement-container-id",
      failureContext: {
        sandboxName: "alpha",
        oldContainerId: "old-container-id",
        newContainerId: "replacement-container-id",
        backupContainerName: null,
        selectedMode: null,
      },
      rollback: vi.fn(async () => {
        throw rollbackError;
      }),
      commit: vi.fn(),
    });

    const failure = await patch.verifyGpuOrExit(verifyGpu).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const stored = (failure as Error & { runtimeRollbackError?: unknown }).runtimeRollbackError;
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(verifyGpu).not.toHaveBeenCalled();
    expect(output).not.toContain(secret);
    expect(output).toContain("diagnostic details were redacted");
    expect(stored).toBeInstanceOf(Error);
    expect(stored).not.toBe(rollbackError);
    expect((stored as Error).message).not.toContain(secret);
    expect(rollbackError.message).toContain(secret);
  });

  it("logs only the sanitized rollback fallback after GPU-proof failure", async () => {
    const deps = makeDeps();
    const secret = `nvapi-${"f".repeat(60)}`;
    const rollbackError = new Error(`Rollback failed: ${secret}`);
    rollbackError.stack = `Rollback stack: ${secret}`;
    Object.freeze(rollbackError);
    const proofError = new Error("nvidia-smi failed") as Error & {
      runtimeRollbackError?: unknown;
    };
    const patch = createDockerGpuSandboxCreatePatch({
      route: "native",
      externalRecreation: true,
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
    });
    patch.attachManagedBootstrapCutover({
      selectedMode: {
        kind: "gpus",
        label: "--gpus all",
        device: "all",
        args: ["--gpus", "all"],
      },
      replacementRuntimeId: "replacement-container-id",
      failureContext: {
        sandboxName: "alpha",
        oldContainerId: "old-container-id",
        newContainerId: "replacement-container-id",
        backupContainerName: null,
        selectedMode: null,
      },
      rollback: vi.fn(async () => {
        throw rollbackError;
      }),
      commit: vi.fn(),
    });

    await expect(
      patch.verifyGpuOrExit(() => {
        throw proofError;
      }),
    ).rejects.toBe(proofError);

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).not.toContain(secret);
    expect(output).toContain("diagnostic details were redacted");
    expect(proofError.runtimeRollbackError).toBeInstanceOf(Error);
    expect(proofError.runtimeRollbackError).not.toBe(rollbackError);
    expect(proofError.message).toContain(
      "Runtime rollback requires attention: Onboarding failed; diagnostic details were redacted",
    );
    expect(proofError.message).not.toContain(secret);
    expect((proofError.runtimeRollbackError as Error).message).not.toContain(secret);
    expect(rollbackError.message).toContain(secret);
    expect(rollbackError.stack).toContain(secret);
  });
});
