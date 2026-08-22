// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import reviewSchema from "../../tools/pr-review-advisor/schema.json" with { type: "json" };
import { createReviewSubmissionController } from "../../tools/pr-review-advisor/review-submission.mts";
import type { TerminologyTrace } from "../../tools/pr-review-advisor/terminology.mts";
import { readParsedTrustedSecurityRubric } from "../../tools/pr-review-advisor/trusted-guidance.mts";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const HEAD = "a".repeat(40);
export const SECURITY_CATEGORY_NAMES = readParsedTrustedSecurityRubric().categories;

export function submissionController(
  traces = new Map<string, TerminologyTrace>(),
  normalizeE2e = (draft: Record<string, unknown>) => draft,
  securityCategoryNames: readonly string[] = SECURITY_CATEGORY_NAMES,
  hasOpenPrReplacement = false,
) {
  return createReviewSubmissionController({
    metadata: {
      baseRef: "origin/main",
      headRef: "HEAD",
      headSha: HEAD,
      changedFiles: ["tools/pr-review-advisor/review-submission.mts"],
      deterministic: {
        testDepth: {
          verdict: "runtime_validation_recommended",
          rationale: "A runtime boundary changed.",
          suggestedTests: ["deterministic runtime test"],
        },
        hasOpenPrReplacement,
      },
    },
    schema: reviewSchema,
    repositoryRoot: ROOT,
    securityCategoryNames,
    terminologyTraces: traces,
    normalizeE2e,
  });
}

export function executeSubmissionTool(
  value: ReturnType<typeof submissionController>,
  name: string,
  input: unknown,
) {
  const tool = value.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.execute(name, input, undefined, undefined, undefined as never);
}

export function reviewFinding(title = "The refusal is hidden") {
  return {
    severity: "warning",
    category: "correctness",
    file: "tools/pr-review-advisor/review-submission.mts",
    line: 7,
    title,
    description: "The changed return path reports success after a refusal.",
    impact: "Callers cannot distinguish refusal from success.",
    recommendation: "Return the refusal status.",
    verificationHint: "Assert the refusal result.",
    missingRegressionTest: "Add a refusal-path test.",
    evidence: ["tools/pr-review-advisor/review-submission.mts:7 returns success"],
    receiptConcerns: [
      "acceptance:Propagate refusal",
      "acceptance:Cover refusal regression",
      "acceptance:Clause",
      `security:${SECURITY_CATEGORY_NAMES[0]}`,
      "source-of-truth:config",
    ],
    basis: {
      kind: "behavior_mismatch",
      observed: "The refusal path returns success.",
      expected: "The refusal path returns refusal.",
    },
  };
}

export function reviewReceipt(
  terminologyReview: unknown = {
    decisions: [],
    noChangesReason: "No changed term adds a new meaning.",
  },
) {
  return {
    summary: {
      recommendation: "merge_as_is",
      confidence: "high",
      oneLine: "One finding remains.",
    },
    terminologyReview,
    acceptanceCoverage: [
      {
        clause: "Propagate refusal",
        status: "met",
        evidence: "tools/pr-review-advisor/review-submission.mts:7",
        findingId: null,
      },
    ] as Array<{
      clause: string;
      status: string;
      evidence: string;
      findingId: string | null;
    }>,
    securityCategories: SECURITY_CATEGORY_NAMES.map((category) => ({
      category,
      verdict: "pass",
      justification: `${category} passed.`,
      findingId: null as string | null,
    })),
    sourceOfTruthReview: [] as Array<{
      surface: string;
      status: string;
      findingId: string | null;
      invalidState: string;
      sourceBoundary: string;
      whyNotSourceFix: string;
      regressionTest: string;
      removalCondition: string;
      evidence: string;
    }>,
    testDepth: {
      verdict: "unit_sufficient",
      rationale: "The behavior is deterministic.",
      suggestedTests: ["focused unit test"],
    },
    positives: ["The change keeps the interface small."],
    reviewCompleteness: { limitations: [], requiresHumanReview: true },
  };
}

export function terminologyDecision(traceId: string) {
  return {
    term: "review receipt",
    change: "introduced",
    disposition: "justified",
    meaning: "The complete structured review sections.",
    contrast: "Unlike drafts, this is complete.",
    existingTerm: null,
    semanticImpact: "evidence",
    recommendation: "Keep the contrast explicit.",
    traceId,
    source: { file: "tools/pr-review-advisor/review-submission.mts", line: 9 },
  };
}

export function reviewE2e() {
  return {
    coverage: {
      classifiedDomains: [],
      requiredTests: [],
      optionalTests: [],
      newE2eRecommendations: [],
      noE2eReason: "No runtime boundary changed.",
      confidence: "high",
    },
    targets: {
      relevantChangedFiles: [],
      changedCredentialFreeTests: [],
      required: [],
      optional: [],
      noTargetE2eReason: "No E2E target is needed.",
      confidence: "high",
    },
  };
}
