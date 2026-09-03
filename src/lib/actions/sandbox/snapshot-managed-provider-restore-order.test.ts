// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  MANAGED_IMAGE_REPOSITORIES,
  type ShippedManagedImageAgent,
} from "../../onboard/managed-image/contract";
import { encodeManagedStartupProfile } from "../../onboard/managed-startup/profile";

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
  const restoreDeepAgentsManagedMcpProjection = vi.fn();
  return {
    events,
    source,
    readManagedSnapshotProfileAuthority,
    prepareManagedSnapshotProfileRestore,
    requireCurrentSnapshotRuntimeProvider,
    prepareSandboxRuntimeRestore,
    confirmSandboxRuntimeRestore,
    restoreDeepAgentsManagedMcpProjection,
  };
});

vi.mock("./snapshot/dependencies", () => ({
  assertSandboxSnapshotCommandAvailable: vi.fn(),
  backupSandboxStateWithManagedAuthority: vi.fn(),
  captureSandboxRuntimeSnapshot: vi.fn(),
  confirmSandboxRuntimeRestore: providerRestore.confirmSandboxRuntimeRestore,
  prepareManagedSnapshotProfileRestore: providerRestore.prepareManagedSnapshotProfileRestore,
  prepareSandboxRuntimeRestore: providerRestore.prepareSandboxRuntimeRestore,
  readManagedSnapshotProfileAuthority: providerRestore.readManagedSnapshotProfileAuthority,
  rejectManagedSnapshotCloneUntilRebind: vi.fn(),
  requireCurrentSnapshotRuntimeProvider: providerRestore.requireCurrentSnapshotRuntimeProvider,
  restoreDeepAgentsManagedMcpProjection: providerRestore.restoreDeepAgentsManagedMcpProjection,
}));

function managedWorkload(agent: ShippedManagedImageAgent = "openclaw") {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile(agent));
  return {
    schemaVersion: 1 as const,
    kind: "managed-image" as const,
    reference: `${MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64" as const,
    release: "v0.0.100",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-123-1",
    capabilityContractVersion: 1 as const,
    startupProfileContractVersion: 1 as const,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true as const,
  };
}

function managedSnapshot(agent: ShippedManagedImageAgent = "openclaw") {
  return {
    snapshotVersion: 4,
    timestamp: "2026-07-30T00:00:00.000Z",
    backupPath: "/tmp/backup-alpha",
    agentType: agent,
    workload: managedWorkload(agent),
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
  providerRestore.restoreDeepAgentsManagedMcpProjection.mockClear();
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
    { agent: "openclaw" as const, providerChecks: 2 },
    { agent: "hermes" as const, providerChecks: 2 },
    { agent: "langchain-deepagents-code" as const, providerChecks: 3 },
  ])(
    "refreshes $agent provider authority at each mutation edge and proves the profile",
    async ({ agent, providerChecks }) => {
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
        ...Array<string>(providerChecks).fill("provider-preflight"),
        "filesystem-restore",
        "provider-restore-proof",
      ]);
      expect(providerRestore.prepareSandboxRuntimeRestore).toHaveBeenCalledTimes(providerChecks);
      expect(providerRestore.confirmSandboxRuntimeRestore).toHaveBeenCalledOnce();
    },
  );

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

  it("rejects changed provider authority before repairing the managed MCP projection (#10756)", async () => {
    fixture.getLatestBackupMock.mockReturnValue(managedSnapshot("langchain-deepagents-code"));
    fixture.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      openshellDriver: "docker",
      mcp: {
        bridges: {
          github: {
            server: "github",
            agent: "langchain-deepagents-code",
            adapter: "deepagents-config",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["GITHUB_TOKEN"],
            providerName: "alpha-mcp-github",
            policyName: "mcp-bridge-github",
            addedAt: "2026-06-01T00:00:00.000Z",
          },
        },
      },
    });
    providerRestore.readManagedSnapshotProfileAuthority.mockReturnValue({
      agent: "langchain-deepagents-code",
    });
    providerRestore.prepareManagedSnapshotProfileRestore.mockReturnValue({
      providerRestoreAuthority: {
        agent: "langchain-deepagents-code",
        profileFingerprint: "a".repeat(64),
      },
    });
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
            agent: "langchain-deepagents-code",
            profileFingerprint: "a".repeat(64),
          },
        };
      })
      .mockImplementationOnce(() => {
        providerRestore.events.push("provider-preflight-rejected");
        throw new Error("runtime changed before projection repair");
      });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(providerRestore.events).toEqual(["provider-preflight", "provider-preflight-rejected"]);
    expect(providerRestore.restoreDeepAgentsManagedMcpProjection).not.toHaveBeenCalled();
    expect(fixture.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("  Destination 'alpha' was not changed.");
  });

  it("rejects changed snapshot content before repairing the managed MCP projection (#10756)", async () => {
    fixture.getLatestBackupMock.mockReturnValue(managedSnapshot("langchain-deepagents-code"));
    fixture.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      openshellDriver: "docker",
    });
    fixture.captureSnapshotRestoreAuthorityMock
      .mockReturnValueOnce({
        schemaVersion: 1,
        backupPath: "/tmp/backup-alpha",
        contentSha256: "a".repeat(64),
      })
      .mockReturnValueOnce({
        schemaVersion: 1,
        backupPath: "/tmp/backup-alpha",
        contentSha256: "b".repeat(64),
      });
    providerRestore.readManagedSnapshotProfileAuthority.mockReturnValue({
      agent: "langchain-deepagents-code",
    });
    providerRestore.prepareManagedSnapshotProfileRestore.mockReturnValue({
      providerRestoreAuthority: {
        agent: "langchain-deepagents-code",
        profileFingerprint: "a".repeat(64),
      },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(providerRestore.restoreDeepAgentsManagedMcpProjection).not.toHaveBeenCalled();
    expect(fixture.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Selected snapshot content changed before filesystem mutation"),
    );
    expect(console.error).toHaveBeenCalledWith("  Destination 'alpha' was not changed.");
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
      workload: managedWorkload(),
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
    const source = {
      name: "alpha",
      agent: "openclaw" as const,
      openshellDriver: "docker",
      imageTag: "legacy-source:test",
      ...(managedSide === "source" ? { workload: managedWorkload() } : {}),
    };
    const destination =
      managedSide === "destination"
        ? {
            name: "beta",
            agent: "openclaw" as const,
            openshellDriver: "docker",
            imageTag: "managed-target@test",
            workload: managedWorkload(),
          }
        : null;
    fixture.getSandboxMock.mockImplementation((name) =>
      name === "alpha" ? source : name === "beta" ? destination : null,
    );
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
