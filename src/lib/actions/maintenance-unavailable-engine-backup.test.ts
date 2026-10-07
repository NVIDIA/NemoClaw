// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSandboxes: vi.fn(),
  getSandbox: vi.fn(),
  recordSandboxStopIntent: vi.fn(),
  updateSandbox: vi.fn(),
  backupSandboxState: vi.fn(),
  captureSandboxListWithGatewayPreflightOrExit: vi.fn(),
  startStoppedSandboxContainerForBackup: vi.fn(),
  backupStartedSandboxState: vi.fn(),
  returnSandboxContainerToStopped: vi.fn(),
  isSandboxContainerDefinitivelyAbsent: vi.fn(),
  unreachableSandboxContainerEngineName: vi.fn(),
  retainStrictPreUpgradeRecoveryState: vi.fn(),
  discardIncompleteBackup: vi.fn(),
  withSandboxMutationLock: vi.fn(),
  enforceRemovedImmutabilityMigrationBoundary: vi.fn(),
  assertNoHermesPortableHostAuthority: vi.fn(),
  defaultPortableStateDir: vi.fn(),
  withPortableHostFence: vi.fn(),
}));

vi.mock("../state/registry", () => ({
  isPublishedSandboxRegistration: () => true,
  listSandboxes: mocks.listSandboxes,
  getSandbox: mocks.getSandbox,
  recordSandboxStopIntent: mocks.recordSandboxStopIntent,
  updateSandbox: mocks.updateSandbox,
}));
vi.mock("../state/sandbox", () => ({
  backupSandboxState: mocks.backupSandboxState,
  BackupResult: {},
}));
vi.mock("../state/mcp-lifecycle-lock", () => ({
  withSandboxMutationLock: mocks.withSandboxMutationLock,
}));
vi.mock("../state/migrations/removed-immutability", () => ({
  enforceRemovedImmutabilityMigrationBoundary: mocks.enforceRemovedImmutabilityMigrationBoundary,
}));
vi.mock("../state/portable-uninstall-retirement", () => ({
  assertNoHermesPortableHostAuthority: mocks.assertNoHermesPortableHostAuthority,
  defaultPortableStateDir: mocks.defaultPortableStateDir,
  withPortableHostFence: mocks.withPortableHostFence,
}));
vi.mock("./sandbox/snapshot/backup-authority", () => ({
  backupSandboxStateWithManagedAuthority: mocks.backupSandboxState,
  discardIncompleteBackup: mocks.discardIncompleteBackup,
}));
vi.mock("../openshell-sandbox-list", () => ({
  captureSandboxListWithGatewayPreflightOrExit: mocks.captureSandboxListWithGatewayPreflightOrExit,
}));
vi.mock("../cli/branding", () => ({
  CLI_NAME: "nemoclaw",
}));
vi.mock("./sandbox/stopped-sandbox-backup", () => ({
  startStoppedSandboxContainerForBackup: mocks.startStoppedSandboxContainerForBackup,
  backupStartedSandboxState: mocks.backupStartedSandboxState,
  returnSandboxContainerToStopped: mocks.returnSandboxContainerToStopped,
  isSandboxContainerDefinitivelyAbsent: mocks.isSandboxContainerDefinitivelyAbsent,
  unreachableSandboxContainerEngineName: mocks.unreachableSandboxContainerEngineName,
  startedSandboxBackupTransactionDeadline: vi.fn(() => 330_000),
  startedSandboxBackupWorkDeadline: (transactionDeadlineMs: number) =>
    transactionDeadlineMs - 30_000,
}));
vi.mock("./sandbox/snapshot/strict-pre-upgrade-recovery", () => ({
  retainStrictPreUpgradeRecoveryState: mocks.retainStrictPreUpgradeRecoveryState,
}));

import { backupAllUnderPortableHostFence } from "./maintenance";

function stoppedSandboxes(...names: string[]) {
  mocks.listSandboxes.mockReturnValue({
    sandboxes: names.map((name) => ({ name })),
    defaultSandbox: null,
  });
}

async function runStrictBackup(purpose: "pre-uninstall" | "pre-upgrade") {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);

  await expect(backupAllUnderPortableHostFence({ purpose, requireAll: true })).rejects.toThrow(
    "exit:1",
  );

  return {
    logOutput: logSpy.mock.calls.flat().join("\n"),
    errorOutput: errorSpy.mock.calls.flat().join("\n"),
  };
}

describe("strict backup when the container engine does not respond (#12749)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stoppedSandboxes("sb-stopped");
    // Nothing is Ready, so the stopped-container start path runs.
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockImplementation(async () => ({
      sandboxes: [],
    }));
    mocks.isSandboxContainerDefinitivelyAbsent.mockReturnValue(false);
    mocks.startStoppedSandboxContainerForBackup.mockReturnValue(null);
    mocks.withSandboxMutationLock.mockImplementation(async (_name: string, action: () => unknown) =>
      action(),
    );
    mocks.withPortableHostFence.mockImplementation(
      async (_home: string, operation: () => unknown) => operation(),
    );
    mocks.defaultPortableStateDir.mockReturnValue("/home/test/.nemoclaw");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      purpose: "pre-uninstall" as const,
      consequence: "because Docker did not respond and their containers cannot be cleaned up.",
      retry: "Start Docker, then rerun the original uninstall command.",
    },
    {
      purpose: "pre-upgrade" as const,
      consequence: "because Docker did not respond.",
      retry: "Start Docker, then run 'nemoclaw backup-all' again.",
    },
  ])("names the engine and its remediation for a $purpose backup", async (row) => {
    mocks.unreachableSandboxContainerEngineName.mockReturnValue("Docker");

    const { logOutput, errorOutput } = await runStrictBackup(row.purpose);

    expect(mocks.unreachableSandboxContainerEngineName).toHaveBeenCalledWith("sb-stopped");
    expect(logOutput).toContain("Skipping 'sb-stopped' (Docker is not responding");
    expect(errorOutput).toContain(
      `1 skipped sandbox(es) could not be started for backup ${row.consequence}`,
    );
    expect(errorOutput).toContain(row.retry);
    // Starting the sandbox is impossible while its engine does not respond, so
    // the not-running remediation must not be offered.
    expect(errorOutput).not.toContain("were not running");
  });

  it("lists every unresponsive engine once and keeps separate guidance for a stopped sandbox", async () => {
    stoppedSandboxes("sb-podman", "sb-docker", "sb-docker-2", "sb-stopped");
    mocks.unreachableSandboxContainerEngineName.mockImplementation(
      (name: string) =>
        ({ "sb-podman": "Podman", "sb-docker": "Docker", "sb-docker-2": "Docker" })[name] ?? null,
    );

    const { errorOutput } = await runStrictBackup("pre-uninstall");

    expect(errorOutput).toContain(
      "3 skipped sandbox(es) could not be started for backup because Docker and Podman did not respond",
    );
    expect(errorOutput).toContain(
      "Start Docker and Podman, then rerun the original uninstall command.",
    );
    expect(errorOutput).toContain("1 skipped sandbox(es) were not running.");
  });
});
