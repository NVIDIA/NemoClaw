// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  countLines,
  evaluateTestFileSizeBudget,
  formatViolations,
  parseBudget,
} from "../scripts/check-test-file-size-budget";

describe("test file size budget", () => {
  it("counts trailing-newline and non-trailing-newline files consistently", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\n")).toBe(1);
    expect(countLines("one\r\ntwo")).toBe(2);
  });

  it("flags non-grandfathered test files above the default ceiling", () => {
    const violations = evaluateTestFileSizeBudget(
      [{ file: "test/new-large.test.ts", lines: 151 }],
      { defaultMaxLines: 150 },
    );

    expect(violations).toEqual([
      {
        kind: "oversized",
        file: "test/new-large.test.ts",
        lines: 151,
        maxLines: 150,
        budgetKind: "default",
      },
    ]);
  });

  it("grandfathers existing large tests without allowing growth", () => {
    const budget = { defaultMaxLines: 150, legacyMaxLines: { "test/legacy.test.ts": 250 } };

    expect(
      evaluateTestFileSizeBudget([{ file: "test/legacy.test.ts", lines: 250 }], budget),
    ).toEqual([]);
    expect(
      evaluateTestFileSizeBudget([{ file: "test/legacy.test.ts", lines: 251 }], budget),
    ).toEqual([
      {
        kind: "oversized",
        file: "test/legacy.test.ts",
        lines: 251,
        maxLines: 250,
        budgetKind: "legacy",
      },
    ]);
  });

  it("requires legacy budgets to ratchet down when oversized tests shrink", () => {
    const violations = evaluateTestFileSizeBudget([{ file: "test/legacy.test.ts", lines: 200 }], {
      defaultMaxLines: 150,
      legacyMaxLines: { "test/legacy.test.ts": 250 },
    });

    expect(violations).toEqual([
      {
        kind: "legacy-ratchet",
        file: "test/legacy.test.ts",
        lines: 200,
        maxLines: 250,
      },
    ]);
    expect(formatViolations(violations)).toContain("lower the budget entry");
  });

  it("rejects stale legacy budget entries", () => {
    const violations = evaluateTestFileSizeBudget([], {
      defaultMaxLines: 150,
      legacyMaxLines: { "test/deleted.test.ts": 200 },
    });

    expect(violations).toEqual([
      { kind: "stale-legacy-budget", file: "test/deleted.test.ts", maxLines: 200 },
    ]);
  });

  it("parses the JSON budget format", () => {
    expect(
      parseBudget(
        JSON.stringify({
          defaultMaxLines: 1500,
          legacyMaxLines: { "test/legacy.test.ts": 2000 },
        }),
      ),
    ).toEqual({
      defaultMaxLines: 1500,
      legacyMaxLines: { "test/legacy.test.ts": 2000 },
    });
  });
});
