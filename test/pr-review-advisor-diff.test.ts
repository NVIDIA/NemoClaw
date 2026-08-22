// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDiff, getFileDiff } from "../tools/advisors/git.mts";
import {
  createGitDiffToolController,
  PR_REVIEW_DIFF_PAGE_CHARACTER_LIMIT,
  PR_REVIEW_DIFF_TOTAL_CHARACTER_LIMIT,
  PR_REVIEW_GIT_DIFF_TOOL,
} from "../tools/pr-review-advisor/git-diff-tool.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("PR review advisor diff", () => {
  it("keeps content after 160,000 characters", () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-pr-advisor-diff-"));
    const previousCwd = process.cwd();
    let diff = "";
    let fileDiff = "";

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
      fileDiff = getFileDiff(base, "HEAD", "review.txt");
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    expect(diff).toContain("complete-diff-tail");
    expect(diff).not.toContain("<diff truncated");
    expect(fileDiff).toBe(diff);
  });

  it("serves an oversized file diff through bounded pages", async () => {
    const oversizedDiff = `diff --git a/review.txt b/review.txt\n${"x".repeat(1_700_000)}\ncomplete-diff-tail\n`;
    const readFileDiff = vi.fn(() => oversizedDiff);
    const controller = createGitDiffToolController({
      baseRef: "base",
      headRef: "head",
      changedFiles: ["review.txt", "src/other.ts"],
      totalDiffCharacters: oversizedDiff.length,
      readFileDiff,
    });
    const diffTool = controller.tools.find((tool) => tool.name === PR_REVIEW_GIT_DIFF_TOOL)!;
    const manifestResult = await diffTool.execute(
      "manifest",
      {},
      undefined,
      undefined,
      undefined as never,
    );
    const manifest = JSON.parse(
      manifestResult.content[0]?.type === "text" ? manifestResult.content[0].text : "{}",
    ) as { changedFiles: string[]; nextCursor: number | null };

    expect(manifest).toMatchObject({
      changedFiles: ["review.txt", "src/other.ts"],
      nextCursor: null,
    });
    expect(JSON.stringify(manifest)).not.toContain("complete-diff-tail");

    const firstResult = await diffTool.execute(
      "first-page",
      { path: "review.txt", cursor: 0 },
      undefined,
      undefined,
      undefined as never,
    );
    const firstPage = JSON.parse(
      firstResult.content[0]?.type === "text" ? firstResult.content[0].text : "{}",
    ) as { chunk: string; nextCursor: number | null };
    expect(firstPage.chunk.length).toBeLessThanOrEqual(PR_REVIEW_DIFF_PAGE_CHARACTER_LIMIT);
    expect(firstPage.nextCursor).not.toBeNull();

    const tailCursor = oversizedDiff.length - "complete-diff-tail\n".length;
    const tailResult = await diffTool.execute(
      "tail-page",
      { path: "review.txt", cursor: tailCursor },
      undefined,
      undefined,
      undefined as never,
    );
    const tailPage = JSON.parse(
      tailResult.content[0]?.type === "text" ? tailResult.content[0].text : "{}",
    ) as { chunk: string; nextCursor: number | null };
    expect(tailPage).toMatchObject({ chunk: "complete-diff-tail\n", nextCursor: null });
    expect(readFileDiff).toHaveBeenCalledOnce();
  });

  it("rejects diff reads outside the deterministic changed-file list", async () => {
    const controller = createGitDiffToolController({
      baseRef: "base",
      headRef: "head",
      changedFiles: ["review.txt"],
      totalDiffCharacters: 1,
      readFileDiff: vi.fn(() => "diff"),
    });
    const diffTool = controller.tools[0]!;

    await expect(
      diffTool.execute(
        "outside",
        { path: "../outside.txt" },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("not in the deterministic changed-file list");
  });

  it("bounds aggregate diff context and suppresses repeated pages", async () => {
    const changedFiles = Array.from({ length: 9 }, (_, index) => `review-${String(index)}.txt`);
    const readFileDiff = vi.fn(() => "x".repeat(PR_REVIEW_DIFF_PAGE_CHARACTER_LIMIT + 1));
    const controller = createGitDiffToolController({
      baseRef: "base",
      headRef: "head",
      changedFiles,
      totalDiffCharacters: changedFiles.length * (PR_REVIEW_DIFF_PAGE_CHARACTER_LIMIT + 1),
      readFileDiff,
    });
    const diffTool = controller.tools[0]!;

    for (const [index, file] of changedFiles.slice(0, 8).entries()) {
      const result = await diffTool.execute(
        `page-${String(index)}`,
        { path: file },
        undefined,
        undefined,
        undefined as never,
      );
      const page = JSON.parse(
        result.content[0]?.type === "text" ? result.content[0].text : "{}",
      ) as { kind: string; characterBudget: { served: number; remaining: number } };
      expect(page.kind).toBe("file_diff");
      expect(page.characterBudget.served).toBe((index + 1) * PR_REVIEW_DIFF_PAGE_CHARACTER_LIMIT);
    }

    const exhaustedResult = await diffTool.execute(
      "exhausted",
      { path: changedFiles[8] },
      undefined,
      undefined,
      undefined as never,
    );
    const exhausted = JSON.parse(
      exhaustedResult.content[0]?.type === "text" ? exhaustedResult.content[0].text : "{}",
    ) as { kind: string; characterBudget: { served: number; remaining: number } };
    expect(exhausted).toMatchObject({
      kind: "file_diff_budget_exhausted",
      characterBudget: { served: PR_REVIEW_DIFF_TOTAL_CHARACTER_LIMIT, remaining: 0 },
    });

    const repeatedResult = await diffTool.execute(
      "repeated",
      { path: changedFiles[0] },
      undefined,
      undefined,
      undefined as never,
    );
    const repeated = JSON.parse(
      repeatedResult.content[0]?.type === "text" ? repeatedResult.content[0].text : "{}",
    ) as { kind: string };
    expect(repeated.kind).toBe("file_diff_page_already_served");
    expect(readFileDiff).toHaveBeenCalledTimes(8);
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
