// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSandboxes: vi.fn(),
  getSandbox: vi.fn(),
  backupSandboxState: vi.fn(),
  captureSandboxListWithGatewayPreflightOrExit: vi.fn(),
  dockerListImagesFormat: vi.fn().mockReturnValue(""),
  dockerRmi: vi.fn(),
  prompt: vi.fn(),
  startStoppedSandboxContainerForBackup: vi.fn(),
  backupStartedSandboxState: vi.fn(),
  returnSandboxContainerToStopped: vi.fn(),
  isSandboxContainerDefinitivelyAbsent: vi.fn(),
  openBackupShieldsWindow: vi.fn(),
  relockBackupShieldsWindow: vi.fn(),
  withSandboxMutationLock: vi.fn(),
  assertNoHermesPortableHostAuthority: vi.fn(),
  defaultPortableStateDir: vi.fn(),
  withPortableHostFence: vi.fn(),
}));

let readySandboxNames = new Set<string>();
let liveSandboxNames = new Set<string>();

function sandboxInventory() {
  return {
    sandboxes: [...new Set([...readySandboxNames, ...liveSandboxNames])].map((name) => ({
      name,
      phase: null,
      readiness: readySandboxNames.has(name) ? ("ready" as const) : ("not_ready" as const),
    })),
  };
}

async function runSandboxMutationAction(
  _sandboxName: string,
  action: () => unknown,
  _options?: { timeoutMs?: number },
): Promise<unknown> {
  return action();
}

vi.mock("../state/registry", () => ({
  isPublishedSandboxRegistration: (entry: { pendingRouteReservation?: true }) =>
    entry.pendingRouteReservation !== true,
  listSandboxes: mocks.listSandboxes,
  getSandbox: mocks.getSandbox,
}));
vi.mock("../state/sandbox", () => ({
  backupSandboxState: mocks.backupSandboxState,
  BackupResult: {},
}));
vi.mock("../state/mcp-lifecycle-lock", () => ({
  withSandboxMutationLock: mocks.withSandboxMutationLock,
}));
vi.mock("../state/portable-uninstall-retirement", () => ({
  assertNoHermesPortableHostAuthority: mocks.assertNoHermesPortableHostAuthority,
  defaultPortableStateDir: mocks.defaultPortableStateDir,
  withPortableHostFence: mocks.withPortableHostFence,
}));
vi.mock("./sandbox/snapshot/backup-authority", () => ({
  backupSandboxStateWithManagedAuthority: (name: string) => mocks.backupSandboxState(name),
}));
vi.mock("../openshell-sandbox-list", () => ({
  captureSandboxListWithGatewayPreflightOrExit: mocks.captureSandboxListWithGatewayPreflightOrExit,
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
vi.mock("./sandbox/backup-shields-window", () => ({
  openBackupShieldsWindow: mocks.openBackupShieldsWindow,
  relockBackupShieldsWindow: mocks.relockBackupShieldsWindow,
}));
vi.mock("../domain/lifecycle/options", () => ({
  normalizeGarbageCollectImagesOptions: (o: unknown) => o || {},
}));

// ../domain/maintenance/images is left unmocked so the gc tests run the real
// orphan-detection helpers and can assert on gc's actual output.

import {
  backupAll,
  backupAllUnderPortableHostFence,
  garbageCollectImages,
  rebuildBackupsDirectory,
  shouldSkipUnreachableSandboxBackup,
} from "./maintenance";

describe("backupAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backupStartedSandboxState.mockReset();
    delete process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS;
    readySandboxNames = new Set(["sb-good", "sb-bad"]);
    liveSandboxNames = new Set();
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockImplementation(async () =>
      sandboxInventory(),
    );
    // Defaults keep every pre-#6520 case on its original path: no sandbox is
    // gateway-observed (so orphan classification is decided by the absence
    // gate alone) and no container is ever definitively absent.
    mocks.isSandboxContainerDefinitivelyAbsent.mockReturnValue(false);
    mocks.startStoppedSandboxContainerForBackup.mockReturnValue(null);
    mocks.returnSandboxContainerToStopped.mockReturnValue(true);
    mocks.openBackupShieldsWindow.mockImplementation(() => ({
      relocked: false,
      wasLocked: false,
    }));
    mocks.relockBackupShieldsWindow.mockReturnValue(true);
    mocks.withSandboxMutationLock.mockImplementation(runSandboxMutationAction);
    mocks.assertNoHermesPortableHostAuthority.mockReset();
    mocks.defaultPortableStateDir.mockImplementation(
      (env: NodeJS.ProcessEnv) => env.NEMOCLAW_TEST_STATE_DIR ?? `${env.HOME}/.nemoclaw`,
    );
    mocks.withPortableHostFence.mockImplementation(async (_home, operation) => operation());
  });

  it("rejects schema-5 authority before OpenShell or backup effects (#9203)", async () => {
    const stateDir = "/private/nemoclaw-test-state";
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", process.env.HOME ?? "");
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
    mocks.assertNoHermesPortableHostAuthority.mockImplementation(() => {
      throw new Error("Command 'backup-all' is not supported");
    });

    await expect(backupAll()).rejects.toThrow("Command 'backup-all' is not supported");
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).not.toHaveBeenCalled();
    expect(mocks.withSandboxMutationLock).not.toHaveBeenCalled();
    expect(mocks.backupSandboxState).not.toHaveBeenCalled();
    expect(mocks.assertNoHermesPortableHostAuthority).toHaveBeenCalledWith(stateDir, "backup-all");
  });

  afterEach(() => {
    delete process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS;
    delete process.env.NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP;
    vi.unstubAllEnvs();
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

  it("backs up published sandboxes while ignoring pending registrations (#9733)", async () => {
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
    readySandboxNames = new Set(["alpha", "beta"]);
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

    expect(mocks.backupSandboxState.mock.calls.map(([name]) => name)).toEqual(["alpha"]);
    expect(mocks.startStoppedSandboxContainerForBackup).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "Pre-upgrade backup: 1 backed up, 0 failed, 0 skipped",
    );
  });

  it("passes the backup action context to gateway preflight", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-good" }],
      defaultSandbox: null,
    });
    readySandboxNames = new Set(["sb-good"]);
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

  it("counts a mutation-lock acquisition failure and continues with later sandboxes", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "alpha" }, { name: "beta" }],
      defaultSandbox: "alpha",
    });
    readySandboxNames = new Set(["alpha", "beta"]);
    mocks.withSandboxMutationLock
      .mockRejectedValueOnce(new Error("Timed out waiting for the sandbox mutation lock"))
      .mockImplementation(runSandboxMutationAction);
    mocks.backupSandboxState.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/beta/timestamp" },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(mocks.withSandboxMutationLock.mock.calls.map(([name]) => name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(mocks.backupSandboxState).toHaveBeenCalledOnce();
    expect(mocks.backupSandboxState).toHaveBeenCalledWith("beta");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("1 backed up, 1 failed, 0 skipped");
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "alpha: backup failed (mutation lock: Timed out waiting for the sandbox mutation lock)",
    );
  });

  it("does not start a stopped container when the first mutation lock cannot be acquired", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-stopped" }],
      defaultSandbox: "sb-stopped",
    });
    readySandboxNames = new Set();
    mocks.startStoppedSandboxContainerForBackup.mockReturnValue({
      containerName: "openshell-sb-stopped-abc",
    });
    mocks.withSandboxMutationLock.mockRejectedValueOnce(
      new Error("Timed out waiting for the sandbox mutation lock"),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(mocks.withSandboxMutationLock).toHaveBeenCalledOnce();
    expect(mocks.startStoppedSandboxContainerForBackup).not.toHaveBeenCalled();
    expect(mocks.openBackupShieldsWindow).not.toHaveBeenCalled();
    expect(mocks.backupStartedSandboxState).not.toHaveBeenCalled();
    expect(mocks.returnSandboxContainerToStopped).not.toHaveBeenCalled();
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
    readySandboxNames = new Set(["sb-bad", "sb-good"]);
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

  it("keeps each Shields window, backup, and relock in one lifecycle transaction (#7952)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "alpha" }, { name: "beta" }],
      defaultSandbox: "alpha",
    });
    readySandboxNames = new Set(["alpha", "beta"]);
    const events: string[] = [];
    mocks.withSandboxMutationLock.mockImplementation(
      async (name: string, action: () => unknown) => {
        events.push(`lock:start:${name}`);
        try {
          return await action();
        } finally {
          events.push(`lock:end:${name}`);
        }
      },
    );
    mocks.openBackupShieldsWindow.mockImplementation(
      (
        name: string,
        options: {
          allowLegacyHermesProtocol?: boolean;
          deferAutoRestoreWhileOwnerAlive?: boolean;
          shieldsUpCommand: string;
        },
      ) => {
        events.push(`open:${name}`);
        expect(options.allowLegacyHermesProtocol).toBeUndefined();
        expect(options.deferAutoRestoreWhileOwnerAlive).toBeUndefined();
        expect(options.shieldsUpCommand).toBe(`nemoclaw ${name} shields up`);
        return { relocked: false, wasLocked: true };
      },
    );
    mocks.backupSandboxState.mockImplementation((name: string) => {
      events.push(`backup:${name}`);
      return {
        success: true,
        backedUpDirs: ["workspace"],
        failedDirs: [],
        backedUpFiles: [],
        failedFiles: [],
        manifest: { backupPath: `/backups/${name}/timestamp` },
      };
    });
    mocks.relockBackupShieldsWindow.mockImplementation(
      (name: string, window: { relocked: boolean }) => {
        events.push(`relock:${name}`);
        window.relocked = true;
        return true;
      },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await backupAll();

    expect(events).toEqual([
      "lock:start:alpha",
      "open:alpha",
      "backup:alpha",
      "relock:alpha",
      "lock:end:alpha",
      "lock:start:beta",
      "open:beta",
      "backup:beta",
      "relock:beta",
      "lock:end:beta",
    ]);
    expect(mocks.withSandboxMutationLock).toHaveBeenNthCalledWith(1, "alpha", expect.any(Function));
    expect(mocks.withSandboxMutationLock).toHaveBeenNthCalledWith(2, "beta", expect.any(Function));
  });

  it("relocks shields after a credential permission failure and keeps the failure hard (#6455)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "alpha" }],
      defaultSandbox: "alpha",
    });
    readySandboxNames = new Set(["alpha"]);
    mocks.openBackupShieldsWindow.mockReturnValue({ relocked: false, wasLocked: true });
    mocks.backupSandboxState.mockReturnValue({
      success: false,
      backedUpDirs: ["workspace"],
      failedDirs: ["credentials"],
      failedDirReasons: { credentials: "permission denied" },
      backedUpFiles: [],
      failedFiles: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(mocks.relockBackupShieldsWindow).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("0 backed up, 1 failed, 0 skipped");
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "backup failed (credentials (permission denied))",
    );
  });

  it("counts an unlock failure and continues with later sandboxes (#6455)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "alpha" }, { name: "beta" }],
      defaultSandbox: "alpha",
    });
    readySandboxNames = new Set(["alpha", "beta"]);
    mocks.openBackupShieldsWindow.mockImplementation((name: string) =>
      name === "alpha" ? null : { relocked: false, wasLocked: false },
    );
    mocks.backupSandboxState.mockImplementation((name: string) => ({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: `/backups/${name}/timestamp` },
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(mocks.backupSandboxState).toHaveBeenCalledTimes(1);
    expect(mocks.backupSandboxState).toHaveBeenCalledWith("beta");
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "alpha: backup failed (could not safely unlock shields)",
    );
    expect(logSpy.mock.calls.flat().join("\n")).toContain("1 backed up, 1 failed, 0 skipped");
  });

  it("aborts remaining backups when shields cannot be restored (#6455)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "alpha" }, { name: "beta" }],
      defaultSandbox: "alpha",
    });
    readySandboxNames = new Set(["alpha", "beta"]);
    mocks.openBackupShieldsWindow.mockReturnValue({ relocked: false, wasLocked: true });
    mocks.backupSandboxState.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/alpha/timestamp" },
    });
    mocks.relockBackupShieldsWindow.mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(backupAll()).rejects.toThrow(
      "Shields lockdown could not be restored for 'alpha' after backup-all",
    );

    expect(mocks.backupSandboxState).toHaveBeenCalledTimes(1);
    expect(mocks.backupSandboxState).toHaveBeenCalledWith("alpha");
    expect(mocks.openBackupShieldsWindow).toHaveBeenCalledTimes(1);
  });

  it("preserves a backup error when shields restoration also fails (#6455)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "alpha" }],
      defaultSandbox: "alpha",
    });
    readySandboxNames = new Set(["alpha"]);
    mocks.openBackupShieldsWindow.mockReturnValue({ relocked: false, wasLocked: true });
    const backupError = new Error("EACCES: permission denied, open '/var/backups/state'");
    mocks.backupSandboxState.mockImplementation(() => {
      throw backupError;
    });
    const relockError = new Error("policy restore failed");
    mocks.relockBackupShieldsWindow.mockImplementation(() => {
      throw relockError;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const failure = await backupAll().catch((error: unknown) => error);

    expect(mocks.withSandboxMutationLock).toHaveBeenCalledOnce();
    expect(mocks.withSandboxMutationLock).toHaveBeenCalledWith("alpha", expect.any(Function));
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain(
      "Backup for 'alpha' failed and Shields lockdown could not be restored",
    );
    expect((failure as AggregateError).errors).toEqual([
      backupError,
      expect.objectContaining({
        cause: relockError,
        message: expect.stringContaining(
          "Shields lockdown could not be restored for 'alpha' after backup-all",
        ),
      }),
    ]);
    expect(mocks.relockBackupShieldsWindow).toHaveBeenCalledOnce();
  });

  it("preserves an orphan-manifest error when shields restoration also fails (#6455)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "alpha" }],
      defaultSandbox: "alpha",
    });
    readySandboxNames = new Set(["alpha"]);
    mocks.openBackupShieldsWindow.mockReturnValue({ relocked: false, wasLocked: true });
    const orphanMessage = "Agent 'alpha' not found: /agents/alpha/manifest.yaml";
    mocks.backupSandboxState.mockImplementation(() => {
      throw new Error(orphanMessage);
    });
    mocks.relockBackupShieldsWindow.mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const failure = await backupAll().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain(
      "encountered an orphan manifest and Shields lockdown could not be restored",
    );
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: orphanMessage }),
      expect.objectContaining({
        message: expect.stringContaining(
          "Shields lockdown could not be restored for 'alpha' after backup-all",
        ),
      }),
    ]);
  });

  it("fails installer-strict backup when a registered sandbox is not Ready (#6114)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-good" }, { name: "sb-stopped" }],
      defaultSandbox: null,
    });
    readySandboxNames = new Set(["sb-good"]);
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

  it("uses uninstall retry guidance when a required sandbox is skipped", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-stopped" }],
      defaultSandbox: null,
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(
      backupAllUnderPortableHostFence({
        purpose: "pre-uninstall",
        requireAll: true,
        sandboxNames: ["sb-stopped"],
      }),
    ).rejects.toThrow("exit:1");

    const errorOutput = errorSpy.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("Strict pre-uninstall backup");
    expect(errorOutput).toContain("rerun the original uninstall command");
    expect(errorOutput).not.toContain("rerun the installer or");
  });

  it("starts a stopped container, backs it up, and returns it to stopped so strict mode passes (#6500)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-good" }, { name: "sb-stopped" }],
      defaultSandbox: null,
    });
    readySandboxNames = new Set(["sb-good"]);
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
    expect(mocks.relockBackupShieldsWindow.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mocks.returnSandboxContainerToStopped.mock.invocationCallOrder.at(-1)!,
    );
    const logOutput = logSpy.mock.calls.flat().join("\n");
    expect(logOutput).toContain("Starting stopped sandbox 'sb-stopped' to back it up");
    expect(logOutput).toContain("Returned 'sb-stopped' to its stopped state");
    expect(logOutput).toContain("2 backed up, 0 failed, 0 skipped");
    expect(logOutput).not.toContain("Skipping 'sb-stopped'");
  });

  it("keeps the stopped-container lifecycle inside one backup transaction (#7952)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-stopped" }],
      defaultSandbox: "sb-stopped",
    });
    readySandboxNames = new Set();
    const events: string[] = [];
    let lockActive = false;
    mocks.withSandboxMutationLock.mockImplementation(
      async (name: string, action: () => unknown) => {
        expect(lockActive).toBe(false);
        events.push(`lock:start:${name}`);
        lockActive = true;
        try {
          return await action();
        } finally {
          lockActive = false;
          events.push(`lock:end:${name}`);
        }
      },
    );
    mocks.startStoppedSandboxContainerForBackup.mockImplementation((name: string) => {
      expect(lockActive).toBe(true);
      events.push(`start:${name}`);
      return { containerName: "openshell-sb-stopped-abc" };
    });
    mocks.openBackupShieldsWindow.mockImplementation((name: string) => {
      expect(lockActive).toBe(true);
      events.push(`open:${name}`);
      return { relocked: false, wasLocked: true };
    });
    mocks.backupStartedSandboxState.mockImplementation(async (name: string) => {
      expect(lockActive).toBe(true);
      events.push(`backup:${name}`);
      return {
        success: true,
        backedUpDirs: ["workspace"],
        failedDirs: [],
        backedUpFiles: [],
        failedFiles: [],
        manifest: { backupPath: "/backups/sb-stopped/timestamp" },
      };
    });
    mocks.relockBackupShieldsWindow.mockImplementation((name: string) => {
      expect(lockActive).toBe(true);
      events.push(`relock:${name}`);
      return true;
    });
    mocks.returnSandboxContainerToStopped.mockImplementation(() => {
      expect(lockActive).toBe(true);
      events.push("stop:sb-stopped");
      return true;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await backupAll();

    expect(events).toEqual([
      "lock:start:sb-stopped",
      "start:sb-stopped",
      "open:sb-stopped",
      "backup:sb-stopped",
      "relock:sb-stopped",
      "stop:sb-stopped",
      "lock:end:sb-stopped",
    ]);
    expect(lockActive).toBe(false);
    expect(mocks.withSandboxMutationLock).toHaveBeenCalledOnce();
    expect(mocks.withSandboxMutationLock).toHaveBeenCalledWith("sb-stopped", expect.any(Function));
  });

  it("returns the container to stopped and counts a failure when the started backup fails (#6500)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-stopped" }],
      defaultSandbox: null,
    });
    readySandboxNames = new Set();
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
    readySandboxNames = new Set();
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
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(backupAll()).rejects.toThrow(
      "could not return its container to the stopped state",
    );

    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "backup cleanup failed (could not return its container to the stopped state",
    );
  });

  it("keeps stopped-container cleanup in the transaction when Shields relock fails (#7952)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-stopped" }],
      defaultSandbox: "sb-stopped",
    });
    readySandboxNames = new Set();
    let lockActive = false;
    mocks.withSandboxMutationLock.mockImplementation(
      async (_name: string, action: () => unknown) => {
        lockActive = true;
        try {
          return await action();
        } finally {
          lockActive = false;
        }
      },
    );
    mocks.startStoppedSandboxContainerForBackup.mockReturnValue({
      containerName: "openshell-sb-stopped-abc",
    });
    mocks.openBackupShieldsWindow.mockReturnValue({ relocked: false, wasLocked: true });
    mocks.backupStartedSandboxState.mockResolvedValue({
      success: true,
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      manifest: { backupPath: "/backups/sb-stopped/timestamp" },
    });
    const relockError = new Error("policy restore failed");
    mocks.relockBackupShieldsWindow.mockImplementation(() => {
      expect(lockActive).toBe(true);
      throw relockError;
    });
    mocks.returnSandboxContainerToStopped.mockImplementation(() => {
      expect(lockActive).toBe(true);
      return true;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const failure = await backupAll().catch((error: unknown) => error);

    expect(failure).toEqual(
      expect.objectContaining({
        cause: relockError,
        message: expect.stringContaining("Shields lockdown could not be restored"),
      }),
    );
    expect(lockActive).toBe(false);
    expect(mocks.withSandboxMutationLock).toHaveBeenCalledOnce();
    expect(mocks.relockBackupShieldsWindow).toHaveBeenCalledOnce();
    expect(mocks.returnSandboxContainerToStopped).toHaveBeenCalledWith("openshell-sb-stopped-abc");
    expect(mocks.openBackupShieldsWindow).toHaveBeenCalledOnce();
  });

  it("returns a started container to stopped when an orphan manifest skips backup (#6500)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-stopped" }],
      defaultSandbox: null,
    });
    readySandboxNames = new Set();
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
    readySandboxNames = new Set();
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
    readySandboxNames = new Set(["sb-bad"]);
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue(sandboxInventory());

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
    readySandboxNames = new Set(["sb-orphan"]);
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
    readySandboxNames = new Set(["sb-bad"]);
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue(sandboxInventory());

    mocks.backupSandboxState.mockImplementation(() => {
      throw new Error("EACCES: permission denied, open '/var/backups/state'");
    });

    await expect(backupAll()).rejects.toThrow(/EACCES/);

    expect(mocks.relockBackupShieldsWindow).toHaveBeenCalledOnce();
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
    readySandboxNames = new Set(["sb-bad"]);
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue(sandboxInventory());

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
    readySandboxNames = new Set(["sb-bad"]);
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue(sandboxInventory());

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
    readySandboxNames = new Set(["sb-bad"]);
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
  ])(
    "emits mode-appropriate unreachable guidance for %s (#6114)",
    async (_mode, requireAll, expectSkipGuidance) => {
      mocks.listSandboxes.mockReturnValue({
        sandboxes: [{ name: "sb-bad" }],
        defaultSandbox: null,
      });
      readySandboxNames = new Set(["sb-bad"]);
      mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue(sandboxInventory());
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
      expect(errorOutput.includes("Strict pre-upgrade backup cannot skip")).toBe(
        !expectSkipGuidance,
      );
      expect(errorOutput).not.toContain("prepare the upgrade manually");

      errorSpy.mockRestore();
      exitSpy.mockRestore();
    },
  );

  it("skips a stranded orphan sandbox without failing strict backup (#6520)", async () => {
    // Uninstall + reinstall strands a sandbox: gateway registration and
    // container removed, sandboxes.json preserved. There is nothing left to
    // back up, so strict backup-all must warn and move on instead of aborting
    // before the installer's recovery phase can surface the orphan.
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "sb-good" }, { name: "sb-stranded" }],
      defaultSandbox: null,
    });
    readySandboxNames = new Set(["sb-good"]);
    liveSandboxNames = new Set(["sb-good"]);
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
    readySandboxNames = new Set();
    liveSandboxNames = new Set();
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
    readySandboxNames = new Set();
    liveSandboxNames = new Set();
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
    readySandboxNames = new Set();
    mocks.captureSandboxListWithGatewayPreflightOrExit
      .mockResolvedValueOnce({ sandboxes: [] })
      .mockResolvedValueOnce({
        sandboxes: [{ name: "sb-flapping", phase: null, readiness: "ready" }],
      });
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
    readySandboxNames = new Set();
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue(sandboxInventory());
    liveSandboxNames = new Set();
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
    mocks.assertNoHermesPortableHostAuthority.mockReset();
    mocks.withPortableHostFence.mockImplementation(async (_home, operation) => operation());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects schema-5 authority before scanning Docker images (#9203)", async () => {
    const stateDir = "/private/nemoclaw-test-state";
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", process.env.HOME ?? "");
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
    mocks.assertNoHermesPortableHostAuthority.mockImplementation(() => {
      throw new Error("Command 'gc' is not supported");
    });

    await expect(garbageCollectImages({ dryRun: true })).rejects.toThrow(
      "Command 'gc' is not supported",
    );
    expect(mocks.dockerListImagesFormat).not.toHaveBeenCalled();
    expect(mocks.dockerRmi).not.toHaveBeenCalled();
    expect(mocks.assertNoHermesPortableHostAuthority).toHaveBeenCalledWith(stateDir, "gc");
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
