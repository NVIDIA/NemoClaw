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
    detectSandboxFallbackDns: vi.fn(() => null),
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

  it("uses the startup-command recreation path with DCode's exact resource limits", () => {
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
      requiredUlimits: [
        { name: "nproc", soft: 512, hard: 512 },
        { name: "nofile", soft: 65_536, hard: 65_536 },
      ],
      timeoutSecs: 60,
      deps,
      overrides: {
        recreatePatch,
      },
    });

    patch.ensureApplied();

    expect(recreatePatch).not.toHaveBeenCalled();
    expect(dockerRunDetached.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "--env",
        "OPENSHELL_SANDBOX_COMMAND=env nemoclaw-start",
        "--ulimit",
        "nproc=512:512",
        "--ulimit",
        "nofile=65536:65536",
      ]),
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

  it("applies managed startup directly to the exact container without recreation", () => {
    const deps = makeDeps();
    const containerId = "b".repeat(64);
    const request = {
      schemaVersion: 1,
      agent: "openclaw",
      encodedProfile: "profile",
      profileFingerprint: "a".repeat(64),
      corporateCaB64: null,
    } as const;
    const transaction = {
      agent: "openclaw",
      containerId,
      image: `sha256:${"c".repeat(64)}`,
    } as const;
    const applyManagedStartupRootRequest = vi.fn(() => transaction);
    const finalizeManagedStartupSharedState = vi.fn(() => ({
      supervisorReady: true,
      failure: null,
    }));
    const recreateStartupPatch = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "native",
      persistStartupCommand: false,
      managedStartupRootApplyRequest: request,
      sandboxName: "alpha",
      openshellSandboxCommand: ["env", "/usr/local/bin/nemoclaw-managed-startup-hold"],
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => [containerId]),
        recreateStartupPatch,
        applyManagedStartupRootRequest,
        finalizeManagedStartupSharedState,
      },
    });

    patch.maybeApplyDuringCreate();
    patch.waitForSupervisorReconnectIfNeeded();

    expect(recreateStartupPatch).not.toHaveBeenCalled();
    expect(applyManagedStartupRootRequest).toHaveBeenCalledWith(
      { containerId, request },
      { dockerCapture: deps.dockerCapture },
    );
    expect(finalizeManagedStartupSharedState).not.toHaveBeenCalled();

    patch.commitAfterReady();
    expect(finalizeManagedStartupSharedState).toHaveBeenCalledWith(
      { transaction, patchResult: null, supervisorReady: true },
      deps,
    );
  });

  it("treats an already-finalized same-profile replay as an applied no-op", () => {
    const deps = makeDeps();
    const containerId = "c".repeat(64);
    const request = {
      schemaVersion: 1,
      agent: "openclaw",
      encodedProfile: "profile",
      profileFingerprint: "a".repeat(64),
      corporateCaB64: null,
    } as const;
    const applyManagedStartupRootRequest = vi.fn(() => null);
    const finalizeManagedStartupSharedState = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "native",
      managedStartupRootApplyRequest: request,
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => [containerId]),
        applyManagedStartupRootRequest,
        finalizeManagedStartupSharedState,
      },
    });

    patch.maybeApplyDuringCreate();
    patch.maybeApplyDuringCreate();
    patch.ensureApplied();
    patch.waitForSupervisorReconnectIfNeeded();
    patch.commitAfterReady();

    expect(applyManagedStartupRootRequest).toHaveBeenCalledOnce();
    expect(finalizeManagedStartupSharedState).not.toHaveBeenCalled();
  });

  it("finishes resource recreation before applying managed startup to the replacement", () => {
    const deps = makeDeps();
    const result = { ...startupResult(), newContainerId: "d".repeat(64) };
    const request = {
      schemaVersion: 1,
      agent: "langchain-deepagents-code",
      encodedProfile: "profile",
      profileFingerprint: "a".repeat(64),
      corporateCaB64: null,
    } as const;
    const transaction = {
      agent: request.agent,
      containerId: result.newContainerId,
      image: `sha256:${"c".repeat(64)}`,
    } as const;
    const calls: string[] = [];
    const recreateStartupPatch = vi.fn(() => {
      calls.push("recreate");
      return result;
    });
    const applyManagedStartupRootRequest = vi.fn(() => {
      calls.push("apply");
      return transaction;
    });
    const patch = createDockerGpuSandboxCreatePatch({
      route: "native",
      persistStartupCommand: true,
      managedStartupRootApplyRequest: request,
      sandboxName: "alpha",
      openshellSandboxCommand: ["env", "/usr/local/bin/nemoclaw-managed-startup-hold"],
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => ["existing-container"]),
        recreateStartupPatch,
        applyManagedStartupRootRequest,
      },
    });

    patch.maybeApplyDuringCreate();

    expect(calls).toEqual(["recreate", "apply"]);
    expect(applyManagedStartupRootRequest).toHaveBeenCalledWith(
      { containerId: result.newContainerId, request },
      { dockerCapture: deps.dockerCapture },
    );
  });

  it("rolls back direct managed shared state when create fails after root application", () => {
    const deps = makeDeps();
    const containerId = "e".repeat(64);
    const request = {
      schemaVersion: 1,
      agent: "hermes",
      encodedProfile: "profile",
      profileFingerprint: "a".repeat(64),
      corporateCaB64: null,
    } as const;
    const transaction = {
      agent: request.agent,
      containerId,
      image: `sha256:${"f".repeat(64)}`,
    } as const;
    const finalizeManagedStartupSharedState = vi.fn(() => ({
      supervisorReady: false,
      failure: null,
    }));
    const finalizeBackup = vi.fn();
    const patch = createDockerGpuSandboxCreatePatch({
      route: "native",
      managedStartupRootApplyRequest: request,
      sandboxName: "alpha",
      timeoutSecs: 60,
      deps,
      overrides: {
        findContainerIds: vi.fn(() => [containerId]),
        applyManagedStartupRootRequest: vi.fn(() => transaction),
        finalizeManagedStartupSharedState,
        finalizeBackup,
      },
    });

    patch.maybeApplyDuringCreate();
    patch.waitForSupervisorReconnectIfNeeded();
    expect(finalizeManagedStartupSharedState).not.toHaveBeenCalled();

    patch.rollbackManagedStartupAfterCreateFailure();

    expect(finalizeManagedStartupSharedState).toHaveBeenCalledWith(
      { transaction, patchResult: null, supervisorReady: false },
      deps,
    );
    expect(finalizeBackup).not.toHaveBeenCalled();
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
