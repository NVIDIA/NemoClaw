// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { scanTextForTestConditionals } from "../scripts/find-test-conditionals";

describe("test conditional scanner", () => {
  it("detects real if statements without matching strings or comments", () => {
    const occurrences = scanTextForTestConditionals(
      "test/virtual-conditionals.test.ts",
      `
        import { expect, it } from "vitest";

        // if (commentedOut) expect(false).toBe(true);
        const fixture = "if (insideString) expect(false).toBe(true)";

        it("branches", () => {
          if (fixture.length > 0) {
            expect(fixture).toContain("if");
          }
        });
      `,
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      line: 8,
      contextKind: "test",
      contextName: "branches",
      containsAssertion: true,
    });
  });

  it("detects executable if statements inside template interpolation", () => {
    const occurrences = scanTextForTestConditionals(
      "test/virtual-template-conditionals.test.ts",
      [
        'import { expect, it } from "vitest";',
        'it("branches in interpolation", () => {',
        "  const value = `${(() => {",
        '    if (process.env.FLAG) return "enabled";',
        '    return "disabled";',
        "  })()}`;",
        '  expect(value).toBeTypeOf("string");',
        "});",
      ].join("\n"),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      contextKind: "test",
      contextName: "branches in interpolation",
      containsControlFlow: true,
    });
  });

  it("scores assertion branches in test bodies above helper guard clauses", () => {
    const occurrences = scanTextForTestConditionals(
      "test/virtual-conditionals.test.ts",
      `
        import { expect, it } from "vitest";

        function maybeNormalize(value?: string) {
          if (value === undefined) return "fallback";
          return value;
        }

        it("branches assertions", () => {
          const value = maybeNormalize("hello");
          if (value === "hello") {
            expect(value).toBe("hello");
          } else {
            expect(value).toBe("fallback");
          }
        });
      `,
    );

    const [testBranch, helperGuard] = occurrences.sort((a, b) => b.score - a.score);

    expect(testBranch).toMatchObject({
      contextKind: "test",
      containsAssertion: true,
      hasElse: true,
    });
    expect(helperGuard).toMatchObject({
      contextKind: "helper",
      containsControlFlow: true,
    });
    expect(testBranch.score).toBeGreaterThan(helperGuard.score);
  });
});
