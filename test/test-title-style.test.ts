// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { scanTestTitleStyle } from "../scripts/checks/test-title-style";

function rulesFor(source: string): string[] {
  return scanTestTitleStyle("test/virtual-title-style.test.ts", source).map(
    (violation) => violation.rule,
  );
}

describe("enforces behavior-oriented Vitest titles", () => {
  it("detects issue-first, metadata-first, placeholder-only, and arrow-label titles", () => {
    const rules = rulesFor(`
      import { describe, it } from "vitest";
      describe("issue #1234 spline behavior", () => {
        it("#1234: fixes splines", () => {});
        it("--force bypasses validation", () => {});
        it("Scenario A: spline fixed", () => {});
        it.each([["spline"]])("%s", () => {});
        it("input → output", () => {});
      });
    `);

    expect(rules).toEqual([
      "issue-reference-suffix",
      "leading-metadata",
      "issue-reference-suffix",
      "leading-metadata",
      "leading-metadata",
      "leading-metadata",
      "placeholder-only",
      "result-arrow",
    ]);
  });

  it("accepts behavior-oriented titles and final issue suffixes through Vitest modifiers", () => {
    const violations = scanTestTitleStyle(
      "test/virtual-title-style.test.ts",
      `
        import { describe, it } from "vitest";
        describe.skipIf(false)("spline behavior (#1234)", () => {
          it("reticulates splines correctly (#1234)", () => {});
          it.each([["cubic"]])("reticulates %s splines", () => {});
        });
      `,
    );

    expect(violations).toEqual([]);
  });

  it("ignores external repository issue references and nonliteral titles", () => {
    const violations = scanTestTitleStyle(
      "test/virtual-title-style.test.ts",
      `
        import { describe, it } from "vitest";
        const generated = "generated elsewhere";
        describe("upstream owner/repo#123 behavior", () => {
          it(generated, () => {});
        });
      `,
    );

    expect(violations).toEqual([]);
  });
});
