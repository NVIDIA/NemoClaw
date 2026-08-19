// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const REVIEW_FINDING_SEVERITIES = ["blocker", "warning", "suggestion"] as const;
export const REVIEW_FINDING_CATEGORIES = [
  "security",
  "correctness",
  "tests",
  "architecture",
  "workflow",
  "docs",
  "scope",
  "acceptance",
] as const;
export const REVIEW_FINDING_SIMPLIFICATION_TAGS = [
  "delete",
  "stdlib",
  "native",
  "yagni",
  "shrink",
] as const;
export const REVIEW_FINDING_BASIS_KINDS = [
  "behavior_mismatch",
  "unmet_acceptance",
  "security_violation",
  "missing_regression",
  "unnecessary_complexity",
  "documentation_mismatch",
  "semantic_ambiguity",
] as const;

type Severity = (typeof REVIEW_FINDING_SEVERITIES)[number];
type Category = (typeof REVIEW_FINDING_CATEGORIES)[number];
type SimplificationTag = (typeof REVIEW_FINDING_SIMPLIFICATION_TAGS)[number];
type FindingBasisKind = (typeof REVIEW_FINDING_BASIS_KINDS)[number];

export type ReviewFinding = Readonly<{
  id: string;
  status: "open" | "resolved" | "superseded";
  supersededBy: string | null;
  severity: Severity;
  category: Category;
  file: string | null;
  line: number | null;
  title: string;
  description: string;
  impact: string;
  recommendation: string;
  verificationHint: string;
  missingRegressionTest: string;
  evidence: readonly string[];
  simplification?: Readonly<{
    tag: SimplificationTag;
    cut: string;
    replacement: string;
    estimatedNetLines: number | null;
    safetyBoundary: string;
  }>;
}>;

export type ReviewFindingInput = Omit<ReviewFinding, "id" | "status" | "supersededBy">;
export type CandidateFindingInput = ReviewFindingInput & {
  basis: {
    kind: FindingBasisKind;
    observed: string;
    expected: string;
  };
};

type LedgerHistory = Readonly<{
  revision: number;
  operation: "add";
  id: string;
  stage: "submit-review";
  reason: null;
  addedEvidence: readonly string[];
  change: ReviewFindingInput;
}>;

export type ReviewFindingLedgerSnapshot = Readonly<{
  version: 1;
  revision: number;
  findings: readonly ReviewFinding[];
  history: readonly LedgerHistory[];
}>;

const EMPTY_FINDINGS: readonly ReviewFinding[] = Object.freeze([]);
const EMPTY_HISTORY: readonly LedgerHistory[] = Object.freeze([]);

export const EMPTY_REVIEW_FINDING_LEDGER_SNAPSHOT: ReviewFindingLedgerSnapshot = Object.freeze({
  version: 1,
  revision: 0,
  findings: EMPTY_FINDINGS,
  history: EMPTY_HISTORY,
});

const ADMISSIBLE_CATEGORY_BASIS_PAIRS: ReadonlySet<string> = new Set([
  ...pairs(["scope", "architecture"], ["behavior_mismatch", "unnecessary_complexity"]),
  ...pairs(
    ["correctness", "acceptance", "docs", "architecture"],
    [
      "behavior_mismatch",
      "unmet_acceptance",
      "documentation_mismatch",
      "unnecessary_complexity",
      "semantic_ambiguity",
    ],
  ),
  ...pairs(["security"], ["security_violation", "semantic_ambiguity"]),
  ...pairs(["tests"], ["missing_regression"]),
  ...pairs(
    ["workflow", "docs", "architecture"],
    ["behavior_mismatch", "documentation_mismatch", "unnecessary_complexity"],
  ),
]);

export function validateReviewFindingSubmission(
  candidates: readonly CandidateFindingInput[],
): ReviewFindingLedgerSnapshot {
  if (candidates.length === 0) return EMPTY_REVIEW_FINDING_LEDGER_SNAPSHOT;

  const findings = candidates.map((candidate, index) => {
    validateCandidateFinding(candidate);
    const { basis: _basis, ...input } = candidate;
    const normalized = normalizeFinding(input);
    return freezeFinding({
      ...normalized,
      id: findingId(index),
      status: "open",
      supersededBy: null,
    });
  });
  const history = findings.map((finding, index) => {
    const { id, status: _status, supersededBy: _supersededBy, ...change } = finding;
    return Object.freeze({
      revision: index + 1,
      operation: "add" as const,
      id,
      stage: "submit-review" as const,
      reason: null,
      addedEvidence: Object.freeze([...finding.evidence]),
      change: structuredClone(change),
    });
  });

  return Object.freeze({
    version: 1,
    revision: findings.length,
    findings: Object.freeze(findings),
    history: Object.freeze(history),
  });
}

function pairs(categories: readonly Category[], basisKinds: readonly FindingBasisKind[]): string[] {
  return categories.flatMap((category) =>
    basisKinds.map((basisKind) => categoryBasisKey(category, basisKind)),
  );
}

function categoryBasisKey(category: Category, basisKind: FindingBasisKind): string {
  return `${category}:${basisKind}`;
}

function findingId(index: number): string {
  return `F-${String(index + 1).padStart(3, "0")}`;
}

function validateCandidateFinding(candidate: CandidateFindingInput): void {
  if (
    !ADMISSIBLE_CATEGORY_BASIS_PAIRS.has(categoryBasisKey(candidate.category, candidate.basis.kind))
  ) {
    throw new Error(
      `No addition policy admits category=${candidate.category} with basis.kind=${candidate.basis.kind}; admissible pairs: ${[...ADMISSIBLE_CATEGORY_BASIS_PAIRS].map((pair) => {
        const [category, basisKind] = pair.split(":");
        return `category=${category} with basis.kind=${basisKind}`;
      }).join("; ")}`,
    );
  }
  const observed = normalizedBasisState(candidate.basis.observed, "basis.observed");
  const expected = normalizedBasisState(candidate.basis.expected, "basis.expected");
  if (observed === expected) {
    throw new Error("basis.observed and basis.expected must describe different states");
  }
}

function normalizedBasisState(value: string, name: string): string {
  return nonempty(value, name).toLocaleLowerCase().replace(/\s+/gu, " ");
}

function normalizeFinding(finding: ReviewFindingInput): ReviewFindingInput {
  return {
    severity: finding.severity,
    category: finding.category,
    file: finding.file === null ? null : nonempty(finding.file, "file"),
    line: finding.line,
    title: nonempty(finding.title, "title"),
    description: nonempty(finding.description, "description"),
    impact: nonempty(finding.impact, "impact"),
    recommendation: nonempty(finding.recommendation, "recommendation"),
    verificationHint: nonempty(finding.verificationHint, "verificationHint"),
    missingRegressionTest: nonempty(finding.missingRegressionTest, "missingRegressionTest"),
    evidence: normalizeEvidence(finding.evidence),
    ...(finding.simplification === undefined
      ? {}
      : { simplification: normalizeSimplification(finding.simplification) }),
  };
}

function normalizeSimplification(
  value: NonNullable<ReviewFindingInput["simplification"]>,
): NonNullable<ReviewFindingInput["simplification"]> {
  return {
    tag: value.tag,
    cut: nonempty(value.cut, "simplification.cut"),
    replacement: nonempty(value.replacement, "simplification.replacement"),
    estimatedNetLines: value.estimatedNetLines,
    safetyBoundary: nonempty(value.safetyBoundary, "simplification.safetyBoundary"),
  };
}

function normalizeEvidence(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => nonempty(value, "evidence")))];
}

function freezeFinding(finding: ReviewFinding): ReviewFinding {
  return Object.freeze({ ...finding, evidence: Object.freeze([...finding.evidence]) });
}

function nonempty(value: string, name: string): string {
  if (!value?.trim()) throw new Error(`${name} must be nonempty`);
  return value.trim();
}
