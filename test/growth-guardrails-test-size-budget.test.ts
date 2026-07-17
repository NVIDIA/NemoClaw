// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { PrBlobClient, PullRequestFile } from "../tools/growth-guardrails/pr-blob-client.mts";
import {
  evaluateTestSizeBudgetViolations,
  runTestSizeBudget,
} from "../tools/growth-guardrails/test-size-budget.mts";

function blobs(entries: Record<string, string | null>): Map<string, string | null> {
  return new Map(Object.entries(entries));
}

function linesOf(count: number): string {
  return "x\n".repeat(count);
}

type BlobFetchCall = {
  readonly repo: string;
  readonly oid: string;
  readonly paths: readonly string[];
};

/** Fake client: resolves blobs from a (repo\0oid\0path) table, no network. */
function fakeClient(
  pullFiles: PullRequestFile[],
  table: Record<string, string | null>,
  fetchCalls: BlobFetchCall[] = [],
): PrBlobClient {
  return {
    getPullFiles: async () => pullFiles,
    fetchBlobs: async (repo, oid, paths) => {
      fetchCalls.push({ repo, oid, paths: [...paths] });
      const map = new Map<string, string | null>();
      for (const path of paths) map.set(path, table[`${repo} ${oid} ${path}`] ?? null);
      return map;
    },
  };
}

const CLEAN_BUDGET = { defaultMaxLines: 1500, legacyMaxLines: {} } as const;
const NO_RENAMES: ReadonlyMap<string, string> = new Map();

describe("growth-guardrails test-size-budget: pure policy", () => {
  it("passes when nothing changed and no test files are touched", () => {
    expect(
      evaluateTestSizeBudgetViolations({
        baseBudget: CLEAN_BUDGET,
        headBudget: CLEAN_BUDGET,
        renames: NO_RENAMES,
        headBlobs: blobs({}),
        changedTests: [],
      }),
    ).toEqual([]);
  });

  it.each([
    [
      "defaultMaxLines increase",
      { defaultMaxLines: 1600, legacyMaxLines: {} },
      /defaultMaxLines increased from 1500 to 1600/,
    ],
    [
      "legacy budget increase",
      { defaultMaxLines: 1500, legacyMaxLines: { "test/a.test.ts": 2000 } },
      /test\/a\.test\.ts legacy budget increased from 1800 to 2000/,
    ],
  ])("flags a weakened budget: %s", (_label, headBudget, pattern) => {
    const violations = evaluateTestSizeBudgetViolations({
      baseBudget: { defaultMaxLines: 1500, legacyMaxLines: { "test/a.test.ts": 1800 } },
      headBudget,
      renames: NO_RENAMES,
      headBlobs: blobs({ "test/a.test.ts": linesOf(1700) }),
      changedTests: [],
    });
    expect(violations.join("\n")).toMatch(pattern);
  });

  it("flags a new legacy budget above the default", () => {
    const violations = evaluateTestSizeBudgetViolations({
      baseBudget: CLEAN_BUDGET,
      headBudget: { defaultMaxLines: 1500, legacyMaxLines: { "test/new.test.ts": 1900 } },
      renames: NO_RENAMES,
      headBlobs: blobs({ "test/new.test.ts": linesOf(1850) }),
      changedTests: [],
    });
    expect(violations.join("\n")).toMatch(
      /adds a new legacy budget \(1900\) above defaultMaxLines \(1500\)/,
    );
  });

  it("flags a legacy entry whose file shrank below its budget", () => {
    const violations = evaluateTestSizeBudgetViolations({
      baseBudget: { defaultMaxLines: 1500, legacyMaxLines: { "test/a.test.ts": 1800 } },
      headBudget: { defaultMaxLines: 1500, legacyMaxLines: { "test/a.test.ts": 1800 } },
      renames: NO_RENAMES,
      headBlobs: blobs({ "test/a.test.ts": linesOf(1600) }),
      changedTests: [],
    });
    expect(violations.join("\n")).toMatch(
      /1600 line\(s\) < 1800 legacy budget; lower the budget entry/,
    );
  });

  it("flags removing a legacy budget while the file still exceeds the default", () => {
    const violations = evaluateTestSizeBudgetViolations({
      baseBudget: { defaultMaxLines: 1500, legacyMaxLines: { "test/a.test.ts": 1800 } },
      headBudget: CLEAN_BUDGET,
      renames: NO_RENAMES,
      headBlobs: blobs({ "test/a.test.ts": linesOf(1700) }),
      changedTests: [],
    });
    expect(violations.join("\n")).toMatch(
      /removed its legacy budget while still exceeding defaultMaxLines/,
    );
  });

  it("flags a changed test file over the default budget", () => {
    const violations = evaluateTestSizeBudgetViolations({
      baseBudget: CLEAN_BUDGET,
      headBudget: CLEAN_BUDGET,
      renames: NO_RENAMES,
      headBlobs: blobs({ "test/big.test.ts": linesOf(1501) }),
      changedTests: ["test/big.test.ts"],
    });
    expect(violations).toEqual(["test/big.test.ts: 1501 line(s) > 1500"]);
  });

  it("enforces default monotonicity against the fallback baseline", () => {
    const violations = evaluateTestSizeBudgetViolations({
      baseBudget: CLEAN_BUDGET,
      headBudget: { defaultMaxLines: 99999, legacyMaxLines: {} },
      renames: NO_RENAMES,
      headBlobs: blobs({ "test/ok.test.ts": linesOf(10) }),
      changedTests: ["test/ok.test.ts"],
    });
    expect(violations.join("\n")).toMatch(/defaultMaxLines increased from 1500 to 99999/);
  });

  it("carries a legacy allowance across a rename without flagging it as new", () => {
    const renames = new Map([["test/new.test.ts", "test/old.test.ts"]]);
    const violations = evaluateTestSizeBudgetViolations({
      baseBudget: { defaultMaxLines: 1500, legacyMaxLines: { "test/old.test.ts": 1800 } },
      headBudget: { defaultMaxLines: 1500, legacyMaxLines: { "test/new.test.ts": 1800 } },
      renames,
      headBlobs: blobs({ "test/new.test.ts": linesOf(1800) }),
      changedTests: [],
    });
    expect(violations).toEqual([]);
  });

  it("throws when a changed test file is missing at the PR head", () => {
    expect(() =>
      evaluateTestSizeBudgetViolations({
        baseBudget: CLEAN_BUDGET,
        headBudget: CLEAN_BUDGET,
        renames: NO_RENAMES,
        headBlobs: blobs({}),
        changedTests: ["test/missing.test.ts"],
      }),
    ).toThrow(/Changed test file test\/missing\.test\.ts was not found/);
  });
});

describe("growth-guardrails test-size-budget: orchestration", () => {
  const ENV = {
    BASE_SHA: "base",
    HEAD_REPO: "fork/repo",
    HEAD_SHA: "head",
    PR_NUMBER: "1",
    REPO: "NVIDIA/NemoClaw",
  } as const;

  it("fetches the changed budget at head and reports a weakened default", async () => {
    const client = fakeClient(
      [
        { filename: "ci/test-file-size-budget.json", status: "modified" },
        { filename: "test/foo.test.ts", status: "modified" },
      ],
      {
        "NVIDIA/NemoClaw base ci/test-file-size-budget.json":
          '{"defaultMaxLines":1500,"legacyMaxLines":{}}',
        "fork/repo head ci/test-file-size-budget.json":
          '{"defaultMaxLines":1600,"legacyMaxLines":{}}',
        "fork/repo head test/foo.test.ts": linesOf(10),
      },
    );
    const result = await runTestSizeBudget(client, ENV);
    expect(result.ok).toBe(false);
    expect(result.changedTestCount).toBe(1);
    expect(result.violations.join("\n")).toMatch(/defaultMaxLines increased from 1500 to 1600/);
  });

  it("passes a clean PR with an unchanged budget", async () => {
    const client = fakeClient([{ filename: "test/foo.test.ts", status: "modified" }], {
      "NVIDIA/NemoClaw base ci/test-file-size-budget.json":
        '{"defaultMaxLines":1500,"legacyMaxLines":{}}',
      "fork/repo head test/foo.test.ts": linesOf(20),
    });
    const result = await runTestSizeBudget(client, ENV);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fetches the base budget and ordinary head tests in two exact batches", async () => {
    const fetchCalls: BlobFetchCall[] = [];
    const client = fakeClient(
      [
        { filename: "test/a.test.ts", status: "modified" },
        { filename: "test/b.test.ts", status: "modified" },
      ],
      {
        "NVIDIA/NemoClaw base ci/test-file-size-budget.json":
          '{"defaultMaxLines":1500,"legacyMaxLines":{}}',
        "fork/repo head test/a.test.ts": linesOf(20),
        "fork/repo head test/b.test.ts": linesOf(30),
      },
      fetchCalls,
    );

    const result = await runTestSizeBudget(client, ENV);

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual([
      {
        repo: "NVIDIA/NemoClaw",
        oid: "base",
        paths: ["ci/test-file-size-budget.json"],
      },
      {
        repo: "fork/repo",
        oid: "head",
        paths: ["test/a.test.ts", "test/b.test.ts"],
      },
    ]);
  });

  it("enforces the fallback baseline when the base budget file is absent", async () => {
    const client = fakeClient([{ filename: "ci/test-file-size-budget.json", status: "added" }], {
      "fork/repo head ci/test-file-size-budget.json":
        '{"defaultMaxLines":2000,"legacyMaxLines":{}}',
    });
    const result = await runTestSizeBudget(client, ENV);
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/defaultMaxLines increased from 1500 to 2000/);
  });

  it("passes an unchanged legacy test renamed with its budget key", async () => {
    const client = fakeClient(
      [
        { filename: "ci/test-file-size-budget.json", status: "modified" },
        { filename: "test/new.test.ts", previous_filename: "test/old.test.ts", status: "renamed" },
      ],
      {
        "NVIDIA/NemoClaw base ci/test-file-size-budget.json":
          '{"defaultMaxLines":1500,"legacyMaxLines":{"test/old.test.ts":1800}}',
        "fork/repo head ci/test-file-size-budget.json":
          '{"defaultMaxLines":1500,"legacyMaxLines":{"test/new.test.ts":1800}}',
        "fork/repo head test/new.test.ts": linesOf(1800),
      },
    );
    const result = await runTestSizeBudget(client, ENV);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
