// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  findTestTitleStyleViolations,
  scanTestTitleStyle,
} from "../scripts/checks/test-title-style.mts";

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

  it("resolves aliased Vitest calls without treating non-Vitest aliases as test primitives", () => {
    const violations = scanTestTitleStyle(
      "test/virtual-title-style.test.ts",
      `
        import { describe as suite, it as caseIt, test as caseTest } from "vitest";
        import { describe as otherSuite } from "other-test-library";
        suite("issue #1234 aliased suite", () => {
          caseIt.only("#1234 aliased case", () => {});
          caseTest("input → output", () => {});
        });
        otherSuite("issue #9999 external alias", () => {});
      `,
    );

    expect(violations.map(({ call, rule }) => ({ call, rule }))).toEqual([
      { call: "describe", rule: "issue-reference-suffix" },
      { call: "describe", rule: "leading-metadata" },
      { call: "it", rule: "issue-reference-suffix" },
      { call: "it", rule: "leading-metadata" },
      { call: "test", rule: "result-arrow" },
    ]);
  });

  it("does not follow symbolic links while walking test roots", () => {
    const root = fs.mkdtempSync(path.join(import.meta.dirname, "__title-style-root-"));
    const outside = fs.mkdtempSync(path.join(import.meta.dirname, "__title-style-outside-"));
    try {
      fs.writeFileSync(
        path.join(outside, "bad.test.ts"),
        'it("issue #1234 hidden behind a symlink", () => {});\n',
      );
      fs.symlinkSync(outside, path.join(root, "linked"), "dir");

      expect(
        findTestTitleStyleViolations([path.relative(import.meta.dirname + "/..", root)]),
      ).toEqual([]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
      fs.rmSync(outside, { force: true, recursive: true });
    }
  });
});
