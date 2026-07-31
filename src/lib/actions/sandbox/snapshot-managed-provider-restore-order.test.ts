// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fixture from "./snapshot-restore-test-fixture";

const providerRestore = vi.hoisted(() => {
  const events: string[] = [];
  const provider = { identity: { id: "docker" } };
  const managedProfile = {
    agent: "openclaw",
    profileFingerprint: "a".repeat(64),
  };
  const source = {
    schemaVersion: 1,
    providerId: "docker",
    providerHandle: "snapshot-provider-handle",
    lifecycleState: "running",
    lifecycleGeneration: "snapshot-generation",
    runtime: {
      schemaVersion: 1,
      providerId: "docker",
      runtime: { kind: "docker-container", handle: "container-id" },
      acceleration: { kind: "none" },
    },
  };
  const readManagedSnapshotProfileAuthority = vi.fn(
    (_source?: unknown): { agent: string } | null => ({
      agent: "openclaw",
    }),
  );
  const prepareManagedSnapshotProfileRestore = vi.fn(() => ({
    providerRestoreAuthority: managedProfile,
  }));
  const requireCurrentSnapshotRuntimeProvider = vi.fn(() => provider);
  const prepareSandboxRuntimeRestore = vi.fn(() => {
    events.push("provider-preflight");
    return {
      phase: "preflighted",
      targetProviderId: "docker",
      targetSandboxName: "alpha",
      source,
      preflight: {},
      managedProfile,
    };
  });
  const confirmSandboxRuntimeRestore = vi.fn(() => {
    events.push("provider-restore-proof");
    return { phase: "validated" };
  });
  return {
    events,
    source,
    readManagedSnapshotProfileAuthority,
    prepareManagedSnapshotProfileRestore,
    requireCurrentSnapshotRuntimeProvider,
    prepareSandboxRuntimeRestore,
    confirmSandboxRuntimeRestore,
  };
});

vi.mock("./snapshot/dependencies", () => ({
  backupSandboxStateWithManagedAuthority: vi.fn(),
  captureSandboxRuntimeSnapshot: vi.fn(),
  confirmSandboxRuntimeRestore: providerRestore.confirmSandboxRuntimeRestore,
  prepareManagedSnapshotProfileRestore: providerRestore.prepareManagedSnapshotProfileRestore,
  prepareSandboxRuntimeRestore: providerRestore.prepareSandboxRuntimeRestore,
  readManagedSnapshotProfileAuthority: providerRestore.readManagedSnapshotProfileAuthority,
  rejectManagedSnapshotCloneUntilRebind: vi.fn(),
  requireCurrentSnapshotRuntimeProvider: providerRestore.requireCurrentSnapshotRuntimeProvider,
}));

function managedSnapshot(agent = "openclaw") {
  return {
    snapshotVersion: 4,
    timestamp: "2026-07-30T00:00:00.000Z",
    backupPath: "/tmp/backup-alpha",
    agentType: agent,
    workload: { kind: "managed-image" },
    runtimeSnapshot: providerRestore.source,
  };
}

beforeEach(() => {
  fixture.resetSnapshotRestoreMocks();
  providerRestore.events.length = 0;
  providerRestore.readManagedSnapshotProfileAuthority.mockClear();
  providerRestore.prepareManagedSnapshotProfileRestore.mockClear();
  providerRestore.requireCurrentSnapshotRuntimeProvider.mockClear();
  providerRestore.prepareSandboxRuntimeRestore.mockClear();
  providerRestore.confirmSandboxRuntimeRestore.mockClear();
  fixture.getLatestBackupMock.mockReturnValue(managedSnapshot());
  fixture.getSandboxMock.mockReturnValue({
    name: "alpha",
    agent: "openclaw",
    openshellDriver: "docker",
  });
  fixture.restoreSandboxStateMock.mockImplementation((_name, _path, options) => {
    try {
      options?.validateBeforeMutation?.();
    } catch (error) {
      return {
        success: false,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: ["workspace"],
        failedFiles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    providerRestore.events.push("filesystem-restore");
    return {
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    };
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fixture.cleanupSnapshotRestoreMocks();
});

describe("managed snapshot provider restore ordering", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("refreshes %s provider authority at the mutation edge and proves the profile", async (agent) => {
    fixture.getLatestBackupMock.mockReturnValue(managedSnapshot(agent));
    fixture.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent,
      openshellDriver: "docker",
    });
    providerRestore.readManagedSnapshotProfileAuthority.mockReturnValue({ agent });
    providerRestore.prepareManagedSnapshotProfileRestore.mockReturnValue({
      providerRestoreAuthority: {
        agent,
        profileFingerprint: "a".repeat(64),
      },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(providerRestore.events).toEqual([
      "provider-preflight",
      "provider-preflight",
      "filesystem-restore",
      "provider-restore-proof",
    ]);
    expect(providerRestore.prepareSandboxRuntimeRestore).toHaveBeenCalledTimes(2);
    expect(providerRestore.confirmSandboxRuntimeRestore).toHaveBeenCalledOnce();
  });

  it("aborts before filesystem mutation when mutation-edge validation fails", async () => {
    providerRestore.prepareSandboxRuntimeRestore
      .mockImplementationOnce(() => {
        providerRestore.events.push("provider-preflight");
        return {
          phase: "preflighted",
          targetProviderId: "docker",
          targetSandboxName: "alpha",
          source: providerRestore.source,
          preflight: {},
          managedProfile: {
            agent: "openclaw",
            profileFingerprint: "a".repeat(64),
          },
        };
      })
      .mockImplementationOnce(() => {
        providerRestore.events.push("provider-preflight-rejected");
        throw new Error("runtime changed after snapshot preflight");
      });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(providerRestore.events).toEqual(["provider-preflight", "provider-preflight-rejected"]);
    expect(fixture.restoreSandboxStateMock).toHaveBeenCalledWith(
      "alpha",
      "/tmp/backup-alpha",
      expect.objectContaining({ validateBeforeMutation: expect.any(Function) }),
    );
    expect(providerRestore.confirmSandboxRuntimeRestore).not.toHaveBeenCalled();
  });
});

describe("legacy snapshot compatibility gate", () => {
  beforeEach(() => {
    fixture.getLatestBackupMock.mockReturnValue({
      snapshotVersion: 3,
      timestamp: "2026-07-29T00:00:00.000Z",
      backupPath: "/tmp/legacy-backup-alpha",
      agentType: "openclaw",
    });
    providerRestore.readManagedSnapshotProfileAuthority.mockImplementation((source: unknown) =>
      (source as { workload?: unknown }).workload ? { agent: "openclaw" } : null,
    );
  });

  it("rejects self-restore when the current target is managed", async () => {
    fixture.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      openshellDriver: "docker",
      workload: { kind: "managed-image" },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("legacy snapshot lacks managed workload"),
    );
    expect(fixture.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(providerRestore.prepareSandboxRuntimeRestore).not.toHaveBeenCalled();
  });

  it.each([
    "source",
    "destination",
  ] as const)("rejects cross-clone when the current %s is managed", async (managedSide) => {
    fixture.getSandboxMock.mockImplementation((name) => {
      if (name === "alpha") {
        return {
          name,
          agent: "openclaw",
          openshellDriver: "docker",
          imageTag: "legacy-source:test",
          ...(managedSide === "source" ? { workload: { kind: "managed-image" } } : {}),
        };
      }
      if (name === "beta" && managedSide === "destination") {
        return {
          name,
          agent: "openclaw",
          openshellDriver: "docker",
          imageTag: "managed-target@test",
          workload: { kind: "managed-image" },
        };
      }
      return null;
    });
    fixture.parseLiveSandboxNamesMock.mockReturnValue(
      new Set(managedSide === "destination" ? ["alpha", "beta"] : ["alpha"]),
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

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("legacy snapshot lacks managed workload"),
    );
    expect(
      fixture.runOpenshellMock.mock.calls.some(
        ([args]) => args[0] === "sandbox" && args[1] === "delete",
      ),
    ).toBe(false);
    expect(fixture.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(fixture.restoreSandboxStateMock).not.toHaveBeenCalled();
  });
});
