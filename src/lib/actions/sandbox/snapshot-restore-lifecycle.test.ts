// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withSandboxMutationLock } from "../../state/mcp-lifecycle-lock";
import * as f from "./snapshot-restore-test-fixture";

const tempHomes: string[] = [];
beforeEach(() => {
  f.resetSnapshotRestoreMocks();
});
afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
  for (const tempHome of tempHomes.splice(0)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
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
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.lifecycleMock.events).toContain("lock:restore sandbox snapshot");
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    expect(f.shieldsMock.repairMutableConfigPermsMock).toHaveBeenCalledWith("alpha");
    expect(f.applyPresetMock).toHaveBeenCalledWith("alpha", "github");
  });

  it("hardens an active timer window before force-deleting a restore destination", async () => {
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
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
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
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
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
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
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

  it("holds the source and destination mutation locks until a cross-sandbox restore finishes (#7178)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-locks-"));
    tempHomes.push(tempHome);
    vi.stubEnv("HOME", tempHome);
    const events: string[] = [];
    let cloneCreated = false;
    let releaseCreate: (() => void) | undefined;
    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createRelease = new Promise<void>((resolve) => {
      releaseCreate = resolve;
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
        : null,
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": {
          status: 0,
          output: cloneCreated ? "alpha Ready\nbeta Ready\n" : "alpha Ready\n",
        },
      }),
    );
    f.streamSandboxCreateMock.mockImplementation(async () => {
      events.push("create-started");
      signalCreateStarted?.();
      await createRelease;
      cloneCreated = true;
      events.push("create-released");
      return { status: 0, output: "", sawProgress: false, forcedReady: false };
    });
    f.restoreSandboxStateMock.mockImplementation(() => {
      events.push("snapshot-restored");
      return {
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    const restore = runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
    await createStarted;
    const sourceMutation = withSandboxMutationLock("alpha", () => {
      events.push("source-mutation");
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(events).toEqual(["create-started"]);

    releaseCreate?.();
    await restore;
    await sourceMutation;

    expect(events).toEqual([
      "create-started",
      "create-released",
      "snapshot-restored",
      "source-mutation",
    ]);
  });

  it("proves the clone supervisor is ready before restoring snapshot state (#7818)", async () => {
    const events: string[] = [];
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
        : null,
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.streamSandboxCreateMock.mockResolvedValue({
      status: 0,
      output: "Sandbox reported Ready before create stream exited; continuing.",
      sawProgress: true,
      forcedReady: true,
    });
    f.waitForRestoredSandboxGatewaySupervisorMock.mockImplementation(() => {
      events.push("supervisor-ready");
      return true;
    });
    f.restoreSandboxStateMock.mockImplementation(() => {
      events.push("snapshot-restored");
      return {
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    expect(f.waitForRestoredSandboxGatewaySupervisorMock).toHaveBeenCalledWith("beta");
    expect(events).toEqual(["supervisor-ready", "snapshot-restored"]);
  });

  it("leaves snapshot state untouched when the clone supervisor never becomes ready (#7818)", async () => {
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
        : null,
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.waitForRestoredSandboxGatewaySupervisorMock.mockReturnValue(false);
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("blocks a cross-sandbox clone before deleting the target when source policy repair is pending (#7178)", async () => {
    const common = {
      agent: "openclaw",
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
    };
    f.getSandboxMock.mockImplementation((name) => {
      return name === "alpha"
        ? {
            ...common,
            name: "alpha",
            imageTag: "nemoclaw-alpha:test",
            baselineExclusionTransition: {
              id: "0b2f3297-a9ab-4c2f-80da-bf1760a1afbf",
              operation: "restore",
              exclusion: {
                version: 1 as const,
                agent: "openclaw",
                key: "agents.openclaw.default",
                digest: "a".repeat(64),
              },
              startedAt: "2026-07-19T00:00:00.000Z",
              targetLiveDigest: "b".repeat(64),
            },
          }
        : name === "beta"
          ? { ...common, name: "beta", imageTag: "nemoclaw-beta:test" }
          : null;
    });
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
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
    ).rejects.toThrow(
      "Cannot clone baseline policy while 'restore agents.openclaw.default' needs repair",
    );

    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("blocks a forced clone before deleting a destination whose policy repair is pending (#7178)", async () => {
    const pendingTransition = {
      id: "0b2f3297-a9ab-4c2f-80da-bf1760a1afbf",
      operation: "restore" as const,
      exclusion: {
        version: 1 as const,
        agent: "openclaw",
        key: "agents.openclaw.default",
        digest: "a".repeat(64),
      },
      startedAt: "2026-07-19T00:00:00.000Z",
      targetLiveDigest: "b".repeat(64),
    };
    f.getSandboxMock.mockImplementation((name) =>
      name
        ? {
            name,
            agent: "openclaw",
            imageTag: `nemoclaw-${name}:test`,
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
            ...(name === "beta" ? { baselineExclusionTransition: pendingTransition } : {}),
          }
        : null,
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });
});

describe("runSandboxSnapshot restore: gateway pairing on a freshly created destination", () => {
  it("provokes and approves device pairing after a cross-sandbox restore", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
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
        : null,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
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

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true });

    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
    expect(f.establishRestoredSandboxGatewayPairingMock).toHaveBeenCalledWith("beta");
  });

  it("fails with repair guidance when restored gateway pairing cannot be verified (#7431)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
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
        : null,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
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
    f.establishRestoredSandboxGatewayPairingMock.mockImplementationOnce(() => {
      throw new Error("authenticated gateway verification failed");
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true }),
    ).rejects.toMatchObject({
      exitCode: 1,
      lines: [
        "State restored into 'beta', but gateway pairing could not be verified.",
        "Run `nemoclaw beta connect` to retry pairing before running an agent.",
        expect.stringContaining("authenticated gateway verification failed"),
      ],
    });
  });

  it.each([
    "hermes",
    "langchain-deepagents-code",
  ])("does not run OpenClaw pairing for a cross-sandbox %s restore (#7431)", async (agent) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent,
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : null,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true });

    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("leaves the working gateway credentials untouched on a self-restore", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
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
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });
});
