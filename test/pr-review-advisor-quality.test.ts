// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeReviewResult,
  parseSecurityRubric,
  readTrustedSecurityRubric,
  recordSynthesisValidationFailureOnDraft,
  renderDetailedReview,
  renderSummary,
  reviewQualityIssues,
} from "../tools/pr-review-advisor/analyze.mts";
import { buildComment } from "../tools/pr-review-advisor/comment.mts";
import { metadata, ROOT, validResult } from "./helpers/pr-review-advisor-test-fixtures.ts";

describe("PR review advisor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flags low-quality normalized advisor fields for same-session validation", () => {
    const result = normalizeReviewResult(
      validResult({
        findings: [
          {
            severity: "warning",
            category: "correctness",
            file: "src/lib/example.ts",
            line: 1,
            title: "Missing details",
          },
        ],
        securityCategories: [],
      }),
      metadata(),
    );

    expect(reviewQualityIssues(result)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("placeholder impact"),
        "securityCategories were defaulted because the advisor omitted verdicts",
      ]),
    );
  });

  it("fills every security category instead of treating a partial review as complete", () => {
    const result = normalizeReviewResult(
      validResult({
        securityCategories: [
          {
            category: "Secrets and Credentials",
            verdict: "pass",
            justification: "No committed credential was found.",
          },
          {
            category: "Invented category",
            verdict: "pass",
            justification: "This category is not part of the security contract.",
          },
        ],
      }),
      metadata(),
    );

    expect(result.securityCategories).toHaveLength(9);
    expect(result.securityCategories).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "Invented category" })]),
    );
    expect(result.securityCategories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "Secrets and Credentials", verdict: "pass" }),
        expect.objectContaining({
          category: "System Security",
          verdict: "warning",
          justification: expect.stringContaining("maintainer review required"),
        }),
      ]),
    );
  });

  it("preserves the canonical draft when same-session synthesis validation fails", () => {
    const draft = normalizeReviewResult(validResult(), metadata());
    const preserved = recordSynthesisValidationFailureOnDraft(draft, "validation timeout");

    expect(preserved.findings).toEqual(draft.findings);
    expect(preserved.reviewCompleteness.limitations[0]).toContain("using canonical draft");
  });

  it("loads the security rubric from the trusted module checkout, not cwd", () => {
    const originalCwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-cwd-"));
    const rubricDir = path.join(tmp, ".agents", "skills", "_shared");
    fs.mkdirSync(rubricDir, { recursive: true });
    fs.writeFileSync(path.join(rubricDir, "security-rubric.md"), "# PR-controlled rubric\n");

    try {
      process.chdir(tmp);
      const rubric = readTrustedSecurityRubric();
      expect(rubric).toContain("# Security Rubric");
      expect(rubric).toContain("Category 9: System Security");
      expect(rubric).not.toContain("PR-controlled rubric");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing and malformed trusted security rubrics", () => {
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("missing rubric fixture");
    });
    expect(() => readTrustedSecurityRubric()).toThrow("Security rubric unavailable");
    readSpy.mockRestore();

    expect(() => parseSecurityRubric("# Security Rubric\n\n## Category 1: Secrets\n")).toThrow(
      "must define exactly 9 categories",
    );
    expect(() =>
      parseSecurityRubric(
        readTrustedSecurityRubric().replace("### Expected evidence", "### Evidence"),
      ),
    ).toThrow("must define Meaning, Questions, and Expected evidence in order");
    expect(() =>
      parseSecurityRubric(
        readTrustedSecurityRubric().replace(
          /### Meaning\n\nKeep credentials[^\n]*\n/u,
          "### Meaning\n\n",
        ),
      ),
    ).toThrow("has empty Meaning");
    expect(() =>
      parseSecurityRubric(
        readTrustedSecurityRubric().replace(
          "### Meaning\n\nKeep credentials",
          "### Questions\n\nDuplicate section.\n\n### Meaning\n\nKeep credentials",
        ),
      ),
    ).toThrow("must define Meaning, Questions, and Expected evidence in order");
  });

  it("renders summaries and sticky comments with maintainer-review framing", () => {
    const result = normalizeReviewResult(validResult(), metadata());
    const summary = renderSummary(result);
    const detailed = renderDetailedReview(result);
    const comment = buildComment({ summary, result, runUrl: "https://example.invalid/run" });

    expect(summary).toContain("# PR Review Advisor");
    expect(summary).toContain("trusted-code boundary");
    expect(summary).toContain("## Blockers");
    expect(summary).toContain("## Warnings");
    expect(summary).toContain("## Suggestions");
    expect(summary).toContain("## Recommended E2E");
    expect(summary).toContain("## Optional E2E");
    expect(summary).not.toContain("E2E coverage");
    expect(summary).not.toContain("E2E selectors");
    expect(summary).not.toContain("Test follow-ups");
    expect(summary).not.toContain("comment builder test");
    expect(summary).not.toContain("🛠️");
    expect(summary).not.toContain("🔎");
    expect(summary).not.toContain("🌱");
    expect(summary).not.toContain("## Acceptance coverage");
    expect(summary).not.toContain("## Security review");
    expect(detailed).toContain("## Acceptance coverage");
    expect(detailed).toContain("## Security review");
    expect(detailed).toContain("## Source-of-truth review");
    expect(detailed).toContain("trusted-code boundary");
    expect(comment).not.toContain("### Action checklist");
    expect(comment).not.toContain("### Findings index");
    expect(comment).not.toContain("PRA-T");
    expect(comment).not.toContain("comment builder test");
    expect(comment).toContain("<!-- head_sha: abc123def456; recommendation: merge_after_fixes -->");
    const provenanceComment = buildComment({
      summary,
      result,
      metadata: {
        runId: "99",
        runAttempt: "2",
        commentId: "7",
        eventName: "pull_request_target",
        prNumber: "42",
        workflowSha: "f".repeat(40),
        baseSha: "d".repeat(40),
        workflowPath: ".github/workflows/pr-review-advisor.yaml",
      },
    });
    expect(provenanceComment).toContain(
      `; event: pull_request_target; pr_number: 42; workflow_sha: ${"f".repeat(40)}; base_sha: ${"d".repeat(40)}; workflow_path: .github/workflows/pr-review-advisor.yaml -->`,
    );
    expect(comment).toContain("## PR Review Advisor — Blocking findings reported");
    expect(
      buildComment({
        summary,
        result,
        marker: "<!-- nemoclaw-pr-review-advisor-nemotron-ultra -->",
        title: "PR Review Advisor (Nemotron Ultra)",
      }),
    ).toContain("## PR Review Advisor (Nemotron Ultra) — Blocking findings reported");
    expect(() =>
      buildComment({
        summary,
        result,
        marker: "<!-- not-the-advisor -->",
        title: "PR Review Advisor",
      }),
    ).toThrow(/marker must be a safe/);
    expect(comment).toContain("**Advisor assessment:** Blockers require maintainer review");
    expect(comment).toContain("**Next action:** Review the blockers below.");
    expect(comment).toContain("### Blockers");
    expect(comment).toContain("#### `PRA-1` Blocker — trusted-code boundary");
    expect(comment).toContain(
      "- **Impact:** A PR-controlled workflow could run advisor code with repository secrets.",
    );
    expect(comment).toContain(
      "- **Verification:** Inspect the workflow checkout and advisor script path.",
    );
    expect(comment).not.toContain("Missing regression test");
    expect(comment).not.toContain("Expected follow-up");
    expect(comment).not.toContain("Done when");
    expect(comment).toContain("This automated review informs maintainers");
    expect(comment).toContain("Warnings and suggestions do not require a response");
    expect(comment).not.toContain("Full advisor summary");
    expect(comment).not.toContain("## Acceptance coverage");
    expect(comment).not.toContain("## Security review");
    expect(comment).toContain("[Workflow run details](https://example.invalid/run)");
    expect(comment).not.toContain("Full AC/security review artifact");
    expect(summary).not.toContain("Recommendation: **merge after fixes**");
    expect(summary).not.toContain("Confidence: **high**");
    expect(comment).toContain("<!-- nemoclaw-pr-review-advisor -->");
    expect(comment).toContain("A maintainer decides whether to merge");
    expect(summary).not.toContain("## Review completeness");
    expect(summary).not.toContain("Maintainer review required");
    expect(comment).toContain("**Findings:** 1 blocker · 0 warnings · 0 suggestions");
    expect(comment).not.toContain("**Top item:**");
    expect(comment.match(/`PRA-1`/g)).toHaveLength(1);
    expect(summary).not.toContain("Base: `origin/main`");
    expect(summary).not.toContain("Head: `HEAD`");
    expect(summary).not.toContain("Analyzed SHA: `abc123def456`");
    expect(comment).not.toContain("Analyzed SHA: `abc123def456`");
    expect(comment).not.toContain("**Recommendation:** merge after fixes");
    expect(comment).not.toContain("**Confidence:** high");

    const followUpResult = normalizeReviewResult(
      validResult({
        summary: {
          recommendation: "merge_after_fixes",
          confidence: "high",
          oneLine: "Follow-up review completed.",
          sinceLastReview: { resolved: 1, stillApplies: 1, newItems: 1 },
        },
      }),
      metadata(),
    );
    const followUp = buildComment({
      summary: renderSummary(followUpResult),
      result: followUpResult,
    });
    expect(followUp).toContain(
      "**Since last review:** 1 prior item resolved · 1 still applies · 1 new item found",
    );
    expect(followUp).not.toContain("Since last review details");
    expect(followUp.match(/`PRA-1`/g)).toHaveLength(1);
  });
});
