// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Trusted policy evaluator: a changed test file may not add `if` statements to
// its body. Runs from the base checkout under pull_request_target and reads PR
// blobs as DATA only — blob text is PARSED with the TypeScript AST, never
// executed.
//
// The `if`-statement count reuses scanTextForTestConditionals from the local
// scanner (scripts/find-test-conditionals.mts) so the workflow and
// `npm run test-conditionals:scan` agree by construction. No second lexer lives
// in workflow YAML.

import { scanTextForTestConditionals } from "../../scripts/find-test-conditionals.mts";
import {
  assertRepositoryName,
  type BlobMap,
  createPrBlobClient,
  type PrBlobClient,
} from "./pr-blob-client.mts";

const TEST_FILE_RE = /^(test|src|nemoclaw\/src)\/.*\.(test|spec)\.(?:[cm]?[jt]s)$/;

/** Count `if` statements in test source using the shared TypeScript AST scanner. */
export function countIfStatements(file: string, text: string): number {
  return scanTextForTestConditionals(file, text).length;
}

function countText(file: string, text: string | null | undefined): number {
  return text == null ? 0 : countIfStatements(file, text);
}

export type ConditionalChange = {
  /** Path to read at the base revision (previous name on a rename). */
  readonly basePath: string;
  /** Path to read at the head revision, or null when removed/renamed-away. */
  readonly headPath: string | null;
  /** Path used in violation output. */
  readonly displayName: string;
};

export type ConditionalEvaluation = {
  readonly details: string[];
  readonly baseTotal: number;
  readonly headTotal: number;
};

/** Pure policy: compare base vs head `if` counts per changed test file. */
export function evaluateConditionalViolations(
  changes: readonly ConditionalChange[],
  baseBlobs: BlobMap,
  headBlobs: BlobMap,
): ConditionalEvaluation {
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
        `${change.headPath ?? change.displayName}: ${headCount} if statement(s), up from ${baseCount}`,
      );
    }
  }

  return { details, baseTotal, headTotal };
}

export type ConditionalEnv = {
  readonly BASE_SHA: string;
  readonly HEAD_REPO: string;
  readonly HEAD_SHA: string;
  readonly PR_NUMBER: string;
  readonly REPO: string;
};

export type ConditionalResult = ConditionalEvaluation & { readonly ok: boolean };

/** Orchestrates fetch + evaluate. The client is injectable for tests. */
export async function runTestConditionals(
  client: PrBlobClient,
  env: ConditionalEnv,
): Promise<ConditionalResult> {
  assertRepositoryName(env.REPO, "REPO");
  assertRepositoryName(env.HEAD_REPO, "HEAD_REPO");

  const files = await client.getPullFiles(env.REPO, env.PR_NUMBER);
  const changedTests = files.filter(
    ({ filename, previous_filename }) =>
      TEST_FILE_RE.test(filename) || TEST_FILE_RE.test(previous_filename ?? ""),
  );

  const changes: ConditionalChange[] = changedTests.map((file) => {
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

  const evaluation = evaluateConditionalViolations(changes, baseBlobs, headBlobs);
  return { ...evaluation, ok: evaluation.details.length === 0 };
}

function readEnv(): ConditionalEnv & { GH_TOKEN: string } {
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
  const result = await runTestConditionals(client, env);
  if (!result.ok) {
    console.error("FAIL: changed test files add if statements.");
    console.error(
      `Changed test files contain ${result.headTotal} if statement(s) at PR head vs ${result.baseTotal} at base.`,
    );
    console.error("");
    console.error(
      "Test bodies should stay linear. Split conditional behavior into separate test cases, use it.skipIf/it.runIf for platform or environment gates, or move non-asserting setup branches into named helpers.",
    );
    console.error("");
    console.error("Files with increased if counts:");
    for (const detail of result.details) console.error(`- ${detail}`);
    console.error("");
    console.error("Run locally: npm run test-conditionals:scan -- --top 25");
    process.exit(1);
  }
  console.log(
    `PASS: changed test files did not add if statements (${result.headTotal} at PR head vs ${result.baseTotal} at base).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
