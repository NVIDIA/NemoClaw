// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PR Review Advisor writing guide", () => {
  it("loads the guide from the advisor checkout", async () => {
    const originalCwd = process.cwd();
    const prWorktree = fs.mkdtempSync(path.join(tmpdir(), "advisor-writing-guide-"));
    fs.writeFileSync(path.join(prWorktree, "WRITING.md"), "# PR-controlled writing guide\n");

    try {
      process.chdir(prWorktree);
      const { readTrustedWritingGuide } = await import("../tools/pr-review-advisor/analyze.mts");
      const writingGuide = readTrustedWritingGuide();

      expect(writingGuide).toContain("# NemoClaw Writing Guide");
      expect(writingGuide).not.toContain("PR-controlled writing guide");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(prWorktree, { recursive: true, force: true });
    }
  });

  it("stops when the trusted guide is unavailable", async () => {
    const { readTrustedWritingGuide } = await import("../tools/pr-review-advisor/analyze.mts");
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("missing guide fixture");
    });

    expect(() => readTrustedWritingGuide()).toThrow("Writing guide unavailable");
  });
});
