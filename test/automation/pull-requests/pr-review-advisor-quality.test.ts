// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSummary } from "../../../tools/pr-review-advisor/render-result.mts";
import { reviewQualityIssues } from "../../../tools/pr-review-advisor/review-quality.mts";
import {
  buildSystemPrompt,
  readTrustedSecurityRubric,
} from "../../../tools/pr-review-advisor/trusted-guidance.mts";
import { buildComment } from "../../../tools/pr-review-advisor/comment.mts";
import { ROOT, validResult } from "../../helpers/pr-review-advisor-test-fixtures.ts";

describe("PR review advisor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flags low-quality normalized advisor fields for same-session validation", () => {
    const currentFinding = validResult().findings[0]!;
    const result = validResult({
      findings: [{ ...currentFinding, impact: "No impact provided." }],
    });

    expect(reviewQualityIssues(result)).toContain(
      "findings[1] trusted-code boundary has placeholder impact",
    );
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
      expect(rubric).toContain("## Category 9: System Security");
      expect(rubric).not.toContain("PR-controlled rubric");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("embeds the complete trusted security rubric in the model prompt", () => {
    const rubric = readTrustedSecurityRubric();

    expect(buildSystemPrompt()).toContain(rubric);
  });

  it("reports a missing trusted security rubric", () => {
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("missing rubric fixture");
    });

    expect(() => readTrustedSecurityRubric()).toThrow("Security rubric unavailable");
  });

  it.each([
    [
      "a missing category",
      (rubric: string) => rubric.replace(/## Category 5:.*?(?=## Category 6:)/su, ""),
      "must define exactly 9 categories",
    ],
    [
      "an out-of-order category",
      (rubric: string) => rubric.replace("## Category 2:", "## Category 3:"),
      "category 2 has a malformed heading",
    ],
    [
      "a duplicate category name",
      (rubric: string) =>
        rubric.replace("## Category 2: Input Validation and Data Sanitization", "## Category 2: Secrets and Credentials"),
      "category names must be unique",
    ],
    [
      "an empty category section",
      (rubric: string) =>
        rubric.replace(
          /### Meaning\n\nKeep credentials[^\n]*\n/u,
          "### Meaning\n\n",
        ),
      "category 1 has empty Meaning",
    ],
    [
      "a different final category",
      (rubric: string) => rubric.replace("## Category 9: System Security", "## Category 9: Host Security"),
      "category 9 must be System Security",
    ],
    [
      "reordered category subsections",
      (rubric: string) =>
        rubric
          .replace("### Meaning", "### Temporary")
          .replace("### Questions", "### Meaning")
          .replace("### Temporary", "### Questions"),
      "must define Meaning, Questions, and Expected evidence in order",
    ],
  ])("rejects a trusted security rubric with %s", (_case, mutate, message) => {
    const malformed = mutate(readTrustedSecurityRubric());
    vi.spyOn(fs, "readFileSync").mockReturnValueOnce(malformed);

    expect(() => readTrustedSecurityRubric()).toThrow(message);
  });

  it("renders summaries and sticky comments with maintainer-review framing", () => {
    const result = validResult();
    const summary = renderSummary(result);
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
        marker: "<!-- nemoclaw-pr-review-advisor-alternate -->",
        title: "Alternate Review Title",
      }),
    ).toContain("## Alternate Review Title — Blocking findings reported");
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
  });
});
