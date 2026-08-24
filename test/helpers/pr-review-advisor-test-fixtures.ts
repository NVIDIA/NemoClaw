// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildRiskPlan } from "../../tools/advisors/risk-plan.mts";
import type {
  ReviewAdvisorResult,
  ReviewMetadata,
} from "../../tools/pr-review-advisor/analyze.mts";

export const ROOT = path.resolve(import.meta.dirname, "../..");

export function metadata(overrides: Partial<ReviewMetadata> = {}): ReviewMetadata {
  const deterministic = {
    diffStat: "1 file changed",
    commits: ["abc123 feat: add review advisor"],
    riskyAreas: [],
    riskPlan: buildRiskPlan({ headSha: "abc123def456", changedFiles: [] }),
    testDepth: {
      verdict: "unit_sufficient",
      rationale: "deterministic fallback",
      suggestedTests: ["run unit tests"],
    },
    staticTestInventory: {
      changedTestFiles: [],
      nearbyTestNames: [],
      candidateExistingCoverage: [],
    },
    simplificationSignals: [],
    workflowSignals: [],
    localizedPatchSignals: [],
    driftEvidence: [],
    github: null,
  };
  return {
    baseRef: "origin/main",
    headRef: "HEAD",
    headSha: "abc123def456",
    changedFiles: ["tools/pr-review-advisor/analyze.mts"],
    deterministic,
    ...overrides,
  } as ReviewMetadata;
}

export function loadAdvisorSchema(): Record<string, unknown> {
  const schemaPath = path.join(ROOT, "tools", "pr-review-advisor", "schema.json");
  return JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as Record<string, unknown>;
}

export function validResult(overrides: Record<string, unknown> = {}): ReviewAdvisorResult {
  return {
    version: 1,
    baseRef: "origin/main",
    headRef: "HEAD",
    headSha: "abc123def456",
    changedFiles: ["tools/pr-review-advisor/analyze.mts"],
    summary: {
      recommendation: "merge_after_fixes",
      confidence: "high",
      oneLine: "Review found one fixable issue.",
      topItem: "trusted-code boundary",
    },
    findings: [
      {
        severity: "blocker",
        category: "workflow",
        file: ".github/workflows/pr-review-advisor.yaml",
        line: 42,
        title: "trusted-code boundary",
        description: "Workflow must execute trusted advisor code only.",
        impact: "A PR-controlled workflow could run advisor code with repository secrets.",
        recommendation: "Keep implementation checkout pinned to main.",
        verificationHint: "Inspect the workflow checkout and advisor script path.",
        missingRegressionTest: "Keep the workflow trusted-code boundary test.",
        evidence: "advisor scripts are invoked from ADVISOR_DIR",
      },
    ],
    terminologyReview: {
      status: "clear",
      decisions: [],
      noChangesReason: "No semantic terminology candidates were selected.",
    },
    acceptanceCoverage: [
      {
        clause: "post a sticky advisory comment",
        status: "met",
        evidence: "comment.mts uses marker",
      },
    ],
    sourceOfTruthReview: [
      {
        surface: "trusted-code boundary",
        status: "satisfied",
        findingId: null,
        invalidState: "PR-controlled workflow code could execute with secrets.",
        sourceBoundary: ".github/workflows/pr-review-advisor.yaml",
        whyNotSourceFix: "The workflow already uses the trusted main checkout.",
        regressionTest: "workflow trusted-code boundary test",
        removalCondition: "Not applicable; this is a permanent boundary rule.",
        evidence: "advisor scripts are invoked from ADVISOR_DIR",
      },
    ],
    e2e: {
      coverage: {
        classifiedDomains: [],
        requiredTests: [],
        optionalTests: [],
        newE2eRecommendations: [],
        noE2eReason: "No E2E impact.",
        confidence: "high",
      },
      targets: {
        relevantChangedFiles: [],
        changedCredentialFreeTests: [],
        required: [],
        optional: [],
        noTargetE2eReason: "No E2E target impact.",
        confidence: "high",
      },
    },
    testDepth: {
      verdict: "mocks_recommended",
      rationale: "GitHub API and filesystem paths are mocked in unit tests.",
      suggestedTests: ["comment builder test"],
    },
    positives: ["Uses a sticky marker for idempotent comments."],
    reviewCompleteness: {
      limitations: ["Automated review only."],
      requiresHumanReview: true,
    },
    ...overrides,
  } as ReviewAdvisorResult;
}
