// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSummary } from "../../../tools/pr-review-advisor/render-result.mts";
import { buildComment } from "../../../tools/pr-review-advisor/comment.mts";
import {
  loadAdvisorSchema,
  metadata,
  validResult,
} from "../../helpers/pr-review-advisor-test-fixtures.ts";

describe("PR review advisor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders simplification opportunities without weakening safety boundaries", () => {
    const result = validResult({
        findings: [
          {
            severity: "suggestion",
            category: "architecture",
            file: "src/lib/example.ts",
            line: 12,
            title: "Replace custom date formatter",
            description: "The new formatter duplicates platform behavior.",
            impact: "Less custom date code reduces maintenance.",
            recommendation: "Use Intl.DateTimeFormat and keep validation unchanged.",
            verificationHint: "Compare output with existing date-format test cases.",
            missingRegressionTest: "Existing date-format test cases should still pass.",
            evidence: "Diff adds a formatter branch for locale output.",
            simplification: {
              tag: "native",
              cut: "custom date formatter helper",
              replacement: "Intl.DateTimeFormat",
              estimatedNetLines: -18,
              safetyBoundary: "Keep input validation and timezone test coverage.",
            },
          },
        ],
      });

    const comment = buildComment({ summary: renderSummary(result), result });

    expect(result.findings[0]?.simplification).toMatchObject({ tag: "native" });
    expect(comment).toContain(
      "- **Simplification (native):** Remove custom date formatter helper; use Intl.DateTimeFormat. Net: -18 lines.",
    );
    expect(comment).toContain("- **Keep:** Keep input validation and timezone test coverage.");
    expect(comment.match(/`PRA-1`/g)).toHaveLength(1);
  });

  it("keeps blocker evidence separate from brief refactoring guidance", () => {
    const result = validResult({
        findings: [
          {
            severity: "blocker",
            category: "architecture",
            file: "src/lib/example.ts",
            line: 24,
            title: "Keep one cleanup result path",
            description: "Cleanup failure has four state representations.",
            impact: "The removal order is harder to verify.",
            recommendation: "Preserve one fail-closed result path before removal.",
            verificationHint: "Inspect the cleanup result at the removal boundary.",
            missingRegressionTest: "The existing cleanup ordering test covers the boundary.",
            evidence: "The diff adds a flag, exception, catch branch, and outer result.",
            simplification: {
              tag: "shrink",
              cut: "the flag, exception, helper, catch branch, and repeated completion call",
              replacement: "the existing cleanup result path",
              estimatedNetLines: -31,
              safetyBoundary: "Preserve failure ordering and authority-drift coverage.",
            },
          },
        ],
      });

    const comment = buildComment({ summary: renderSummary(result), result });
    const blockers = comment.indexOf("### Blockers");
    const refactoring = comment.indexOf("### Recommended refactoring");

    expect(blockers).toBeGreaterThan(-1);
    expect(refactoring).toBeGreaterThan(blockers);
    expect(comment.slice(blockers, refactoring)).not.toContain("Simplification (shrink)");
    expect(comment).toContain(
      "- **`PRA-1`:** Remove the flag, exception, helper, catch branch, and repeated completion call; use the existing cleanup result path. Net: -31 lines. Keep: Preserve failure ordering and authority-drift coverage.",
    );
    expect(comment).toContain(
      "_Implementation guidance; a fix with equal or lower complexity is acceptable._",
    );
    expect(comment.match(/`PRA-1`/g)).toHaveLength(2);
  });

  it("keeps refactoring guidance within the visible blocker cap", () => {
    const result = validResult({
        findings: Array.from({ length: 21 }, (_, index) => ({
          severity: "blocker",
          category: "architecture",
          file: "src/lib/example.ts",
          line: index + 1,
          title: `Blocker ${index + 1}`,
          description: "The changed path has an unresolved design issue.",
          impact: "The implementation remains harder to maintain.",
          recommendation: "Use the existing result path.",
          ...(index === 20
            ? {
                simplification: {
                  tag: "shrink",
                  cut: "the extra state path",
                  replacement: "the existing result path",
                  estimatedNetLines: -12,
                  safetyBoundary: "Preserve cleanup ordering.",
                },
              }
            : {}),
        })),
      });

    const comment = buildComment({ summary: renderSummary(result), result });

    expect(comment).toContain("#### `PRA-20` Blocker — Blocker 20");
    expect(comment).not.toContain("`PRA-21`");
    expect(comment).not.toContain("### Recommended refactoring");
  });

  it("keeps warning-only reviews non-blocking without synthetic test tasks", () => {
    const result = validResult({
        findings: [
          {
            severity: "warning",
            category: "correctness",
            file: "src/lib/example.ts",
            line: 12,
            title: "Resolve the warning first",
            description: "Warnings should remain ahead of test follow-ups in scan-first sections.",
            recommendation:
              "Resolve or justify this warning before working through test follow-ups.",
          },
        ],
      });

    const comment = buildComment({ summary: renderSummary(result), result });
    expect(comment).toContain("## PR Review Advisor — No blocking findings reported");
    expect(comment).toContain("**Advisor assessment:** No blocking advisor findings reported");
    expect(comment).toContain("**Next action:** Review the warnings below.");
    expect(comment).toContain("### Warnings");
    expect(comment).toContain("#### `PRA-1` Warning — Resolve the warning first");
    expect(comment).not.toContain("PRA-T");
    expect(comment).not.toContain("Missing regression test");
    expect(comment.match(/`PRA-1`/g)).toHaveLength(1);
  });

  it("renders suggestions with no required response", () => {
    const result = validResult({
        findings: [
          {
            severity: "suggestion",
            category: "correctness",
            file: "src/lib/example.ts",
            line: 12,
            title: "Simplify changed branch",
            description: "The new branch can reuse the existing helper.",
            impact: "Duplicated branches make future fixes easier to apply in only one path.",
            recommendation: "Refactor the changed branch in this PR if it remains local.",
            verificationHint: "Compare the changed branch with the existing helper call.",
            missingRegressionTest:
              "Existing unit coverage is sufficient after the branch is simplified.",
            evidence: "Diff adds a duplicate branch next to the helper call.",
          },
        ],
      });

    const comment = buildComment({ summary: renderSummary(result), result });

    expect(comment).toContain("**Findings:** 0 blockers · 0 warnings · 1 suggestion");
    expect(comment).toContain("**Next action:** Consider the suggestions below.");
    expect(comment).toContain("### Suggestions");
    expect(comment).toContain("No response is required");
    expect(comment).toContain("#### `PRA-1` Suggestion — Simplify changed branch");
    expect(comment).toContain("- **Suggestion:** Refactor the changed branch");
    expect(comment).not.toContain("- [ ]");
    expect(comment).not.toContain("Expected follow-up");
    expect(comment).not.toContain("Done when");
    expect(comment.match(/`PRA-1`/g)).toHaveLength(1);
  });

  it("keeps test-depth advice out of the public comment", () => {
    const result = validResult({
        findings: [],
        summary: {
          recommendation: "merge_as_is",
          confidence: "high",
          oneLine: "No concrete defects found.",
        },
        testDepth: {
          verdict: "mocks_recommended",
          rationale: "check </details> and @team",
          suggestedTests: ["probe **bold** [link](https://bad.invalid)"],
        },
      });
    const summary = renderSummary(result);
    const comment = buildComment({ summary, result });

    expect(result.summary.recommendation).toBe("merge_as_is");
    expect(comment).toContain("No advisor follow-up needed");
    expect(comment).not.toContain("PRA-T");
    expect(comment).not.toContain("probe");
    expect(comment).not.toContain("check &lt;/details&gt;");
    expect(summary).not.toContain("probe");
  });

  it("renders concrete test coverage inside a non-tests finding", () => {
    const result = validResult({
        findings: [
          {
            severity: "warning",
            category: "correctness",
            file: "src/example.ts",
            line: 12,
            title: "Failure path is untested",
            description: "The changed failure branch has no assertion.",
            impact: "A regression could turn failure into success.",
            recommendation: "Add one failure-path assertion.",
            verificationHint: "Run the focused test file.",
            missingRegressionTest: "Assert that the changed failure branch returns nonzero.",
            evidence: "The diff changes the branch without a matching test.",
          },
        ],
      });
    const comment = buildComment({ summary: renderSummary(result), result });

    expect(comment).toContain("#### `PRA-1` Warning — Failure path is untested");
    expect(comment).toContain(
      "- **Test coverage:** Assert that the changed failure branch returns nonzero.",
    );
    expect(comment).not.toContain("PRA-T");
    expect(comment.match(/`PRA-1`/g)).toHaveLength(1);
  });

  it.each(["PRA-1", "PRA-2", "PRA-3"])(
    "keeps hostile file locations inside finding fields [%s]",
    (id) => {
      const result = validResult({
          findings: [
            {
              severity: "blocker",
              category: "correctness",
              file: "src/a|b.ts",
              line: 7,
              title: "Pipe in path",
              description: "Location should not add a table cell.",
            },
            {
              severity: "warning",
              category: "correctness",
              file: "src/a\nb.ts",
              line: 8,
              title: "Newline in path",
              description: "Location should stay on one rendered line.",
            },
            {
              severity: "suggestion",
              category: "correctness",
              file: "src/a`b.ts",
              line: 9,
              title: "Backtick in path",
              description: "Location should not break a Markdown code span.",
            },
          ],
        });
      const comment = buildComment({ summary: renderSummary(result), result });

      expect(comment).toContain("- **Location:** <code>src/a&#124;b.ts:7</code>");
      expect(comment).toContain("- **Location:** <code>src/a b.ts:8</code>");
      expect(comment).toContain("- **Location:** <code>src/a`b.ts:9</code>");
      expect(comment).not.toContain("src/a\nb.ts");
      expect(comment).not.toContain("`src/a`b.ts:9`");

      expect(comment.match(new RegExp("`" + id + "`", "g"))).toHaveLength(1);
    },
  );

  it("escapes advisor finding text before rendering sticky comments", () => {
    const result = validResult({
        summary: {
          recommendation: "merge_after_fixes",
          confidence: "high",
          oneLine: "Review found one fixable issue.",
          topItem: "top @team <b> **x**",
        },
        findings: [
          {
            severity: "blocker",
            category: "correctness",
            file: "src/<bad>(1).ts",
            line: 7,
            title: "</details> @team **boom** [x](https://bad.invalid)",
            description: "first\n### injected <script>",
            recommendation: "ping @here & fix _now_",
            evidence: "`code` <tag>",
          },
        ],
      });
    const comment = buildComment({ summary: renderSummary(result), result });

    expect(comment).not.toContain("**Top item:**");
    expect(comment).toContain(
      "&lt;/details&gt; &#64;team \\*\\*boom\\*\\* \\[x\\]\\(https://bad.invalid\\)",
    );
    expect(comment).toContain("src/&lt;bad&gt;(1).ts:7");
    expect(comment).toContain("first ### injected &lt;script&gt;");
    expect(comment).toContain("ping &#64;here &amp; fix \\_now\\_");
    expect(comment).toContain("\\`code\\` &lt;tag&gt;");
    expect(comment).not.toContain("</details> @team");
    expect(comment).not.toContain("### injected <script>");
  });

  it.each(["needs_rework", "blocked"])(
    "rejects retired public recommendation %s",
    (recommendation) => {
      const schema = loadAdvisorSchema();
      const validate = new Ajv2020({ strict: false }).compile(schema);

      expect(validate(validResult({ summary: { ...validResult().summary, recommendation } }))).toBe(
        false,
      );
    },
  );

  it("normalizes output that validates against the JSON schema", () => {
    const schema = loadAdvisorSchema();
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const result = validResult();

    expect(schema["SPDX-License-Identifier"]).toBe("Apache-2.0");
    expect(validate(result)).toBe(true);

    const decision = {
      id: "T-001",
      term: "review-bound",
      change: "introduced",
      disposition: "replace",
      meaning: "Evidence for one revision.",
      contrast: null,
      existingTerm: "commit SHA",
      semanticImpact: "evidence",
      recommendation: "Use commit SHA.",
      traceId: "term-valid",
      source: { file: "WRITING.md", line: 12, headSha: "a".repeat(40) },
    };
    const invalidReceipts = [
      {
        status: "clear",
        decisions: [],
        noChangesReason: "No candidates.\nInjected text.",
      },
      {
        status: "candidates",
        decisions: [{ ...decision, term: "review-bound\ninjected" }],
        noChangesReason: null,
      },
      {
        status: "candidates",
        decisions: [{ ...decision, recommendation: "Use commit SHA.\nInjected text." }],
        noChangesReason: null,
      },
      {
        status: "candidates",
        decisions: [{ ...decision, source: { ...decision.source, headSha: "abc123" } }],
        noChangesReason: null,
      },
    ];
    expect(invalidReceipts.every((terminologyReview) =>
        Object.is(validate({ ...result, terminologyReview }), false))).toBe(true);
  });
});
