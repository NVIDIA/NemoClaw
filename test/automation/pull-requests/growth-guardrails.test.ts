// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  addedJavaScriptViolations,
  conditionalGrowthViolations,
  diagnostics,
  e2eAssertionBudgetGrowthViolations,
  loopGrowthViolations,
  onboardGrowthViolations,
  testOnly as checkTestOnly,
  testSizeViolations,
} from "../../helpers/growth-guardrail-checks";
import {
  type GrowthGuardrailDiff,
  loadGrowthGuardrailDiff,
  testOnly as diffTestOnly,
} from "../../helpers/growth-guardrail-diff";

function fixtureDiff(
  files: GrowthGuardrailDiff["files"],
  base: Readonly<Record<string, string>>,
  head: Readonly<Record<string, string>>,
): GrowthGuardrailDiff {
  return {
    files,
    async readBase(paths) {
      return new Map(paths.map((file) => [file, base[file] ?? null]));
    },
    async readHead(paths) {
      return new Map(paths.map((file) => [file, head[file] ?? null]));
    },
  };
}

function e2eAssertionBudget(
  expectCalls: number,
  referenceSha = "a".repeat(40),
  file = "test/e2e/live/example.test.ts",
): string {
  const metrics = {
    expectCalls,
    matcherAssertions: expectCalls,
    nodeAssertions: 0,
    namedAssertionHelpers: 0,
    failCalls: 0,
    throwGuards: 0,
    objectFieldAssertions: 0,
    assertionPoints: expectCalls,
    generatedProbeBlocks: 0,
    generatedProbeConditions: 0,
  };
  return JSON.stringify({
    $comment: "fixture",
    schemaVersion: 1,
    issue: 10934,
    epic: 10920,
    reference: {
      mainSha: referenceSha,
      currentMainCollectedTests: 1,
      epicMainSha: "b".repeat(40),
      epicCollectedTests: 95,
      epicDirectExpectCalls: 2184,
      epicLiveExpectCalls: 2677,
    },
    limits: {
      testFileCount: 1,
      liveFileCount: 1,
      direct: metrics,
      unique: metrics,
      fileMetricOrder: [
        "directExpectCalls",
        "directAssertionPoints",
        "transitiveExpectCalls",
        "transitiveAssertionPoints",
        "transitiveGeneratedProbeBlocks",
      ],
      files: {
        [file]: [expectCalls, expectCalls, expectCalls, expectCalls, 0],
      },
    },
  });
}

describe("codebase growth guardrails", () => {
  let diff: GrowthGuardrailDiff;

  beforeAll(async () => {
    diff = await loadGrowthGuardrailDiff();
  });

  it("requires TypeScript for new Node.js files", () => {
    const violations = addedJavaScriptViolations(diff.files);
    expect(violations, diagnostics.javascript(violations)).toEqual([]);
  });

  it("keeps src/lib/onboard.ts net-neutral or smaller", async () => {
    const violations = await onboardGrowthViolations(diff);
    expect(violations, diagnostics.onboard(violations)).toEqual([]);
  });

  it("keeps changed test files within the size budget", async () => {
    const violations = await testSizeViolations(diff);
    expect(violations, diagnostics.size(violations)).toEqual([]);
  });

  it("does not increase the live E2E assertion baseline", async () => {
    const violations = await e2eAssertionBudgetGrowthViolations(diff);
    expect(violations, diagnostics.e2eAssertions(violations)).toEqual([]);
  });

  it("does not add if statements to changed test files", async () => {
    const violations = await conditionalGrowthViolations(diff);
    expect(violations, diagnostics.conditionals(violations)).toEqual([]);
  });

  it("does not add test loops directly, through one-use helpers, or through callback-forwarding helpers", async () => {
    const violations = await loopGrowthViolations(diff);
    expect(violations, diagnostics.loops(violations)).toEqual([]);
  }, 60_000);
});

describe("codebase growth guardrail test support", () => {
  it("caches repeated blob reads across guardrail checks", () => {
    const read = vi.fn((file: string) => `${file} content`);
    const cache = new Map<string, string | null>();

    expect(diffTestOnly.readFilesCached(["test/a.test.ts"], cache, read)).toEqual(
      new Map([["test/a.test.ts", "test/a.test.ts content"]]),
    );
    expect(diffTestOnly.readFilesCached(["test/a.test.ts"], cache, read)).toEqual(
      new Map([["test/a.test.ts", "test/a.test.ts content"]]),
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects an added JavaScript file without rejecting an existing JavaScript rename", () => {
    expect(
      addedJavaScriptViolations([
        { filename: "test/new.test.js", status: "added" },
        {
          filename: "test/new-name.test.js",
          previous_filename: "test/old-name.test.js",
          status: "renamed",
        },
      ]),
    ).toEqual(["test/new.test.js"]);
  });

  it("rejects growth in the onboarding entry point", async () => {
    const diff = fixtureDiff(
      [{ filename: "src/lib/onboard.ts", status: "modified" }],
      { "src/lib/onboard.ts": "first\n" },
      { "src/lib/onboard.ts": "first\nsecond\n" },
    );
    expect(await onboardGrowthViolations(diff)).toEqual(["src/lib/onboard.ts grew by 1 line(s)"]);
  });

  it("rejects a larger default test file budget", async () => {
    const diff = fixtureDiff(
      [{ filename: "ci/test-file-size-budget.json", status: "modified" }],
      { "ci/test-file-size-budget.json": '{"defaultMaxLines":1500}' },
      { "ci/test-file-size-budget.json": '{"defaultMaxLines":2000}' },
    );
    expect(await testSizeViolations(diff)).toContain("defaultMaxLines increased from 1500 to 2000");
  });

  it("accepts the initial live E2E assertion budget", async () => {
    const budget = e2eAssertionBudget(1);
    const diff = fixtureDiff(
      [{ filename: "ci/e2e-assertion-budget.json", status: "added" }],
      {},
      { "ci/e2e-assertion-budget.json": budget },
    );

    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
  });

  it("accepts a lower live E2E assertion budget", async () => {
    const diff = fixtureDiff(
      [{ filename: "ci/e2e-assertion-budget.json", status: "modified" }],
      { "ci/e2e-assertion-budget.json": e2eAssertionBudget(2) },
      { "ci/e2e-assertion-budget.json": e2eAssertionBudget(1) },
    );

    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
  });

  it("rejects a larger live E2E assertion budget and changed reference", async () => {
    const diff = fixtureDiff(
      [{ filename: "ci/e2e-assertion-budget.json", status: "modified" }],
      { "ci/e2e-assertion-budget.json": e2eAssertionBudget(1) },
      { "ci/e2e-assertion-budget.json": e2eAssertionBudget(2, "c".repeat(40)) },
    );
    const violations = await e2eAssertionBudgetGrowthViolations(diff);

    expect(violations).toContain("live E2E assertion reference metadata changed");
    expect(violations).toContain("direct.expectCalls increased from 1 to 2");
    expect(violations).toContain(
      "test/e2e/live/example.test.ts directExpectCalls increased from 1 to 2",
    );
  });

  it("rejects an omitted live E2E assertion budget unless its test was removed", async () => {
    const withoutFile = JSON.parse(e2eAssertionBudget(1)) as {
      limits: { files: Record<string, unknown> };
    };
    withoutFile.limits.files = {};
    const base = { "ci/e2e-assertion-budget.json": e2eAssertionBudget(1) };
    const head = {
      "ci/e2e-assertion-budget.json": JSON.stringify(withoutFile),
    };

    const omitted = fixtureDiff(
      [{ filename: "ci/e2e-assertion-budget.json", status: "modified" }],
      base,
      head,
    );
    expect(await e2eAssertionBudgetGrowthViolations(omitted)).toContain(
      "test/e2e/live/example.test.ts omitted its live E2E assertion budget",
    );

    const removed = fixtureDiff(
      [
        { filename: "ci/e2e-assertion-budget.json", status: "modified" },
        { filename: "test/e2e/live/example.test.ts", status: "removed" },
      ],
      base,
      head,
    );
    expect(await e2eAssertionBudgetGrowthViolations(removed)).toEqual([]);
  });

  it("carries a live E2E assertion budget across a test rename", async () => {
    const renamed = "test/e2e/live/renamed.test.ts";
    const diff = fixtureDiff(
      [
        { filename: "ci/e2e-assertion-budget.json", status: "modified" },
        {
          filename: renamed,
          previous_filename: "test/e2e/live/example.test.ts",
          status: "renamed",
        },
      ],
      { "ci/e2e-assertion-budget.json": e2eAssertionBudget(2) },
      {
        "ci/e2e-assertion-budget.json": e2eAssertionBudget(1, "a".repeat(40), renamed),
      },
    );

    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
  });

  it("rejects a changed test that is missing from the latest PR commit", async () => {
    const diff = fixtureDiff(
      [{ filename: "test/example.test.ts", status: "modified" }],
      { "ci/test-file-size-budget.json": '{"defaultMaxLines":1500}' },
      {},
    );
    expect(await testSizeViolations(diff)).toContain(
      "test/example.test.ts was not found at the latest PR commit",
    );
  });

  it("asks for a stale legacy budget to be removed when its test is deleted", async () => {
    const budget = '{"defaultMaxLines":1500,"legacyMaxLines":{"test/legacy.test.ts":1}}';
    const diff = fixtureDiff(
      [{ filename: "test/legacy.test.ts", status: "removed" }],
      {
        "ci/test-file-size-budget.json": budget,
        "test/legacy.test.ts": "legacy\n",
      },
      { "ci/test-file-size-budget.json": budget },
    );
    expect(await testSizeViolations(diff)).toEqual([
      "test/legacy.test.ts no longer exists; remove its legacy budget 1",
    ]);
  });

  it("reports an oversized changed legacy test once", async () => {
    const budget = '{"defaultMaxLines":1500,"legacyMaxLines":{"test/legacy.test.ts":1}}';
    const diff = fixtureDiff(
      [{ filename: "test/legacy.test.ts", status: "modified" }],
      {
        "ci/test-file-size-budget.json": budget,
        "test/legacy.test.ts": "legacy\n",
      },
      {
        "ci/test-file-size-budget.json": budget,
        "test/legacy.test.ts": "legacy\ngrowth\n",
      },
    );
    expect(await testSizeViolations(diff)).toEqual([
      "test/legacy.test.ts has 2 lines, above its budget 1",
    ]);
  });

  it("rejects a new if statement in a changed test file", async () => {
    const diff = fixtureDiff(
      [{ filename: "test/example.test.ts", status: "modified" }],
      { "test/example.test.ts": "it('works', () => expect(ok).toBe(true));" },
      { "test/example.test.ts": "it('works', () => { if (ok) expect(ok).toBe(true); });" },
    );
    expect(await conditionalGrowthViolations(diff)).toEqual([
      "test/example.test.ts: 1 if statement(s), up from 0",
    ]);
  });

  it("rejects a new loop in a changed test callback", async () => {
    const diff = fixtureDiff(
      [{ filename: "test/example.test.ts", status: "modified" }],
      { "test/example.test.ts": "it('works', () => expect(rows).toBeDefined());" },
      {
        "test/example.test.ts":
          "it('works', () => { for (const row of rows) expect(row).toBeDefined(); });",
      },
    );
    expect(await loopGrowthViolations(diff)).toEqual([
      "test/example.test.ts: 1 test loop(s), up from 0",
    ]);
  });

  it.each([
    ["if statements", conditionalGrowthViolations, "if (ok) expect(ok).toBe(true);"],
    [
      "test loops",
      loopGrowthViolations,
      "for (const row of rows) it(row.name, () => expect(row).toBeDefined());",
    ],
  ])("compares %s across a renamed test", async (_name, violations, addedSyntax) => {
    const file = {
      filename: "test/new.test.ts",
      previous_filename: "test/old.test.ts",
      status: "renamed",
    };
    const base = "it('works', () => expect(ok).toBe(true));";

    expect(
      await violations(
        fixtureDiff([file], { "test/old.test.ts": base }, { "test/new.test.ts": base }),
      ),
    ).toEqual([]);
    expect(
      await violations(
        fixtureDiff(
          [file],
          { "test/old.test.ts": base },
          { "test/new.test.ts": `${base}\n${addedSyntax}` },
        ),
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["plain assertion", "it('works', () => expect(true).toBe(true));", 0],
    ["conditional assertion", "it('works', () => { if (ok) expect(ok).toBe(true); });", 1],
  ])("counts if statements in %s", (_name, source, expected) => {
    expect(checkTestOnly.countIfStatements("test/example.test.ts", source)).toBe(expected);
  });

  it.each([
    ["plain assertion", "it('works', () => expect(true).toBe(true));", 0],
    [
      "test callback loop",
      "it('works', () => { for (const row of rows) expect(row).toBe(1); });",
      1,
    ],
    [
      "table definition loop",
      "for (const row of rows) it(row.name, () => expect(row).toBe(1));",
      1,
    ],
    [
      "named test callback loop",
      "function verifyRows() { for (const row of rows) expect(row).toBe(1); } it('works', verifyRows);",
      1,
    ],
    [
      "one-use loop helper",
      "function collect(rows) { for (const row of rows) consume(row); } it('works', () => collect(rows));",
      1,
    ],
    [
      "thin callback-forwarding helper",
      "function repeat(rows, action) { for (const row of rows) action(row); } it('works', () => repeat(rows, (row) => expect(row).toBe(1)));",
      1,
    ],
    [
      "callback-forwarding helper declared inside a test",
      "it('works', () => { function repeat(rows, action) { for (const row of rows) action(row); } repeat(rows, (row) => expect(row).toBe(1)); });",
      1,
    ],
    [
      "reused setup helper",
      "function collect(rows) { for (const row of rows) consume(row); } it('works', () => collect(rows)); it('also works', () => collect(moreRows));",
      0,
    ],
    [
      "same-named helpers in different lexical scopes",
      "function collect(rows) { for (const row of rows) consume(row); } it('outer', () => collect(rows)); it('nested', () => { function collect(value) { consume(value); } collect(value); });",
      1,
    ],
    [
      "uncalled nested helper loop",
      "it('works', () => { function collect(rows) { for (const row of rows) consume(row); } expect(ok).toBe(true); });",
      0,
    ],
    ["support helper loop", "function collect(rows) { for (const row of rows) consume(row); }", 0],
  ])("counts test loops in %s", (_name, source, expected) => {
    expect(checkTestOnly.countTestLoops("test/example.test.ts", source)).toBe(expected);
  });

  it("parses renamed and added files from a zero-delimited Git diff", () => {
    expect(diffTestOnly.parseChangedFiles("R100\0old.ts\0new.ts\0A\0added.ts\0")).toEqual([
      { filename: "new.ts", previous_filename: "old.ts", status: "renamed" },
      { filename: "added.ts", status: "added" },
    ]);
  });

  it("compares a main merge worktree with its MERGE_HEAD commit", () => {
    expect(diffTestOnly.selectLocalComparisonBase("branch-base", "main-head", true)).toBe(
      "main-head",
    );
  });

  it("keeps the branch merge base outside a main merge", () => {
    expect(diffTestOnly.selectLocalComparisonBase("branch-base", null, false)).toBe("branch-base");
    expect(diffTestOnly.selectLocalComparisonBase("branch-base", "topic-head", false)).toBe(
      "branch-base",
    );
  });

  it("accepts only conclusive Git ancestry probe results", () => {
    expect(diffTestOnly.parseAncestorProbe(0, undefined)).toBe(true);
    expect(diffTestOnly.parseAncestorProbe(1, undefined)).toBe(false);
    expect(() => diffTestOnly.parseAncestorProbe(128, undefined)).toThrow(
      "git merge-base --is-ancestor failed with status 128",
    );
    expect(() => diffTestOnly.parseAncestorProbe(null, new Error("spawn failed"))).toThrow(
      "spawn failed",
    );
  });
});
