// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildRiskPlan } from "../tools/advisors/risk-plan.mts";
import { normalizeReviewResult } from "../tools/pr-review-advisor/analyze.mts";
import {
  EMPTY_REVIEW_FINDING_LEDGER_SNAPSHOT,
  type CandidateFindingInput,
  validateReviewFindingSubmission,
} from "../tools/pr-review-advisor/review-ledger.mts";

function finding() {
  return {
    severity: "warning" as const,
    category: "correctness" as const,
    file: "src/lib/runner.ts",
    line: 42,
    title: "Refusal status is masked",
    description: "The refusal path returns success.",
    impact: "Automation can treat a rejected action as successful.",
    recommendation: "Propagate the refusal status.",
    verificationHint: "Read the refusal return at src/lib/runner.ts:42.",
    missingRegressionTest: "Assert that refusal returns a nonzero status.",
    evidence: ["src/lib/runner.ts:42 returns zero on refusal"],
  };
}

function candidate(overrides: Partial<CandidateFindingInput> = {}): CandidateFindingInput {
  return {
    ...finding(),
    basis: {
      kind: "behavior_mismatch",
      observed: "The refusal path returns success.",
      expected: "The refusal path returns a nonzero status.",
    },
    ...overrides,
  };
}

function reviewMetadata(): Parameters<typeof normalizeReviewResult>[1] {
  return {
    baseRef: "origin/main",
    headRef: "HEAD",
    headSha: "abc123def456",
    changedFiles: ["src/lib/runner.ts"],
    deterministic: {
      diffStat: "1 file changed",
      commits: [],
      riskyAreas: [],
      riskPlan: buildRiskPlan({ headSha: "abc123def456", changedFiles: [] }),
      testDepth: {
        verdict: "unit_sufficient",
        rationale: "deterministic fallback",
        suggestedTests: [],
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
      previousAdvisorReview: null,
      github: null,
    },
  };
}

describe("PR review finding submission", () => {
  it("requires every source-of-truth review item to declare findingId", () => {
    expect(() =>
      normalizeReviewResult(
        {
          sourceOfTruthReview: [{ surface: "resolved cleanup", status: "satisfied" }],
        },
        reviewMetadata(),
      ),
    ).toThrow("sourceOfTruthReview[1] must include findingId");
  });

  it("keeps source-of-truth prose from creating findings", () => {
    const result = normalizeReviewResult(
      {
        findings: [{ ...finding(), evidence: finding().evidence.join("\n") }],
        sourceOfTruthReview: [
          {
            surface: "best-effort refusal cleanup",
            status: "needs_followup",
            findingId: "F-001",
            invalidState: "A refusal can be reported as success.",
            sourceBoundary: "Runner refusal handling.",
            whyNotSourceFix: "Not established.",
            regressionTest: finding().missingRegressionTest,
            removalCondition: "Remove the cleanup when refusal state is impossible.",
            evidence: finding().evidence[0],
          },
        ],
      },
      reviewMetadata(),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.sourceOfTruthReview).toMatchObject([
      { surface: "best-effort refusal cleanup", findingId: "F-001" },
    ]);
  });

  it("returns the explicit immutable empty canonical snapshot", () => {
    const snapshot = validateReviewFindingSubmission([]);

    expect(snapshot).toBe(EMPTY_REVIEW_FINDING_LEDGER_SNAPSHOT);
    expect(snapshot).toEqual({ version: 1, revision: 0, findings: [], history: [] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.findings)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
  });

  it("assigns canonical IDs and creates the immutable submission snapshot", () => {
    const snapshot = validateReviewFindingSubmission([
      candidate(),
      candidate({
        file: "src/lib/timeout.ts",
        line: 9,
        title: "Timeout status is masked",
        evidence: ["src/lib/timeout.ts:9 returns zero on timeout"],
      }),
    ]);

    expect(snapshot).toMatchObject({
      version: 1,
      revision: 2,
      findings: [
        { id: "F-001", status: "open", supersededBy: null },
        { id: "F-002", status: "open", supersededBy: null },
      ],
      history: [
        { revision: 1, operation: "add", id: "F-001", stage: "submit-review", reason: null },
        { revision: 2, operation: "add", id: "F-002", stage: "submit-review", reason: null },
      ],
    });
    expect(snapshot.findings[0]).not.toHaveProperty("basis");
    expect(snapshot.history[0]?.change).not.toHaveProperty("basis");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.findings)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.findings[0])).toBe(true);
    expect(Object.isFrozen(snapshot.findings[0]?.evidence)).toBe(true);
  });

  it("normalizes submitted finding text, evidence, and simplification", () => {
    const snapshot = validateReviewFindingSubmission([
      candidate({
        file: "  src/lib/runner.ts  ",
        title: "  Refusal status is masked  ",
        description: "  The refusal path returns success.  ",
        impact: "  Automation sees success.  ",
        recommendation: "  Propagate refusal.  ",
        verificationHint: "  Read line 42.  ",
        missingRegressionTest: "  Assert refusal status.  ",
        evidence: ["  src/lib/runner.ts:42 returns zero  ", "src/lib/runner.ts:42 returns zero"],
        simplification: {
          tag: "delete",
          cut: "  duplicate fallback  ",
          replacement: "  direct return  ",
          estimatedNetLines: -8,
          safetyBoundary: "  preserve refusal status  ",
        },
      }),
    ]);

    expect(snapshot.findings[0]).toMatchObject({
      file: "src/lib/runner.ts",
      title: "Refusal status is masked",
      description: "The refusal path returns success.",
      impact: "Automation sees success.",
      recommendation: "Propagate refusal.",
      verificationHint: "Read line 42.",
      missingRegressionTest: "Assert refusal status.",
      evidence: ["src/lib/runner.ts:42 returns zero"],
      simplification: {
        cut: "duplicate fallback",
        replacement: "direct return",
        safetyBoundary: "preserve refusal status",
      },
    });
  });

  it.each([
    ["correctness behavior", candidate()],
    [
      "security violation",
      candidate({
        category: "security",
        basis: {
          kind: "security_violation",
          observed: "The caller controls the requested identity.",
          expected: "The runtime authenticates the requested identity.",
        },
      }),
    ],
    [
      "missing regression",
      candidate({
        category: "tests",
        basis: {
          kind: "missing_regression",
          observed: "Only the successful exit path is asserted.",
          expected: "Both successful and failing exit paths are asserted.",
        },
      }),
    ],
    [
      "workflow documentation mismatch",
      candidate({
        category: "workflow",
        basis: {
          kind: "documentation_mismatch",
          observed: "The workflow accepts an undocumented input.",
          expected: "The documented and accepted inputs match.",
        },
      }),
    ],
  ] as const)("keeps an admissible %s eligible", (_label, eligible) => {
    expect(validateReviewFindingSubmission([eligible]).findings).toMatchObject([
      { id: "F-001", status: "open", title: eligible.title },
    ]);
  });

  it("rejects an inadmissible category and basis combination", () => {
    expect(() =>
      validateReviewFindingSubmission([
        candidate({
          category: "security",
          basis: {
            kind: "behavior_mismatch",
            observed: "The caller controls the requested identity.",
            expected: "The runtime authenticates the requested identity.",
          },
        }),
      ]),
    ).toThrow("No addition policy admits category=security with basis.kind=behavior_mismatch");
  });

  it("rejects a candidate whose observed and expected states normalize equally", () => {
    expect(() =>
      validateReviewFindingSubmission([
        candidate({
          basis: {
            kind: "behavior_mismatch",
            observed: "The implementation validates the requested identity.",
            expected: "  the implementation VALIDATES the requested identity.  ",
          },
        }),
      ]),
    ).toThrow("basis.observed and basis.expected must describe different states");
  });

  it("rejects empty required text during final validation", () => {
    expect(() => validateReviewFindingSubmission([candidate({ title: "   " })])).toThrow(
      "title must be nonempty",
    );
    expect(() => validateReviewFindingSubmission([candidate({ evidence: ["   "] })])).toThrow(
      "evidence must be nonempty",
    );
  });
});
