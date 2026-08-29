// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDiff } from "../../../tools/advisors/git.mts";

const ROOT = path.resolve(import.meta.dirname, "../../..");

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

  it("falls back to a two-dot diff when the refs have no merge base", () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-pr-advisor-diff-"));
    const previousCwd = process.cwd();
    let diff = "";

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tmp });
      fs.writeFileSync(path.join(tmp, "base.txt"), "base\n");
      execFileSync("git", ["add", "base.txt"], { cwd: tmp });
      commit(tmp, "base");
      const base = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: tmp,
        encoding: "utf8",
      }).trim();

      execFileSync("git", ["checkout", "--orphan", "unrelated", "--quiet"], { cwd: tmp });
      execFileSync("git", ["rm", "-rf", ".", "--quiet"], { cwd: tmp });
      fs.writeFileSync(path.join(tmp, "head.txt"), "fallback-tail\n");
      execFileSync("git", ["add", "head.txt"], { cwd: tmp });
      commit(tmp, "head");

      process.chdir(tmp);
      diff = getDiff(base, "HEAD");
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    expect(diff).toContain("fallback-tail");
  });

  it("fails when neither diff form can resolve the requested ref", () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-pr-advisor-diff-"));
    const previousCwd = process.cwd();

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tmp });
      fs.writeFileSync(path.join(tmp, "review.txt"), "base\n");
      execFileSync("git", ["add", "review.txt"], { cwd: tmp });
      commit(tmp, "base");
      const base = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: tmp,
        encoding: "utf8",
      }).trim();

      process.chdir(tmp);
      expect(() => getDiff(base, "missing-ref")).toThrow("failed to read complete diff");
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes failure artifacts when trusted Git inputs are unavailable", () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-pr-advisor-diff-"));
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(ROOT, "tools/pr-review-advisor/analyze.mts"),
        "--base",
        "missing-ref",
        "--head",
        "HEAD",
        "--schema",
        path.join(ROOT, "tools/pr-review-advisor/schema.json"),
        "--out-dir",
        tmp,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );

    try {
      expect(result.status).toBe(1);
      expect(
        JSON.parse(fs.readFileSync(path.join(tmp, "pr-review-advisor-result.json"), "utf8")),
      ).toMatchObject({ failed: true });
      expect(
        JSON.parse(fs.readFileSync(path.join(tmp, "pr-review-advisor-final-result.json"), "utf8")),
      ).toMatchObject({
        headSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
        reviewCompleteness: { requiresHumanReview: true },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function commit(cwd: string, message: string): void {
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
      message,
    ],
    { cwd },
  );
}
