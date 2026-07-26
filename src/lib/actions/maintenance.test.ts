// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSandboxes: vi.fn(),
  backupSandboxState: vi.fn(),
  captureSandboxListWithGatewayPreflightOrExit: vi.fn(),
  parseReadySandboxNames: vi.fn(),
  parseLiveSandboxNames: vi.fn(),
  dockerListImagesFormat: vi.fn().mockReturnValue(""),
  dockerRmi: vi.fn(),
  prompt: vi.fn(),
  startStoppedSandboxContainerForBackup: vi.fn(),
  backupStartedSandboxState: vi.fn(),
  returnSandboxContainerToStopped: vi.fn(),
  isSandboxContainerDefinitivelyAbsent: vi.fn(),
}));

vi.mock("../state/registry", () => ({
  isRouteOnlySandboxReservation: (entry: { pendingRouteReservation?: true; createdAt?: string }) =>
    entry.pendingRouteReservation === true && entry.createdAt === undefined,
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
  parseLiveSandboxNames: mocks.parseLiveSandboxNames,
}));
// GATEWAY_PORT is baked from NEMOCLAW_GATEWAY_PORT at module load. Pin it so
// the #6520 orphan-classification tests (which run the real gateway-binding
// resolvers against literal ports) don't invert on a shell that exports a
// non-default gateway port.
vi.mock("../core/ports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/ports")>()),
  GATEWAY_PORT: 8080,
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
vi.mock("./sandbox/stopped-sandbox-backup", () => ({
  startStoppedSandboxContainerForBackup: mocks.startStoppedSandboxContainerForBackup,
  backupStartedSandboxState: mocks.backupStartedSandboxState,
  returnSandboxContainerToStopped: mocks.returnSandboxContainerToStopped,
  isSandboxContainerDefinitivelyAbsent: mocks.isSandboxContainerDefinitivelyAbsent,
}));
vi.mock("../domain/lifecycle/options", () => ({
  normalizeGarbageCollectImagesOptions: (o: unknown) => o || {},
}));

// ../domain/maintenance/images is left unmocked so the gc tests run the real
// orphan-detection helpers and can assert on gc's actual output.

import {
  backupAll,
  garbageCollectImages,
  rebuildBackupsDirectory,
  shouldSkipUnreachableSandboxBackup,
} from "./maintenance";

describe("backupAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backupStartedSandboxState.mockReset();
    delete process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS;
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue({
      status: 0,
      output: "sb-good\nsb-bad\n",
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-good", "sb-bad"]));
    // Defaults keep every pre-#6520 case on its original path: no sandbox is
    // gateway-observed (so orphan classification is decided by the absence
    // gate alone) and no container is ever definitively absent.
    mocks.parseLiveSandboxNames.mockReturnValue(new Set());
    mocks.isSandboxContainerDefinitivelyAbsent.mockReturnValue(false);
    mocks.startStoppedSandboxContainerForBackup.mockReturnValue(null);
    mocks.returnSandboxContainerToStopped.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS;
    delete process.env.NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP;
    vi.restoreAllMocks();
  });

  it("reports the rebuild backup directory under the selected gateway state root", () => {
    expect(rebuildBackupsDirectory("/home/tester", 9123)).toBe(
      "/home/tester/.nemoclaw/gateways/9123/rebuild-backups",
    );
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

  it("returns before gateway preflight when the registry has only a route reservation (#6500)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "tm", pendingRouteReservation: true }],
      defaultSandbox: null,
    });
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await backupAll();

    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).not.toHaveBeenCalled();
    expect(mocks.backupSandboxState).not.toHaveBeenCalled();
    expect(mocks.startStoppedSandboxContainerForBackup).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("No sandboxes registered");
  });

  it("backs up real sandboxes while ignoring a route-only reservation (#6500)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [
        { name: "tm", pendingRouteReservation: true },
        { name: "alpha" },
        {
          name: "beta",
          pendingRouteReservation: true,
          createdAt: "2026-07-13T00:00:00.000Z",
        },
      ],
      defaultSandbox: "alpha",
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["alpha", "beta"]));
    mocks.backupSandboxState.mockImplementation((name: string) => ({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: `/backups/${name}/timestamp` },
    }));
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await backupAll();

    expect(mocks.backupSandboxState.mock.calls.map(([name]) => name)).toEqual(["alpha", "beta"]);
    expect(mocks.startStoppedSandboxContainerForBackup).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "Pre-upgrade backup: 2 backed up, 0 failed, 0 skipped",
    );
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

    // The listing must be pinned to the selected gateway (#6114/#6520):
    // OpenShell's mutable current selection may be a sibling gateway, and an
    // unpinned list would let the orphan classifier make a fail-open
    // stranded call from another gateway's sandboxes.
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).toHaveBeenCalledWith(
      {
        action: "backing up registered sandboxes",
        command: "nemoclaw backup-all",
      },
      { gatewayName: "nemoclaw" },
    );
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

  it("preserves retry counters when ready sandboxes have mixed backup outcomes (#6455)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-bad" }, { name: "sb-good" }, { name: "sb-stopped" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-bad", "sb-good"]));
    mocks.backupSandboxState.mockImplementation((name: string) =>
      name === "sb-bad"
        ? {
            success: false,
            backedUpDirs: [],
            failedDirs: ["identity"],
            failedDirReasons: { identity: "permission denied" },
            backedUpFiles: [],
            failedFiles: ["settings.json"],
          }
        : {
            success: true,
            backedUpDirs: ["workspace"],
            failedDirs: [],
            backedUpFiles: [],
            failedFiles: [],
            manifest: { backupPath: "/backups/sb-good/timestamp" },
          },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit:1");
    });

    await expect(backupAll()).rejects.toThrow("exit:1");

    const logOutput = logSpy.mock.calls.flat().join("\n");
    expect(logOutput).toContain("Skipping 'sb-stopped' (not running");
    expect(logOutput).toContain("1 backed up, 1 failed, 1 skipped");
    expect(logOutput).toContain("start the sandbox/container");
    expect(logOutput).toContain("nemoclaw backup-all");
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "backup failed (identity (permission denied), settings.json)",
    );
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
    expect(errorOutput).toContain("1 skipped sandbox(es) were not running");
    expect(errorOutput).toContain("Start each sandbox/container");
    expect(errorOutput).toContain("rerun the installer or");
    expect(errorOutput).toContain("Resolve each skipped sandbox using its reason above");
    expect(errorOutput).not.toContain("prepare the upgrade manually");
  });

  it("starts a stopped container, backs it up, and returns it to stopped so strict mode passes (#6500)", async () => {
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
    mocks.startStoppedSandboxContainerForBackup.mockImplementation((name: string) =>
      name === "sb-stopped" ? { containerName: "openshell-sb-stopped-abc" } : null,
    );
    mocks.backupStartedSandboxState.mockResolvedValue({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/sb-stopped/timestamp" },
    });
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await backupAll();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mocks.backupStartedSandboxState).toHaveBeenCalledWith("sb-stopped");
    expect(mocks.backupSandboxState).toHaveBeenCalledWith("sb-good");
    expect(mocks.returnSandboxContainerToStopped).toHaveBeenCalledWith("openshell-sb-stopped-abc");
    const logOutput = logSpy.mock.calls.flat().join("\n");
    expect(logOutput).toContain("Starting stopped sandbox 'sb-stopped' to back it up");
    expect(logOutput).toContain("Returned 'sb-stopped' to its stopped state");
    expect(logOutput).toContain("2 backed up, 0 failed, 0 skipped");
    expect(logOutput).not.toContain("Skipping 'sb-stopped'");
  });

  it("returns the container to stopped and counts a failure when the started backup fails (#6500)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-stopped" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set());
    mocks.startStoppedSandboxContainerForBackup.mockReturnValue({
      containerName: "openshell-sb-stopped-abc",
    });
    mocks.backupStartedSandboxState.mockResolvedValue({
      success: false,
      backedUpDirs: [],
      failedDirs: ["identity"],
      failedDirReasons: { identity: "permission denied" },
      backedUpFiles: [],
      failedFiles: [],
    });
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(mocks.returnSandboxContainerToStopped).toHaveBeenCalledWith("openshell-sb-stopped-abc");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("0 backed up, 1 failed, 0 skipped");
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "backup failed (identity (permission denied))",
    );
  });

  it("fails when the started container cannot be returned to its stopped state (#6500)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-stopped" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set());
    mocks.startStoppedSandboxContainerForBackup.mockReturnValue({
      containerName: "openshell-sb-stopped-abc",
    });
    mocks.backupStartedSandboxState.mockResolvedValue({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/sb-stopped/timestamp" },
    });
    mocks.returnSandboxContainerToStopped.mockReturnValue(false);
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(logSpy.mock.calls.flat().join("\n")).toContain("0 backed up, 1 failed, 0 skipped");
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "backup cleanup failed (could not return its container to the stopped state",
    );
  });

  it("returns a started container to stopped when an orphan manifest skips backup (#6500)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-stopped" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set());
    mocks.startStoppedSandboxContainerForBackup.mockReturnValue({
      containerName: "openshell-sb-stopped-abc",
    });
    mocks.backupStartedSandboxState.mockRejectedValue(
      new Error("Agent 'sb-stopped' not found: /path/to/manifest.yaml"),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await backupAll();

    expect(mocks.returnSandboxContainerToStopped).toHaveBeenCalledWith("openshell-sb-stopped-abc");
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Returned 'sb-stopped' to its stopped state");
    expect(output).toContain("Skipped 'sb-stopped' (orphan manifest)");
  });

  it("keeps the not-running skip when no stopped container can be started (#6114)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-stopped" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set());
    mocks.startStoppedSandboxContainerForBackup.mockReturnValue(null);
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(mocks.backupStartedSandboxState).not.toHaveBeenCalled();
    expect(mocks.returnSandboxContainerToStopped).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Skipping 'sb-stopped' (not running");
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

  it("skips a stranded orphan sandbox without failing strict backup (#6520)", async () => {
    // Uninstall + reinstall strands a sandbox: gateway registration and
    // container removed, sandboxes.json preserved. There is nothing left to
    // back up, so strict backup-all must warn and move on instead of aborting
    // before the installer's recovery phase can surface the orphan.
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-good" }, { name: "sb-stranded" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["sb-good"]));
    mocks.parseLiveSandboxNames.mockReturnValue(new Set(["sb-good"]));
    mocks.isSandboxContainerDefinitivelyAbsent.mockImplementation(
      (name: string) => name === "sb-stranded",
    );
    mocks.backupSandboxState.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/sb-good/timestamp" },
    });
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await backupAll();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mocks.backupSandboxState).toHaveBeenCalledWith("sb-good");
    expect(mocks.backupStartedSandboxState).not.toHaveBeenCalled();
    // The exemption requires a confirming second pinned listing after the loop.
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).toHaveBeenCalledTimes(2);
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).toHaveBeenNthCalledWith(
      2,
      {
        action: "confirming stranded sandboxes remain absent from the selected gateway",
        command: "nemoclaw backup-all",
      },
      { gatewayName: "nemoclaw" },
    );
    const logOutput = logSpy.mock.calls.flat().join("\n");
    expect(logOutput).toContain(
      "1 recorded sandbox(es) were not found on their recorded gateway: sb-stranded.",
    );
    expect(logOutput).toContain("destroy` to clear a stranded record");
    expect(logOutput).toContain("onboard` to rebuild it");
    expect(logOutput).toContain("1 backed up, 0 failed, 0 skipped");
    expect(logOutput).not.toContain("Skipping 'sb-stranded'");
  });

  it("keeps the strict abort for an absent sandbox bound to a different gateway (#6520)", async () => {
    // A sandbox persisted against a sibling gateway may be healthy there;
    // this gateway's backup-all must never claim it is stranded, even when
    // its container is absent on this host.
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-other", gatewayPort: 9999 }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set());
    mocks.parseLiveSandboxNames.mockReturnValue(new Set());
    mocks.isSandboxContainerDefinitivelyAbsent.mockReturnValue(true);
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const logOutput = logSpy.mock.calls.flat().join("\n");
    expect(logOutput).toContain("Skipping 'sb-other' (not running");
    expect(logOutput).not.toContain("were not found on their recorded gateway");
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "requires every registered sandbox to be backed up",
    );
  });

  it("keeps the strict abort when an unobserved sandbox still has a container (#6520)", async () => {
    // Orphan classification alone is race-prone: a sandbox mid-reconnect (or
    // one whose gateway row is drifting) is unobserved on the gateway yet its
    // container still exists. Only definitive container absence may downgrade
    // the strict abort to a stranded-orphan warning.
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-reconnecting" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set());
    mocks.parseLiveSandboxNames.mockReturnValue(new Set());
    mocks.isSandboxContainerDefinitivelyAbsent.mockReturnValue(false);
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.isSandboxContainerDefinitivelyAbsent).toHaveBeenCalledWith("sb-reconnecting");
    const logOutput = logSpy.mock.calls.flat().join("\n");
    expect(logOutput).toContain("Skipping 'sb-reconnecting' (not running");
    expect(logOutput).not.toContain("were not found on their recorded gateway");
  });

  it("reverts a stranded candidate to a strict skip when the confirming listing observes it again (#6520)", async () => {
    // The pre-loop listing can be minutes stale by the time the loop ends. A
    // candidate the confirming second listing observes has reconnected — the
    // exemption must not apply and strict mode must keep failing closed.
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-flapping" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set());
    mocks.captureSandboxListWithGatewayPreflightOrExit
      .mockResolvedValueOnce({ status: 0, output: "" })
      .mockResolvedValueOnce({
        status: 0,
        output: "sb-flapping  openshell  2026-07-21 10:00:00  Ready\n",
      });
    mocks.parseLiveSandboxNames.mockImplementation((output: string) =>
      output.includes("sb-flapping") ? new Set(["sb-flapping"]) : new Set(),
    );
    mocks.isSandboxContainerDefinitivelyAbsent.mockReturnValue(true);
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).toHaveBeenCalledTimes(2);
    const logOutput = logSpy.mock.calls.flat().join("\n");
    expect(logOutput).toContain("Skipping 'sb-flapping' (not running");
    expect(logOutput).toContain("0 backed up, 0 failed, 1 skipped");
    expect(logOutput).not.toContain("were not found on their recorded gateway");
  });

  it("reverts a stranded candidate to a strict skip when its container reappears (#6520)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-flapping" }],
      defaultSandbox: null,
    });
    mocks.parseReadySandboxNames.mockReturnValue(new Set());
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue({
      status: 0,
      output: "",
    });
    mocks.parseLiveSandboxNames.mockReturnValue(new Set());
    mocks.isSandboxContainerDefinitivelyAbsent.mockReturnValueOnce(true).mockReturnValueOnce(false);
    process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).toHaveBeenCalledTimes(2);
    expect(mocks.isSandboxContainerDefinitivelyAbsent).toHaveBeenCalledTimes(2);
    expect(mocks.isSandboxContainerDefinitivelyAbsent).toHaveBeenNthCalledWith(1, "sb-flapping");
    expect(mocks.isSandboxContainerDefinitivelyAbsent).toHaveBeenNthCalledWith(2, "sb-flapping");
    const logOutput = logSpy.mock.calls.flat().join("\n");
    expect(logOutput).toContain("Skipping 'sb-flapping' (not running");
    expect(logOutput).toContain("0 backed up, 0 failed, 1 skipped");
    expect(logOutput).not.toContain("were not found on their recorded gateway");
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
