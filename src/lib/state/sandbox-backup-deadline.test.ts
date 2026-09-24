// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const executorMocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  inspectDescriptorSnapshotRoot: vi.fn(),
  scanDescriptorSnapshot: vi.fn(),
  applyDescriptorSnapshotActions: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawnSync: executorMocks.spawnSync };
});

vi.mock("../../../nemoclaw/dist/shared/snapshot-sanitizer-boundary.cjs", () => ({
  SnapshotSanitizerPrerequisiteError: class extends Error {},
  applyDescriptorSnapshotActions: executorMocks.applyDescriptorSnapshotActions,
  decodeDescriptorSnapshotContent: vi.fn(),
  inspectDescriptorSnapshotRoot: executorMocks.inspectDescriptorSnapshotRoot,
  scanDescriptorSnapshot: executorMocks.scanDescriptorSnapshot,
}));

import { sanitizeSnapshotDirectory } from "../security/snapshot-sanitizer";
import {
  removeBackupEntryWithinDeadline,
  safeTarExtract,
  sanitizeBackupDirectory,
} from "./sandbox";

const snapshotRoot = {
  canonicalPath: "/backup",
  identity: {
    dev: "1",
    ino: "2",
    mode: "16832",
    nlink: "1",
    size: "0",
    mtimeNs: "0",
    ctimeNs: "0",
  },
};

describe("sandbox backup finalization deadline", () => {
  beforeEach(() => {
    executorMocks.spawnSync.mockReset();
    executorMocks.spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: "",
      stderr: "",
    });
    executorMocks.inspectDescriptorSnapshotRoot.mockReset();
    executorMocks.inspectDescriptorSnapshotRoot.mockReturnValue(snapshotRoot);
    executorMocks.scanDescriptorSnapshot.mockReset();
    executorMocks.scanDescriptorSnapshot.mockReturnValue({
      root: snapshotRoot.identity,
      directories: [],
      files: [],
    });
    executorMocks.applyDescriptorSnapshotActions.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the remaining deadline to each tar executor", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    expect(safeTarExtract(Buffer.from("archive"), "/backup", 12_345)).toEqual({
      success: true,
    });
    expect(executorMocks.spawnSync).toHaveBeenCalledTimes(3);
    expect(executorMocks.spawnSync.mock.calls.map((call) => call[2]?.timeout)).toEqual([
      2_345, 2_345, 2_345,
    ]);
  });

  it("does not start tar after the backup deadline", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    expect(safeTarExtract(Buffer.from("archive"), "/backup", 10_000)).toEqual({
      success: false,
      error: "tar entry validation skipped: backup deadline expired",
    });
    expect(executorMocks.spawnSync).not.toHaveBeenCalled();
  });

  it("stops the post-extraction audit when the backup deadline expires", () => {
    const targetDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-backup-audit-"));
    onTestFinished(() => rmSync(targetDir, { recursive: true, force: true }));
    writeFileSync(path.join(targetDir, "state.json"), "{}");
    writeFileSync(path.join(targetDir, "state-2.json"), "{}");
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_000)
      .mockReturnValue(12_345);

    expect(safeTarExtract(Buffer.from("archive"), targetDir, 12_345)).toEqual({
      success: false,
      error: "post-extraction audit exceeded backup deadline",
    });
  });

  it("passes the remaining deadline to the sanitizer executor", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    sanitizeSnapshotDirectory("/backup", 12_345);

    expect(executorMocks.scanDescriptorSnapshot).toHaveBeenCalledWith(
      snapshotRoot,
      expect.any(Set),
      undefined,
      2_345,
    );
  });

  it("does not start sanitization after the backup deadline", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    expect(() => sanitizeSnapshotDirectory("/backup", 10_000)).toThrow(
      "snapshot sanitization deadline expired",
    );
    expect(executorMocks.inspectDescriptorSnapshotRoot).not.toHaveBeenCalled();
    expect(executorMocks.scanDescriptorSnapshot).not.toHaveBeenCalled();
  });

  it("defers cleanup when the bounded sanitizer executor times out", () => {
    const backupPath = mkdtempSync(path.join(tmpdir(), "nemoclaw-sanitizer-timeout-"));
    onTestFinished(() => rmSync(backupPath, { recursive: true, force: true }));
    executorMocks.scanDescriptorSnapshot.mockImplementation(() => {
      throw new Error("snapshot sanitization deadline expired");
    });

    expect(() => sanitizeBackupDirectory(backupPath, {}, Date.now() + 10_000, true)).toThrow(
      "deferred incomplete backup cleanup",
    );
    expect(existsSync(backupPath)).toBe(true);
  });

  it("leaves a rejected extracted tree for post-lifecycle bounded cleanup", () => {
    const targetDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-symlink-audit-"));
    onTestFinished(() => rmSync(targetDir, { recursive: true, force: true }));
    const outsideDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-symlink-outside-"));
    onTestFinished(() => rmSync(outsideDir, { recursive: true, force: true }));
    const symlinkPath = path.join(targetDir, "escape");
    symlinkSync(outsideDir, symlinkPath);

    expect(safeTarExtract(Buffer.from("archive"), targetDir, Date.now() + 10_000, true)).toEqual({
      success: false,
      error: expect.stringContaining("post-extraction symlink audit failed"),
      cleanupDeferred: true,
    });
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
  });

  it("retains a partial permission-denied tree when bounded removal times out", () => {
    const targetDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-partial-permission-tree-"));
    onTestFinished(() => rmSync(targetDir, { recursive: true, force: true }));
    writeFileSync(path.join(targetDir, "large-partial-state"), "retained");
    executorMocks.spawnSync.mockReturnValueOnce({
      status: null,
      signal: "SIGKILL",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      stdout: "",
      stderr: "",
    });

    expect(removeBackupEntryWithinDeadline(targetDir, Date.now() + 10_000)).toBe(false);
    expect(existsSync(path.join(targetDir, "large-partial-state"))).toBe(true);
    expect(executorMocks.spawnSync.mock.calls[0]?.[2]).toMatchObject({
      timeout: expect.any(Number),
      killSignal: "SIGKILL",
    });
  });
});
