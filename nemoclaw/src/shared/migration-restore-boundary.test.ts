// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const { helperControls } = vi.hoisted(() => ({
  helperControls: {
    path: "/usr/bin/python3" as string | null,
    result: null as null | { status: number; stdout: string; stderr: string },
  },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) =>
      helperControls.result ?? actual.spawnSync(...args),
  };
});

vi.mock("./snapshot-sanitizer-boundary.cjs", () => ({
  resolveTrustedSnapshotSanitizerPythonPath: () => helperControls.path,
}));

import {
  restoreDescriptorSnapshotReplacements,
  type DescriptorRestoreReplacement,
} from "./migration-restore-boundary.cjs";

const replacement: DescriptorRestoreReplacement = {
  sourcePath: "/snapshot/openclaw",
  targetPath: "/home/operator/.openclaw",
  label: "OpenClaw state directory",
  kind: "directory",
};

beforeEach(() => {
  helperControls.path = "/usr/bin/python3";
  helperControls.result = null;
});

describe("migration restore descriptor boundary", () => {
  it("fails closed when a trusted Python interpreter is unavailable", () => {
    helperControls.path = null;

    expect(restoreDescriptorSnapshotReplacements([replacement])).toEqual(
      expect.objectContaining({ ok: false, phase: "prerequisite" }),
    );
  });

  it("rejects relative replacement paths before invoking the helper", () => {
    expect(
      restoreDescriptorSnapshotReplacements([{ ...replacement, sourcePath: "snapshot/openclaw" }]),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        phase: "staging",
        message: "restore replacement paths must be absolute",
      }),
    );
  });

  it("reports an interpreter launch failure without mutating paths", () => {
    helperControls.path = "/definitely/missing/nemoclaw-test-python";

    expect(restoreDescriptorSnapshotReplacements([replacement])).toEqual(
      expect.objectContaining({ ok: false, phase: "staging" }),
    );
  });

  it("rejects an empty replacement plan", () => {
    expect(restoreDescriptorSnapshotReplacements([])).toEqual(
      expect.objectContaining({
        ok: false,
        phase: "staging",
        message: expect.stringContaining("replacement plan is invalid"),
      }),
    );
  });

  it("rejects malformed helper output", () => {
    helperControls.result = { status: 0, stdout: "not-json", stderr: "" };

    expect(restoreDescriptorSnapshotReplacements([replacement])).toEqual(
      expect.objectContaining({ ok: false, phase: "staging" }),
    );
  });

  it("rejects structurally invalid helper output", () => {
    helperControls.result = { status: 0, stdout: "{}", stderr: "" };

    expect(restoreDescriptorSnapshotReplacements([replacement])).toEqual(
      expect.objectContaining({ ok: false, phase: "staging" }),
    );
  });
});
