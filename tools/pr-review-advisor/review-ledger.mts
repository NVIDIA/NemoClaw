// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export const REVIEW_FINDING_LIMIT = 20;
export const REVIEW_FINDING_SOURCE_MAX_BYTES = 1024 * 1024;

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

export type ReviewFindingInput = Omit<ReviewFinding, "id">;
export type CandidateFindingInput = ReviewFindingInput & {
  receiptConcerns?: readonly string[];
  basis: {
    kind: FindingBasisKind;
    observed: string;
    expected: string;
  };
};

export type ReviewFindingSnapshot = Readonly<{
  version: 1;
  findings: readonly ReviewFinding[];
}>;

export const EMPTY_REVIEW_FINDING_SNAPSHOT: ReviewFindingSnapshot = Object.freeze({
  version: 1,
  findings: Object.freeze([]),
});

const ADMISSIBLE_CATEGORY_BASIS_PAIRS: ReadonlySet<string> = new Set([
  ...pairs(["scope"], ["behavior_mismatch", "unmet_acceptance", "unnecessary_complexity"]),
  ...pairs(["architecture"], ["behavior_mismatch", "unnecessary_complexity"]),
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
  repositoryRoot: string,
): ReviewFindingSnapshot {
  if (candidates.length > REVIEW_FINDING_LIMIT) {
    throw new Error(`findings must contain at most ${REVIEW_FINDING_LIMIT} items`);
  }
  const realRepositoryRoot = fs.realpathSync(repositoryRoot);
  if (candidates.length === 0) return EMPTY_REVIEW_FINDING_SNAPSHOT;
  const lineCounts = new Map<string, number>();

  const findings = candidates.map((candidate, index) => {
    validateCandidateFinding(candidate, realRepositoryRoot, lineCounts);
    const { basis: _basis, receiptConcerns: _receiptConcerns, ...input } = candidate;
    const normalized = normalizeFinding(input);
    return freezeFinding({ ...normalized, id: findingId(index) });
  });

  return Object.freeze({ version: 1, findings: Object.freeze(findings) });
}

function pairs(categories: readonly Category[], basisKinds: readonly FindingBasisKind[]): string[] {
  return categories.flatMap((category) =>
    basisKinds.map((basisKind) => categoryBasisKey(category, basisKind)),
  );
}

function categoryBasisKey(category: Category, basisKind: FindingBasisKind): string {
  return `${category}:${basisKind}`;
}

export function findingId(index: number): string {
  return `F-${String(index + 1).padStart(3, "0")}`;
}

function validateCandidateFinding(
  candidate: CandidateFindingInput,
  realRepositoryRoot: string,
  lineCounts: Map<string, number>,
): void {
  if (
    !ADMISSIBLE_CATEGORY_BASIS_PAIRS.has(categoryBasisKey(candidate.category, candidate.basis.kind))
  ) {
    throw new Error(
      `No addition policy admits category=${candidate.category} with basis.kind=${candidate.basis.kind}; admissible pairs: ${[
        ...ADMISSIBLE_CATEGORY_BASIS_PAIRS,
      ]
        .map((pair) => {
          const [category, basisKind] = pair.split(":");
          return `category=${category} with basis.kind=${basisKind}`;
        })
        .join("; ")}`,
    );
  }
  validateFindingLocation(candidate.file, candidate.line, realRepositoryRoot, lineCounts);
  const observed = normalizedBasisState(candidate.basis.observed, "basis.observed");
  const expected = normalizedBasisState(candidate.basis.expected, "basis.expected");
  if (observed === expected) {
    throw new Error("basis.observed and basis.expected must describe different states");
  }
}

function validateFindingLocation(
  file: string | null,
  line: number | null,
  realRepositoryRoot: string,
  lineCounts: Map<string, number>,
): void {
  if (file === null || file.trim() === "") {
    throw new Error("finding file must be a nonempty repository-relative path");
  }
  const normalized = file.trim().replace(/\\/gu, "/");
  const components = normalized.split("/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//u.test(normalized) || components.includes("..")) {
    throw new Error(`finding file must be repository-relative without traversal: ${file}`);
  }
  if (components.includes(".git")) {
    throw new Error(`finding file must not identify repository-control metadata: ${file}`);
  }
  const candidatePath = path.resolve(realRepositoryRoot, normalized);
  let realCandidatePath: string;
  let stat: fs.Stats;
  try {
    realCandidatePath = fs.realpathSync(candidatePath);
    stat = fs.statSync(realCandidatePath);
  } catch {
    throw new Error(`finding file must identify a current repository regular file: ${file}`);
  }
  const relative = path.relative(realRepositoryRoot, realCandidatePath);
  const realComponents = relative.split(path.sep);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !stat.isFile()) {
    throw new Error(`finding file must identify a current repository regular file: ${file}`);
  }
  if (realComponents.includes(".git")) {
    throw new Error(`finding file must not identify repository-control metadata: ${file}`);
  }
  if (stat.size > REVIEW_FINDING_SOURCE_MAX_BYTES) {
    throw new Error(
      `finding file exceeds the ${REVIEW_FINDING_SOURCE_MAX_BYTES}-byte source evidence limit: ${file}`,
    );
  }
  if (line === null || !Number.isInteger(line) || line < 1) {
    throw new Error("finding line must be a positive integer");
  }
  let lineCount = lineCounts.get(realCandidatePath);
  if (lineCount === undefined) {
    lineCount = countFileLines(realCandidatePath);
    lineCounts.set(realCandidatePath, lineCount);
  }
  if (line > lineCount) {
    throw new Error(`finding line ${line} exceeds current file line count ${lineCount}: ${file}`);
  }
}

function countFileLines(file: string): number {
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let lines = 0;
  let bytesRead = 0;
  let lastByte = -1;
  try {
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      for (let index = 0; index < bytesRead; index += 1) {
        lastByte = buffer[index] ?? -1;
        if (lastByte === 0) {
          throw new Error(`finding file must be text source without NUL bytes: ${file}`);
        }
        if (lastByte === 10) lines += 1;
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return lastByte === -1 || lastByte === 10 ? lines : lines + 1;
}

function normalizedBasisState(value: string, name: string): string {
  return nonempty(value, name).toLocaleLowerCase().replace(/\s+/gu, " ");
}

function normalizeFinding(finding: ReviewFindingInput): ReviewFindingInput {
  return {
    severity: finding.severity,
    category: finding.category,
    file: nonempty(finding.file!, "file"),
    line: finding.line!,
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
  return deepFreeze({ ...finding, evidence: [...finding.evidence] });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function nonempty(value: string, name: string): string {
  if (!value?.trim()) throw new Error(`${name} must be nonempty`);
  return value.trim();
}
