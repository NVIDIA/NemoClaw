// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Trusted policy evaluator: a changed test file must not increase its test-loop
// count. The workflow reads pull-request blobs as data and parses them with the
// TypeScript AST. It never executes pull-request code.

import { scanTextForTestLoops } from "../../scripts/growth-guardrails/find-test-loops.mts";
import {
  assertRepositoryName,
  type BlobMap,
  createPrBlobClient,
  type PrBlobClient,
} from "./pr-blob-client.mts";

const TEST_FILE_RE = /^(test|src|nemoclaw\/src)\/.*\.(test|spec)\.(?:[cm]?[jt]s)$/;

export function countTestLoops(file: string, text: string): number {
  return scanTextForTestLoops(file, text).length;
}

function countText(file: string, text: string | null | undefined): number {
  return text == null ? 0 : countTestLoops(file, text);
}

export type LoopChange = {
  readonly basePath: string;
  readonly headPath: string | null;
  readonly displayName: string;
};

export type LoopEvaluation = {
  readonly details: string[];
  readonly baseTotal: number;
  readonly headTotal: number;
};

export function evaluateLoopViolations(
  changes: readonly LoopChange[],
  baseBlobs: BlobMap,
  headBlobs: BlobMap,
): LoopEvaluation {
  const details: string[] = [];
  let baseTotal = 0;
  let headTotal = 0;

  for (const change of changes) {
    const baseCount = countText(change.basePath, baseBlobs.get(change.basePath) ?? null);
    const headCount =
      change.headPath === null
        ? 0
        : countText(change.headPath, headBlobs.get(change.headPath) ?? null);
    baseTotal += baseCount;
    headTotal += headCount;
    if (headCount > baseCount) {
      details.push(
        `${change.headPath ?? change.displayName}: ${headCount} test loop(s), up from ${baseCount}`,
      );
    }
  }

  return { details, baseTotal, headTotal };
}

export type LoopEnv = {
  readonly BASE_SHA: string;
  readonly HEAD_REPO: string;
  readonly HEAD_SHA: string;
  readonly PR_NUMBER: string;
  readonly REPO: string;
};

export type LoopResult = LoopEvaluation & { readonly ok: boolean };

export async function runTestLoops(client: PrBlobClient, env: LoopEnv): Promise<LoopResult> {
  assertRepositoryName(env.REPO, "REPO");
  assertRepositoryName(env.HEAD_REPO, "HEAD_REPO");

  const files = await client.getPullFiles(env.REPO, env.PR_NUMBER);
  const changedTests = files.filter(
    ({ filename, previous_filename }) =>
      TEST_FILE_RE.test(filename) || TEST_FILE_RE.test(previous_filename ?? ""),
  );

  const changes: LoopChange[] = changedTests.map((file) => {
    const basePath = TEST_FILE_RE.test(file.previous_filename ?? "")
      ? (file.previous_filename as string)
      : file.filename;
    const headPath =
      file.status === "removed" || !TEST_FILE_RE.test(file.filename) ? null : file.filename;
    return { basePath, headPath, displayName: file.filename };
  });

  const basePaths = [...new Set(changes.map((change) => change.basePath))];
  const headPaths = [
    ...new Set(changes.map((change) => change.headPath).filter((p): p is string => p !== null)),
  ];

  const [baseBlobs, headBlobs] = await Promise.all([
    client.fetchBlobs(env.REPO, env.BASE_SHA, basePaths),
    client.fetchBlobs(env.HEAD_REPO, env.HEAD_SHA, headPaths),
  ]);

  const evaluation = evaluateLoopViolations(changes, baseBlobs, headBlobs);
  return { ...evaluation, ok: evaluation.details.length === 0 };
}

function readEnv(): LoopEnv & { GH_TOKEN: string } {
  const { BASE_SHA, GH_TOKEN, HEAD_REPO, HEAD_SHA, PR_NUMBER, REPO } = process.env;
  if (!BASE_SHA || !GH_TOKEN || !HEAD_REPO || !HEAD_SHA || !PR_NUMBER || !REPO) {
    throw new Error(
      "Missing required environment: BASE_SHA GH_TOKEN HEAD_REPO HEAD_SHA PR_NUMBER REPO",
    );
  }
  return { BASE_SHA, GH_TOKEN, HEAD_REPO, HEAD_SHA, PR_NUMBER, REPO };
}

async function main(): Promise<void> {
  const env = readEnv();
  const client = createPrBlobClient({ token: env.GH_TOKEN });
  const result = await runTestLoops(client, env);
  if (!result.ok) {
    console.error("FAIL: changed test files increase test-loop counts.");
    console.error(
      `Across all changed test files: ${result.headTotal} test loop(s) at the latest PR commit vs ${result.baseTotal} at base.`,
    );
    console.error("");
    console.error(
      "Keep test callbacks linear. Move iteration needed for one behavior into a named helper outside the test callback. Use it.each or test.each when loop rows are independent cases.",
    );
    console.error("");
    console.error("Files with increased test loop counts:");
    for (const detail of result.details) console.error(`- ${detail}`);
    console.error("");
    console.error("Run locally: npm run test-loops:scan -- --top 25");
    process.exit(1);
  }
  console.log(
    `PASS: no changed test file increased its test-loop count (${result.headTotal} total at the latest PR commit vs ${result.baseTotal} at base).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
