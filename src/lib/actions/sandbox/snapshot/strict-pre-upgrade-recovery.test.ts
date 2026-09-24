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

import {
  discardIncompleteStrictBackup,
  retainStrictPreUpgradeRecoveryState,
} from "./strict-pre-upgrade-recovery";

const sandbox = { name: "alpha", gatewayName: "recorded-gateway" };
const runtimeSelection = {
  gatewayName: "recorded-gateway",
  workspace: "default",
};

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
          runtimeSelection: {
            gatewayName: "recorded-gateway",
            workspace: "default",
          },
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

  it("returns a failed strict backup for lifecycle-safe caller cleanup", async () => {
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
    ).resolves.toHaveProperty("manifest.backupPath", "/backups/alpha/timestamp");
    expect(mocks.removeSandboxStateBackup).not.toHaveBeenCalled();
  });

  it("reports deferred cleanup failure without hiding the original backup failure", () => {
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

    expect(discardIncompleteStrictBackup(sandbox as never, result as never, 12_345)).toMatchObject({
      error:
        "backup failed. Failed strict pre-upgrade backup at '/backups/alpha/timestamp' could not be removed",
    });
    expect(mocks.removeSandboxStateBackup).toHaveBeenCalledWith(
      "alpha",
      "/backups/alpha/timestamp",
      12_345,
    );
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

  it("skips policy capture and returns a failed result for caller cleanup after expiry (#11936)", async () => {
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
        "Strict pre-upgrade recovery retention did not complete the policy capture before the backup deadline",
    });
    expect(mocks.captureRecordedSandboxBasePolicy).not.toHaveBeenCalled();
    expect(mocks.observeMcpStateForRebuild).not.toHaveBeenCalled();
    expect(mocks.removeSandboxStateBackup).not.toHaveBeenCalled();
  });

  it("waits for a timed-out policy capture to terminate before cleanup (#11936)", async () => {
    let observationSettled = false;
    mocks.captureRecordedSandboxBasePolicy.mockImplementation(
      async (_name, _operation, _runtime, deadlineMs: number | undefined) => {
        expect(deadlineMs).toBeTypeOf("number");
        await new Promise((resolve) => setTimeout(resolve, 30));
        observationSettled = true;
        throw new Error("policy child terminated at its deadline");
      },
    );
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
        Date.now() + 25,
      ),
    ).resolves.toMatchObject({
      success: false,
      error:
        "Strict pre-upgrade recovery retention did not complete the policy capture before the backup deadline",
    });
    expect(mocks.captureRecordedSandboxBasePolicy).toHaveBeenCalledOnce();
    expect(observationSettled).toBe(true);
    expect(mocks.observeMcpStateForRebuild).not.toHaveBeenCalled();
    expect(mocks.writeRebuildPolicyHandoff).not.toHaveBeenCalled();
    expect(mocks.removeSandboxStateBackup).not.toHaveBeenCalled();
  });

  it("waits for a timed-out MCP observation to terminate before cleanup (#11936)", async () => {
    let observationSettled = false;
    mocks.observeMcpStateForRebuild.mockImplementation(
      async (_sandbox, _runtime, _inspect, deadline: { deadlineMs: number } | undefined) => {
        expect(deadline?.deadlineMs).toBeTypeOf("number");
        await new Promise((resolve) => setTimeout(resolve, 30));
        observationSettled = true;
        throw new Error("MCP child terminated at its deadline");
      },
    );
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
        Date.now() + 25,
      ),
    ).resolves.toMatchObject({
      success: false,
      error:
        "Strict pre-upgrade recovery retention did not complete the MCP observation before the backup deadline",
    });
    expect(mocks.observeMcpStateForRebuild).toHaveBeenCalledOnce();
    expect(observationSettled).toBe(true);
    expect(mocks.writeRebuildPolicyHandoff).not.toHaveBeenCalled();
    expect(mocks.writeRebuildMcpHandoff).not.toHaveBeenCalled();
    expect(mocks.removeSandboxStateBackup).not.toHaveBeenCalled();
  });

  it("rejects a policy capture that reaches the deadline before MCP observation (#11936)", async () => {
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
        "Strict pre-upgrade recovery retention did not complete the policy capture before the backup deadline",
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
    expect(mocks.observeMcpStateForRebuild).toHaveBeenCalledWith(sandbox, runtimeSelection, true, {
      deadlineMs: 10_000,
      now: expect.any(Function),
    });
    expect(mocks.removeSandboxStateBackup).not.toHaveBeenCalled();
  });

  it("returns a failed result without publishing either handoff when MCP observation fails", async () => {
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
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("MCP observation unavailable"),
      manifest: { backupPath: "/backups/alpha/timestamp" },
    });
    expect(mocks.writeRebuildPolicyHandoff).not.toHaveBeenCalled();
    expect(mocks.writeRebuildMcpHandoff).not.toHaveBeenCalled();
    expect(mocks.removeSandboxStateBackup).not.toHaveBeenCalled();
  });

  it("fails safely for caller cleanup when MCP handoff publication fails", async () => {
    mocks.writeRebuildMcpHandoff.mockImplementation(() => {
      throw new Error("MCP handoff write failed");
    });
    const result = {
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/alpha/timestamp" },
    };

    const failed = await retainStrictPreUpgradeRecoveryState(
      sandbox as never,
      result as never,
      runtimeSelection,
    );

    expect(failed).toMatchObject({
      success: false,
      error: expect.stringContaining("MCP handoff write failed"),
      manifest: { backupPath: "/backups/alpha/timestamp" },
    });
    expect(mocks.writeRebuildPolicyHandoff).toHaveBeenCalledOnce();
    expect(discardIncompleteStrictBackup(sandbox as never, failed, 12_345)).not.toHaveProperty(
      "manifest",
    );
    expect(mocks.removeSandboxStateBackup).toHaveBeenCalledWith(
      "alpha",
      "/backups/alpha/timestamp",
      12_345,
    );
  });

  it("returns a failed result for a non-timeout policy error", async () => {
    mocks.captureRecordedSandboxBasePolicy.mockRejectedValue(new Error("policy unavailable"));
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
      success: false,
      error: expect.stringContaining("policy unavailable"),
      manifest: { backupPath: "/backups/alpha/timestamp" },
    });
    expect(mocks.observeMcpStateForRebuild).not.toHaveBeenCalled();
    expect(mocks.removeSandboxStateBackup).not.toHaveBeenCalled();
  });
});
