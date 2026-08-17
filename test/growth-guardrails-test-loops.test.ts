// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { scanTextForTestLoops } from "../scripts/growth-guardrails/find-test-loops.mts";
import type { PrBlobClient, PullRequestFile } from "../tools/growth-guardrails/pr-blob-client.mts";
import {
  countTestLoops,
  evaluateLoopViolations,
  type LoopChange,
  runTestLoops,
} from "../tools/growth-guardrails/test-loops.mts";

const NO_LOOP = "it('a', () => { expect(1).toBe(1); });";
const ONE_LOOP = "it('a', () => { for (const row of rows) expect(row).toBeDefined(); });";
const TWO_LOOPS =
  "it('a', () => { for (const row of rows) consume(row); for (const item of items) consume(item); });";

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
      return new Map(paths.map((path) => [path, table[`${repo} ${oid} ${path}`] ?? null]));
    },
  };
}

describe("growth-guardrails test-loops: AST parity", () => {
  it.each([
    ["no loops", NO_LOOP, 0],
    ["one loop", ONE_LOOP, 1],
    ["two loops", TWO_LOOPS, 2],
  ])("countTestLoops matches the shared AST scanner: %s", (_label, source, expected) => {
    expect(countTestLoops("test/x.test.ts", source)).toBe(expected);
    expect(countTestLoops("test/x.test.ts", source)).toBe(
      scanTextForTestLoops("test/x.test.ts", source).length,
    );
  });
});

describe("growth-guardrails test-loops: pure policy", () => {
  const same = (path: string): LoopChange => ({
    basePath: path,
    headPath: path,
    displayName: path,
  });

  it("flags a test file that adds a test loop", () => {
    const result = evaluateLoopViolations(
      [same("test/a.test.ts")],
      blobs({ "test/a.test.ts": NO_LOOP }),
      blobs({ "test/a.test.ts": ONE_LOOP }),
    );
    expect(result.details).toEqual(["test/a.test.ts: 1 test loop(s), up from 0"]);
    expect([result.baseTotal, result.headTotal]).toEqual([0, 1]);
  });

  it("passes a test file that removes test loops", () => {
    const result = evaluateLoopViolations(
      [same("test/a.test.ts")],
      blobs({ "test/a.test.ts": TWO_LOOPS }),
      blobs({ "test/a.test.ts": ONE_LOOP }),
    );
    expect(result.details).toEqual([]);
    expect([result.baseTotal, result.headTotal]).toEqual([2, 1]);
  });

  it("compares a renamed test with its previous path", () => {
    const result = evaluateLoopViolations(
      [
        {
          basePath: "test/old.test.ts",
          headPath: "test/new.test.ts",
          displayName: "test/new.test.ts",
        },
      ],
      blobs({ "test/old.test.ts": ONE_LOOP }),
      blobs({ "test/new.test.ts": ONE_LOOP }),
    );
    expect(result.details).toEqual([]);
  });

  it("flags a per-file increase when another test file removes loops", () => {
    const result = evaluateLoopViolations(
      [same("test/adder.test.ts"), same("test/remover.test.ts")],
      blobs({ "test/adder.test.ts": NO_LOOP, "test/remover.test.ts": TWO_LOOPS }),
      blobs({ "test/adder.test.ts": ONE_LOOP, "test/remover.test.ts": NO_LOOP }),
    );
    expect(result.details).toEqual([
      "test/adder.test.ts: 1 test loop(s), up from 0",
    ]);
    expect([result.baseTotal, result.headTotal]).toEqual([2, 1]);
  });

  it("counts a removed test file as zero at the latest PR commit", () => {
    const result = evaluateLoopViolations(
      [{ basePath: "test/gone.test.ts", headPath: null, displayName: "test/gone.test.ts" }],
      blobs({ "test/gone.test.ts": TWO_LOOPS }),
      blobs({}),
    );
    expect(result.details).toEqual([]);
    expect([result.baseTotal, result.headTotal]).toEqual([2, 0]);
  });
});

describe("growth-guardrails test-loops: orchestration", () => {
  const ENV = {
    BASE_SHA: "base",
    HEAD_REPO: "fork/repo",
    HEAD_SHA: "head",
    PR_NUMBER: "1",
    REPO: "NVIDIA/NemoClaw",
  } as const;

  it("fails a PR whose changed test adds a test loop", async () => {
    const client = fakeClient([{ filename: "test/a.test.ts", status: "modified" }], {
      "NVIDIA/NemoClaw base test/a.test.ts": NO_LOOP,
      "fork/repo head test/a.test.ts": ONE_LOOP,
    });
    const result = await runTestLoops(client, ENV);
    expect(result.ok).toBe(false);
    expect(result.details).toEqual(["test/a.test.ts: 1 test loop(s), up from 0"]);
  });

  it("ignores changed source files that are not tests", async () => {
    const client = fakeClient([{ filename: "src/lib/foo.ts", status: "modified" }], {});
    const result = await runTestLoops(client, ENV);
    expect(result.ok).toBe(true);
    expect([result.baseTotal, result.headTotal]).toEqual([0, 0]);
  });

  it("fetches each changed test path once per revision", async () => {
    const fetchCalls: BlobFetchCall[] = [];
    const client = fakeClient(
      [
        { filename: "test/a.test.ts", status: "modified" },
        { filename: "test/b.test.ts", status: "modified" },
        { filename: "test/a.test.ts", status: "modified" },
      ],
      {
        "NVIDIA/NemoClaw base test/a.test.ts": NO_LOOP,
        "NVIDIA/NemoClaw base test/b.test.ts": NO_LOOP,
        "fork/repo head test/a.test.ts": NO_LOOP,
        "fork/repo head test/b.test.ts": NO_LOOP,
      },
      fetchCalls,
    );

    const result = await runTestLoops(client, ENV);

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
