// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  findTestRegistrationViolations,
  formatViolations,
  isScannedModule,
  scanTestRegistrations,
} from "../../scripts/checks/test-registration-boundary.mts";

function scan(source: string, file = "test/helpers/example-helper.ts") {
  return scanTestRegistrations(file, source);
}

describe("test registration boundary scanner", () => {
  it("flags a helper module that registers a suite", () => {
    const violations = scan(
      [
        'import { describe, expect, it } from "vitest";',
        "",
        "export function registerExampleTests() {",
        '  describe("example", () => {',
        '    it("holds", () => expect(1).toBe(1));',
        "  });",
        "}",
      ].join("\n"),
    );

    expect(violations).toEqual([
      { file: "test/helpers/example-helper.ts", line: 4, column: 3, call: "describe" },
      { file: "test/helpers/example-helper.ts", line: 5, column: 5, call: "it" },
    ]);
  });

  it("flags the describe, it, suite, and test registrations", () => {
    const violations = scan(
      [
        'import { describe, it, suite, test } from "vitest";',
        "",
        'describe("a", () => {});',
        'it("b", () => {});',
        'suite("c", () => {});',
        'test("d", () => {});',
      ].join("\n"),
    );

    expect(violations.map(({ call }) => call)).toEqual(["describe", "it", "suite", "test"]);
  });

  it("flags modifier chains on a registration binding", () => {
    const violations = scan(
      [
        'import { describe, it, test } from "vitest";',
        "",
        'describe.each([1, 2])("each %i", () => {});',
        'it.only("only", () => {});',
        'it.skip("skip", () => {});',
        'test.skipIf(false)("skipIf", () => {});',
        'test.runIf(true)("runIf", () => {});',
        'describe.concurrent("concurrent", () => {});',
      ].join("\n"),
    );

    expect(violations.map(({ call }) => call)).toEqual([
      "describe.each",
      "it.only",
      "it.skip",
      "test.skipIf",
      "test.runIf",
      "describe.concurrent",
    ]);
  });

  it("reports a chained registration once at the root binding", () => {
    const violations = scan(
      ['import { it } from "vitest";', "", 'it.skipIf(false)("chained", () => {});'].join("\n"),
    );

    expect(violations).toEqual([
      { file: "test/helpers/example-helper.ts", line: 3, column: 1, call: "it.skipIf" },
    ]);
  });

  it("resolves a renamed registration import", () => {
    const violations = scan(
      [
        'import { describe as group, it as scenario } from "vitest";',
        "",
        'group("renamed", () => {',
        '  scenario("case", () => {});',
        "});",
      ].join("\n"),
    );

    expect(violations.map(({ call }) => call)).toEqual(["group", "scenario"]);
  });

  it("resolves registrations reached through a namespace import", () => {
    const violations = scan(
      [
        'import * as vitest from "vitest";',
        "",
        'vitest.describe.only("namespaced", () => {});',
      ].join("\n"),
    );

    expect(violations.map(({ call }) => call)).toEqual(["vitest.describe.only"]);
  });

  it("flags tagged-template registrations through direct, renamed, and namespace imports", () => {
    const violations = scan(
      [
        'import { describe, test as scenario } from "vitest";',
        'import * as vitest from "vitest";',
        "",
        'describe.each`value | expected\n${1} | ${1}`("direct", () => {});',
        'scenario.each`value\n${2}`("renamed", () => {});',
        'vitest.suite.each`value\n${3}`("namespaced", () => {});',
      ].join("\n"),
    );

    expect(violations.map(({ call }) => call)).toEqual([
      "describe.each",
      "scenario.each",
      "vitest.suite.each",
    ]);
  });

  it("does not flag fixture extension", () => {
    const violations = scan(
      [
        'import { test as base, describe, expect } from "vitest";',
        "",
        "export const test = base.extend({",
        "  resource: async ({}, use) => {",
        "    await use({});",
        "  },",
        "});",
        "",
        "export { describe, expect };",
      ].join("\n"),
    );

    expect(violations).toEqual([]);
  });

  it("does not flag registration names inside comments and strings", () => {
    const violations = scan(
      [
        'import { describe } from "vitest";',
        "",
        '// describe("commented", () => {});',
        '/* it("blocked", () => {}); */',
        "export const label = 'test(\"quoted\", () => {})';",
      ].join("\n"),
    );

    expect(violations).toEqual([]);
  });

  it("does not flag a locally declared registration name", () => {
    const violations = scan(
      [
        'import { expect } from "vitest";',
        "",
        "function it(title: string, body: () => void) {",
        "  return { title, body };",
        "}",
        "",
        'export const recorded = it("local", () => expect(true).toBe(true));',
      ].join("\n"),
    );

    expect(violations).toEqual([]);
  });

  it("resolves a nested registration parameter instead of the imported binding", () => {
    const violations = scan(
      [
        'import { it } from "vitest";',
        "",
        'it("imported", () => {});',
        "function invoke(it: (title: string, body: () => void) => unknown) {",
        '  it("local", () => {});',
        "}",
      ].join("\n"),
    );

    expect(violations).toEqual([
      { file: "test/helpers/example-helper.ts", line: 3, column: 1, call: "it" },
    ]);
  });

  it("does not flag a type-only Vitest import", () => {
    const violations = scan(
      [
        'import type { TestContext } from "vitest";',
        "",
        "export function describe(context: TestContext) {",
        "  return context;",
        "}",
        "",
        "export const described = describe({} as TestContext);",
      ].join("\n"),
    );

    expect(violations).toEqual([]);
  });
});

describe("test registration boundary module selection", () => {
  it("selects modules that Vitest does not collect as test files", () => {
    expect(isScannedModule("test/helpers/example-helper.ts")).toBe(true);
    expect(isScannedModule("src/lib/example.mts")).toBe(true);
    expect(isScannedModule("bin/example.js")).toBe(true);
  });

  it("does not select test or spec files", () => {
    expect(isScannedModule("src/lib/example.test.ts")).toBe(false);
    expect(isScannedModule("test/example.spec.js")).toBe(false);
  });

  it("selects an orphan suite module but exempts one imported by a test", () => {
    expect(isScannedModule("test/orphan-suite.ts")).toBe(true);
    expect(isScannedModule("test/credentials/local-credential-helper-suite.ts", true)).toBe(false);
    expect(isScannedModule("test/openclaw-integrity-pin-suite.ts", true)).toBe(false);
  });

  it("does not select files that are not JavaScript or TypeScript", () => {
    expect(isScannedModule("docs/example.mdx")).toBe(false);
    expect(isScannedModule("scripts/example.sh")).toBe(false);
  });
});

describe("test registration boundary diagnostics", () => {
  it("names the file, position, and remediation for each violation", () => {
    const report = formatViolations([
      { file: "test/helpers/example-helper.ts", line: 4, column: 3, call: "describe" },
    ]);

    expect(report).toContain("test/helpers/example-helper.ts:4:3 describe(...)");
    expect(report).toContain("*.test.ts");
    expect(report).toContain("*-suite.ts");
  });
});

describe("test registration boundary repository state", () => {
  it("exempts an imported suite module and reports an orphan suite module", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-test-registration-boundary-"));
    try {
      writeFileSync(path.join(root, "collected.test.ts"), 'import "./imported-suite";\n');
      writeFileSync(
        path.join(root, "imported-suite.ts"),
        'import { it } from "vitest";\nit("imported", () => {});\n',
      );
      writeFileSync(
        path.join(root, "orphan-suite.ts"),
        'import { it } from "vitest";\nit("orphan", () => {});\n',
      );

      const violations = findTestRegistrationViolations([root]);

      expect(violations).toHaveLength(1);
      expect(path.basename(violations[0]?.file ?? "")).toBe("orphan-suite.ts");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reports no test registration outside test and suite files", () => {
    expect(findTestRegistrationViolations()).toEqual([]);
  });
});
