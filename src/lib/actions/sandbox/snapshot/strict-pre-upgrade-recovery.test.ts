// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureRecordedSandboxBasePolicy: vi.fn(),
  observeMcpStateForRebuild: vi.fn(),
  removeSandboxStateBackup: vi.fn(),
  writeRebuildMcpHandoff: vi.fn(),
  writeRebuildPolicyHandoff: vi.fn(),
}));

vi.mock("../../../policy", () => ({
  captureRecordedSandboxBasePolicy: mocks.captureRecordedSandboxBasePolicy,
}));
vi.mock("../../../state/sandbox", () => ({
  removeSandboxStateBackup: mocks.removeSandboxStateBackup,
  writeRebuildMcpHandoff: mocks.writeRebuildMcpHandoff,
  writeRebuildPolicyHandoff: mocks.writeRebuildPolicyHandoff,
}));
vi.mock("../rebuild-mcp-phase", () => ({
  observeMcpStateForRebuild: mocks.observeMcpStateForRebuild,
}));

import { retainStrictPreUpgradeRecoveryState } from "./strict-pre-upgrade-recovery";

const sandbox = { name: "alpha", gatewayName: "recorded-gateway" };
const runtimeSelection = { gatewayName: "recorded-gateway", workspace: "default" };

describe("strict pre-upgrade recovery retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeSandboxStateBackup.mockReturnValue(true);
    mocks.captureRecordedSandboxBasePolicy.mockResolvedValue("version: 1\n");
    mocks.observeMcpStateForRebuild.mockResolvedValue({ entries: [] });
    mocks.writeRebuildPolicyHandoff.mockImplementation((manifest) => ({
      ...manifest,
      rebuildPolicyHandoff: { file: "policy.yaml", sha256: "a".repeat(64) },
    }));
    mocks.writeRebuildMcpHandoff.mockImplementation((manifest, entries, runtimeSelection) => ({
      ...manifest,
      rebuildMcpHandoff: { entries, runtimeSelection },
    }));
  });

  it("binds policy and an explicit empty MCP observation to a successful backup", async () => {
    const result = {
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/alpha/timestamp" },
    };

    await expect(
      retainStrictPreUpgradeRecoveryState(sandbox as never, result as never, runtimeSelection),
    ).resolves.toMatchObject({
      manifest: {
        rebuildPolicyHandoff: expect.any(Object),
        rebuildMcpHandoff: {
          entries: [],
          runtimeSelection: { gatewayName: "recorded-gateway", workspace: "default" },
        },
      },
    });
    expect(mocks.observeMcpStateForRebuild).toHaveBeenCalledWith(sandbox, runtimeSelection, true);
  });

  it("preserves observed MCP entries and their runtime authority", async () => {
    const entries = [{ server: "github" }];
    const observedRuntimeSelection = {
      gatewayName: "recorded-gateway",
      workspace: "default",
      localTlsDir: "/state/tls",
    };
    mocks.observeMcpStateForRebuild.mockResolvedValue({
      entries,
      runtimeSelection: observedRuntimeSelection,
    });
    const result = {
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/alpha/timestamp" },
    };

    await retainStrictPreUpgradeRecoveryState(sandbox as never, result as never, runtimeSelection);

    expect(mocks.writeRebuildMcpHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ rebuildPolicyHandoff: expect.any(Object) }),
      entries,
      observedRuntimeSelection,
    );
  });

  it("removes a failed strict backup before returning the failure", async () => {
    const result = {
      success: false,
      backedUpDirs: [],
      failedDirs: ["workspace"],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/alpha/timestamp" },
    };

    await expect(
      retainStrictPreUpgradeRecoveryState(sandbox as never, result as never, runtimeSelection),
    ).resolves.not.toHaveProperty("manifest");
    expect(mocks.removeSandboxStateBackup).toHaveBeenCalledWith(
      "alpha",
      "/backups/alpha/timestamp",
    );
  });

  it("reports cleanup failure without hiding the original backup failure", async () => {
    mocks.removeSandboxStateBackup.mockReturnValue(false);
    const result = {
      success: false,
      error: "backup failed",
      backedUpDirs: [],
      failedDirs: ["workspace"],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/alpha/timestamp" },
    };

    await expect(
      retainStrictPreUpgradeRecoveryState(sandbox as never, result as never, runtimeSelection),
    ).resolves.toMatchObject({
      error:
        "backup failed. Failed strict pre-upgrade backup at '/backups/alpha/timestamp' could not be removed",
    });
  });

  it("fails closed when a successful backup has no published manifest", async () => {
    await expect(
      retainStrictPreUpgradeRecoveryState(
        sandbox as never,
        {
          success: true,
          backedUpDirs: ["workspace"],
          failedDirs: [],
          backedUpFiles: [],
          failedFiles: [],
        } as never,
        runtimeSelection,
      ),
    ).rejects.toThrow("completed without a published manifest");
    expect(mocks.captureRecordedSandboxBasePolicy).not.toHaveBeenCalled();
  });

  it("skips the policy capture and discards the snapshot once the deadline expires (#11936)", async () => {
    const result = {
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/alpha/timestamp" },
    };

    await expect(
      retainStrictPreUpgradeRecoveryState(
        sandbox as never,
        result as never,
        runtimeSelection,
        10_000,
        () => 10_000,
      ),
    ).resolves.toMatchObject({
      success: false,
      error:
        "Strict pre-upgrade recovery retention skipped the policy capture: backup deadline expired",
    });
    expect(mocks.captureRecordedSandboxBasePolicy).not.toHaveBeenCalled();
    expect(mocks.observeMcpStateForRebuild).not.toHaveBeenCalled();
    expect(mocks.removeSandboxStateBackup).toHaveBeenCalledWith(
      "alpha",
      "/backups/alpha/timestamp",
    );
  });

  it("does not start the MCP observation when the policy capture reaches the deadline (#11936)", async () => {
    let now = 9_000;
    mocks.captureRecordedSandboxBasePolicy.mockImplementation(async () => {
      now = 10_000;
      return "version: 1\n";
    });
    const result = {
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/alpha/timestamp" },
    };

    await expect(
      retainStrictPreUpgradeRecoveryState(
        sandbox as never,
        result as never,
        runtimeSelection,
        10_000,
        () => now,
      ),
    ).resolves.toMatchObject({
      success: false,
      error:
        "Strict pre-upgrade recovery retention skipped the MCP observation: backup deadline expired",
    });
    expect(mocks.captureRecordedSandboxBasePolicy).toHaveBeenCalledOnce();
    expect(mocks.observeMcpStateForRebuild).not.toHaveBeenCalled();
    expect(mocks.writeRebuildPolicyHandoff).not.toHaveBeenCalled();
  });

  it("completes both observations while the deadline leaves time", async () => {
    const result = {
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/alpha/timestamp" },
    };

    await expect(
      retainStrictPreUpgradeRecoveryState(
        sandbox as never,
        result as never,
        runtimeSelection,
        10_000,
        () => 1_000,
      ),
    ).resolves.toMatchObject({ success: true });
    expect(mocks.observeMcpStateForRebuild).toHaveBeenCalledWith(sandbox, runtimeSelection, true);
    expect(mocks.removeSandboxStateBackup).not.toHaveBeenCalled();
  });

  it("does not publish either handoff when MCP observation fails", async () => {
    mocks.observeMcpStateForRebuild.mockRejectedValue(new Error("MCP observation unavailable"));
    const result = {
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/alpha/timestamp" },
    };

    await expect(
      retainStrictPreUpgradeRecoveryState(sandbox as never, result as never, runtimeSelection),
    ).rejects.toThrow("MCP observation unavailable");
    expect(mocks.writeRebuildPolicyHandoff).not.toHaveBeenCalled();
    expect(mocks.writeRebuildMcpHandoff).not.toHaveBeenCalled();
  });
});
