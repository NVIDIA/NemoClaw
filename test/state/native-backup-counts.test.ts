// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), backup: vi.fn() }));

vi.mock("../../src/lib/openshell-sandbox-list", () => ({
  captureSandboxListWithGatewayPreflightOrExit: mocks.inventory,
}));
vi.mock("../../src/lib/state/mcp-lifecycle-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/state/mcp-lifecycle-lock")>()),
  withSandboxMutationLock: async (_name: string, action: () => unknown) => action(),
}));
vi.mock("../../src/lib/actions/sandbox/snapshot/backup-authority", () => ({
  backupSandboxStateWithManagedAuthority: mocks.backup,
  discardIncompleteBackup: vi.fn(),
}));

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-backup-counts-"));
const fixtureHome = path.join(fixtureRoot, "home");
fs.mkdirSync(fixtureHome);
vi.stubEnv("HOME", fixtureHome);
vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8080");
vi.stubEnv("NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS", "0");

const sandboxState = await import("../../src/lib/state/sandbox");
const { backupAll } = await import("../../src/lib/actions/maintenance");
let nativeRoot: string;
let capturedBackup: ReturnType<typeof sandboxState.backupSandboxState> | undefined;

function capture() {
  capturedBackup = sandboxState.backupSandboxState("alpha", {
    nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
  });
  return capturedBackup;
}

beforeEach(() => {
  vi.stubEnv("HOME", fixtureHome);
  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8080");
  vi.stubEnv("NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS", "0");
  fs.mkdirSync(path.join(fixtureHome, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureHome, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: { name: "alpha", model: "m", provider: "p", gpuEnabled: false, agent: null },
      },
    }),
  );
  nativeRoot = fs.mkdtempSync(path.join(fixtureRoot, "native-home-"));
  mocks.inventory.mockResolvedValue({
    sandboxes: [{ name: "alpha", readiness: "ready", phase: "Ready" }],
  });
  mocks.backup.mockImplementation(capture);
  capturedBackup = undefined;
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function populateNativeHome() {
  fs.mkdirSync(path.join(nativeRoot, "notes", "nested"), { recursive: true });
  fs.writeFileSync(path.join(nativeRoot, "notes", "one.txt"), "one\n");
  fs.writeFileSync(path.join(nativeRoot, "notes", "nested", "two.txt"), "two\n");
  fs.symlinkSync("one.txt", path.join(nativeRoot, "notes", "alias"));
}

describe("native backup entry counts (#13066)", () => {
  it("counts archived directories and non-directory entries without changing opaque results", () => {
    populateNativeHome();

    const backup = capture();

    expect(backup.success, backup.error).toBe(true);
    expect(backup).toMatchObject({
      nativeArchiveCounts: { directories: 3, files: 3 },
      backedUpDirs: ["."],
      backedUpFiles: [],
      manifest: { version: 2, backupComplete: true },
    });
    const archive = path.join(backup.manifest!.backupPath, "native-home.tar");
    expect(fs.statSync(archive).size).toBeGreaterThan(0);
    expect(backup.manifest?.nativeState?.archive).toBe("native-home.tar");
  });

  it("reports counts and the retained archive path after backup-all succeeds", async () => {
    populateNativeHome();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await backupAll();

    expect(capturedBackup?.success, capturedBackup?.error).toBe(true);
    const archive = path.join(capturedBackup!.manifest!.backupPath, "native-home.tar");
    expect(log.mock.calls.flat().join("\n")).toContain(`alpha: 3 dirs, 3 files → ${archive}`);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "Pre-upgrade backup: 1 backed up, 0 failed, 0 skipped",
    );
  });

  it("reports zero files when the native archive only contains its root directory", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await backupAll();

    expect(capturedBackup?.success, capturedBackup?.error).toBe(true);
    expect(log.mock.calls.flat().join("\n")).toContain("alpha: 1 dirs, 0 files →");
  });

  it("reports unavailable counts when an older native result has no inventory", async () => {
    populateNativeHome();
    mocks.backup.mockImplementation(() => {
      const { nativeArchiveCounts: _counts, ...result } = capture();
      return result;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await backupAll();

    expect(log.mock.calls.flat().join("\n")).toContain("entry counts unavailable");
    expect(log.mock.calls.flat().join("\n")).not.toContain("1 dirs, 0 files");
  });

  it("does not publish counts when native capture fails", () => {
    const backup = sandboxState.backupSandboxState("alpha", {
      nativeStateSource: {
        root: "/sandbox",
        directory: nativeRoot,
        assertCurrent: () => {
          throw new Error("native source changed");
        },
      },
    });

    expect(backup.success).toBe(false);
    expect(backup.error).toContain("native source changed");
    expect(backup).not.toHaveProperty("nativeArchiveCounts");
    expect(backup.manifest).toBeUndefined();
  });

  it("does not publish counts when authority validation rejects the captured archive", () => {
    populateNativeHome();
    const backup = sandboxState.backupSandboxState("alpha", {
      nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
      validateBeforePublish: () => {
        throw new Error("backup authority changed");
      },
    });

    expect(backup.success).toBe(false);
    expect(backup.error).toContain("backup authority changed");
    expect(backup).not.toHaveProperty("nativeArchiveCounts");
    expect(backup.manifest).toBeUndefined();
  });

  it("omits the count disclosure when cleanup makes a captured backup unsuccessful", async () => {
    populateNativeHome();
    mocks.backup.mockImplementation(() => ({
      ...capture(),
      success: false,
      error: "cleanup failed",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(backupAll()).rejects.toThrow("exit:1");

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.flat().join("\n")).not.toContain("3 dirs, 3 files");
    expect(log.mock.calls.flat().join("\n")).toContain("0 backed up, 1 failed, 0 skipped");
  });
});
