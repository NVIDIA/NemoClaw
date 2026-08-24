// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ReviewTestDepth = {
  verdict: "unknown" | "unit_sufficient" | "mocks_recommended" | "runtime_validation_recommended";
  rationale: string;
  suggestedTests: string[];
};

type QualityFinding = {
  title: string;
  description: string;
  impact: string;
  recommendation: string;
  verificationHint: string;
  missingRegressionTest: string;
  evidence: string | readonly string[];
};

type QualityReview = {
  findings: readonly QualityFinding[];
};

const PLACEHOLDER_VALUES = new Set([
  "No description provided.",
  "Review manually.",
  "No evidence provided.",
  "No impact provided.",
  "No verification hint provided.",
  "No regression test recommendation provided.",
]);

export function reviewQualityIssues(result: QualityReview): string[] {
  const issues: string[] = [];
  for (const [index, finding] of result.findings.entries()) {
    const prefix = `findings[${index + 1}] ${finding.title}`;
    for (const field of [
      "description",
      "impact",
      "recommendation",
      "verificationHint",
      "missingRegressionTest",
      "evidence",
    ] as const) {
      const fieldValue = finding[field];
      const value = typeof fieldValue === "string" ? fieldValue : fieldValue.join("\n");
      if (!value.trim() || PLACEHOLDER_VALUES.has(value)) {
        issues.push(`${prefix} has placeholder ${field}`);
      }
    }
  }
  return issues.slice(0, 20);
}

const VERDICT_RANK: Record<ReviewTestDepth["verdict"], number> = {
  unknown: 0,
  unit_sufficient: 1,
  mocks_recommended: 2,
  runtime_validation_recommended: 3,
};

export function enforceDeterministicTestDepthFloor(
  requested: ReviewTestDepth,
  deterministic: ReviewTestDepth,
): ReviewTestDepth {
  const verdict =
    VERDICT_RANK[requested.verdict] < VERDICT_RANK[deterministic.verdict]
      ? deterministic.verdict
      : requested.verdict;
  const deterministicTests = unique(deterministic.suggestedTests);
  const requestedTests = unique(requested.suggestedTests).filter(
    (test) => !deterministicTests.includes(test),
  );
  return {
    verdict,
    rationale: [...new Set([deterministic.rationale, requested.rationale])].join(" "),
    suggestedTests: [...deterministicTests, ...requestedTests].slice(0, 20),
  };
}

function unique(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}
