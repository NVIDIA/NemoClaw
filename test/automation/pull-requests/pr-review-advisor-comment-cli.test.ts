// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  E2E_RENDER_LIMIT,
  trustedE2eRecommendationInventory,
} from "../../../tools/advisors/e2e-recommendations.mts";
import {
  buildComment,
  normalizeAdvisorReport,
  normalizeCommentOptions,
  readAdvisorReport,
  readCommentArtifacts,
} from "../../../tools/pr-review-advisor/comment.mts";

const ROOT = path.resolve(import.meta.dirname, "../../..");

describe("PR review advisor comment CLI", () => {
  it("reports E2E recommendations that do not fit", () => {
    const inventory = trustedE2eRecommendationInventory();
    const trustedIds = [...inventory.allowedJobIds, ...inventory.manualOnlyJobIds]
      .filter((id) => id !== "inference-routing" && id !== "managed-image-protected-runtime")
      .slice(0, 2 * (E2E_RENDER_LIMIT + 1));
    const requiredIds = trustedIds.slice(0, E2E_RENDER_LIMIT + 1);
    const optionalIds = trustedIds.slice(E2E_RENDER_LIMIT + 1);
    expect(requiredIds).toHaveLength(E2E_RENDER_LIMIT + 1);
    expect(optionalIds).toHaveLength(E2E_RENDER_LIMIT + 1);

    const comment = buildComment({
      summary: "unused",
      result: {
        e2e: {
          coverage: {
            requiredTests: requiredIds.map((id) => ({
              id,
              reason: "Trusted E2E recommendation.",
            })),
            optionalTests: optionalIds.map((id) => ({
              id,
              reason: "Trusted optional E2E recommendation.",
            })),
          },
          targets: { required: [], optional: [] },
        },
      },
    });

    const renderedIds = [...comment.matchAll(/<code>([^<]+)<\/code>/gu)].map((match) => match[1]);
    expect(renderedIds).toEqual([
      ...requiredIds.slice(0, E2E_RENDER_LIMIT),
      ...optionalIds.slice(0, E2E_RENDER_LIMIT),
    ]);
    expect(renderedIds).not.toContain(requiredIds.at(-1));
    expect(renderedIds).not.toContain(optionalIds.at(-1));
    expect(comment).toContain("(+1 more)");
    expect(comment).toContain(
      `<summary>${E2E_RENDER_LIMIT + 1} optional E2E recommendations</summary>`,
    );
    expect(comment).toContain("- _1 more._");
  });

  it("does not render terminology without a source commit", () => {
    const comment = buildComment({
      summary: "unused",
      result: {
        terminologyReview: {
          status: "candidates",
          noChangesReason: null,
          decisions: [
            {
              term: "review-bound",
              disposition: "replace",
              recommendation: "Use commit SHA.",
              source: { file: "guide.md", line: 4 },
            },
          ],
        },
      },
    });

    expect(comment).not.toContain("semantic terminology decision");
    expect(comment).not.toContain("review-bound");
  });

  it("ignores malformed E2E collections and selectors outside the trusted inventory", () => {
    const malformedCollectionsComment = buildComment({
      summary: "unused",
      result: {
        e2e: {
          coverage: { requiredTests: {}, optionalTests: "full-e2e" },
          targets: { required: "full-e2e", optional: {} },
        },
      } as never,
    });
    expect(malformedCollectionsComment).toContain("**Recommended E2E:** _None_");
    expect(malformedCollectionsComment).not.toContain("<code>full-e2e</code>");

    const selectorTypeComment = buildComment({
      summary: "unused",
      result: {
        e2e: {
          coverage: { requiredTests: [], optionalTests: [] },
          targets: {
            required: [
              {
                id: "security-posture",
                workflow: "e2e.yaml",
                selectorType: "job",
                required: true,
              },
              {
                id: "full-e2e",
                workflow: "e2e.yaml",
                selectorType: "workflow",
                required: true,
              },
            ],
            optional: [],
          },
        },
      },
    });
    expect(selectorTypeComment).toContain("**Manual-only E2E:** <code>security-posture</code>");
    expect(selectorTypeComment).not.toContain("<code>full-e2e</code>");
  });

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
    const customSummary = path.join(
      tmp,
      "artifacts",
      "alternate-review-advisor",
      "pr-review-advisor-summary.md",
    );
    const customResult = path.join(
      tmp,
      "artifacts",
      "alternate-review-advisor",
      "pr-review-advisor-final-result.json",
    );
    fs.mkdirSync(path.dirname(defaultSummary), { recursive: true });
    fs.writeFileSync(defaultSummary, "# default synthesis\n");
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
        summary: "# default synthesis\n",
        result: { summary: { recommendation: "merge_as_is" } },
      });
      expect(
        normalizeCommentOptions({
          marker: "<!-- nemoclaw-pr-review-advisor-alternate -->",
          title: "Alternate Review Title",
          label: "alternate review advisor",
        }),
      ).toMatchObject({ marker: "<!-- nemoclaw-pr-review-advisor-alternate -->" });
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
        readCommentArtifacts(customSummary, customResult, { summaryExplicit: true }),
      ).toThrow(`No PR review advisor summary found at ${customSummary}`);
      fs.mkdirSync(path.dirname(customSummary), { recursive: true });
      fs.writeFileSync(customSummary, "# custom synthesis\n");
      expect(() =>
        readCommentArtifacts(customSummary, customResult, {
          summaryExplicit: true,
          resultExplicit: true,
        }),
      ).toThrow(`No PR review advisor result found at ${customResult}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes the authoritative synthesis status", () => {
    const finalResult = {
      version: 1,
      summary: { confidence: "high" },
      findings: [
        { severity: "blocker", title: "one" },
        { severity: "warning", title: "two" },
        { severity: "suggestion", title: "three" },
        { severity: "invalid", title: "ignored" },
      ],
    };

    expect(normalizeAdvisorReport(finalResult, finalResult)).toEqual({
      status: "completed",
      partial: false,
      confidence: "high",
      counts: { blockers: 1, warnings: 1, suggestions: 1 },
    });
    expect(
      normalizeAdvisorReport(
        { failed: true, partial: true, reason: "provider text must not render" },
        { ...finalResult, summary: { confidence: "low" } },
      ),
    ).toEqual({
      status: "failed",
      partial: true,
      confidence: "low",
      counts: { blockers: 1, warnings: 1, suggestions: 1 },
    });
    expect(normalizeAdvisorReport({ failed: true }, finalResult)).toEqual({
      status: "failed",
      partial: false,
    });
    expect(normalizeAdvisorReport({ skipped: true }, finalResult)).toEqual({
      status: "skipped",
      partial: false,
    });
    expect(normalizeAdvisorReport(undefined, finalResult)).toEqual({
      status: "unavailable",
      partial: false,
    });
  });

  it("reads one authoritative synthesis result", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-result-"));
    const analysis = path.join(tmp, "analysis.json");
    const result = {
      version: 1,
      summary: { confidence: "medium" },
      findings: [],
    };
    fs.writeFileSync(analysis, `${JSON.stringify(result)}\n`);

    try {
      expect(readAdvisorReport(analysis, result)).toEqual({
        status: "completed",
        partial: false,
        confidence: "medium",
        counts: { blockers: 0, warnings: 0, suggestions: 0 },
      });
      expect(() => readAdvisorReport(path.join(tmp, "missing.json"), result)).toThrow(
        /No advisor analysis result found/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("renders sanitized authoritative synthesis status", () => {
    const result = {
      version: 1,
      summary: {
        recommendation: "info_only",
        confidence: "high",
        oneLine: "Synthesis completed.",
      },
      findings: [{ severity: "warning", title: "Review warning" }],
    };
    const comment = buildComment({
      summary: "# ignored\n",
      result,
      report: normalizeAdvisorReport(result, result),
    });

    expect(comment).toContain("**Advisor assessment:** Informational / high confidence");
    expect(comment).toContain(
      "**Synthesis status:** Completed · high confidence · 0 blockers · 1 warning · 0 suggestions",
    );
    expect(comment).toContain("**Status:** Synthesis completed.");
    expect(comment).not.toContain("Model lanes");
    expect(comment).not.toContain("second opinion");
  });
});
