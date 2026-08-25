// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
const ROOT = path.resolve(import.meta.dirname, "../../..");

import {
  EMPTY_REVIEW_FINDING_SNAPSHOT,
  REVIEW_FINDING_LIMIT,
  REVIEW_FINDING_SOURCE_MAX_BYTES,
  type CandidateFindingInput,
  validateReviewFindingSubmission,
} from "../../../tools/pr-review-advisor/review-ledger.mts";

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

describe("PR review finding submission", () => {
  it("returns the explicit immutable empty canonical snapshot", () => {
    const snapshot = validateReviewFindingSubmission([], ROOT);

    expect(snapshot).toBe(EMPTY_REVIEW_FINDING_SNAPSHOT);
    expect(snapshot).toEqual({ version: 1, findings: [] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.findings)).toBe(true);
  });

  it("assigns canonical IDs and creates the immutable submission snapshot", () => {
    const snapshot = validateReviewFindingSubmission(
      [
        candidate(),
        candidate({
          file: "tools/pr-review-advisor/review-ledger.mts",
          line: 9,
          title: "Timeout status is masked",
          evidence: ["tools/pr-review-advisor/review-ledger.mts:9 returns zero on timeout"],
        }),
      ],
      ROOT,
    );

    expect(snapshot).toMatchObject({
      version: 1,
      findings: [{ id: "F-001" }, { id: "F-002" }],
    });
    expect(snapshot).not.toHaveProperty("revision");
    expect(snapshot).not.toHaveProperty("history");
    expect(snapshot.findings[0]).not.toHaveProperty("status");
    expect(snapshot.findings[0]).not.toHaveProperty("supersededBy");
    expect(snapshot.findings[0]).not.toHaveProperty("basis");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.findings)).toBe(true);
    expect(Object.isFrozen(snapshot.findings[0])).toBe(true);
    expect(Object.isFrozen(snapshot.findings[0]?.evidence)).toBe(true);
  });

  it("deeply freezes canonical finding values", () => {
    const snapshot = validateReviewFindingSubmission(
      [
        candidate({
          simplification: {
            tag: "delete",
            cut: "duplicate fallback",
            replacement: "direct return",
            estimatedNetLines: -8,
            safetyBoundary: "preserve refusal status",
          },
        }),
      ],
      ROOT,
    );
    const findingValue = snapshot.findings[0]!;

    expect(Object.isFrozen(findingValue.simplification)).toBe(true);
    expect(() => {
      (findingValue.simplification as { cut: string }).cut = "mutated";
    }).toThrow(TypeError);
    expect(() => {
      (findingValue.evidence as string[]).push("mutated");
    }).toThrow(TypeError);
    expect(snapshot.findings[0]!.simplification?.cut).toBe("duplicate fallback");
    expect(snapshot.findings[0]!.evidence).toEqual([
      "src/lib/runner.ts:42 returns zero on refusal",
    ]);
  });

  it("normalizes submitted finding text, evidence, and simplification", () => {
    const snapshot = validateReviewFindingSubmission(
      [
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
      ],
      ROOT,
    );

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
    expect(validateReviewFindingSubmission([eligible], ROOT).findings).toMatchObject([
      { id: "F-001", title: eligible.title },
    ]);
  });

  it("rejects oversized submissions before filesystem reads", () => {
    const realpath = vi.spyOn(fs, "realpathSync");
    expect(() =>
      validateReviewFindingSubmission(
        Array.from({ length: REVIEW_FINDING_LIMIT + 1 }, () => candidate()),
        ROOT,
      ),
    ).toThrow(`findings must contain at most ${REVIEW_FINDING_LIMIT} items`);
    expect(realpath).not.toHaveBeenCalled();
  });

  it("scans each repeated real file once per validation", () => {
    const open = vi.spyOn(fs, "openSync");
    validateReviewFindingSubmission(
      [candidate({ line: 1 }), candidate({ line: 2, title: "Second finding" })],
      ROOT,
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("counts a practical large file incrementally", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-large-file-"));
    const relative = path.relative(ROOT, path.join(tmp, "large.ts"));
    try {
      fs.writeFileSync(path.join(tmp, "large.ts"), "x\n".repeat(100_000));
      expect(
        validateReviewFindingSubmission([candidate({ file: relative, line: 100_000 })], ROOT)
          .findings,
      ).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an inadmissible category and basis combination", () => {
    expect(() =>
      validateReviewFindingSubmission(
        [
          candidate({
            category: "security",
            basis: {
              kind: "behavior_mismatch",
              observed: "The caller controls the requested identity.",
              expected: "The runtime authenticates the requested identity.",
            },
          }),
        ],
        ROOT,
      ),
    ).toThrow("No addition policy admits category=security with basis.kind=behavior_mismatch");
  });

  it("rejects a candidate whose observed and expected states normalize equally", () => {
    expect(() =>
      validateReviewFindingSubmission(
        [
          candidate({
            basis: {
              kind: "behavior_mismatch",
              observed: "The implementation validates the requested identity.",
              expected: "  the implementation VALIDATES the requested identity.  ",
            },
          }),
        ],
        ROOT,
      ),
    ).toThrow("basis.observed and basis.expected must describe different states");
  });

  it("accepts the valid final text line and rejects invalid repository locations", () => {
    expect(
      validateReviewFindingSubmission(
        [candidate({ file: "tools/pr-review-advisor/review-ledger.mts", line: 1 })],
        ROOT,
      ).findings,
    ).toHaveLength(1);
    expect(() =>
      validateReviewFindingSubmission(
        [candidate({ file: "tools/pr-review-advisor/review-ledger.mts", line: 1_000_000 })],
        ROOT,
      ),
    ).toThrow("exceeds current file line count");
    expect(() =>
      validateReviewFindingSubmission([candidate({ file: "tools/pr-review-advisor" })], ROOT),
    ).toThrow("regular file");
  });

  it("rejects repository-control metadata without rejecting .github", () => {
    expect(() =>
      validateReviewFindingSubmission([candidate({ file: ".git/config", line: 1 })], ROOT),
    ).toThrow("repository-control metadata");
    expect(
      validateReviewFindingSubmission(
        [candidate({ file: ".github/PULL_REQUEST_TEMPLATE.md", line: 1 })],
        ROOT,
      ).findings,
    ).toHaveLength(1);
  });

  it("rejects oversized source evidence before opening it", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-ledger-size-"));
    const oversized = path.join(repositoryRoot, "oversized.ts");
    try {
      const descriptor = fs.openSync(oversized, "w");
      fs.ftruncateSync(descriptor, REVIEW_FINDING_SOURCE_MAX_BYTES + 1);
      fs.closeSync(descriptor);
      const open = vi.spyOn(fs, "openSync");
      expect(() =>
        validateReviewFindingSubmission(
          [candidate({ file: "oversized.ts", line: 1 })],
          repositoryRoot,
        ),
      ).toThrow(`${REVIEW_FINDING_SOURCE_MAX_BYTES}-byte source evidence limit`);
      expect(open).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("rejects NUL-containing source evidence", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-ledger-binary-"));
    try {
      fs.writeFileSync(path.join(repositoryRoot, "binary.ts"), Buffer.from("first\n\0second\n"));
      expect(() =>
        validateReviewFindingSubmission(
          [candidate({ file: "binary.ts", line: 1 })],
          repositoryRoot,
        ),
      ).toThrow("text source without NUL bytes");
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("counts a final unterminated line and rejects a symlink escape", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-ledger-root-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-ledger-outside-"));
    try {
      fs.writeFileSync(path.join(repositoryRoot, "two-lines.ts"), "first\nsecond");
      fs.writeFileSync(path.join(outsideRoot, "outside.ts"), "outside\n");
      fs.symlinkSync(path.join(outsideRoot, "outside.ts"), path.join(repositoryRoot, "escaped.ts"));

      expect(
        validateReviewFindingSubmission(
          [candidate({ file: "two-lines.ts", line: 2 })],
          repositoryRoot,
        ).findings,
      ).toHaveLength(1);
      expect(() =>
        validateReviewFindingSubmission(
          [candidate({ file: "two-lines.ts", line: 3 })],
          repositoryRoot,
        ),
      ).toThrow("exceeds current file line count 2");
      expect(() =>
        validateReviewFindingSubmission(
          [candidate({ file: "escaped.ts", line: 1 })],
          repositoryRoot,
        ),
      ).toThrow("regular file");
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects empty required text during final validation", () => {
    expect(() => validateReviewFindingSubmission([candidate({ title: "   " })], ROOT)).toThrow(
      "title must be nonempty",
    );
    expect(() => validateReviewFindingSubmission([candidate({ evidence: ["   "] })], ROOT)).toThrow(
      "evidence must be nonempty",
    );
  });
});
