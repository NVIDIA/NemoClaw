// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { safeTarExtract } from "./sandbox";

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
});
