// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDiff } from "../tools/advisors/git.mts";

describe("PR review advisor diff", () => {
  it("keeps content after 160,000 characters", () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-pr-advisor-diff-"));
    const previousCwd = process.cwd();
    let diff = "";

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tmp });
      fs.writeFileSync(path.join(tmp, "review.txt"), "base\n");
      execFileSync("git", ["add", "review.txt"], { cwd: tmp });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=NemoClaw Test",
          "-c",
          "user.email=nemoclaw-test@example.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "-m",
          "base",
        ],
        { cwd: tmp },
      );
      const base = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: tmp,
        encoding: "utf8",
      }).trim();

      fs.writeFileSync(
        path.join(tmp, "review.txt"),
        `${"x".repeat(170_000)}\ncomplete-diff-tail\n`,
      );
      execFileSync("git", ["add", "review.txt"], { cwd: tmp });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=NemoClaw Test",
          "-c",
          "user.email=nemoclaw-test@example.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "-m",
          "head",
        ],
        { cwd: tmp },
      );

      process.chdir(tmp);
      diff = getDiff(base, "HEAD");
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    expect(diff).toContain("complete-diff-tail");
    expect(diff).not.toContain("<diff truncated");
  });
});
