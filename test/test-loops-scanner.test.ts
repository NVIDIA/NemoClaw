// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  formatReport,
  scanTextForTestLoops,
} from "../scripts/growth-guardrails/find-test-loops.mts";

describe("test loop scanner", () => {
  it("detects each for-loop form inside a test callback", () => {
    const occurrences = scanTextForTestLoops(
      "test/virtual-loops.test.ts",
      `
        it("iterates", async () => {
          for (let index = 0; index < 2; index += 1) consume(index);
          for (const key in record) consume(key);
          for (const value of values) consume(value);
          for await (const value of stream) consume(value);
        });
      `,
    );

    expect(occurrences.map((occurrence) => occurrence.kind)).toEqual([
      "for",
      "for-in",
      "for-of",
      "for-await-of",
    ]);
    expect(occurrences[0]).toMatchObject({
      contextKind: "test",
      contextName: "iterates",
    });
  });

  it("detects a loop that generates test definitions", () => {
    const occurrences = scanTextForTestLoops(
      "test/virtual-generated-tests.test.ts",
      `
        describe("generated tests", () => {
          for (const value of values) {
            it(String(value), () => expect(value).toBeDefined());
          }
        });
      `,
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      kind: "for-of",
      contextKind: "suite",
      contextName: "generated tests",
    });
  });

  it("allows required iteration in a named helper outside the test callback", () => {
    const occurrences = scanTextForTestLoops(
      "test/virtual-helper-loops.test.ts",
      `
        function collect(values) {
          for (const value of values) consume(value);
        }
        it("collects values", () => {
          collect(values);
          expect(values).toBeDefined();
        });
      `,
    );

    expect(occurrences).toEqual([]);
  });

  it("ignores fixture text, hooks, and loop forms outside the rule", () => {
    const occurrences = scanTextForTestLoops(
      "test/virtual-ignored-loops.test.ts",
      `
        const fixture = \`for (const row of rows) { expect(row).toBeDefined(); }\`;
        afterEach(() => {
          for (const resource of resources) resource.close();
        });
        it("waits", () => {
          while (pending()) wait();
          do { wait(); } while (pending());
          values.forEach(consume);
          expect(fixture).toContain("for");
        });
      `,
    );

    expect(occurrences).toEqual([]);
  });

  it("detects a for loop inside executable template interpolation", () => {
    const occurrences = scanTextForTestLoops(
      "test/virtual-template-loop.test.ts",
      [
        'it("iterates in interpolation", () => {',
        "  const value = `${(() => {",
        "    for (const item of items) consume(item);",
        '    return "done";',
        "  })()}`;",
        '  expect(value).toBe("done");',
        "});",
      ].join("\n"),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      kind: "for-of",
      contextKind: "test",
      contextName: "iterates in interpolation",
    });
  });

  it("reports findings as test loops", () => {
    const occurrences = scanTextForTestLoops(
      "test/virtual-report.test.ts",
      'it("iterates", () => { for (const value of values) consume(value); });',
    );
    const report = formatReport(
      {
        summary: { scannedFiles: 1, filesWithLoops: 1, loopCount: 1 },
        files: [{ file: "test/virtual-report.test.ts", count: 1 }],
        occurrences,
      },
      { top: 1 },
    );

    expect(report).toContain("found 1 test loop(s) in 1 file(s)");
    expect(report).toContain("\nTest loops:\n");
    expect(report).not.toContain("table-test candidate");
  });
});
