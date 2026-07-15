// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";

beforeEach(f.resetSnapshotRestoreMocks);
afterEach(f.cleanupSnapshotRestoreMocks);
describe("runSandboxSnapshot restore: lifecycle and destination safety", () => {
  it("restores the latest snapshot into the source sandbox", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    f.getLatestBackupMock.mockReturnValue({
      snapshotVersion: 4,
      name: "stable",
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Using latest snapshot v4 name=stable");
    expect(output).toContain("Restoring snapshot into 'alpha'");
    expect(output).toContain("Restored 1 directories, 1 files");
  });

  it("keeps a successful restore when every post-restore reconciliation warns", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const customPolicy = {
      name: "corp-policy",
      content: "network_policies:\n  corp-policy: {}\n",
      sourcePath: "/policies/corp-policy.yaml",
    };
    f.getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["github", customPolicy.name],
      customPolicies: [customPolicy],
    });
    f.restoreSandboxStateMock.mockResolvedValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    });
    f.shieldsMock.repairMutableConfigPermsMock.mockImplementation(() => {
      throw new Error("permission repair failed");
    });
    f.applyPresetContentMock.mockImplementation(() => {
      throw new Error("custom replay failed");
    });
    f.applyPresetMock.mockImplementation(() => {
      throw new Error("preset reconciliation failed");
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).resolves.toBeUndefined();

    expect(f.shieldsMock.repairMutableConfigPermsMock).toHaveBeenCalledWith("alpha");
    expect(f.applyPresetContentMock).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      { custom: { sourcePath: customPolicy.sourcePath } },
    );
    expect(f.applyPresetMock).toHaveBeenCalledWith("alpha", "github");
    expect(consoleLog.mock.calls.flat().join("\n")).toContain("Restored 1 directories, 1 files");
    const warnings = consoleWarn.mock.calls.flat().join("\n");
    expect(warnings).toContain(
      "OpenClaw config permission repair errored: permission repair failed",
    );
    expect(warnings).toContain("corp-policy (apply: custom replay failed)");
    expect(warnings).toContain("github (apply: preset reconciliation failed)");
  });

  it("delegates managed and custom-image snapshot restores to the state layer", async () => {
    f.getLatestBackupMock.mockReturnValue({
      snapshotVersion: 4,
      name: "stable",
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    f.getSandboxMock.mockReturnValue({ name: "alpha", agent: "langchain-deepagents-code" });
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");

    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      fromDockerfile: "/tmp/Dockerfile",
    });
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    expect(f.restoreSandboxStateMock).toHaveBeenCalledTimes(2);
  });

  it("keeps active-timer restore, permission repair, and policy reconciliation serialized", async () => {
    const order: string[] = [];
    const lockReleased = vi.fn(() => order.push("lock released"));
    const restoredState = {
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    };
    let releaseRestore = () => {};
    const pendingRestore = new Promise<typeof restoredState>((resolve) => {
      releaseRestore = () => resolve(restoredState);
    });
    f.lifecycleMock.withTimerBoundMock.mockImplementation(
      async (_sandboxName, command, operation) => {
        f.lifecycleMock.events.push(`lock:${command}`);
        try {
          return await operation();
        } finally {
          lockReleased();
        }
      },
    );
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({
      pid: 4242,
      sandboxName: "alpha",
      snapshotPath: "/tmp/policy.yaml",
      restoreAt: "2026-06-27T06:00:00.000Z",
      processToken: "a".repeat(32),
    });
    f.getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["github"],
    });
    f.restoreSandboxStateMock.mockImplementation(() => {
      order.push("restore");
      return pendingRestore;
    });
    f.shieldsMock.repairMutableConfigPermsMock.mockImplementation(() => {
      order.push("repair permissions");
      return { applied: true, verified: true, errors: [] };
    });
    f.applyPresetMock.mockImplementation(() => {
      order.push("reconcile policy");
      return true;
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    const restoreOperation = runSandboxSnapshot("alpha", { kind: "restore" });
    const completion = restoreOperation.then(() => order.push("complete"));
    await vi.waitFor(() => expect(f.restoreSandboxStateMock).toHaveBeenCalledOnce());

    expect(f.lifecycleMock.events).toContain("lock:restore sandbox snapshot");
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    expect(f.shieldsMock.repairMutableConfigPermsMock).not.toHaveBeenCalled();
    expect(f.applyPresetMock).not.toHaveBeenCalled();
    expect(lockReleased).not.toHaveBeenCalled();
    expect(order).toEqual(["restore"]);

    releaseRestore();
    await completion;

    expect(f.shieldsMock.repairMutableConfigPermsMock).toHaveBeenCalledWith("alpha");
    expect(f.applyPresetMock).toHaveBeenCalledWith("alpha", "github");
    expect(lockReleased).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "restore",
      "repair permissions",
      "reconcile policy",
      "lock released",
      "complete",
    ]);
  });

  it("hardens an active timer window before force-deleting a restore destination", async () => {
    f.getOpenShellSandboxDescriptorMock.mockResolvedValue({
      id: "alpha-id",
      name: "alpha",
      image: "nemoclaw-alpha:live-descriptor",
    });
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({
      pid: 4242,
      sandboxName: "beta",
      snapshotPath: "/tmp/policy.yaml",
      restoreAt: "2026-06-27T06:00:00.000Z",
      processToken: "b".repeat(32),
    });
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : {
            name: "beta",
            agent: "openclaw",
            imageTag: "nemoclaw-beta:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          },
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    });

    expect(f.shieldsMock.shieldsUpMock).toHaveBeenCalledWith("beta", {
      throwOnError: true,
      allowLegacyHermesProtocol: true,
    });
    expect(f.lifecycleMock.events.indexOf("harden")).toBeLessThan(
      f.lifecycleMock.events.indexOf("delete"),
    );
    expect(f.lifecycleMock.events.indexOf("delete")).toBeLessThan(
      f.lifecycleMock.events.indexOf("cleanup-shields"),
    );
    expect(f.streamSandboxCreateMock).toHaveBeenCalled();
    expect(f.getOpenShellSandboxDescriptorMock).toHaveBeenNthCalledWith(1, "nemoclaw", "alpha");
    expect(f.getOpenShellSandboxDescriptorMock).toHaveBeenNthCalledWith(2, "nemoclaw", "alpha");
    expect(f.getOpenShellSandboxDescriptorMock).toHaveBeenCalledTimes(2);
    expect(f.streamSandboxCreateMock.mock.calls[0]?.[1]).toContain(
      "nemoclaw-alpha:live-descriptor",
    );
    expect(f.streamSandboxCreateMock).toHaveBeenCalledOnce();
    const destinationDeleteCalls = f.runOpenshellMock.mock.calls.filter(
      ([args]) => args.join("\0") === "sandbox\0delete\0beta",
    );
    expect(destinationDeleteCalls).toHaveLength(1);
    const deleteCallIndex = f.runOpenshellMock.mock.calls.indexOf(destinationDeleteCalls[0]);
    const [firstReadOrder, secondReadOrder] =
      f.getOpenShellSandboxDescriptorMock.mock.invocationCallOrder;
    const deleteOrder = f.runOpenshellMock.mock.invocationCallOrder[deleteCallIndex];
    const [createOrder] = f.streamSandboxCreateMock.mock.invocationCallOrder;
    expect(firstReadOrder).toBeLessThan(secondReadOrder);
    expect(secondReadOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(createOrder);
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
  });

  it("does not delete or create when a descriptor difference is observed between samples", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
    }));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.getOpenShellSandboxDescriptorMock
      .mockResolvedValueOnce({ id: "alpha-id", name: "alpha", image: "alpha:v1" })
      .mockResolvedValueOnce({ id: "alpha-id", name: "alpha", image: "alpha:v2" });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Source sandbox image differed between pre-mutation descriptor samples",
    );
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("blocks auto-create before deleting a destination when a gateway peer conflicts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: name === "gamma" ? "anthropic-prod" : "nvidia-nim",
      model: name === "gamma" ? "claude-new" : "nvidia/model-a",
    }));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain("gamma");
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });
});
