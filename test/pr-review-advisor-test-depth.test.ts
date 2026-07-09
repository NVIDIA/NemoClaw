// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { renderSummary, sanitizeTestDepth } from "../tools/pr-review-advisor/analyze.mts";
import { buildComment } from "../tools/pr-review-advisor/comment.mts";

type TestDepth = Parameters<typeof sanitizeTestDepth>[1];
type ReviewResult = Parameters<typeof renderSummary>[0];

function reviewResult(testDepth: TestDepth): ReviewResult {
  return {
    version: 1,
    baseRef: "origin/main",
    headRef: "HEAD",
    headSha: "abc123def456",
    changedFiles: ["tools/pr-review-advisor/analyze.mts"],
    summary: {
      recommendation: "merge_after_fixes",
      confidence: "high",
      oneLine: "Review requires deeper validation.",
    },
    findings: [],
    acceptanceCoverage: [],
    securityCategories: [],
    sourceOfTruthReview: [],
    testDepth,
    positives: [],
    reviewCompleteness: {
      limitations: ["Automated review only."],
      requiresHumanReview: true,
    },
  };
}

describe("PR review advisor deterministic test-depth floor", () => {
  it("preserves runtime validation against model downgrades (#6446)", () => {
    const result = sanitizeTestDepth(
      {
        verdict: "unit_sufficient",
        rationale: "The model found unit coverage sufficient.",
        suggestedTests: [],
      },
      {
        verdict: "runtime_validation_recommended",
        rationale: "The deterministic risk plan requires the sandbox-lifecycle E2E job.",
        suggestedTests: ["Run `sandbox-lifecycle` from the deterministic risk plan."],
      },
    );

    expect(result.verdict).toBe("runtime_validation_recommended");
    expect(result.rationale).toContain("deterministic risk plan");
    expect(result.suggestedTests).toEqual([
      "Run `sandbox-lifecycle` from the deterministic risk plan.",
    ]);
  });

  it("keeps the complete floor and model guidance visible within shared caps (#6446)", () => {
    const deterministicTests = Array.from(
      { length: 13 },
      (_value, index) => `Run deterministic E2E job ${index + 1}.`,
    );
    const modelTests = Array.from(
      { length: 20 },
      (_value, index) => `Add model-specific regression test ${index + 1}.`,
    );
    const testDepth = sanitizeTestDepth(
      {
        verdict: "runtime_validation_recommended",
        rationale: "The model identified a retry-specific gap.",
        suggestedTests: modelTests,
      },
      {
        verdict: "runtime_validation_recommended",
        rationale: "The deterministic risk plan requires runtime validation.",
        suggestedTests: deterministicTests,
      },
    );
    const result = reviewResult(testDepth);
    const summary = renderSummary(result);
    const comment = buildComment({ summary, result });

    expect(summary).toContain("Run deterministic E2E job 1.");
    expect(summary).toContain("Add model-specific regression test 1.");
    expect(comment).toContain("Run deterministic E2E job 1.");
    expect(comment).toContain("Add model-specific regression test 1.");
    expect(testDepth.suggestedTests).toHaveLength(20);
    expect(testDepth.suggestedTests).toEqual(expect.arrayContaining(deterministicTests));
  });
});
