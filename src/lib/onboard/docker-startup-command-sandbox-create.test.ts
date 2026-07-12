// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DockerContainerInspect,
  DockerGpuPatchFailureContext,
  DockerGpuPatchResult,
} from "./docker-gpu-patch";
import { createDockerGpuSandboxCreatePatch } from "./docker-gpu-sandbox-create";

function startupResult(): DockerGpuPatchResult {
  return {
    applied: true,
    oldContainerId: "old-container-id",
    newContainerId: "new-container-id",
    originalName: "openshell-alpha",
    backupContainerName: "openshell-alpha-nemoclaw-gpu-backup-1780491860342",
    mode: {
      kind: "startup-command",
      label: "persistent sandbox startup command",
      device: "",
      args: [],
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

function inspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Image: `sha256:${"c".repeat(64)}`,
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity"],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
      User: "0",
      WorkingDir: "/workspace",
    },
    HostConfig: { NetworkMode: "openshell-docker", RestartPolicy: { Name: "unless-stopped" } },
  };
}

describe("Docker startup-command sandbox creation", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the default startup-command recreation path for non-GPU Hermes containers", () => {
    const dockerCaptureOutput: Record<string, string> = {
      ps: "old-container-id\n",
      inspect: JSON.stringify([inspectFixture()]),
    };
    const dockerRunDetached = vi.fn((_args: readonly string[]) => ({
      status: 0,
      stdout: "new-container-id\n",
    }));
    const deps = {
      ...makeDeps(),
      dockerCapture: vi.fn((args: readonly string[]) => dockerCaptureOutput[args[0] ?? ""] ?? ""),
      dockerRunDetached,
      dockerRename: vi.fn(() => ({ status: 0 })),
      dockerStop: vi.fn(() => ({ status: 0 })),
      now: () => new Date("2026-07-10T00:00:00Z"),
    };
    const recreatePatch = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "native",
      persistStartupCommand: true,
      sandboxName: "alpha",
      openshellSandboxCommand: ["env", "nemoclaw-start"],
      timeoutSecs: 60,
      deps,
      overrides: {
        recreatePatch,
      },
    });

    patch.ensureApplied();

    expect(recreatePatch).not.toHaveBeenCalled();
    expect(dockerRunDetached.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["--env", "OPENSHELL_SANDBOX_COMMAND=env nemoclaw-start"]),
    );
    expect(patch.selectedMode()?.kind).toBe("startup-command");
  });

  it("rolls back startup-command recreation when the supervisor does not reconnect", () => {
    const deps = makeDeps();
    const result = startupResult();
    const capturePreRollbackDiagnostics = vi.fn(() => null);
    const finalizeBackup = vi.fn(() => ({ backupRemoved: false, rolledBack: true }));
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "native",
      persistStartupCommand: true,
      sandboxName: "alpha",
      openshellSandboxCommand: ["env", "nemoclaw-start"],
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreateStartupPatch: vi.fn(() => result),
        waitForSupervisor: vi.fn(() => false),
        capturePreRollbackDiagnostics,
        finalizeBackup,
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
    const [, error, exitDeps] = onPatchFailureExit.mock.calls[0];
    expect((error as Error).message).toMatch(/pre-patch sandbox restored/);
    const context = (exitDeps as { context: DockerGpuPatchFailureContext }).context;
    expect(context.selectedMode?.kind).toBe("startup-command");
    expect(context.rolledBack).toBe(true);
  });

  it("reports startup-command creation failures through the composed patch boundary", () => {
    const deps = makeDeps();
    const onPatchFailureExit = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "native",
      persistStartupCommand: true,
      sandboxName: "alpha",
      openshellSandboxCommand: ["env", "nemoclaw-start"],
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreateStartupPatch: vi.fn(() => {
          throw new Error("startup recreate failed");
        }),
        onPatchFailureExit,
      },
    });

    patch.maybeApplyDuringCreate();
    expect(patch.createFailureMessage()).toMatch(/startup-command patch failed/);
    patch.exitOnPatchError();
    expect(onPatchFailureExit).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ message: "startup recreate failed" }),
      expect.objectContaining({ runCaptureOpenshell: deps.runCaptureOpenshell }),
    );
  });
});
