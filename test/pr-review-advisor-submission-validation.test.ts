// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import reviewSchema from "../tools/pr-review-advisor/schema.json" with { type: "json" };
import { persistSuccessfulReview } from "../tools/pr-review-advisor/analyze.mts";
import type { ArtifactPaths } from "../tools/pr-review-advisor/artifacts.mts";
import {
  createReviewSubmissionController,
  RECORD_FINDINGS_TOOL,
  RECORD_REVIEW_RECEIPT_TOOL,
  RECOMMEND_E2E_TOOL,
  SUBMIT_REVIEW_TOOL,
  type ReviewSubmissionController,
} from "../tools/pr-review-advisor/review-submission.mts";
import type { TerminologyTrace } from "../tools/pr-review-advisor/terminology.mts";
import {
  HEAD,
  ROOT,
  SECURITY_CATEGORY_NAMES,
  executeSubmissionTool as execute,
  reviewE2e as e2e,
  reviewFinding as finding,
  reviewReceipt as receipt,
  submissionController as controller,
  terminologyDecision,
} from "./helpers/pr-review-advisor-submission-fixtures";

const ARTIFACTS: ArtifactPaths = {
  result: "result.json",
  finalResult: "final-result.json",
  summary: "summary.md",
  sessionHtml: "session.html",
};

function completedSubmission(result: unknown): ReviewSubmissionController {
  return {
    tools: [],
    result: () => result,
    findingSnapshot: () => ({ version: 1, findings: [] }),
    terminologySnapshot: () => ({
      version: 1,
      revision: 1,
      headSha: HEAD,
      review: {
        status: "clear",
        decisions: [],
        noChangesReason: "No terminology changes.",
      },
    }),
    finalize: vi.fn(),
    discard: vi.fn(),
  };
}

describe("PR review advisor submission validation", () => {
  it("uses the injected security inventory for receipt schema and validation", async () => {
    const injected = ["Injected Security Category"];
    const submission = controller(new Map(), (draft) => draft, injected);
    const draft = receipt();
    draft.securityCategories = [
      {
        category: injected[0]!,
        verdict: "pass",
        justification: "The injected category passed.",
        findingId: null,
      },
    ];
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await expect(execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft)).resolves.toBeDefined();
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toBeDefined();

    const rejected = controller(new Map(), (value) => value, injected);
    await execute(rejected, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await expect(execute(rejected, RECORD_REVIEW_RECEIPT_TOOL, receipt())).rejects.toThrow(
      "record_review_receipt failed schema validation",
    );
    expect(rejected.findingSnapshot()).toEqual({ version: 1, findings: [] });
  });

  const acceptanceMissing = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [
      {
        clause: "Clause",
        status: "missing",
        evidence: "evidence",
        findingId: "F-001",
      },
    ];
  };
  const acceptancePartial = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [
      {
        clause: "Clause",
        status: "partial",
        evidence: "evidence",
        findingId: "F-001",
      },
    ];
  };
  const securityFail = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [];
    draft.securityCategories[0] = {
      ...draft.securityCategories[0],
      verdict: "fail",
      findingId: "F-001",
    };
  };
  const securityWarning = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [];
    draft.securityCategories[0] = {
      ...draft.securityCategories[0],
      verdict: "warning",
      findingId: "F-001",
    };
  };
  const sourceMissing = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [];
    draft.sourceOfTruthReview = [
      {
        surface: "config",
        status: "missing",
        findingId: "F-001",
        invalidState: "stale",
        sourceBoundary: "source",
        whyNotSourceFix: "none",
        regressionTest: "test",
        removalCondition: "fixed",
        evidence: "evidence",
      },
    ];
  };
  const sourceFollowup = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [];
    draft.sourceOfTruthReview = [
      {
        surface: "config",
        status: "needs_followup",
        findingId: "F-001",
        invalidState: "stale",
        sourceBoundary: "source",
        whyNotSourceFix: "none",
        regressionTest: "test",
        removalCondition: "fixed",
        evidence: "evidence",
      },
    ];
  };

  it.each([
    ["acceptance missing", "acceptance", "unmet_acceptance", "blocker", acceptanceMissing],
    ["acceptance partial minimum", "acceptance", "unmet_acceptance", "warning", acceptancePartial],
    ["acceptance partial blocker", "acceptance", "unmet_acceptance", "blocker", acceptancePartial],
    ["security fail", "security", "security_violation", "blocker", securityFail],
    ["security warning minimum", "security", "security_violation", "warning", securityWarning],
    ["security warning blocker", "security", "security_violation", "blocker", securityWarning],
    ["source missing suggestion", "architecture", "behavior_mismatch", "suggestion", sourceMissing],
    [
      "source follow-up suggestion",
      "architecture",
      "behavior_mismatch",
      "suggestion",
      sourceFollowup,
    ],
  ] as const)(
    "accepts %s linked finding severity",
    async (_name, category, basisKind, severity, mutateReceipt) => {
      const accepted = controller();
      const draft = receipt();
      mutateReceipt(draft);
      await execute(accepted, RECORD_FINDINGS_TOOL, {
        findings: [
          {
            ...finding(),
            severity,
            category,
            basis: { ...finding().basis, kind: basisKind },
          },
        ],
      });
      await execute(accepted, RECORD_REVIEW_RECEIPT_TOOL, draft);
      await execute(accepted, RECOMMEND_E2E_TOOL, e2e());
      await expect(execute(accepted, SUBMIT_REVIEW_TOOL, {})).resolves.toBeDefined();
    },
  );

  it.each([
    ["acceptance missing", "acceptance", "unmet_acceptance", "warning", acceptanceMissing],
    ["acceptance partial", "acceptance", "unmet_acceptance", "suggestion", acceptancePartial],
    ["security fail", "security", "security_violation", "warning", securityFail],
    ["security warning", "security", "security_violation", "suggestion", securityWarning],
  ] as const)(
    "rejects weaker %s linked finding severity atomically",
    async (_name, category, basisKind, severity, mutateReceipt) => {
      const rejected = controller();
      const draft = receipt();
      mutateReceipt(draft);
      await execute(rejected, RECORD_FINDINGS_TOOL, {
        findings: [
          {
            ...finding(),
            severity,
            category,
            basis: { ...finding().basis, kind: basisKind },
          },
        ],
      });
      await execute(rejected, RECORD_REVIEW_RECEIPT_TOOL, draft);
      await execute(rejected, RECOMMEND_E2E_TOOL, e2e());
      await expect(execute(rejected, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow("requires");
      expect(rejected.findingSnapshot()).toEqual({ version: 1, findings: [] });
      expect(rejected.result()).toBeNull();
    },
  );

  it("resolves terminology traces lazily at submission time", async () => {
    let traces = new Map<string, TerminologyTrace>();
    const submission = createReviewSubmissionController({
      metadata: {
        baseRef: "origin/main",
        headRef: "HEAD",
        headSha: HEAD,
        changedFiles: ["tools/pr-review-advisor/review-submission.mts"],
        deterministic: {
          testDepth: {
            verdict: "unit_sufficient",
            rationale: "Unit coverage is sufficient.",
            suggestedTests: ["focused unit test"],
          },
          hasOpenPrReplacement: false,
        },
      },
      schema: reviewSchema,
      repositoryRoot: ROOT,
      securityCategoryNames: SECURITY_CATEGORY_NAMES,
      terminologyTraces: () => traces,
      normalizeE2e: (draft) => draft,
    });
    const trace: TerminologyTrace = {
      id: "lazy-trace",
      term: "review receipt",
      variants: ["review receipt"],
      baseSha: "b".repeat(40),
      headSha: HEAD,
      baseOccurrences: 0,
      headOccurrences: 1,
      baseEvidenceTruncated: false,
      headEvidenceTruncated: false,
      changedLocations: [
        {
          file: "tools/pr-review-advisor/review-submission.mts",
          line: 9,
          text: "review receipt",
        },
      ],
      baseSamples: [],
      headSamples: [],
      firstCommitSha: HEAD,
    };
    traces = new Map([[trace.id, trace]]);
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(
      submission,
      RECORD_REVIEW_RECEIPT_TOOL,
      receipt({
        decisions: [terminologyDecision(trace.id)],
        noChangesReason: null,
      }),
    );
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.not.toHaveProperty(
      "terminate",
    );
  });

  it("preserves traced terminology provenance in the canonical result", async () => {
    const trace: TerminologyTrace = {
      id: "term-trace",
      term: "review receipt",
      variants: ["review receipt"],
      baseSha: "b".repeat(40),
      headSha: HEAD,
      baseOccurrences: 0,
      headOccurrences: 1,
      baseEvidenceTruncated: false,
      headEvidenceTruncated: false,
      changedLocations: [
        {
          file: "tools/pr-review-advisor/review-submission.mts",
          line: 9,
          text: "review receipt",
        },
      ],
      baseSamples: [],
      headSamples: [],
      firstCommitSha: HEAD,
    };
    const submission = controller(new Map([[trace.id, trace]]));
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(
      submission,
      RECORD_REVIEW_RECEIPT_TOOL,
      receipt({
        decisions: [terminologyDecision(trace.id)],
        noChangesReason: null,
      }),
    );
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, SUBMIT_REVIEW_TOOL, {});
    submission.finalize();
    const result = submission.result() as Record<string, any>;
    expect(result.terminologyReview.decisions[0]).toMatchObject({
      id: "T-001",
      traceId: trace.id,
      source: {
        file: "tools/pr-review-advisor/review-submission.mts",
        line: 9,
        headSha: HEAD,
      },
    });
  });

  it.each([
    [
      "SDK execution errors",
      ["provider failed"],
      completedSubmission({ submitted: true }),
      "PR review advisor SDK execution failed: provider failed",
    ],
    [
      "missing atomic submission",
      [],
      completedSubmission(null),
      "PR review advisor did not atomically submit a review result",
    ],
  ] as const)("writes no canonical artifacts for %s", (_name, errors, submission, reason) => {
    const write = vi.fn();
    expect(() => persistSuccessfulReview(errors, submission, ARTIFACTS, write)).toThrow(reason);
    expect(write).not.toHaveBeenCalled();
  });

  it("writes each canonical artifact exactly once after finalized success", () => {
    const result = { submitted: true };
    const submission = completedSubmission(result);
    const write = vi.fn();

    expect(persistSuccessfulReview([], submission, ARTIFACTS, write)).toBe(result);
    expect(write.mock.calls).toEqual([
      [ARTIFACTS.result, result],
      [ARTIFACTS.finalResult, result],
    ]);
  });
});
