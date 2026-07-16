// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { scanTextForTestConditionals } from "../scripts/find-test-conditionals.mts";
import type { PrBlobClient, PullRequestFile } from "../tools/growth-guardrails/pr-blob-client.mts";
import {
  type ConditionalChange,
  countIfStatements,
  evaluateConditionalViolations,
  runTestConditionals,
} from "../tools/growth-guardrails/test-conditionals.mts";

// Fixtures are string literals (test data), so they do not add real `if`
// statements to this file under the very policy it exercises.
const NO_IF = "it('a', () => { expect(1).toBe(1); });";
const ONE_IF = "it('a', () => { if (cond) { expect(1).toBe(1); } });";
const TWO_IF = "it('a', () => { if (a) { expect(1).toBe(1); } if (b) { expect(2).toBe(2); } });";

function blobs(entries: Record<string, string | null>): Map<string, string | null> {
  return new Map(Object.entries(entries));
}

type BlobFetchCall = {
  readonly repo: string;
  readonly oid: string;
  readonly paths: readonly string[];
};

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

describe("growth-guardrails test-conditionals: AST parity", () => {
  it.each([
    ["no if", NO_IF, 0],
    ["one if", ONE_IF, 1],
    ["two ifs", TWO_IF, 2],
  ])("countIfStatements matches the shared AST scanner: %s", (_label, source, expected) => {
    expect(countIfStatements("test/x.test.ts", source)).toBe(expected);
    expect(countIfStatements("test/x.test.ts", source)).toBe(
      scanTextForTestConditionals("test/x.test.ts", source).length,
    );
  });
});

describe("growth-guardrails test-conditionals: pure policy", () => {
  const same = (path: string): ConditionalChange => ({
    basePath: path,
    headPath: path,
    displayName: path,
  });

  it("flags a test file that adds an if statement", () => {
    const result = evaluateConditionalViolations(
      [same("test/a.test.ts")],
      blobs({ "test/a.test.ts": NO_IF }),
      blobs({ "test/a.test.ts": ONE_IF }),
    );
    expect(result.details).toEqual(["test/a.test.ts: 1 if statement(s), up from 0"]);
    expect([result.baseTotal, result.headTotal]).toEqual([0, 1]);
  });

  it("passes a test file that removes if statements", () => {
    const result = evaluateConditionalViolations(
      [same("test/a.test.ts")],
      blobs({ "test/a.test.ts": TWO_IF }),
      blobs({ "test/a.test.ts": ONE_IF }),
    );
    expect(result.details).toEqual([]);
    expect([result.baseTotal, result.headTotal]).toEqual([2, 1]);
  });

  it("compares across a rename using the previous path at base", () => {
    const result = evaluateConditionalViolations(
      [
        {
          basePath: "test/old.test.ts",
          headPath: "test/new.test.ts",
          displayName: "test/new.test.ts",
        },
      ],
      blobs({ "test/old.test.ts": ONE_IF }),
      blobs({ "test/new.test.ts": ONE_IF }),
    );
    expect(result.details).toEqual([]);
  });

  it("flags a per-file increase even when another changed test removes an if", () => {
    const result = evaluateConditionalViolations(
      [same("test/adder.test.ts"), same("test/remover.test.ts")],
      blobs({ "test/adder.test.ts": NO_IF, "test/remover.test.ts": TWO_IF }),
      blobs({ "test/adder.test.ts": ONE_IF, "test/remover.test.ts": NO_IF }),
    );
    expect(result.details).toEqual(["test/adder.test.ts: 1 if statement(s), up from 0"]);
    expect([result.baseTotal, result.headTotal]).toEqual([2, 1]);
  });

  it("counts a removed test file as zero at head", () => {
    const result = evaluateConditionalViolations(
      [{ basePath: "test/gone.test.ts", headPath: null, displayName: "test/gone.test.ts" }],
      blobs({ "test/gone.test.ts": TWO_IF }),
      blobs({}),
    );
    expect(result.details).toEqual([]);
    expect([result.baseTotal, result.headTotal]).toEqual([2, 0]);
  });
});

describe("growth-guardrails test-conditionals: orchestration", () => {
  const ENV = {
    BASE_SHA: "base",
    HEAD_REPO: "fork/repo",
    HEAD_SHA: "head",
    PR_NUMBER: "1",
    REPO: "NVIDIA/NemoClaw",
  } as const;

  it("fails a PR whose changed test adds an if statement", async () => {
    const client = fakeClient([{ filename: "test/a.test.ts", status: "modified" }], {
      "NVIDIA/NemoClaw base test/a.test.ts": NO_IF,
      "fork/repo head test/a.test.ts": ONE_IF,
    });
    const result = await runTestConditionals(client, ENV);
    expect(result.ok).toBe(false);
    expect(result.details).toEqual(["test/a.test.ts: 1 if statement(s), up from 0"]);
  });

  it("ignores non-test changed files", async () => {
    const client = fakeClient([{ filename: "src/lib/foo.ts", status: "modified" }], {});
    const result = await runTestConditionals(client, ENV);
    expect(result.ok).toBe(true);
    expect([result.baseTotal, result.headTotal]).toEqual([0, 0]);
  });

  it("batches deduplicated ordinary test paths once per revision", async () => {
    const fetchCalls: BlobFetchCall[] = [];
    const client = fakeClient(
      [
        { filename: "test/a.test.ts", status: "modified" },
        { filename: "test/b.test.ts", status: "modified" },
        { filename: "test/a.test.ts", status: "modified" },
      ],
      {
        "NVIDIA/NemoClaw base test/a.test.ts": NO_IF,
        "NVIDIA/NemoClaw base test/b.test.ts": NO_IF,
        "fork/repo head test/a.test.ts": NO_IF,
        "fork/repo head test/b.test.ts": NO_IF,
      },
      fetchCalls,
    );

    const result = await runTestConditionals(client, ENV);

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual([
      {
        repo: "NVIDIA/NemoClaw",
        oid: "base",
        paths: ["test/a.test.ts", "test/b.test.ts"],
      },
      {
        repo: "fork/repo",
        oid: "head",
        paths: ["test/a.test.ts", "test/b.test.ts"],
      },
    ]);
  });
});
