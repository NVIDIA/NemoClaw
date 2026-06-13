// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DockerGpuPatchFailureContext,
  DockerGpuPatchResult,
} from "../../../dist/lib/onboard/docker-gpu-patch";
import { buildSandboxGpuCreateArgs } from "../../../dist/lib/onboard/sandbox-gpu-create";
import {
  createDockerGpuSandboxCreatePatch,
  resolveDockerGpuSandboxCreatePlan,
} from "../../../dist/lib/onboard/docker-gpu-sandbox-create";

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
    const finalizeBackup = vi.fn(() => ({ backupRemoved: true, rolledBack: false }));
    const onPatchFailureExit = vi.fn();
    const findContainerIds = vi.fn(() => ["existing-container"]);

    const patch = createDockerGpuSandboxCreatePatch({
      enabled: true,
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
    expect(recreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ waitForSupervisor: false }),
      expect.objectContaining({ runCaptureOpenshell: deps.runCaptureOpenshell }),
    );
    // Critical invariant: the patch helper must NOT remove the backup during
    // create (recreatePatch was called with waitForSupervisor: false; the
    // result still carries backupRemoved=false).
    expect(finalizeBackup).not.toHaveBeenCalled();

    patch.waitForSupervisorReconnectIfNeeded();
    expect(waitForSupervisor).toHaveBeenCalledTimes(1);
    expect(finalizeBackup).toHaveBeenCalledTimes(1);
    expect(finalizeBackup).toHaveBeenCalledWith({ result, supervisorReady: true }, deps);
    expect(onPatchFailureExit).not.toHaveBeenCalled();
  });

  it("rolls back to the backup container and surfaces rolledBack=true diagnostics when supervisorReady=false", () => {
    const deps = makeDeps();
    const result = deferredCreateResult();
    const recreatePatch = vi.fn(() => result);
    const waitForSupervisor = vi.fn(() => false);
    const finalizeBackup = vi.fn(() => ({ backupRemoved: false, rolledBack: true }));
    const onPatchFailureExit = vi.fn();
    const findContainerIds = vi.fn(() => ["existing-container"]);

    const patch = createDockerGpuSandboxCreatePatch({
      enabled: true,
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
    const finalizeBackup = vi.fn(() => ({ backupRemoved: false, rolledBack: false }));
    const onPatchFailureExit = vi.fn();
    const findContainerIds = vi.fn(() => ["existing-container"]);

    const patch = createDockerGpuSandboxCreatePatch({
      enabled: true,
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
      enabled: true,
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
      enabled: true,
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
});

describe("resolveDockerGpuSandboxCreatePlan Docker Desktop WSL handling", () => {
  it("keeps useDockerGpuPatch=true on Docker Desktop WSL even when NEMOCLAW_DOCKER_GPU_PATCH=0", () => {
    const originalEnv = process.env.NEMOCLAW_DOCKER_GPU_PATCH;
    process.env.NEMOCLAW_DOCKER_GPU_PATCH = "0";
    try {
      const plan = resolveDockerGpuSandboxCreatePlan(
        { sandboxGpuEnabled: true },
        {
          dockerDriverGateway: true,
          detectDockerDesktopWsl: () => true,
        },
      );
      expect(plan.useDockerGpuPatch).toBe(true);
    } finally {
      if (originalEnv === undefined) delete process.env.NEMOCLAW_DOCKER_GPU_PATCH;
      else process.env.NEMOCLAW_DOCKER_GPU_PATCH = originalEnv;
    }
  });

  it("honors NEMOCLAW_DOCKER_GPU_PATCH=0 when not on Docker Desktop WSL", () => {
    const originalEnv = process.env.NEMOCLAW_DOCKER_GPU_PATCH;
    process.env.NEMOCLAW_DOCKER_GPU_PATCH = "0";
    try {
      const plan = resolveDockerGpuSandboxCreatePlan(
        { sandboxGpuEnabled: true },
        {
          dockerDriverGateway: true,
          detectDockerDesktopWsl: () => false,
        },
      );
      expect(plan.useDockerGpuPatch).toBe(false);
    } finally {
      if (originalEnv === undefined) delete process.env.NEMOCLAW_DOCKER_GPU_PATCH;
      else process.env.NEMOCLAW_DOCKER_GPU_PATCH = originalEnv;
    }
  });

  it("suppresses the openshell sandbox create --gpu flag on Docker Desktop WSL when the opt-out is ignored", () => {
    const originalEnv = process.env.NEMOCLAW_DOCKER_GPU_PATCH;
    process.env.NEMOCLAW_DOCKER_GPU_PATCH = "0";
    try {
      const sandboxGpuConfig = { sandboxGpuEnabled: true };
      const plan = resolveDockerGpuSandboxCreatePlan(sandboxGpuConfig, {
        dockerDriverGateway: true,
        detectDockerDesktopWsl: () => true,
      });
      expect(plan.useDockerGpuPatch).toBe(true);
      const createArgs = buildSandboxGpuCreateArgs(sandboxGpuConfig, {
        suppressGpuFlag: plan.useDockerGpuPatch,
      });
      expect(createArgs).toEqual([]);
    } finally {
      if (originalEnv === undefined) delete process.env.NEMOCLAW_DOCKER_GPU_PATCH;
      else process.env.NEMOCLAW_DOCKER_GPU_PATCH = originalEnv;
    }
  });

  it("emits --gpu when the patch is disabled outside Docker Desktop WSL", () => {
    const originalEnv = process.env.NEMOCLAW_DOCKER_GPU_PATCH;
    process.env.NEMOCLAW_DOCKER_GPU_PATCH = "0";
    try {
      const sandboxGpuConfig = { sandboxGpuEnabled: true };
      const plan = resolveDockerGpuSandboxCreatePlan(sandboxGpuConfig, {
        dockerDriverGateway: true,
        detectDockerDesktopWsl: () => false,
      });
      expect(plan.useDockerGpuPatch).toBe(false);
      const createArgs = buildSandboxGpuCreateArgs(sandboxGpuConfig, {
        suppressGpuFlag: plan.useDockerGpuPatch,
      });
      expect(createArgs).toEqual(["--gpu"]);
    } finally {
      if (originalEnv === undefined) delete process.env.NEMOCLAW_DOCKER_GPU_PATCH;
      else process.env.NEMOCLAW_DOCKER_GPU_PATCH = originalEnv;
    }
  });
});
