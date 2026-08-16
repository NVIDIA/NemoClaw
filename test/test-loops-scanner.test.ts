// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { scanTextForTestLoops } from "../scripts/growth-guardrails/find-test-loops.mts";

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

  it("ignores fixture text and loop forms that do not represent table-test candidates", () => {
    const occurrences = scanTextForTestLoops(
      "test/virtual-helper-loops.test.ts",
      `
        const fixture = \`for (const row of rows) { expect(row).toBeDefined(); }\`;
        function collect(values) {
          for (const value of values) consume(value);
        }
        afterEach(() => {
          for (const resource of resources) resource.close();
        });
        it("waits", () => {
          while (pending()) wait();
          do { wait(); } while (pending());
          values.forEach(consume);
          collect(values);
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
});
