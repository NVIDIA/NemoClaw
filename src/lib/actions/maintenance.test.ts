// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSandboxes: vi.fn(),
  backupSandboxState: vi.fn(),
  detectOpenShellStateRpcPreflightIssue: vi.fn().mockReturnValue(null),
  detectOpenShellStateRpcResultIssue: vi.fn().mockReturnValue(null),
  printOpenShellStateRpcIssue: vi.fn(),
  captureSandboxListWithGatewayRecovery: vi.fn(),
  printSandboxListFailureWithRecoveryContext: vi.fn(),
  parseReadySandboxNames: vi.fn(),
  dockerListImagesFormat: vi.fn().mockReturnValue(""),
  dockerRmi: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock("../state/registry", () => ({
  listSandboxes: mocks.listSandboxes,
}));
vi.mock("../state/sandbox", () => ({
  backupSandboxState: mocks.backupSandboxState,
  BackupResult: {},
}));
vi.mock("../adapters/openshell/gateway-drift", () => ({
  detectOpenShellStateRpcPreflightIssue: mocks.detectOpenShellStateRpcPreflightIssue,
  detectOpenShellStateRpcResultIssue: mocks.detectOpenShellStateRpcResultIssue,
  printOpenShellStateRpcIssue: mocks.printOpenShellStateRpcIssue,
}));
vi.mock("../openshell-sandbox-list", () => ({
  captureSandboxListWithGatewayRecovery: mocks.captureSandboxListWithGatewayRecovery,
  printSandboxListFailureWithRecoveryContext: mocks.printSandboxListFailureWithRecoveryContext,
}));
vi.mock("../runtime-recovery", () => ({
  parseReadySandboxNames: mocks.parseReadySandboxNames,
}));
vi.mock("../adapters/docker", () => ({
  dockerListImagesFormat: mocks.dockerListImagesFormat,
  dockerRmi: mocks.dockerRmi,
}));
vi.mock("../cli/branding", () => ({
  CLI_NAME: "nemoclaw",
}));
vi.mock("../credentials/store", () => ({
  prompt: mocks.prompt,
}));
vi.mock("../domain/lifecycle/options", () => ({
  normalizeGarbageCollectImagesOptions: (o: unknown) => o || {},
}));
vi.mock("../domain/maintenance/images", () => ({
  findOrphanedSandboxImages: vi.fn().mockReturnValue([]),
  parseSandboxImageRows: vi.fn().mockReturnValue([]),
}));

import { backupAll } from "./maintenance";

describe("backupAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureSandboxListWithGatewayRecovery.mockResolvedValue({
      result: { status: 0, output: "sb-good\nsb-bad\n" },
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-good", "sb-bad"]));
  });

  it("continues backup loop when backupSandboxState throws for one sandbox", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-bad" }, { name: "sb-good" }],
      defaultSandbox: null,
    });

    // First sandbox throws (simulating missing agent manifest)
    mocks.backupSandboxState.mockImplementationOnce(() => {
      throw new Error("Agent 'unknown-agent' not found: /path/to/manifest.yaml");
    });

    // Second sandbox succeeds
    mocks.backupSandboxState.mockImplementationOnce(() => ({
      success: true,
      backedUpDirs: ["dir1"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/sb-good/timestamp" },
    }));

    // Should not throw — the loop should catch and continue
    await backupAll();

    // Both sandboxes should have been attempted
    expect(mocks.backupSandboxState).toHaveBeenCalledTimes(2);
    expect(mocks.backupSandboxState).toHaveBeenCalledWith("sb-bad");
    expect(mocks.backupSandboxState).toHaveBeenCalledWith("sb-good");
  });

  it("counts thrown sandboxes as skipped, not failed", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-bad" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-bad"]));
    mocks.captureSandboxListWithGatewayRecovery.mockResolvedValue({
      result: { status: 0, output: "sb-bad\n" },
    });

    mocks.backupSandboxState.mockImplementation(() => {
      throw new Error("Agent 'orphan' not found: /agents/orphan/manifest.yaml");
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await backupAll();

    // Should log "Skipped" warning, not "backup failed"
    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Skipped");
    expect(output).toContain("orphan");
    expect(output).toContain("0 failed");
    expect(output).toContain("1 skipped");
    consoleSpy.mockRestore();
  });

  it("re-throws non-orphan-manifest errors so the installer aborts the upgrade", async () => {
    // Real failures (disk full, SSH timeout, permission denied, programming
    // bugs) must propagate. Counting them as 'skipped' and returning exit 0
    // would let the installer march forward with a corrupt or absent backup
    // and silently lose state on restore.
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-bad" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-bad"]));
    mocks.captureSandboxListWithGatewayRecovery.mockResolvedValue({
      result: { status: 0, output: "sb-bad\n" },
    });

    mocks.backupSandboxState.mockImplementation(() => {
      throw new Error("EACCES: permission denied, open '/var/backups/state'");
    });

    await expect(backupAll()).rejects.toThrow(/EACCES/);
  });

  it("re-throws an Agent-not-found message without the `: manifest.yaml` suffix (loadAgent contract)", async () => {
    // The orphan-manifest matcher is anchored to the exact loadAgent() shape
    // `Agent '<name>' not found: <manifestPath>`. A bare `Agent '...' not found`
    // could plausibly surface from a different layer (registry lookup, manifest
    // index, future code) and should still abort the batch instead of being
    // silently skipped as if it were a missing manifest file.
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-bad" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-bad"]));
    mocks.captureSandboxListWithGatewayRecovery.mockResolvedValue({
      result: { status: 0, output: "sb-bad\n" },
    });

    mocks.backupSandboxState.mockImplementation(() => {
      throw new Error("Agent 'phantom' not found");
    });

    await expect(backupAll()).rejects.toThrow(/Agent 'phantom' not found/);
  });

  it("re-throws an Agent-not-found message whose path does not end in manifest.yaml", async () => {
    // The matcher is anchored to the manifest file path loadAgent() emits
    // (`path.join(AGENTS_DIR, name, "manifest.yaml")` at
    // src/lib/agent/defs.ts:367). A future error that wraps `Agent '...' not
    // found:` with a different artifact path (e.g. a binary, config, or
    // registry entry) must keep aborting the batch instead of being treated
    // as an orphan manifest.
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-bad" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-bad"]));
    mocks.captureSandboxListWithGatewayRecovery.mockResolvedValue({
      result: { status: 0, output: "sb-bad\n" },
    });

    mocks.backupSandboxState.mockImplementation(() => {
      throw new Error("Agent 'phantom' not found: /agents/phantom/binary");
    });

    await expect(backupAll()).rejects.toThrow(/binary/);
  });
});
