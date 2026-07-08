// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSandboxes: vi.fn(),
  backupSandboxState: vi.fn(),
  captureSandboxListWithGatewayPreflightOrExit: vi.fn(),
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
vi.mock("../openshell-sandbox-list", () => ({
  captureSandboxListWithGatewayPreflightOrExit: mocks.captureSandboxListWithGatewayPreflightOrExit,
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
// ../domain/maintenance/images is left unmocked so the gc tests run the real
// orphan-detection helpers and can assert on gc's actual output.

import { backupAll, garbageCollectImages, shouldSkipUnreachableSandboxBackup } from "./maintenance";

describe("backupAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS;
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue({
      status: 0,
      output: "sb-good\nsb-bad\n",
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-good", "sb-bad"]));
  });

  afterEach(() => {
    delete process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS;
    delete process.env.NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP;
    vi.restoreAllMocks();
  });

  it("returns before gateway preflight when no sandboxes are registered", async () => {
    mocks.listSandboxes.mockReturnValue({ sandboxes: [], defaultSandbox: null });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await backupAll();

    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).not.toHaveBeenCalled();
    expect(mocks.backupSandboxState).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("No sandboxes registered");
    logSpy.mockRestore();
  });

  it("passes the backup action context to gateway preflight", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-good" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-good"]));
    mocks.backupSandboxState.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/sb-good/timestamp" },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await backupAll();

    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).toHaveBeenCalledWith({
      action: "backing up registered sandboxes",
      command: "nemoclaw backup-all",
    });
    expect(mocks.backupSandboxState).toHaveBeenCalledWith("sb-good");
    logSpy.mockRestore();
  });

  it("does not back up when gateway preflight exits", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-good" }],
      defaultSandbox: null,
    });
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockRejectedValueOnce(
      new Error("process.exit(1)"),
    );

    await expect(backupAll()).rejects.toThrow("process.exit(1)");

    expect(mocks.backupSandboxState).not.toHaveBeenCalled();
  });

  it("backs up only sandboxes reported Ready by OpenShell", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-good" }, { name: "sb-stopped" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-good"]));
    mocks.backupSandboxState.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/sb-good/timestamp" },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await backupAll();

    expect(mocks.backupSandboxState).toHaveBeenCalledOnce();
    expect(mocks.backupSandboxState).toHaveBeenCalledWith("sb-good");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Skipping 'sb-stopped' (not running)");
    logSpy.mockRestore();
  });

  it("fails installer-strict backup when a registered sandbox is not Ready (#6114)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-good" }, { name: "sb-stopped" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-good"]));
    mocks.backupSandboxState.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/sb-good/timestamp" },
    });
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = errorSpy.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("requires every registered sandbox to be backed up");
    expect(errorOutput).toContain("Resolve each skipped sandbox using its reason above");
    expect(errorOutput).not.toContain("prepare the upgrade manually");
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
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue({
      status: 0,
      output: "sb-bad\n",
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

  it("fails installer-strict backup when an orphan manifest is skipped (#6114)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-orphan" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-orphan"]));
    mocks.backupSandboxState.mockImplementation(() => {
      throw new Error("Agent 'orphan' not found: /agents/orphan/manifest.yaml");
    });
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
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
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue({
      status: 0,
      output: "sb-bad\n",
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
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue({
      status: 0,
      output: "sb-bad\n",
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
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue({
      status: 0,
      output: "sb-bad\n",
    });

    mocks.backupSandboxState.mockImplementation(() => {
      throw new Error("Agent 'phantom' not found: /agents/phantom/binary");
    });

    await expect(backupAll()).rejects.toThrow(/binary/);
  });

  it("skips a running but SSH-unreachable sandbox when NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP=1", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-bad" }, { name: "sb-good" }],
      defaultSandbox: null,
    });
    mocks.backupSandboxState.mockImplementation((name: string) =>
      name === "sb-bad"
        ? {
            success: false,
            unreachable: true,
            backedUpDirs: [],
            failedDirs: ["memories"],
            backedUpFiles: [],
            failedFiles: [],
          }
        : {
            success: true,
            backedUpDirs: ["dir1"],
            failedDirs: [],
            backedUpFiles: [],
            failedFiles: [],
            manifest: { backupPath: "/backups/sb-good/timestamp" },
          },
    );

    process.env.NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await backupAll();

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Skipped 'sb-bad'");
    expect(output).toContain("1 backed up, 0 failed, 1 skipped");
    expect(exitSpy).not.toHaveBeenCalled();

    delete process.env.NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP;
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("does not let the unreachable waiver bypass installer-strict backup (#6114)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-bad" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-bad"]));
    mocks.backupSandboxState.mockReturnValue({
      success: false,
      unreachable: true,
      backedUpDirs: [],
      failedDirs: ["memories"],
      backedUpFiles: [],
      failedFiles: [],
    });
    process.env.NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP = "1";
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([
    ["standalone backup", "", true],
    ["installer-strict backup", "1", false],
  ])("emits mode-appropriate unreachable guidance for %s (#6114)", async (_mode, requireAll, expectSkipGuidance) => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-bad" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-bad"]));
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue({
      status: 0,
      output: "sb-bad\n",
    });
    mocks.backupSandboxState.mockImplementation(() => ({
      success: false,
      unreachable: true,
      backedUpDirs: [],
      failedDirs: ["memories"],
      backedUpFiles: [],
      failedFiles: [],
    }));

    delete process.env.NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP;
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = requireAll;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    const errorOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(errorOutput.includes("NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP=1")).toBe(
      expectSkipGuidance,
    );
    expect(errorOutput.includes("Strict pre-upgrade backup cannot skip")).toBe(!expectSkipGuidance);
    expect(errorOutput).not.toContain("prepare the upgrade manually");

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("shouldSkipUnreachableSandboxBackup", () => {
  it("is true only for exactly '1'", () => {
    expect(
      shouldSkipUnreachableSandboxBackup({ NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP: "1" }),
    ).toBe(true);
    expect(
      shouldSkipUnreachableSandboxBackup({ NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP: "0" }),
    ).toBe(false);
    expect(
      shouldSkipUnreachableSandboxBackup({ NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP: "true" }),
    ).toBe(false);
    expect(shouldSkipUnreachableSandboxBackup({})).toBe(false);
  });
});

describe("garbageCollectImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces a local-repo orphan while preserving a registered local image (#6301)", async () => {
    // Local repo holds an orphan (gc-test-orphan-111) plus a still-registered
    // image (live-222); the gateway repo holds only an in-use image.
    mocks.dockerListImagesFormat.mockImplementation((repo: string) =>
      repo === "nemoclaw-sandbox-local"
        ? "nemoclaw-sandbox-local:gc-test-orphan-111\t3GB\nnemoclaw-sandbox-local:live-222\t2GB"
        : "openshell/sandbox-from:in-use\t1GB",
    );
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [
        { imageTag: "nemoclaw-sandbox-local:live-222" },
        { imageTag: "openshell/sandbox-from:in-use" },
      ],
      defaultSandbox: null,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await garbageCollectImages({ dryRun: true });

    const out = logSpy.mock.calls.flat().join("\n");
    logSpy.mockRestore();

    // The local orphan is reported, the still-registered local image is not,
    // and both repos are scanned.
    expect(out).toContain("nemoclaw-sandbox-local:gc-test-orphan-111");
    expect(out).not.toContain("nemoclaw-sandbox-local:live-222");
    const scannedRepos = mocks.dockerListImagesFormat.mock.calls.map((call) => call[0]);
    expect(scannedRepos).toContain("openshell/sandbox-from");
    expect(scannedRepos).toContain("nemoclaw-sandbox-local");
  });
});
