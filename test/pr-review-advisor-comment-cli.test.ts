// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  buildComment,
  normalizeAdvisorLaneReport,
  normalizeCommentOptions,
  readAdvisorLaneReports,
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

  it("normalizes completed, partial, failed, skipped, and unavailable lane states", () => {
    const headSha = "a".repeat(40);
    const finalResult = {
      version: 1,
      headSha,
      summary: { confidence: "high" },
      findings: [
        { severity: "blocker", title: "one" },
        { severity: "warning", title: "two" },
        { severity: "suggestion", title: "three" },
        { severity: "invalid", title: "ignored" },
      ],
      e2e: {
        coverage: {
          requiredTests: [{ id: "security-posture", reason: "not fingerprinted" }],
          optionalTests: [],
        },
        targets: {
          required: [
            {
              id: "security-posture",
              workflow: "e2e.yaml",
              selectorType: "job",
              reason: "not fingerprinted",
            },
          ],
          optional: [],
        },
      },
    };

    const completed = normalizeAdvisorLaneReport(finalResult, finalResult, headSha);
    expect(completed).toMatchObject({
      status: "completed",
      partial: false,
      confidence: "high",
      counts: { blockers: 1, warnings: 1, suggestions: 1 },
    });
    expect(completed.fingerprints?.findings).toMatch(/^[0-9a-f]{64}$/u);
    expect(completed.fingerprints?.e2e).toMatch(/^[0-9a-f]{64}$/u);
    const reordered = normalizeAdvisorLaneReport(
      { ...finalResult, findings: [...finalResult.findings].reverse() },
      { ...finalResult, findings: [...finalResult.findings].reverse() },
      headSha,
    );
    expect(reordered.fingerprints?.findings).toBe(completed.fingerprints?.findings);

    expect(
      normalizeAdvisorLaneReport(
        { failed: true, partial: true, reason: "provider text must not render" },
        { ...finalResult, summary: { confidence: "low" } },
        headSha,
      ),
    ).toMatchObject({
      status: "failed",
      partial: true,
      confidence: "low",
      counts: { blockers: 1, warnings: 1, suggestions: 1 },
    });
    expect(normalizeAdvisorLaneReport({ failed: true }, finalResult, headSha)).toEqual({
      status: "failed",
      partial: false,
    });
    expect(normalizeAdvisorLaneReport({ skipped: true }, finalResult, headSha)).toEqual({
      status: "skipped",
      partial: false,
    });
    expect(normalizeAdvisorLaneReport(undefined, finalResult, headSha)).toEqual({
      status: "unavailable",
      partial: false,
    });
    expect(normalizeAdvisorLaneReport(finalResult, finalResult, "b".repeat(40))).toEqual({
      status: "unavailable",
      partial: false,
    });
  });

  it("reads optional second-opinion artifacts without making them publication-critical", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-lanes-"));
    const primaryAnalysis = path.join(tmp, "primary-analysis.json");
    const secondaryAnalysis = path.join(tmp, "secondary-analysis.json");
    const secondaryResult = path.join(tmp, "secondary-final.json");
    const headSha = "a".repeat(40);
    const primaryResult = {
      version: 1,
      headSha,
      summary: { confidence: "medium" },
      findings: [],
    };
    fs.writeFileSync(primaryAnalysis, `${JSON.stringify(primaryResult)}\n`);
    fs.writeFileSync(
      secondaryAnalysis,
      `${JSON.stringify({ failed: true, partial: true, reason: "secret-like failure text" })}\n`,
    );
    fs.writeFileSync(
      secondaryResult,
      `${JSON.stringify({
        version: 1,
        headSha,
        summary: { confidence: "low", oneLine: "untrusted secondary prose" },
        findings: [{ severity: "warning", title: "secondary finding prose" }],
      })}\n`,
    );

    try {
      expect(
        readAdvisorLaneReports({
          primaryAnalysisResultPath: primaryAnalysis,
          primaryResult,
          secondOpinionAnalysisResultPath: secondaryAnalysis,
          secondOpinionResultPath: secondaryResult,
        }),
      ).toMatchObject({
        primary: { status: "completed", confidence: "medium" },
        secondOpinion: {
          status: "failed",
          partial: true,
          confidence: "low",
          counts: { blockers: 0, warnings: 1, suggestions: 0 },
        },
      });
      fs.writeFileSync(secondaryResult, "not json\n");
      expect(
        readAdvisorLaneReports({
          primaryAnalysisResultPath: primaryAnalysis,
          primaryResult,
          secondOpinionAnalysisResultPath: secondaryAnalysis,
          secondOpinionResultPath: secondaryResult,
        }).secondOpinion,
      ).toEqual({ status: "unavailable", partial: false });
      expect(
        readAdvisorLaneReports({
          primaryAnalysisResultPath: primaryAnalysis,
          primaryResult,
        }).secondOpinion,
      ).toEqual({ status: "unavailable", partial: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("renders sanitized model-lane status and structural disagreement only", () => {
    const result = {
      version: 1,
      headSha: "a".repeat(40),
      summary: {
        recommendation: "info_only",
        confidence: "high",
        oneLine: "Primary review completed.",
      },
      findings: [{ severity: "warning", title: "Primary warning" }],
      e2e: {
        coverage: {
          requiredTests: [],
          optionalTests: [{ id: "docs-validation", reason: "primary optional coverage" }],
        },
        targets: {
          required: [],
          optional: [
            {
              id: "docs-validation",
              workflow: "e2e.yaml",
              selectorType: "job",
              required: false,
              reason: "primary optional selector",
            },
          ],
        },
      },
    };
    const primary = normalizeAdvisorLaneReport(result, result, result.headSha);
    const secondOpinionResult = {
      version: 1,
      headSha: result.headSha,
      summary: { confidence: "low", oneLine: "do not publish this summary" },
      findings: [{ severity: "warning", title: "do not publish this finding" }],
      e2e: {
        coverage: { requiredTests: [{ id: "security-posture" }], optionalTests: [] },
        targets: { required: [], optional: [] },
      },
    };
    const secondOpinion = normalizeAdvisorLaneReport(
      secondOpinionResult,
      secondOpinionResult,
      result.headSha,
    );
    const comment = buildComment({
      summary: "# ignored\n",
      result,
      lanes: { primary, secondOpinion },
    });

    expect(comment).toContain("**Advisor assessment:** Informational / high confidence");
    expect(comment).toContain(
      "**GPT-5.6 Terra (primary):** Completed · high confidence · 0 blockers · 1 warning · 0 suggestions",
    );
    expect(comment).toContain(
      "**Nemotron 3 Ultra (non-blocking second opinion):** Completed · low confidence · 0 blockers · 1 warning · 0 suggestions",
    );
    expect(comment).toContain("normalized findings differ");
    expect(comment).toContain("normalized E2E selections differ");
    expect(comment).toContain("severity counts match");
    expect(comment).not.toContain("do not publish this summary");
    expect(comment).not.toContain("do not publish this finding");
    expect(comment).not.toContain("Why no E2E coverage is recommended");
    expect(comment).not.toContain("Why no selector is recommended");

    const partialComment = buildComment({
      summary: "# ignored\n",
      result,
      lanes: {
        primary,
        secondOpinion: normalizeAdvisorLaneReport(
          { failed: true, partial: true, reason: "do not publish this provider failure" },
          secondOpinionResult,
          result.headSha,
        ),
      },
    });
    expect(partialComment).toContain(
      "**Nemotron 3 Ultra (non-blocking second opinion):** Failed after a partial review · low confidence · 0 blockers · 1 warning · 0 suggestions",
    );
    expect(partialComment).not.toContain("Model comparison");
    expect(partialComment).not.toContain("do not publish this provider failure");
    expect(partialComment).not.toContain("do not publish this summary");
    expect(partialComment).not.toContain("do not publish this finding");
  });
});
