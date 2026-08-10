// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  evaluateCodebaseBudgetMonotonicity,
  evaluateJavaScriptFileContract,
  evaluateOnboardLineContract,
  evaluateTestConditionalContract,
  parseCodebaseGrowthBudget,
  type CodebaseGrowthBudget,
} from "../tools/growth-guardrails/codebase-contract.mts";
import {
  evaluateAddedJavaScriptFiles,
  evaluateOnboardGrowth,
} from "../tools/growth-guardrails/check-pr.mts";

const BASE_BUDGET: CodebaseGrowthBudget = {
  onboardMaxLines: 100,
  javascriptFiles: ["bin/legacy.js"],
  testIfCounts: { "test/legacy.test.ts": 2 },
};
const NO_RENAMES: ReadonlyMap<string, string> = new Map();

describe("codebase growth repository contract", () => {
  it("accepts the exact JavaScript allowance", () => {
    expect(evaluateJavaScriptFileContract(["bin/legacy.js"], ["bin/legacy.js"])).toEqual([]);
  });

  it.each([
    [
      ["bin/legacy.js", "test/new.js"],
      ["bin/legacy.js"],
      /test\/new\.js: JavaScript file is not allowed/,
    ],
    [[], ["bin/legacy.js"], /bin\/legacy\.js: stale JavaScript allowance/],
  ])("rejects a JavaScript allowance mismatch", (current, allowed, pattern) => {
    expect(evaluateJavaScriptFileContract(current, allowed).join("\n")).toMatch(pattern);
  });

  it.each([
    [101, /101 lines exceeds budget 100/],
    [99, /99 lines is below stale budget 100/],
  ])("rejects an onboard line count outside the exact budget", (lines, pattern) => {
    expect(evaluateOnboardLineContract(lines, 100).join("\n")).toMatch(pattern);
  });

  it("rejects unbudgeted counts and stale test conditional budgets", () => {
    expect(
      evaluateTestConditionalContract(
        { "test/added.test.ts": 1, "test/shrunk.test.ts": 1 },
        { "test/shrunk.test.ts": 2, "test/stale.test.ts": 3 },
      ),
    ).toEqual([
      "test/added.test.ts: if statement count 1 has no budget",
      "test/shrunk.test.ts: if statement count 1 is below stale budget 2",
      "test/stale.test.ts: stale if statement budget 3 has no matching count",
    ]);
  });

  it("parses a valid codebase growth budget", () => {
    expect(parseCodebaseGrowthBudget(JSON.stringify(BASE_BUDGET))).toEqual(BASE_BUDGET);
  });

  it("preserves __proto__ as an own conditional-budget property", () => {
    const parsed = parseCodebaseGrowthBudget(
      '{"onboardMaxLines":100,"javascriptFiles":[],"testIfCounts":{"__proto__":1}}',
    );
    expect(Object.hasOwn(parsed.testIfCounts, "__proto__")).toBe(true);
    expect(parsed.testIfCounts.__proto__).toBe(1);
  });

  it("rejects an unsorted JavaScript allowance", () => {
    expect(() =>
      parseCodebaseGrowthBudget(
        JSON.stringify({
          onboardMaxLines: 100,
          javascriptFiles: ["z.js", "a.js"],
          testIfCounts: {},
        }),
      ),
    ).toThrow(/sorted unique paths/);
  });
});

describe("codebase growth trusted policy", () => {
  it("allows a budget reduction and same-language renames", () => {
    const head: CodebaseGrowthBudget = {
      onboardMaxLines: 90,
      javascriptFiles: ["bin/renamed.js"],
      testIfCounts: { "test/renamed.test.ts": 1 },
    };
    const renames = new Map([
      ["bin/renamed.js", "bin/legacy.js"],
      ["test/renamed.test.ts", "test/legacy.test.ts"],
    ]);
    expect(evaluateCodebaseBudgetMonotonicity(BASE_BUDGET, head, renames)).toEqual([]);
  });

  it("rejects increased and new allowances", () => {
    const head: CodebaseGrowthBudget = {
      onboardMaxLines: 101,
      javascriptFiles: ["bin/legacy.js", "test/new.js"],
      testIfCounts: { "test/legacy.test.ts": 3, "test/new.test.ts": 1 },
    };
    expect(evaluateCodebaseBudgetMonotonicity(BASE_BUDGET, head, NO_RENAMES)).toEqual([
      "onboardMaxLines increased from 100 to 101",
      "test/new.js: adds a JavaScript allowance",
      "test/legacy.test.ts: if-statement budget increased from 2 to 3",
      "test/new.test.ts: adds an if-statement budget of 1",
    ]);
  });

  it("rejects newly added JavaScript files but permits a JavaScript rename", () => {
    expect(
      evaluateAddedJavaScriptFiles([
        { filename: "test/new.js", status: "added" },
        { filename: "bin/new.js", previous_filename: "bin/old.js", status: "renamed" },
      ]),
    ).toEqual(["test/new.js: new JavaScript files must use TypeScript"]);
  });

  it("rejects net growth in the onboard entrypoint", () => {
    expect(
      evaluateOnboardGrowth([
        { filename: "src/lib/onboard.ts", status: "modified", additions: 4, deletions: 2 },
      ]),
    ).toEqual(["src/lib/onboard.ts: grew by 2 line(s) (+4/-2)"]);
  });
});
