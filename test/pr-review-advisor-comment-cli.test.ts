// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  normalizeCommentOptions,
  readCommentArtifacts,
} from "../tools/pr-review-advisor/comment.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("PR review advisor comment CLI", () => {
  it("validates configurable comment CLI fields and explicit artifacts", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-comment-"));
    const defaultSummary = path.join(
      tmp,
      "artifacts",
      "pr-review-advisor",
      "pr-review-advisor-summary.md",
    );
    const defaultResult = path.join(
      tmp,
      "artifacts",
      "pr-review-advisor",
      "pr-review-advisor-final-result.json",
    );
    const laneSummary = path.join(
      tmp,
      "artifacts",
      "pr-review-advisor-nemotron-ultra",
      "pr-review-advisor-summary.md",
    );
    const laneResult = path.join(
      tmp,
      "artifacts",
      "pr-review-advisor-nemotron-ultra",
      "pr-review-advisor-final-result.json",
    );
    fs.mkdirSync(path.dirname(defaultSummary), { recursive: true });
    fs.writeFileSync(defaultSummary, "# default lane\n");
    fs.writeFileSync(
      defaultResult,
      `${JSON.stringify({ summary: { recommendation: "merge_as_is" } })}\n`,
    );

    try {
      expect(
        readCommentArtifacts(defaultSummary, defaultResult, {
          summaryExplicit: true,
          resultExplicit: true,
        }),
      ).toEqual({
        summary: "# default lane\n",
        result: { summary: { recommendation: "merge_as_is" } },
      });
      expect(
        normalizeCommentOptions({
          marker: "<!-- nemoclaw-pr-review-advisor-nemotron-ultra -->",
          title: "PR Review Advisor (Nemotron Ultra)",
          label: "PR review advisor (Nemotron Ultra)",
        }),
      ).toMatchObject({ marker: "<!-- nemoclaw-pr-review-advisor-nemotron-ultra -->" });
      expect(() =>
        normalizeCommentOptions({ marker: "<!-- other -->", title: "ok", label: "ok" }),
      ).toThrow(/marker must be a safe/);
      expect(() =>
        normalizeCommentOptions({
          marker: "<!-- nemoclaw-pr-review-advisor -->",
          title: "bad\nheading",
          label: "ok",
        }),
      ).toThrow(/title must be a non-empty single-line string/);
      expect(() =>
        readCommentArtifacts(laneSummary, laneResult, { summaryExplicit: true }),
      ).toThrow(`No PR review advisor summary found at ${laneSummary}`);
      fs.mkdirSync(path.dirname(laneSummary), { recursive: true });
      fs.writeFileSync(laneSummary, "# nemotron lane\n");
      expect(() =>
        readCommentArtifacts(laneSummary, laneResult, {
          summaryExplicit: true,
          resultExplicit: true,
        }),
      ).toThrow(`No PR review advisor result found at ${laneResult}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
