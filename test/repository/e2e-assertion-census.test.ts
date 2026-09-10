// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  analyzeAssertionSource,
  budgetForE2eAssertionCensus,
  buildE2eAssertionCensus,
  evaluateE2eAssertionBudget,
  formatE2eAssertionBudget,
  formatE2eAssertionBudgetViolations,
  formatE2eAssertionCensus,
  parseE2eAssertionBudget,
  type E2eAssertionBudget,
  type E2eAssertionCensus,
} from "../../scripts/checks/e2e-assertion-census.mts";
import { describe, expect, test } from "../helpers/owned-test-resources";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const BUDGET_PATH = path.join(REPO_ROOT, "ci/e2e-assertion-budget.json");
const COMMENT =
  "SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.\n" +
  "SPDX-License-Identifier: Apache-2.0";

function writeSource(root: string, file: string, source: string): void {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

function emptyBudget(): E2eAssertionBudget {
  return {
    $comment: COMMENT,
    schemaVersion: 1,
    issue: 10934,
    epic: 10920,
    reference: {
      mainSha: "a".repeat(40),
      currentMainCollectedTests: 92,
      epicMainSha: "b".repeat(40),
      epicCollectedTests: 95,
      epicDirectExpectCalls: 2184,
      epicLiveExpectCalls: 2677,
    },
    limits: {
      testFileCount: 0,
      liveFileCount: 0,
      direct: analyzeAssertionSource("empty.ts", ""),
      unique: analyzeAssertionSource("empty.ts", ""),
      fileMetricOrder: [
        "directExpectCalls",
        "directAssertionPoints",
        "transitiveExpectCalls",
        "transitiveAssertionPoints",
        "transitiveGeneratedProbeBlocks",
      ],
      files: {},
    },
  };
}

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

function censusWith(
  census: E2eAssertionCensus,
  update: (copy: Mutable<E2eAssertionCensus>) => void,
): E2eAssertionCensus {
  const copy = structuredClone(census) as Mutable<E2eAssertionCensus>;
  update(copy);
  return copy;
}

describe("live E2E assertion census (#10934)", () => {
  test("counts assertion syntax and independently checked object fields", () => {
    const metrics = analyzeAssertionSource(
      "test/e2e/live/example.test.ts",
      `
        import assert from "node:assert/strict";
        expect(value).toBe(true);
        expect(value).toMatchObject({ first: 1, nested: { second: 2 } });
        assert(value);
        assert.strictEqual(actual, expected);
        expectReady(value);
        assertSafe(value);
        fail("product state failed");
        if (!value) throw new Error("product state failed");
      `,
    );

    expect(metrics).toMatchObject({
      expectCalls: 2,
      matcherAssertions: 2,
      nodeAssertions: 2,
      namedAssertionHelpers: 2,
      failCalls: 1,
      throwGuards: 1,
      objectFieldAssertions: 1,
      assertionPoints: 9,
      generatedProbeBlocks: 0,
      generatedProbeConditions: 0,
    });
  });

  test("counts named, aliased, namespace, and CommonJS Node assertion imports", () => {
    const metrics = analyzeAssertionSource(
      "test/e2e/live/example.test.ts",
      `
        import verify, { strictEqual as same } from "node:assert/strict";
        import { strict as strictCheck } from "node:assert";
        import * as check from "node:assert";
        const { deepEqual: equal } = require("assert");
        const requiredStrict = require("node:assert").strict;
        verify(value);
        same(actual, expected);
        strictCheck.ok(value);
        check.ok(value);
        equal(actual, expected);
        requiredStrict.deepEqual(actual, expected);
      `,
    );

    expect(metrics.nodeAssertions).toBe(6);
    expect(metrics.assertionPoints).toBe(6);
  });

  test("counts asymmetric expect factories without treating them as assertions", () => {
    const metrics = analyzeAssertionSource(
      "test/e2e/live/example.test.ts",
      "expect(value).toEqual(expect.objectContaining({ state: 'ready', nested: { id: 1 } }));",
    );

    expect(metrics.expectCalls).toBe(2);
    expect(metrics.matcherAssertions).toBe(1);
    expect(metrics.objectFieldAssertions).toBe(1);
    expect(metrics.assertionPoints).toBe(2);
  });

  test("ignores assertions in comments and reports generated probe blocks separately", () => {
    const metrics = analyzeAssertionSource(
      "test/e2e/live/example.test.ts",
      [
        "// expect(comment).toBe(true);",
        "/* assert(comment); */",
        'const ordinary = "expect(text).toBe(true)";',
        "const shellProbe = `set -eu",
        "test -f /sandbox/result",
        '[ "$status" = ready ] || exit 4`;',
      ].join("\n"),
    );

    expect(metrics.expectCalls).toBe(0);
    expect(metrics.matcherAssertions).toBe(0);
    expect(metrics.nodeAssertions).toBe(0);
    expect(metrics.generatedProbeBlocks).toBe(1);
    expect(metrics.generatedProbeConditions).toBe(2);
  });

  test("reports direct, transitive, shared, and cyclic live companion assertions", ({
    resources,
  }) => {
    const root = resources.temporaryDirectory("nemoclaw-e2e-assertion-census-");
    writeSource(
      root,
      "test/e2e/live/first.test.ts",
      'import "./first-helper";\nexpect(first).toBe(true);\n',
    );
    writeSource(
      root,
      "test/e2e/live/second.test.ts",
      'import "./shared";\nexpect(second).toBe(true);\n',
    );
    writeSource(
      root,
      "test/e2e/live/first-helper.ts",
      'import "./shared";\nexpectHelper(first);\n',
    );
    writeSource(
      root,
      "test/e2e/live/shared.ts",
      'import "./first-helper";\nexpect(shared).toBe(true);\nthrow new Error("must not execute");\n',
    );

    const census = buildE2eAssertionCensus(root);
    const first = census.files.find(({ file }) => file.endsWith("first.test.ts"));
    const second = census.files.find(({ file }) => file.endsWith("second.test.ts"));

    expect(census).toMatchObject({ testFileCount: 2, liveFileCount: 4 });
    expect(first?.companions).toEqual(["test/e2e/live/first-helper.ts", "test/e2e/live/shared.ts"]);
    expect(first?.direct.expectCalls).toBe(1);
    expect(first?.transitive.expectCalls).toBe(2);
    expect(first?.transitive.namedAssertionHelpers).toBe(1);
    expect(second?.companions).toEqual([
      "test/e2e/live/first-helper.ts",
      "test/e2e/live/shared.ts",
    ]);
    expect(census.unique.expectCalls).toBe(3);
    expect(census.unique.namedAssertionHelpers).toBe(1);
    expect(census.unique.throwGuards).toBe(1);
  });

  test("fails closed on malformed source and unresolved live imports", ({ resources }) => {
    expect(() => analyzeAssertionSource("broken.ts", "expect(value).toBe(true")).toThrow(
      /broken\.ts:1/u,
    );

    const root = resources.temporaryDirectory("nemoclaw-e2e-assertion-import-");
    writeSource(root, "test/e2e/live/example.test.ts", 'import "./missing";\n');
    expect(() => buildE2eAssertionCensus(root)).toThrow(/Unresolved live E2E companion import/u);
  });

  test("ignores an existing non-source local import", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-e2e-assertion-non-source-import-");
    writeSource(root, "test/e2e/live/example.test.ts", 'import data from "./fixture.json";\n');
    writeSource(root, "test/e2e/live/fixture.json", '{"value":true}\n');

    expect(buildE2eAssertionCensus(root)).toMatchObject({
      testFileCount: 1,
      liveFileCount: 1,
      files: [{ companions: [] }],
    });
  });

  test("fails closed on a symlinked live source", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-e2e-assertion-symlink-");
    writeSource(root, "outside.ts", "export {};\n");
    const liveRoot = path.join(root, "test/e2e/live");
    fs.mkdirSync(liveRoot, { recursive: true });
    fs.symlinkSync(path.join(root, "outside.ts"), path.join(liveRoot, "linked.test.ts"));

    expect(() => buildE2eAssertionCensus(root)).toThrow(/must not be a symlink/u);
  });

  test("accepts the current budget and requires every reduction to lower it", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-e2e-assertion-budget-");
    writeSource(
      root,
      "test/e2e/live/example.test.ts",
      "expect(first).toBe(true);\nexpect(second).toBe(true);\n",
    );
    const census = buildE2eAssertionCensus(root);
    const budget = budgetForE2eAssertionCensus(emptyBudget(), census);
    expect(evaluateE2eAssertionBudget(census, budget)).toEqual([]);

    const reduced = censusWith(census, (copy) => {
      copy.direct.expectCalls -= 1;
      copy.unique.expectCalls -= 1;
      copy.files[0]!.direct.expectCalls -= 1;
      copy.files[0]!.transitive.expectCalls -= 1;
    });
    expect(evaluateE2eAssertionBudget(reduced, budget)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stale-budget",
          metric: "expectCalls",
        }),
      ]),
    );
  });

  test("rejects assertion growth, missing budgets, and removed files", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-e2e-assertion-growth-");
    writeSource(root, "test/e2e/live/example.test.ts", "expect(first).toBe(true);\n");
    const census = buildE2eAssertionCensus(root);
    const budget = budgetForE2eAssertionCensus(emptyBudget(), census);
    const grown = censusWith(census, (copy) => {
      copy.direct.expectCalls += 1;
      copy.unique.expectCalls += 1;
      copy.files[0]!.direct.expectCalls += 1;
      copy.files[0]!.transitive.expectCalls += 1;
    });
    expect(evaluateE2eAssertionBudget(grown, budget)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "growth", metric: "expectCalls" })]),
    );

    const noFileBudget: E2eAssertionBudget = {
      ...budget,
      limits: { ...budget.limits, files: {} },
    };
    expect(evaluateE2eAssertionBudget(census, noFileBudget)).toContainEqual(
      expect.objectContaining({ kind: "missing-budget", file: census.files[0]!.file }),
    );

    const removed = censusWith(census, (copy) => {
      copy.files = [];
      copy.testFileCount = 0;
      copy.liveFileCount = 0;
      copy.direct = analyzeAssertionSource("empty.ts", "");
      copy.unique = analyzeAssertionSource("empty.ts", "");
    });
    expect(evaluateE2eAssertionBudget(removed, budget)).toContainEqual(
      expect.objectContaining({ kind: "removed-file", file: census.files[0]!.file }),
    );
  });

  test("parses exact budget metadata and rejects incomplete metric objects", () => {
    const source = JSON.stringify(emptyBudget());
    expect(parseE2eAssertionBudget(source)).toEqual(emptyBudget());

    const incomplete = structuredClone(emptyBudget()) as unknown as {
      limits: { direct: Record<string, unknown> };
    };
    delete incomplete.limits.direct.expectCalls;
    expect(() => parseE2eAssertionBudget(JSON.stringify(incomplete))).toThrow(
      /complete assertion metric set/u,
    );
  });

  test("formats the census and actionable ratchet failures", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-e2e-assertion-format-");
    writeSource(root, "test/e2e/live/example.test.ts", "expect(first).toBe(true);\n");
    const census = buildE2eAssertionCensus(root);
    const budget = budgetForE2eAssertionCensus(emptyBudget(), census);
    const grown = censusWith(census, (copy) => {
      copy.files[0]!.direct.expectCalls += 1;
    });
    const violations = evaluateE2eAssertionBudget(grown, budget);

    expect(formatE2eAssertionCensus(census)).toContain("test/e2e/live/example.test.ts | 1 | 1");
    expect(formatE2eAssertionBudgetViolations(violations)).toContain(
      "test/e2e/live/example.test.ts direct.expectCalls: current 2; baseline 1; delta +1 (growth)",
    );
    const serializedBudget = formatE2eAssertionBudget(budget);
    expect(serializedBudget).toContain('"test/e2e/live/example.test.ts": [1,1,1,1,0]');
  });

  test("keeps the checked-in current-main census synchronized", () => {
    const census = buildE2eAssertionCensus(REPO_ROOT);
    const budget = parseE2eAssertionBudget(fs.readFileSync(BUDGET_PATH, "utf8"));
    expect(evaluateE2eAssertionBudget(census, budget)).toEqual([]);
  });
});
