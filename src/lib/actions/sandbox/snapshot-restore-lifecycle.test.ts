// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { withSandboxMutationLock } from "../../state/mcp-lifecycle-lock";
import * as f from "./snapshot-restore-test-fixture";
import * as providerAdapters from "../../adapters/openshell/managed-provider-adapter";

const tempHomes: string[] = [];
beforeAll(async () => {
  await import("./snapshot");
}, 60_000);
beforeEach(() => {
  f.resetSnapshotRestoreMocks();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-restore-home-"));
  tempHomes.push(tempHome);
  vi.stubEnv("HOME", tempHome);
});
afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
  vi.unstubAllEnvs();
  for (const tempHome of tempHomes.splice(0)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
describe("runSandboxSnapshot restore: lifecycle and destination safety", () => {
  it("holds the per-sandbox mutation lock across snapshot creation", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-create-lock-"));
    tempHomes.push(tempHome);
    vi.stubEnv("HOME", tempHome);
    let releaseLock: (() => void) | undefined;
    let signalLocked: (() => void) | undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const externalMutation = withSandboxMutationLock("alpha", async () => {
      signalLocked?.();
      await release;
    });
    await locked;
    f.backupSandboxStateMock.mockReturnValue({
      success: true,
      manifest: {
        timestamp: "2026-07-31T00:00:00.000Z",
        backupPath: "/tmp/backup-alpha",
      },
      backedUpDirs: [],
      restoredDirs: [],
      backedUpFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    f.findBackupMock.mockReturnValue({
      match: {
        snapshotVersion: 4,
        timestamp: "2026-07-31T00:00:00.000Z",
        backupPath: "/tmp/backup-alpha",
      },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    const create = runSandboxSnapshot("alpha", { kind: "create" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();

    releaseLock?.();
    await externalMutation;
    await create;
    expect(f.backupSandboxStateMock).toHaveBeenCalledWith("alpha", { name: null });
  });

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

  it.each([
    { label: "managed", fromDockerfile: undefined },
    { label: "custom-image", fromDockerfile: "/tmp/Dockerfile" },
  ])(
    "leaves user-managed Deep Agents MCP config untouched for $label restores",
    async ({ fromDockerfile }) => {
      f.getLatestBackupMock.mockReturnValue({
        snapshotVersion: 4,
        name: "stable",
        timestamp: "2026-06-15T00:00:00.000Z",
        backupPath: "/tmp/backup-alpha",
      });
      f.getSandboxMock.mockReturnValue({
        name: "alpha",
        agent: "langchain-deepagents-code",
        ...(fromDockerfile ? { fromDockerfile } : {}),
      });
      f.restoreDeepAgentsNativeMcpConfigMock.mockImplementation(() => {
        throw new Error("Snapshot restore must not rewrite user-managed native MCP config");
      });
      f.restoreSandboxStateMock.mockImplementation(() => {
        f.lifecycleMock.events.push("restore-snapshot-state");
        return {
          success: true,
          restoredDirs: [".state"],
          restoredFiles: ["config.toml"],
          failedDirs: [],
          failedFiles: [],
        };
      });
      const { runSandboxSnapshot } = await import("./snapshot");

      await runSandboxSnapshot("alpha", { kind: "restore" });

      expect(f.restoreDeepAgentsNativeMcpConfigMock).not.toHaveBeenCalled();
      expect(f.getMcpProviderInspectionRuntimeSelectionMock).not.toHaveBeenCalled();
      expect(f.lifecycleMock.events).toEqual(["restore-snapshot-state"]);
      expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    },
  );

  it("repairs mutable permissions after restoring OpenClaw config", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    f.getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
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

    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    expect(f.mutableConfigMock.repairMutableConfigPermsMock).toHaveBeenCalledWith("alpha");
    expect(f.applyPresetMock).not.toHaveBeenCalled();
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("OpenClaw config permissions restored");
    expect(output).toContain("Restored 1 directories, 1 files");
    expect(output.indexOf("OpenClaw config permissions restored")).toBeLessThan(
      output.indexOf("Restored 1 directories, 1 files"),
    );
  });

  it("fails after restore when OpenClaw config permission verification fails", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    f.getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    });
    f.mutableConfigMock.repairMutableConfigPermsMock.mockReturnValue({
      applied: true,
      verified: false,
      errors: ["openclaw.json remains read-only"],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).rejects.toMatchObject({
      exitCode: 1,
      lines: [
        "State restored into 'alpha', but OpenClaw config permissions could not be verified.",
        expect.stringContaining("nemoclaw alpha doctor --fix"),
        "Details: openclaw.json remains read-only",
      ],
    });
    expect(consoleLog.mock.calls.flat().join("\n")).not.toContain(
      "Restored 1 directories, 1 files",
    );
  });

  it("fails after restore when OpenClaw config permission repair throws", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    f.getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    });
    f.mutableConfigMock.repairMutableConfigPermsMock.mockImplementationOnce(() => {
      throw new Error("permission repair unavailable");
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).rejects.toMatchObject({
      exitCode: 1,
      lines: [
        "State restored into 'alpha', but OpenClaw config permissions could not be verified.",
        expect.stringContaining("nemoclaw alpha doctor --fix"),
        "Details: permission repair unavailable",
      ],
    });
    expect(consoleLog.mock.calls.flat().join("\n")).not.toContain(
      "Restored 1 directories, 1 files",
    );
  });

  it("finishes destination messaging cleanup before creating a forced-restore replacement (#9806)", async () => {
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
    const createAdapter = providerAdapters.createManagedProviderAdapter;
    let releaseCleanup!: () => void;
    let signalCleanupStarted!: () => void;
    const cleanupPending = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupStarted = new Promise<void>((resolve) => {
      signalCleanupStarted = resolve;
    });
    vi.spyOn(providerAdapters, "createManagedProviderAdapter").mockImplementation((run) => {
      const adapter = createAdapter(run);
      return {
        ...adapter,
        async deleteProvider(request) {
          const result = await adapter.deleteProvider(request);
          signalCleanupStarted();
          await cleanupPending;
          return result;
        },
      };
    });
    const providerDeletes = () =>
      f.runOpenshellMock.mock.calls
        .map(([args]) => args)
        .filter((args) => args[0] === "provider" && args[1] === "delete");
    let providerDeletesAtCreation: string[][] = [];
    f.streamSandboxCreateMock.mockImplementation(async () => {
      providerDeletesAtCreation = providerDeletes();
      return { status: 0, output: "", sawProgress: false, forcedReady: false };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    const restore = runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    });
    try {
      await Promise.race([
        cleanupStarted,
        restore.then(() => {
          throw new Error("Restore finished without awaiting provider cleanup.");
        }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        f.runOpenshellMock.mock.calls.map(([args]) => args).filter((args) => args[1] === "delete"),
      ).toEqual([
        ["sandbox", "delete", "-g", "nemoclaw", "beta"],
        ["provider", "delete", expect.stringMatching(/^beta-/u)],
      ]);
      expect(providerDeletes()).toHaveLength(1);
      expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
      expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    } finally {
      releaseCleanup();
      await restore;
    }

    expect(providerDeletesAtCreation.map((args) => args[2]).sort()).toEqual([
      "beta-discord-bridge",
      "beta-slack-app",
      "beta-slack-bridge",
      "beta-teams-bridge",
      "beta-telegram-bridge",
      "beta-wechat-bridge",
    ]);
    expect(providerDeletes()).toEqual(providerDeletesAtCreation);
    expect(f.streamSandboxCreateMock).toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
  });

  it.each([
    {
      label: "an unknown runtime provider",
      destination: {
        name: "beta",
        agent: "openclaw",
        imageTag: "nemoclaw-beta:test",
        openshellDriver: "future-runtime",
        provider: "nvidia-nim",
        model: "nvidia/model-a",
      },
      expected: "is not registered for this operation",
    },
    {
      label: "a mismatched legacy workload receipt",
      destination: {
        name: "beta",
        agent: "openclaw",
        imageTag: "nemoclaw-beta:current",
        openshellDriver: "docker",
        provider: "nvidia-nim",
        model: "nvidia/model-a",
        workload: {
          schemaVersion: 1 as const,
          kind: "legacy-dockerfile" as const,
          reference: "nemoclaw-beta:recorded",
          shared: false as const,
        },
      },
      expected: "could not prove ownership",
    },
  ])(
    "refuses force deletion before every side effect for $label",
    async ({ destination, expected }) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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
          : name === "beta"
            ? destination
            : null,
      );
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

      expect(consoleError.mock.calls.flat().join("\n")).toContain(expected);
      expect(f.stopNimContainerMock).not.toHaveBeenCalled();
      expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
      expect(f.lifecycleMock.events).not.toContain("delete");
      expect(f.runOpenshellMock).not.toHaveBeenCalledWith(
        expect.arrayContaining(["provider", "delete"]),
        expect.anything(),
      );
      expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
      expect(f.registerSandboxMock).not.toHaveBeenCalled();
    },
  );

  it.skip("rechecks cleanup authority inside the destination lock before every side effect", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const destination = {
      name: "beta",
      agent: "openclaw",
      imageTag: "nemoclaw-beta:test",
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
      workload: {
        schemaVersion: 1 as const,
        kind: "legacy-dockerfile" as const,
        reference: "nemoclaw-beta:test",
        shared: false as const,
      },
    };
    let lockedDestination = destination;
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
        : name === "beta"
          ? lockedDestination
          : null,
    );
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

    expect(consoleError.mock.calls.flat().join("\n")).toContain("could not prove ownership");
    expect(f.stopNimContainerMock).not.toHaveBeenCalled();
    expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.runOpenshellMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(["provider", "delete"]),
      expect.anything(),
    );
    expect(f.removeSandboxRegistryEntryOutcomeMock).not.toHaveBeenCalled();
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("stops after deleting a destination when registry removal loses authority", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const destination = {
      name: "beta",
      agent: "openclaw",
      imageTag: "nemoclaw-beta:test",
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
    };
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
        : name === "beta"
          ? destination
          : null,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.removeSandboxRegistryEntryOutcomeMock.mockReturnValue({
      status: "blocked",
      reason: "authority-unproven",
      removed: false,
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.lifecycleMock.events).toContain("delete");
    expect(consoleError.mock.calls.flat().join("\n")).toContain("registry entry was preserved");
    expect(f.getSandboxMock("beta")).toBe(destination);
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
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

    expect(f.waitForRestoredSandboxGatewaySupervisorMock).not.toHaveBeenCalled();
    expect(events).toEqual(["snapshot-restored"]);
  });

  it("restores snapshot state without a NemoClaw supervisor gate", async () => {
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
    ).resolves.toBeUndefined();

    expect(f.waitForRestoredSandboxGatewaySupervisorMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).toHaveBeenCalled();
  });

  it("preserves a changed destination row when clone finalization fails", async () => {
    const entries = new Map<string, f.SandboxRecord>([
      [
        "alpha",
        {
          name: "alpha",
          agent: "openclaw",
          imageTag: "nemoclaw-alpha:test",
          openshellDriver: "docker",
          provider: "nvidia-nim",
          model: "nvidia/model-a",
        },
      ],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.registerSandboxMock.mockImplementation((entry) => {
      const registered = { ...entry, pendingRouteReservation: true };
      entries.set(entry.name, registered);
      return registered;
    });
    let replacement: f.SandboxRecord | null = null;
    f.finalizePendingSandboxRegistrationIfCurrentMock.mockImplementation((expected) => {
      const next = {
        ...expected,
        lifecycleGeneration: "replacement-generation",
      };
      replacement = next;
      entries.set("beta", next);
      return false;
    });
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      exitCode: 1,
      lines: expect.arrayContaining([
        "Snapshot state was not restored. The current registry row was preserved.",
      ]),
    });

    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta" }),
      undefined,
      { pending: true },
    );
    expect(f.finalizePendingSandboxRegistrationIfCurrentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta" }),
    );
    expect(f.removeSandboxMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock.mock.invocationCallOrder[0]).toBeLessThan(
      f.finalizePendingSandboxRegistrationIfCurrentMock.mock.invocationCallOrder[0],
    );
    expect(entries.get("beta")).toEqual(replacement);
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("finalizes an identity-matching pending clone after a process restart", async () => {
    const pendingFingerprint = createHash("sha256").update("beta-live-id").digest("hex");
    const entries = new Map<string, f.SandboxRecord>([
      [
        "alpha",
        {
          name: "alpha",
          agent: "openclaw",
          imageTag: "nemoclaw-alpha:test",
          openshellDriver: "docker",
          provider: "nvidia-nim",
          model: "nvidia/model-a",
        },
      ],
      [
        "beta",
        {
          name: "beta",
          createdAt: "2026-08-20T00:00:00.000Z",
          pendingRouteReservation: true,
          agent: "openclaw",
          imageTag: "nemoclaw-alpha:test",
          openshellDriver: "docker",
          provider: "nvidia-nim",
          model: "nvidia/model-a",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "clone-generation",
          lifecycleLiveIdentityFingerprint: pendingFingerprint,
        },
      ],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.finalizePendingSandboxRegistrationIfCurrentMock.mockImplementation((expected) => {
      expect(expected.pendingRouteReservation).toBe(true);
      entries.set(expected.name, { ...expected, pendingRouteReservation: undefined });
      return true;
    });
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    expect(f.finalizePendingSandboxRegistrationIfCurrentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta" }),
    );
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
    expect(entries.get("beta")?.pendingRouteReservation).toBeUndefined();
  });

  it("refuses snapshot recovery of a session-owned pending registration", async () => {
    const pendingFingerprint = createHash("sha256").update("beta-live-id").digest("hex");
    const entries = new Map<string, f.SandboxRecord>([
      [
        "alpha",
        {
          name: "alpha",
          agent: "openclaw",
          imageTag: "nemoclaw-alpha:test",
          openshellDriver: "docker",
          provider: "nvidia-nim",
          model: "nvidia/model-a",
        },
      ],
      [
        "beta",
        {
          name: "beta",
          createdAt: "2026-08-20T00:00:00.000Z",
          pendingRouteReservation: true,
          reservationSessionId: "onboard-session",
          agent: "openclaw",
          imageTag: "nemoclaw-alpha:test",
          openshellDriver: "docker",
          provider: "nvidia-nim",
          model: "nvidia/model-a",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "clone-generation",
          lifecycleLiveIdentityFingerprint: pendingFingerprint,
        },
      ],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.finalizePendingSandboxRegistrationIfCurrentMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(entries.get("beta")).toMatchObject({
      pendingRouteReservation: true,
      reservationSessionId: "onboard-session",
    });
  });

  it.each(["absent", "identity-drifted"] as const)(
    "cleans an %s pending clone before recreating it after a process restart",
    async (state) => {
      const entries = new Map<string, f.SandboxRecord>([
        [
          "alpha",
          {
            name: "alpha",
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          },
        ],
        [
          "beta",
          {
            name: "beta",
            createdAt: "2026-08-20T00:00:00.000Z",
            pendingRouteReservation: true,
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
            gatewayName: "nemoclaw",
            lifecycleGeneration: "clone-generation",
            lifecycleLiveIdentityFingerprint: createHash("sha256")
              .update("expected-live-id")
              .digest("hex"),
          },
        ],
      ]);
      f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
      f.parseLiveSandboxNamesMock.mockImplementation(
        (output: string) => new Set(output.includes("beta Ready") ? ["alpha", "beta"] : ["alpha"]),
      );
      f.removeSandboxRegistryEntryOutcomeMock.mockImplementation((name) => {
        entries.delete(name);
        return { status: "complete", removed: true };
      });
      f.registerSandboxMock.mockImplementation((entry) => {
        const registered = { ...entry, pendingRouteReservation: true };
        entries.set(entry.name, registered);
        return registered;
      });
      f.finalizePendingSandboxRegistrationIfCurrentMock.mockImplementation((expected) => {
        expect(expected.pendingRouteReservation).toBe(true);
        entries.set(expected.name, { ...expected, pendingRouteReservation: undefined });
        return true;
      });
      f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
      let gatewayListCalls = 0;
      f.captureOpenshellMock.mockImplementation((args) => {
        gatewayListCalls += Number(
          args[0] === "sandbox" && args[1] === "list" && args.includes("-g"),
        );
        const betaIsVisible = state === "identity-drifted" || gatewayListCalls > 1;
        return f.openshellResponses(args, {
          "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
          "sandbox list": {
            status: 0,
            output: betaIsVisible ? "alpha Ready\nbeta Ready\n" : "alpha Ready\n",
          },
        });
      });
      const { runSandboxSnapshot } = await import("./snapshot");

      await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

      expect(f.removeSandboxRegistryEntryOutcomeMock).toHaveBeenCalledWith("beta");
      expect(f.streamSandboxCreateMock).toHaveBeenCalledTimes(1);
      expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
    },
  );

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

  it.each(["hermes", "langchain-deepagents-code"])(
    "does not run OpenClaw pairing for a cross-sandbox %s restore (#7431)",
    async (agent) => {
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
    },
  );

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
