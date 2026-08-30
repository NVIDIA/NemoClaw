// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backupSandboxState: vi.fn(),
  captureOpenshell: vi.fn(() => ({ status: 0, output: "alpha Ready\n" })),
  findBackup: vi.fn(() => ({ match: null })),
  removeIncompleteSnapshot: vi.fn(
    () =>
      ({ removed: true }) as {
        removed: boolean;
        error?: string;
      },
  ),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: vi.fn(),
}));

vi.mock("../../runtime-recovery", () => ({
  parseLiveSandboxNames: vi.fn(() => new Set(["alpha"])),
}));

vi.mock("../../shields", () => ({
  isShieldsDown: vi.fn(() => true),
}));

vi.mock("../../shields/timer-bound-lock", () => ({
  withTimerBoundShieldsMutationLock: vi.fn(
    (_sandboxName: string, _command: string, operation: () => unknown) => operation(),
  ),
}));

vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(() => ({ name: "alpha", agent: "openclaw" })),
}));

vi.mock("../../state/sandbox", () => ({
  backupSandboxState: mocks.backupSandboxState,
  findBackup: mocks.findBackup,
  removeIncompleteSnapshot: mocks.removeIncompleteSnapshot,
}));

vi.mock("./sandbox-gateway-routing", () => ({
  probeGatewayRunning: vi.fn(() => true),
  selectSandboxGatewayIfRegistered: vi.fn(() => true),
  usesGatewayMetadataProbe: vi.fn(() => false),
}));

const INCOMPLETE_PATH = "/home/user/.nemoclaw/rebuild-backups/alpha/2026-08-04T06-53-38-310Z";

function failedCaptureWithPublishedSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    success: false,
    manifest: { backupPath: INCOMPLETE_PATH },
    backedUpDirs: ["workspace"],
    failedDirs: [],
    backedUpFiles: [],
    failedFiles: ["openclaw.json"],
    ...overrides,
  };
}

describe("snapshot create cleanup after a failed capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeIncompleteSnapshot.mockReturnValue({ removed: true });
    mocks.findBackup.mockReturnValue({ match: null });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createSnapshot(): Promise<string> {
    const { runSandboxSnapshot } = await import("./snapshot");
    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });
    return vi.mocked(console.error).mock.calls.flat().join("\n");
  }

  it("reports the failed directories and files", async () => {
    mocks.backupSandboxState.mockReturnValue(
      failedCaptureWithPublishedSnapshot({
        failedDirs: ["workspace", "skills"],
        failedDirReasons: { workspace: "permission denied" },
      }),
    );

    const errors = await createSnapshot();

    expect(errors).toContain("Snapshot failed.");
    expect(errors).toContain("Failed directories: workspace (permission denied), skills");
    expect(errors).toContain("Failed files: openclaw.json");
  });

  it("removes the snapshot so a later restore cannot select an incomplete capture (#8201)", async () => {
    mocks.backupSandboxState.mockReturnValue(failedCaptureWithPublishedSnapshot());

    const errors = await createSnapshot();

    expect(mocks.removeIncompleteSnapshot).toHaveBeenCalledWith(INCOMPLETE_PATH);
    expect(errors).toContain("Removed the incomplete snapshot.");
  });

  it("names the snapshot that is still listed when removal fails", async () => {
    mocks.backupSandboxState.mockReturnValue(failedCaptureWithPublishedSnapshot());
    mocks.removeIncompleteSnapshot.mockReturnValue({
      removed: false,
      error: "EACCES: permission denied",
    });

    const errors = await createSnapshot();

    expect(errors).toContain(
      `The incomplete snapshot at '${INCOMPLETE_PATH}' could not be removed: EACCES: permission denied`,
    );
    expect(errors).toContain("Remove it before the next restore.");
  });

  it("does not attempt removal when the capture failed before publishing a snapshot", async () => {
    mocks.backupSandboxState.mockReturnValue({
      success: false,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      error: "Snapshot name 'dup' already exists.",
    });

    const errors = await createSnapshot();

    expect(mocks.removeIncompleteSnapshot).not.toHaveBeenCalled();
    expect(errors).toContain("Snapshot name 'dup' already exists.");
  });

  it("does not touch a snapshot whose capture succeeded", async () => {
    mocks.backupSandboxState.mockReturnValue({
      success: true,
      manifest: { backupPath: INCOMPLETE_PATH, timestamp: "2026-08-04T06-53-38-310Z" },
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: ["openclaw.json"],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "create" });

    expect(mocks.removeIncompleteSnapshot).not.toHaveBeenCalled();
  });
});
